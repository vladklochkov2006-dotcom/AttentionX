/**
 * Tournament Finalizer
 * Checks if active tournament has ended and finalizes it on-chain.
 *
 * Flow:
 * 1. Get active tournament from PackOpener
 * 2. Check if endTime has passed
 * 3. Fetch all participants and their lineups from chain
 * 4. Calculate each player's score using DB startup points + card multipliers
 * 5. Distribute prize pool proportionally to scores
 * 6. Call finalizeTournament(tournamentId, winners[], amounts[]) on-chain
 * 7. Players can then claimPrize() to receive XTZ
 *
 * Designed to be imported by server/index.js and run periodically.
 * Requires ADMIN_PRIVATE_KEY env variable for blockchain transactions.
 */

import { ethers } from 'ethers';
import * as db from '../db/database.js';
import { CHAIN, CONTRACTS, ADMIN_PRIVATE_KEY } from '../config.js';

const tournamentABI = [
    'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function finalizeTournament(uint256 tournamentId, address[] winners, uint256[] amounts)',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
    'function getUserLineup(uint256 tournamentId, address user) view returns (tuple(uint256[5] cardIds, address owner, uint256 timestamp, bool cancelled, bool claimed))',
];

const nftABI = [
    'function getCardInfo(uint256 tokenId) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
];

const packOpenerABI = [
    'function activeTournamentId() view returns (uint256)',
];

// Startup name → contract startupId (1-indexed, matching NFT contract)
const STARTUP_IDS = {
    'Openclaw': 1,
    'Lovable': 2,
    'Cursor': 3,
    'OpenAI': 4,
    'Anthropic': 5,
    'Browser Use': 6,
    'Dedalus Labs': 7,
    'Autumn': 8,
    'Axiom': 9,
    'Multifactor': 10,
    'Dome': 11,
    'GrazeMate': 12,
    'Tornyol Systems': 13,
    'Pocket': 14,
    'Caretta': 15,
    'AxionOrbital Space': 16,
    'Freeport Markets': 17,
    'Ruvo': 18,
    'Lightberry': 19,
};

// Reverse map: startupId → name
const STARTUP_NAMES = {};
for (const [name, id] of Object.entries(STARTUP_IDS)) {
    STARTUP_NAMES[id] = name;
}

/**
 * Build startup points map from aggregated DB scores.
 * Returns: { startupId: points }
 */
function buildStartupPoints(tournamentId) {
    const points = {}; // startupId → total points
    const dailyScores = db.getAggregatedStartupScores(tournamentId);

    console.log('\n   Aggregated startup scores:');
    dailyScores.forEach(score => {
        const startupId = STARTUP_IDS[score.startup_name];
        if (startupId) {
            points[startupId] = Math.floor(score.total_points);
            if (points[startupId] > 0) {
                console.log(`     ${score.startup_name} (ID ${startupId}): ${points[startupId]} pts`);
            }
        }
    });

    return points;
}

/**
 * Check if tournament has ended and finalize it.
 * Returns: { finalized: boolean, reason: string }
 */
async function checkAndFinalize() {
    const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
    const packOpener = new ethers.Contract(CONTRACTS.PackOpener, packOpenerABI, provider);
    const tournamentContract = new ethers.Contract(CONTRACTS.TournamentManager, tournamentABI, provider);
    const nftContract = new ethers.Contract(CONTRACTS.AttentionX_NFT, nftABI, provider);

    // 1. Get active tournament
    const tournamentId = Number(await packOpener.activeTournamentId());
    if (tournamentId === 0) {
        return { finalized: false, reason: 'No active tournament on chain' };
    }

    // 2. Get tournament data
    const t = await tournamentContract.getTournament(tournamentId);
    const now = Math.floor(Date.now() / 1000);
    const endTime = Number(t.endTime);
    const status = Number(t.status); // 0=Created, 1=Active, 2=Finalized, 3=Cancelled
    const prizePool = t.prizePool;

    console.log(`   Tournament #${tournamentId} | ends: ${new Date(endTime * 1000).toISOString()} | status: ${status} | pool: ${ethers.formatEther(prizePool)} XTZ`);

    // Already finalized or cancelled
    if (status === 2) {
        return { finalized: false, reason: 'Already finalized' };
    }
    if (status === 3) {
        return { finalized: false, reason: 'Tournament cancelled' };
    }

    // Not ended yet
    if (now < endTime) {
        const hoursLeft = ((endTime - now) / 3600).toFixed(1);
        return { finalized: false, reason: `Still active (${hoursLeft}h remaining)` };
    }

    // 3. Tournament ended - prepare finalization
    console.log('   Tournament ended! Preparing finalization...');

    // Check admin key
    if (!ADMIN_PRIVATE_KEY) {
        db.updateTournamentStatus(tournamentId, 'ended');
        db.saveDatabase();
        return { finalized: false, reason: 'ADMIN_PRIVATE_KEY not set - cannot finalize on-chain. DB marked as ended.' };
    }

    // 4. Get startup points from DB
    const startupPoints = buildStartupPoints(tournamentId);

    // 5. Fetch participants and calculate scores off-chain
    console.log('\n   Fetching participants and calculating scores...');
    const participants = await tournamentContract.getTournamentParticipants(tournamentId);
    console.log(`   ${participants.length} participants`);

    const userScores = []; // { address, score }
    let totalScore = 0n;

    for (const participant of participants) {
        try {
            const lineup = await tournamentContract.getUserLineup(tournamentId, participant);

            // Skip cancelled entries
            if (lineup.cancelled) {
                console.log(`     ${participant.substring(0, 10)}... - cancelled, skipping`);
                continue;
            }

            let userScore = 0n;

            // Calculate score for each of 5 cards
            for (const tokenId of lineup.cardIds) {
                if (Number(tokenId) === 0) continue;

                const info = await nftContract.getCardInfo(tokenId);
                const sId = Number(info.startupId);
                const multiplier = Number(info.multiplier);
                const pts = startupPoints[sId] || 0;

                userScore += BigInt(pts) * BigInt(multiplier);
            }

            userScores.push({ address: participant, score: userScore });
            totalScore += userScore;

            console.log(`     ${participant.substring(0, 10)}... - score: ${userScore}`);
        } catch (e) {
            console.error(`     ${participant.substring(0, 10)}... - error: ${e.message}`);
        }
    }

    console.log(`\n   Total score: ${totalScore}`);

    // 6. Calculate proportional prize distribution
    const winners = [];
    const amounts = [];

    if (totalScore > 0n && prizePool > 0n) {
        for (const { address, score } of userScores) {
            if (score > 0n) {
                const prize = (score * prizePool) / totalScore;
                winners.push(address);
                amounts.push(prize);
                console.log(`     ${address.substring(0, 10)}... - prize: ${ethers.formatEther(prize)} XTZ`);
            }
        }
    } else if (totalScore === 0n) {
        console.log('   No scores - no prizes to distribute');
    } else {
        console.log('   No prize pool');
    }

    // 7. Finalize on blockchain
    console.log(`\n   Sending finalizeTournament tx (${winners.length} winners)...`);
    const wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    const tournamentWithSigner = tournamentContract.connect(wallet);

    const tx = await tournamentWithSigner.finalizeTournament(tournamentId, winners, amounts);
    console.log(`   TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    console.log(`   TX confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed})`);

    // 8. Update DB
    db.updateTournamentStatus(tournamentId, 'finalized');
    db.saveDatabase();

    return { finalized: true, reason: `Tournament #${tournamentId} finalized! ${winners.length} winners, pool: ${ethers.formatEther(prizePool)} XTZ` };
}

export { checkAndFinalize };
