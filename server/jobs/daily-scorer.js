/**
 * Unified Daily Scorer (multi-chain)
 *
 * Fetches tweets ONCE, then applies scores to ALL network databases.
 * Twitter data is chain-agnostic; only player scores differ per network
 * (players own different cards on each chain).
 *
 * Steps:
 * 1. Fetch & score tweets for ALL startups (once)
 * 2. For each network:
 *    a. Switch to that network's database
 *    b. Save live feed + base scores
 *    c. Check for active tournament on that chain
 *    d. If active: fetch participants, calculate player scores, update leaderboard
 * 3. Print AI scoring summary
 * 4. Generate AI headline summaries for feed events (per network DB)
 *
 * Designed to run daily at 00:00 UTC via server scheduler (primary server only).
 * Scores the PREVIOUS day (yesterday UTC).
 */

import { ethers } from 'ethers';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as db from '../db/database.js';
import {
    CHAIN_CONFIGS, CONTRACT_CONFIGS, ALL_NETWORKS,
    dbPathForNetwork, schemaPath, NETWORK_NAME, ADMIN_API_KEY
} from '../config.js';
import { computeDailyScoreHmac, computeScoreHmac, computeLeaderboardHmac, computeIntegrityHash } from '../middleware/integrity.js';

/** Notify a secondary server to reload its DB from disk after scorer writes */
async function notifyReloadDb(networkName) {
    const port = CHAIN_CONFIGS[networkName]?.SERVER_PORT;
    if (!port || networkName === NETWORK_NAME) return; // skip self
    try {
        const res = await fetch(`http://localhost:${port}/api/reload-db`, {
            method: 'POST',
            headers: { 'X-Admin-Key': ADMIN_API_KEY, 'Content-Type': 'application/json' },
        });
        if (res.ok) console.log(`  [${networkName}] Notified server (port ${port}) to reload DB`);
        else console.error(`  [${networkName}] Reload failed: ${res.status}`);
    } catch (e) {
        console.error(`  [${networkName}] Could not reach server on port ${port}: ${e.message}`);
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import Twitter scorer
const twitterScorerPath = join(__dirname, '../../scripts/twitter-league-scorer.js');
const { processStartupForDate, STARTUP_MAPPING, aiStats, logAI, setLogContext } = await import(`file:///${twitterScorerPath.replace(/\\/g, '/')}`);

// ============ Blockchain ABIs ============

const packOpenerABI = [
    'function activeTournamentId() view returns (uint256)'
];

const tournamentABI = [
    'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
    'function getUserLineup(uint256 tournamentId, address user) view returns (tuple(uint256[5] cardIds, address owner, uint256 timestamp, bool cancelled, bool claimed))',
];

const nftABI = [
    'function getCardInfo(uint256 tokenId) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
];

const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'EpicRare', 'Legendary'];

// ============ Blockchain reads (parameterized by network) ============

function getProvider(networkName) {
    return new ethers.JsonRpcProvider(CHAIN_CONFIGS[networkName].RPC_URL);
}

async function getActiveTournament(networkName) {
    const provider = getProvider(networkName);
    const contracts = CONTRACT_CONFIGS[networkName];
    const packOpener = new ethers.Contract(contracts.PackOpener, packOpenerABI, provider);
    const tournament = new ethers.Contract(contracts.TournamentManager, tournamentABI, provider);

    const tournamentId = await packOpener.activeTournamentId();
    if (tournamentId == 0) return null;

    const t = await tournament.getTournament(tournamentId);
    const now = Math.floor(Date.now() / 1000);
    const regStart = Number(t.registrationStart);
    const start = Number(t.startTime);
    const end = Number(t.endTime);

    let status = 'upcoming';
    if (now < regStart) status = 'upcoming';
    else if (now >= regStart && now < start) status = 'registration';
    else if (now >= start && now < end) status = 'active';
    else if (now >= end) status = 'ended';

    return {
        id: Number(tournamentId),
        startTime: start,
        endTime: end,
        registrationStart: regStart,
        prizePool: ethers.formatEther(t.prizePool),
        entryCount: Number(t.entryCount),
        status
    };
}

async function getParticipants(networkName, tournamentId) {
    const provider = getProvider(networkName);
    const contracts = CONTRACT_CONFIGS[networkName];
    const tournament = new ethers.Contract(contracts.TournamentManager, tournamentABI, provider);
    const participants = await tournament.getTournamentParticipants(tournamentId);
    return participants.map(addr => addr.toLowerCase());
}

async function getPlayerCards(networkName, tournamentId, playerAddress) {
    const provider = getProvider(networkName);
    const contracts = CONTRACT_CONFIGS[networkName];
    const tournament = new ethers.Contract(contracts.TournamentManager, tournamentABI, provider);
    const nft = new ethers.Contract(contracts.AttentionX_NFT, nftABI, provider);

    const lineup = await tournament.getUserLineup(tournamentId, playerAddress);
    const cards = [];

    for (const tokenId of lineup.cardIds) {
        if (tokenId == 0) continue;
        const info = await nft.getCardInfo(tokenId);
        cards.push({
            tokenId: Number(tokenId),
            name: info.name,
            rarity: RARITY_NAMES[info.rarity] || 'Common',
            multiplier: Number(info.multiplier)
        });
    }

    return cards;
}

// ============ Scoring logic ============

function calculatePlayerScore(playerCards, startupBaseScores) {
    let totalPoints = 0;
    const breakdown = {};

    for (const card of playerCards) {
        const baseScore = startupBaseScores[card.name] || 0;
        const cardPoints = baseScore * card.multiplier;

        totalPoints += cardPoints;
        breakdown[card.name] = {
            basePoints: baseScore,
            rarity: card.rarity,
            multiplier: card.multiplier,
            totalPoints: cardPoints
        };
    }

    return { totalPoints, breakdown };
}

/**
 * Get yesterday's date string in UTC (YYYY-MM-DD).
 */
function getYesterdayUTC() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
}

