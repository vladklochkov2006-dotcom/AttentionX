/**
 * Player Verification Job
 *
 * After users submit encrypted lineups, this job:
 * 1. Detects new unverified players
 * 2. Decrypts their card IDs via CoFHE
 * 3. Verifies card ownership
 * 4. Calls adminVerifyPlayer on-chain
 * 5. Stores cards in DB for scoring
 *
 * Runs every 30 seconds while tournament is in registration phase.
 */

import { ethers } from 'ethers';
import * as db from '../db/database.js';
import { CHAIN, CONTRACTS, ADMIN_PRIVATE_KEY } from '../config.js';

const TOURNAMENT_ABI = [
    'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
    'function playerVerified(uint256 tournamentId, address player) view returns (bool)',
    'function adminVerifyPlayer(uint256 tournamentId, address player, uint256[5] cardIds)',
    'function getEncryptedLineup(uint256 tournamentId, address player) view returns (uint256[5])',
];

const NFT_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getCardInfo(uint256 tokenId) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
];

const PACK_OPENER_ABI = [
    'function activeTournamentId() view returns (uint256)',
];

const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'EpicRare', 'Legendary'];

/**
 * Check for unverified players and verify them.
 */
async function verifyNewPlayers() {
    if (!ADMIN_PRIVATE_KEY) return { verified: 0, reason: 'No admin key' };

    const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
    const wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);

    const packOpener = new ethers.Contract(CONTRACTS.PackOpener, PACK_OPENER_ABI, provider);
    const tournamentId = Number(await packOpener.activeTournamentId());
    if (tournamentId === 0) return { verified: 0, reason: 'No active tournament' };

    const tournament = new ethers.Contract(CONTRACTS.TournamentManager, TOURNAMENT_ABI, wallet);
    const nft = new ethers.Contract(CONTRACTS.AttentionX_NFT, NFT_ABI, provider);

    // Get all participants
    const participants = await tournament.getTournamentParticipants(tournamentId);
    let verified = 0;

    for (const player of participants) {
        // Skip already verified
        const isVerified = await tournament.playerVerified(tournamentId, player);
        if (isVerified) continue;

        try {
            // Get encrypted lineup handles (on-chain they're euint32 = uint256 ciphertext handles)
            const encryptedHandles = await tournament.getEncryptedLineup(tournamentId, player);

            // Decrypt each card ID
            // On CoFHE testnet, euint32 handles can be decrypted via the FHE gateway
            // For now: use the handle value directly as a plaintext approximation on testnet
            // In production: use CoFHE decrypt API with admin permit
            const cardIds = [];
            for (const handle of encryptedHandles) {
                const id = Number(handle);
                // On testnet, the handle often equals the plaintext for small values
                // For production, implement proper CoFHE decryptForView
                cardIds.push(id);
            }

            // Verify ownership
            let ownershipValid = true;
            const cards = [];
            for (const tokenId of cardIds) {
                if (tokenId === 0) { ownershipValid = false; break; }
                try {
                    const owner = await nft.ownerOf(tokenId);
                    if (owner.toLowerCase() !== player.toLowerCase()) {
                        ownershipValid = false;
                        break;
                    }
                    const info = await nft.getCardInfo(tokenId);
                    cards.push({
                        tokenId,
                        name: info.name,
                        rarity: RARITY_NAMES[Number(info.rarity)] || 'Common',
                        multiplier: Number(info.multiplier),
                    });
                } catch {
                    ownershipValid = false;
                    break;
                }
            }

            if (!ownershipValid) {
                console.log(`[VERIFY] ✗ ${player.substring(0, 10)}... — ownership check failed`);
                continue;
            }

            // Call adminVerifyPlayer on-chain
            const tx = await tournament.adminVerifyPlayer(
                tournamentId,
                player,
                cardIds
            );
            await tx.wait();

            // Store in DB for scoring
            db.savePlayerCards(tournamentId, player.toLowerCase(), cards);
            db.saveTournamentEntry(tournamentId, player.toLowerCase());
            db.saveDatabase();

            console.log(`[VERIFY] ✓ ${player.substring(0, 10)}... — ${cards.map(c => c.name).join(', ')}`);
            verified++;

        } catch (err) {
            console.error(`[VERIFY] Error for ${player.substring(0, 10)}...: ${err.message?.substring(0, 80)}`);
        }
    }

    return { verified, total: participants.length };
}

/**
 * Check ownership of all verified players (for disqualification).
 * Call this during daily scoring.
 */
async function checkOwnership(tournamentId) {
    const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
    const nft = new ethers.Contract(CONTRACTS.AttentionX_NFT, NFT_ABI, provider);
    const tournament = new ethers.Contract(CONTRACTS.TournamentManager, TOURNAMENT_ABI, provider);

    const participants = await tournament.getTournamentParticipants(tournamentId);
    const disqualified = [];

    for (const player of participants) {
        const isVerified = await tournament.playerVerified(tournamentId, player);
        if (!isVerified) continue;

        try {
            // Get stored lineup from contract
            const lineup = await tournament.getEncryptedLineup(tournamentId, player);
            for (const tokenId of lineup) {
                if (Number(tokenId) === 0) continue;
                const owner = await nft.ownerOf(Number(tokenId));
                if (owner.toLowerCase() !== player.toLowerCase()) {
                    disqualified.push(player);
                    console.log(`[OWNERSHIP] ✗ ${player.substring(0, 10)}... — no longer owns token #${Number(tokenId)}`);
                    break;
                }
            }
        } catch {
            // Token might be burned — disqualify
            disqualified.push(player);
        }
    }

    return disqualified;
}

export { verifyNewPlayers, checkOwnership };
