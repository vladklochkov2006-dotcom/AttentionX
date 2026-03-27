/**
 * Verify Encrypted Lineups (Privacy-Preserving)
 *
 * After users register with FHE-encrypted cards, this job:
 * 1. Finds unverified players
 * 2. Decrypts card IDs via CoFHE SDK (admin has FHE.allow access)
 * 3. Verifies card ownership
 * 4. Stores cards ONLY in private DB (NOT on-chain) during tournament
 * 5. After tournament ends: calls adminVerifyPlayer to reveal on-chain
 *
 * IMPORTANT: We NEVER call adminVerifyPlayer during an active tournament.
 * Plaintext card IDs must stay off-chain until the tournament is over.
 */

import { ethers } from 'ethers';
import * as db from '../db/database.js';
import { CHAIN, CONTRACTS, ADMIN_PRIVATE_KEY } from '../config.js';

const ABI = [
    'function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
    'function playerVerified(uint256, address) view returns (bool)',
    'function adminVerifyPlayer(uint256 tournamentId, address player, uint256[5] cardIds)',
    'function getEncryptedLineup(uint256, address) view returns (uint256[5])',
];

const NFT_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getCardInfo(uint256 tokenId) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
];

const PACK_OPENER_ABI = [
    'function activeTournamentId() view returns (uint256)',
];

const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'EpicRare', 'Legendary'];

// Track which players we've already processed (in-memory, resets on server restart)
const _processedPlayers = new Set();

/**
 * Decrypt encrypted card IDs using CoFHE SDK (Node.js).
 * Admin has FHE.allow access granted by the contract.
 */
async function decryptCardIds(encryptedHandles, playerAddress) {
    try {
        // Dynamic import CoFHE SDK for Node.js
        const { createCofheConfig, createCofheClient } = await import('@cofhe/sdk/node');
        const { sepolia: cofheSepolia } = await import('@cofhe/sdk/chains');
        const { createPublicClient, createWalletClient, http } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');
        const { sepolia } = await import('viem/chains');

        const account = privateKeyToAccount(`0x${ADMIN_PRIVATE_KEY}`);
        const publicClient = createPublicClient({ chain: sepolia, transport: http(CHAIN.RPC_URL) });
        const walletClient = createWalletClient({ chain: sepolia, transport: http(CHAIN.RPC_URL), account });

        const config = createCofheConfig({ supportedChains: [cofheSepolia] });
        const cofheClient = createCofheClient(config);
        await cofheClient.connect(publicClient, walletClient);

        // Decrypt each handle
        const { FheTypes } = await import('@cofhe/sdk');
        const cardIds = [];
        for (const handle of encryptedHandles) {
            if (handle === 0n || handle === BigInt(0)) {
                cardIds.push(0);
                continue;
            }
            try {
                const decrypted = await cofheClient.decryptForView(handle, FheTypes.Uint32).execute();
                cardIds.push(Number(decrypted));
            } catch (err) {
                console.warn(`[VERIFY] Could not decrypt handle ${handle.toString().substring(0, 16)}...: ${err.message?.substring(0, 60)}`);
                cardIds.push(0);
            }
        }
        return cardIds;
    } catch (err) {
        console.error(`[VERIFY] CoFHE decryption failed: ${err.message?.substring(0, 100)}`);
        return null;
    }
}

/**
 * Process new tournament registrations.
 * During active tournament: decrypt + verify ownership + store in DB only.
 * After tournament ends: also call adminVerifyPlayer to reveal on-chain.
 */
