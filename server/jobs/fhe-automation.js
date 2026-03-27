/**
 * FHE Automation — runs after daily scorer
 *
 * Automates all FHE tournament steps:
 * 1. setPointsFromPlaintext — encrypt startup scores on-chain
 * 2. computeEncryptedScores — calculate player scores (FHE)
 * 3. finalizeScores — mark scores complete
 * 4. computeDarkRanks — encrypted leaderboard ranking
 *
 * At tournament end (handled by finalize-tournament.js):
 * 5. finalizeWithPrizes — distribute prize pool
 */

import { ethers } from 'ethers';
import * as db from '../db/database.js';
import { CHAIN, CONTRACTS, ADMIN_PRIVATE_KEY } from '../config.js';

const TOURNAMENT_FHE_ABI = [
    'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function setPointsFromPlaintext(uint256 tournamentId, uint32[19] rawPoints)',
    'function computeEncryptedScores(uint256 tournamentId, uint256 batchStart, uint256 batchSize)',
    'function finalizeScores(uint256 tournamentId)',
    'function computeDarkRanks(uint256 tournamentId, uint256 batchStart, uint256 batchSize)',
    'function pointsFinalized(uint256 tournamentId) view returns (bool)',
    'function scoresComputed(uint256 tournamentId) view returns (bool)',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
];

const PACK_OPENER_ABI = [
    'function activeTournamentId() view returns (uint256)',
];

// Startup name → index (0-based for the points array)
const STARTUP_ORDER = [
    'Openclaw', 'Lovable', 'Cursor', 'OpenAI', 'Anthropic',
    'Browser Use', 'Dedalus Labs', 'Autumn', 'Axiom', 'Multifactor',
    'Dome', 'GrazeMate', 'Tornyol Systems', 'Pocket', 'Caretta',
    'AxionOrbital Space', 'Freeport Markets', 'Ruvo', 'Lightberry',
];

const BATCH_SIZE = 20; // Process 20 participants per tx

/**
 * Run FHE automation for the active tournament.
 * Call this after daily scorer completes.
 */
async function runFheAutomation() {
    if (!ADMIN_PRIVATE_KEY) {
        console.log('[FHE] No ADMIN_PRIVATE_KEY — skipping FHE automation');
        return { success: false, reason: 'No admin key' };
    }

    const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
    const wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);

    const packOpener = new ethers.Contract(CONTRACTS.PackOpener, PACK_OPENER_ABI, provider);
    const tournamentId = Number(await packOpener.activeTournamentId());

    if (tournamentId === 0) {
        return { success: false, reason: 'No active tournament' };
    }

    const tournament = new ethers.Contract(CONTRACTS.TournamentManager, TOURNAMENT_FHE_ABI, wallet);
    const t = await tournament.getTournament(tournamentId);
    const now = Math.floor(Date.now() / 1000);
    const status = Number(t.status);

    // Only run during active phase (after startTime, before endTime)
    if (status === 2 || status === 3) {
        return { success: false, reason: `Tournament #${tournamentId} already finalized/cancelled` };
    }
    if (now < Number(t.startTime)) {
        return { success: false, reason: `Tournament #${tournamentId} not started yet` };
    }

    console.log(`[FHE] Processing tournament #${tournamentId}`);

    try {
        // Step 1: Set points from daily scorer
        const aggregatedScores = db.getAggregatedStartupScores(tournamentId);
        const points = new Array(19).fill(0);

        for (const score of aggregatedScores) {
            const idx = STARTUP_ORDER.indexOf(score.startup_name);
            if (idx >= 0) {
                points[idx] = Math.floor(score.total_points);
            }
        }

        console.log('[FHE] Step 1: Setting encrypted points...');
        console.log('  Points:', points.map((p, i) => `${STARTUP_ORDER[i]}=${p}`).filter(s => !s.endsWith('=0')).join(', '));

        const tx1 = await tournament.setPointsFromPlaintext(tournamentId, points);
        await tx1.wait();
        console.log('[FHE] ✓ Points set');

        // Step 2: Compute encrypted scores (in batches)
        const participants = await tournament.getTournamentParticipants(tournamentId);
        const participantCount = participants.length;

        if (participantCount === 0) {
            console.log('[FHE] No participants — skipping score computation');
            return { success: true, reason: 'Points set, no participants' };
        }

        console.log(`[FHE] Step 2: Computing scores for ${participantCount} participants...`);
        for (let start = 0; start < participantCount; start += BATCH_SIZE) {
            const size = Math.min(BATCH_SIZE, participantCount - start);
            console.log(`  Batch ${start}..${start + size - 1}`);
            const tx2 = await tournament.computeEncryptedScores(tournamentId, start, size);
            await tx2.wait();
        }
        console.log('[FHE] ✓ Scores computed');

        // Step 3: Finalize scores
        console.log('[FHE] Step 3: Finalizing scores...');
        const tx3 = await tournament.finalizeScores(tournamentId);
        await tx3.wait();
        console.log('[FHE] ✓ Scores finalized');

        // Step 4: Compute dark ranks (in batches)
        console.log(`[FHE] Step 4: Computing dark ranks...`);
        for (let start = 0; start < participantCount; start += BATCH_SIZE) {
            const size = Math.min(BATCH_SIZE, participantCount - start);
            console.log(`  Batch ${start}..${start + size - 1}`);
            const tx4 = await tournament.computeDarkRanks(tournamentId, start, size);
            await tx4.wait();
        }
        console.log('[FHE] ✓ Dark ranks computed');

        return { success: true, reason: `FHE automation complete for tournament #${tournamentId}` };

    } catch (err) {
        console.error(`[FHE] Error: ${err.message}`);
        return { success: false, reason: err.message };
    }
}

export { runFheAutomation };
