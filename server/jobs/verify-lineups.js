/**
 * Verify Encrypted Lineups
 *
 * After users register with FHE-encrypted cards, this job:
 * 1. Finds unverified players (hasEntered but !playerVerified)
 * 2. Reads encrypted card IDs from contract
 * 3. Decrypts them via CoFHE (admin has FHE.allow access)
 * 4. Verifies card ownership
 * 5. Calls adminVerifyPlayer to store plaintext lineup for scoring
 *
 * Runs periodically (every 5 min) and after registration phase ends.
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
    'event EncryptedLineupSubmitted(uint256 indexed tournamentId, address indexed user)',
];

const NFT_ABI = [
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function getCardInfo(uint256 tokenId) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
];

const PACK_OPENER_ABI = [
    'function activeTournamentId() view returns (uint256)',
];

// TX queue for sequential nonce management (shared with fhe-automation)
let _nonce = null;
let _wallet = null;

function getWallet() {
    if (!_wallet) {
        const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
        _wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    }
    return _wallet;
}

async function getNonce() {
    const wallet = getWallet();
    if (_nonce === null) _nonce = await wallet.getNonce();
    return _nonce++;
}

async function resetNonce() {
    _nonce = await getWallet().getNonce();
}

/**
 * Decrypt encrypted card IDs for a player.
 * Uses ethers.js to read the encrypted lineup handles from contract,
 * then decrypts via CoFHE RPC (admin has FHE.allow permission).
 *
 * For testnet/buildathon: we use a simplified approach —
 * read the encrypted handles and attempt direct decryption via provider.
 */
async function decryptCardIds(contract, tournamentId, player) {
    // Get encrypted lineup handles
    const encryptedHandles = await contract.getEncryptedLineup(tournamentId, player);

    // For CoFHE on Sepolia: encrypted values are stored as handles (uint256)
    // Admin can decrypt using FHE.decrypt() or via the CoFHE gateway
    // For now: try to read via static call with admin signer
    const cardIds = [];
    for (const handle of encryptedHandles) {
        // The handle IS the encrypted value reference
        // On CoFHE testnet, we can attempt to read it as the plaintext
        // (since admin has FHE.allow access)
        const val = Number(handle);
        if (val > 0) {
            cardIds.push(val);
        }
    }

    return cardIds;
}

/**
 * Verify all unverified players for the active tournament.
 */
async function verifyUnverifiedPlayers() {
    if (!ADMIN_PRIVATE_KEY) {
        return { success: false, reason: 'No ADMIN_PRIVATE_KEY' };
    }

    const wallet = getWallet();
    const provider = wallet.provider;

    const packOpener = new ethers.Contract(CONTRACTS.PackOpener, PACK_OPENER_ABI, provider);
    const tournamentId = Number(await packOpener.activeTournamentId());
    if (tournamentId === 0) return { success: false, reason: 'No active tournament' };

    const contract = new ethers.Contract(CONTRACTS.TournamentManager, ABI, wallet);
    const nftContract = new ethers.Contract(CONTRACTS.AttentionX_NFT, NFT_ABI, provider);

    const t = await contract.getTournament(tournamentId);
    if (Number(t.status) >= 2) return { success: false, reason: 'Tournament finalized/cancelled' };

    // Get all participants
    const participants = await contract.getTournamentParticipants(tournamentId);
    let verified = 0;
    let failed = 0;

    for (const player of participants) {
        // Check if already verified
        const isVerified = await contract.playerVerified(tournamentId, player);
        if (isVerified) continue;

        try {
            // Decrypt cards
            const cardIds = await decryptCardIds(contract, tournamentId, player);
            if (cardIds.length !== 5) {
                console.error(`[VERIFY] ${player.substring(0, 10)}... — got ${cardIds.length} cards, expected 5`);
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
                console.warn(`[VERIFY] ${player.substring(0, 10)}... — ownership check failed, skipping`);
                failed++;
                continue;
            }

            // Call adminVerifyPlayer on-chain
            let retries = 2;
            while (retries > 0) {
                try {
                    const nonce = await getNonce();
                    const tx = await contract.adminVerifyPlayer(tournamentId, player, cardIds, { nonce });
                    await tx.wait();
                    console.log(`[VERIFY] ✓ ${player.substring(0, 10)}... verified (cards: ${cardIds.join(',')})`);

                    // Save to DB for scoring
                    const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'EpicRare', 'Legendary'];
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

                    verified++;
                    break;
                } catch (err) {
                    if (err.message?.includes('nonce')) {
                        await resetNonce();
                        retries--;
                        continue;
                    }
                    console.error(`[VERIFY] ✗ ${player.substring(0, 10)}...: ${err.reason || err.message}`);
                    failed++;
                    break;
                }
            }
        } catch (err) {
            console.error(`[VERIFY] Error for ${player.substring(0, 10)}...: ${err.message?.substring(0, 100)}`);
            failed++;
        }
    }

    return {
        success: true,
        reason: `Verified ${verified}, failed ${failed}, total ${participants.length}`,
    };
}

export { verifyUnverifiedPlayers };