async function verifyUnverifiedPlayers() {
    if (!ADMIN_PRIVATE_KEY) {
        return { success: false, reason: 'No ADMIN_PRIVATE_KEY' };
    }

    const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
    const wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);

    const packOpener = new ethers.Contract(CONTRACTS.PackOpener, PACK_OPENER_ABI, provider);
    const tournamentId = Number(await packOpener.activeTournamentId());
    if (tournamentId === 0) return { success: false, reason: 'No active tournament' };

    const contract = new ethers.Contract(CONTRACTS.TournamentManager, ABI, wallet);
    const nftContract = new ethers.Contract(CONTRACTS.AttentionX_NFT, NFT_ABI, provider);

    const t = await contract.getTournament(tournamentId);
    const status = Number(t.status);
    const now = Math.floor(Date.now() / 1000);
    const tournamentEnded = now >= Number(t.endTime) || status >= 2;

    if (status === 3) return { success: false, reason: 'Tournament cancelled' };

    const participants = await contract.getTournamentParticipants(tournamentId);
    let processed = 0;
    let failed = 0;

    for (const player of participants) {
        const playerKey = `${tournamentId}:${player.toLowerCase()}`;

        // Skip if already processed this session
        if (_processedPlayers.has(playerKey)) continue;

        // Check if already has cards in DB
        const existingCards = db.getPlayerCards?.(tournamentId, player.toLowerCase());
        if (existingCards && existingCards.length === 5) {
            _processedPlayers.add(playerKey);
            continue;
        }

        try {
            // Read encrypted handles from contract
            const encHandles = await contract.getEncryptedLineup(tournamentId, player);
            const hasData = encHandles.some(h => h !== 0n);
            if (!hasData) continue;

            // Decrypt card IDs via CoFHE
            const cardIds = await decryptCardIds(encHandles, player);
            if (!cardIds || cardIds.length !== 5 || cardIds.some(id => id === 0)) {
                console.warn(`[VERIFY] ${player.substring(0, 10)}... — decryption incomplete`);
                failed++;
                continue;
            }

            // Verify ownership
            let ownsAll = true;
            for (const tokenId of cardIds) {
                const owner = await nftContract.ownerOf(tokenId);
                if (owner.toLowerCase() !== player.toLowerCase()) {
                    console.warn(`[VERIFY] ${player.substring(0, 10)}... — doesn't own token #${tokenId}`);
                    ownsAll = false;
                    break;
                }
            }

            if (!ownsAll) {
                failed++;
                continue;
            }

            // Store in DB ONLY (not on-chain) — preserves privacy
            const cards = [];
            for (const tokenId of cardIds) {
                try {
                    const info = await nftContract.getCardInfo(tokenId);
                    cards.push({
                        tokenId,
                        name: info.name,
                        rarity: RARITY_NAMES[Number(info.rarity)] || 'Common',
                        multiplier: Number(info.multiplier),
                    });
                } catch {
                    cards.push({ tokenId, name: `Card #${tokenId}`, rarity: 'Unknown', multiplier: 1 });
                }
            }

            db.savePlayerCards(tournamentId, player.toLowerCase(), cards);
            db.saveTournamentEntry(tournamentId, player.toLowerCase());
            db.saveDatabase();

            console.log(`[VERIFY] ✓ ${player.substring(0, 10)}... — cards stored in DB (private, NOT on-chain)`);
            _processedPlayers.add(playerKey);
            processed++;

            // ONLY reveal on-chain AFTER tournament ends
            if (tournamentEnded) {
                const isVerified = await contract.playerVerified(tournamentId, player);
                if (!isVerified) {
                    try {
                        const nonce = await wallet.getNonce();
                        const tx = await contract.adminVerifyPlayer(tournamentId, player, cardIds, { nonce });
                        await tx.wait();
                        console.log(`[VERIFY] ✓ ${player.substring(0, 10)}... — revealed on-chain (tournament ended)`);
                    } catch (err) {
                        console.error(`[VERIFY] On-chain reveal failed: ${err.reason || err.message?.substring(0, 80)}`);
                    }
                }
            }
        } catch (err) {
            console.error(`[VERIFY] Error for ${player.substring(0, 10)}...: ${err.message?.substring(0, 100)}`);
            failed++;
        }
    }

    return {
        success: true,
        reason: `Processed ${processed}, failed ${failed}, total ${participants.length}${tournamentEnded ? ' (revealing on-chain)' : ' (DB only, cards private)'}`,
    };
}

export { verifyUnverifiedPlayers };