// ============ Per-network scoring ============

/**
 * Apply tweet data + base scores to a single network's database.
 * Saves live feed, daily scores, and (if tournament active) player scores.
 */
async function applyToNetwork(networkName, scoringDate, startupBaseScores, tweetResults, force) {
    console.log(`\n  === Network: ${networkName.toUpperCase()} ===`);

    // Switch DB to this network
    const originalPath = db.getCurrentDbPath();
    const targetPath = dbPathForNetwork(networkName);
    if (targetPath !== originalPath) {
        await db.switchToDb(targetPath, schemaPath());
    }

    try {
        // Check for active tournament on this chain
        let tournament = null;
        try {
            tournament = await getActiveTournament(networkName);
        } catch (error) {
            console.error(`  [${networkName}] Failed to read tournament: ${error.message}`);
        }

        const hasTournament = tournament && tournament.status === 'active';

        if (hasTournament) {
            console.log(`  Tournament #${tournament.id} | status=${tournament.status} | players=${tournament.entryCount}`);
            db.saveTournament(tournament);

            // Check for duplicate scores
            const existingScores = db.getDailyScores(tournament.id, scoringDate);
            if (existingScores.length > 0 && !force) {
                console.log(`  Already scored for ${scoringDate}. Skipping.`);
                return;
            }
            if (existingScores.length > 0 && force) {
                console.log(`  [FORCE] Clearing old scores for ${scoringDate}...`);
                db.clearDailyScoresForDate(tournament.id, scoringDate);
                db.clearLiveFeedForDate(scoringDate);
            }
        } else {
            console.log(`  ${tournament ? `Tournament #${tournament.id} status="${tournament.status}"` : 'No active tournament'}. Feed-only mode.`);
            if (force) db.clearLiveFeedForDate(scoringDate);
        }

        // Save live feed (always) + daily scores (if tournament)
        for (const [name, result] of Object.entries(tweetResults)) {
            if (hasTournament) {
                const dailyHmac = computeDailyScoreHmac({
                    tournamentId: tournament.id,
                    startupName: name,
                    date: scoringDate,
                    basePoints: result.totalPoints,
                    tweetsAnalyzed: result.tweetCount
                });
                db.saveDailyScore(
                    tournament.id, name, scoringDate,
                    result.totalPoints, result.tweetCount,
                    result.tweets.flatMap(t => t.events),
                    dailyHmac
                );
            }

            for (const tweet of result.tweets) {
                const events = tweet.events || [];
                if (events.length === 0) continue;
                const primary = events[0] || { type: 'ENGAGEMENT', score: 0 };
                db.saveLiveFeedEvent(
                    name, primary.type,
                    tweet.text ? tweet.text.substring(0, 200) : `${name}: ${primary.type}`,
                    tweet.points || primary.score || 0,
                    tweet.id || null, scoringDate,
                    tweet.headline || null
                );
            }
        }

        // Integrity hash chain
        if (hasTournament) {
            try {
                const scoresJson = JSON.stringify(
                    Object.entries(startupBaseScores).sort(([a], [b]) => a.localeCompare(b))
                );
                const previousHash = db.getLatestIntegrityHash(tournament.id);
                const integrityHash = computeIntegrityHash(tournament.id, scoringDate, scoresJson, previousHash);
                db.setConfig(`integrity_latest_${tournament.id}`, JSON.stringify({
                    hash: integrityHash,
                    previousHash: previousHash || 'GENESIS',
                    date: scoringDate
                }));
                console.log(`  Integrity chain: ${integrityHash.substring(0, 16)}...`);
            } catch (e) {
                console.error(`  Integrity hash error: ${e.message}`);
            }
        }

        // Player scores (only if tournament active)
        if (hasTournament) {
            let participants = [];
            try {
                participants = await getParticipants(networkName, tournament.id);
            } catch (error) {
                console.error(`  [${networkName}] Failed to read participants: ${error.message}`);
            }
            console.log(`  ${participants.length} participants`);

            for (const p of participants) {
                db.saveTournamentEntry(tournament.id, p);
            }

            for (const participant of participants) {
                try {
                    const cards = await getPlayerCards(networkName, tournament.id, participant);
                    if (cards.length === 0) {
                        console.log(`  ${participant.substring(0, 10)}... - no cards`);
                        continue;
                    }

                    db.savePlayerCards(tournament.id, participant, cards);
                    const { totalPoints, breakdown } = calculatePlayerScore(cards, startupBaseScores);

                    const scoreHmac = computeScoreHmac({
                        tournamentId: tournament.id,
                        playerAddress: participant,
                        date: scoringDate,
                        points: totalPoints,
                        breakdown
                    });
                    db.saveScoreHistory(tournament.id, participant, scoringDate, totalPoints, breakdown, scoreHmac);

                    const history = db.getPlayerScoreHistory(tournament.id, participant);
                    const totalScore = history.reduce((sum, h) => sum + h.points_earned, 0);

                    const leaderboardHmac = computeLeaderboardHmac({
                        tournamentId: tournament.id,
                        playerAddress: participant,
                        totalScore
                    });
                    db.updateLeaderboard(tournament.id, participant, totalScore, leaderboardHmac);

                    console.log(`  ${participant.substring(0, 10)}... - today: ${totalPoints.toFixed(1)} | total: ${totalScore.toFixed(1)}`);
                } catch (error) {
                    console.error(`  Error for ${participant.substring(0, 10)}...: ${error.message}`);
                }
            }

            // Print leaderboard
            const leaderboard = db.getLeaderboard(tournament.id, 10);
            if (leaderboard.length > 0) {
                console.log(`  Leaderboard (${networkName}):`);
                leaderboard.forEach((entry, i) => {
                    console.log(`    ${i + 1}. ${entry.address.substring(0, 10)}... - ${entry.score.toFixed(1)} pts`);
                });
            }
        }

        // AI summaries for this network's feed
        try {
            const { summarizeFeedEvents, setSummarizerContext } = await import('../services/ai-summarizer.js');
            setSummarizerContext(scoringDate);
            let summarized = 0;
            while (true) {
                const unsummarized = db.getUnsummarizedFeedEvents(20);
                if (unsummarized.length === 0) break;
                const results = await summarizeFeedEvents(unsummarized);
                db.batchUpdateFeedSummaries(results);
                summarized += results.length;
            }
            if (summarized > 0) console.log(`  ${summarized} AI summaries generated`);
        } catch (e) {
            console.error(`  Summarizer error: ${e.message}`);
        }

        // Save this network's DB
        db.saveDatabase();
        console.log(`  [${networkName}] DB saved.`);

        // Notify secondary server to reload from disk
        await notifyReloadDb(networkName);

    } finally {
        // Switch back to original DB if we swapped
        if (targetPath !== originalPath) {
            await db.switchToDb(originalPath);
        }
    }
}

// ============ Main scoring function ============

/**
 * Run unified daily scoring across all networks.
 * Fetches tweets ONCE, then applies to each network's database.
 *
 * @param {string} [dateOverride] - Optional date to score (YYYY-MM-DD). Defaults to yesterday UTC.
 * @param {boolean} [force] - If true, clear old scores/feed for this date and re-score.
 */
async function runDailyScoring(dateOverride, force = false) {
    const scoringDate = dateOverride || getYesterdayUTC();
    console.log(`\n=== Unified Daily Scorer ===`);
    console.log(`Scoring date: ${scoringDate}`);
    console.log(`Networks: ${ALL_NETWORKS.join(', ')}`);

    // Ensure DB is initialized (needed when running standalone, not via server)
    await db.initDatabase();

    // Set log context for this run
    setLogContext(scoringDate);
    aiStats.reset();

    // 1. Fetch & score tweets for all startups ONCE (chain-agnostic)
    console.log('\n[1] Fetching tweets (once for all networks)...');
    const startupBaseScores = {};
    const tweetResults = {}; // { startupName: { totalPoints, tweetCount, tweets } }
    const handles = Object.keys(STARTUP_MAPPING);

    for (let i = 0; i < handles.length; i++) {
        const handle = handles[i];
        const name = STARTUP_MAPPING[handle];
        console.log(`  [${i + 1}/${handles.length}] @${handle} (${name})`);

        try {
            const result = await processStartupForDate(handle, scoringDate);
            startupBaseScores[name] = result.totalPoints;
            tweetResults[name] = result;
            console.log(`  -> ${result.tweetCount} tweets, ${result.totalPoints} pts`);
        } catch (error) {
            console.error(`  Error scoring ${name}: ${error.message}`);
            startupBaseScores[name] = 0;
            tweetResults[name] = { totalPoints: 0, tweetCount: 0, tweets: [] };
        }

        // Rate limit between startups
        if (i < handles.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // 2. Apply scores to each network
    console.log('\n[2] Applying scores to all networks...');
    for (const networkName of ALL_NETWORKS) {
        try {
            await applyToNetwork(networkName, scoringDate, startupBaseScores, tweetResults, force);
        } catch (error) {
            console.error(`  [${networkName}] FAILED: ${error.message}`);
        }
    }

    // 3. Print AI scoring summary
    console.log('\n[3] AI Scoring Summary:');
    console.log(`  Startups scored: ${aiStats.totalStartups}`);
    console.log(`  AI success: ${aiStats.aiSuccessStartups} | Keyword fallback: ${aiStats.keywordFallbackStartups}`);
    console.log(`  Tweets total: ${aiStats.totalTweetsAnalyzed} | AI: ${aiStats.aiScoredTweets} | Keywords: ${aiStats.keywordScoredTweets}`);
    if (Object.keys(aiStats.modelAttempts).length > 0) {
        console.log('  Model breakdown:');
        for (const [model, stats] of Object.entries(aiStats.modelAttempts)) {
            console.log(`    ${model}: tried=${stats.tried} ok=${stats.succeeded} fail=${stats.failed}`);
        }
    }
    if (aiStats.errors.length > 0) {
        console.log(`  Errors (${aiStats.errors.length}):`);
        for (const e of aiStats.errors.slice(0, 5)) {
            console.log(`    ${e.startup} / ${e.model}: ${e.error}`);
        }
    }

    logAI({
        type: 'scoring_run_summary',
        date: scoringDate,
        mode: 'unified',
        networks: ALL_NETWORKS,
        totalStartups: aiStats.totalStartups,
        aiSuccessStartups: aiStats.aiSuccessStartups,
        keywordFallbackStartups: aiStats.keywordFallbackStartups,
        totalTweets: aiStats.totalTweetsAnalyzed,
        aiScoredTweets: aiStats.aiScoredTweets,
        keywordScoredTweets: aiStats.keywordScoredTweets,
        modelAttempts: aiStats.modelAttempts,
        errors: aiStats.errors
    });

    aiStats.reset();

    console.log(`\n=== Unified scoring complete for ${ALL_NETWORKS.length} networks ===`);
}

export { runDailyScoring };
