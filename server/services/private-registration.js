/**
 * Private Tournament Registration
 *
 * User signs a message off-chain → sends to server → server registers on-chain.
 * Cards are NEVER visible in user's transaction history.
 *
 * Flow:
 * 1. Frontend: user picks 5 cards, signs EIP-712 message
 * 2. Server: verifies signature, stores cards in private DB
 * 3. Server: calls adminRegisterPlayer(tournamentId, player, cardIds) on-chain
 * 4. Cards are locked on-chain but only visible in admin's tx (not user's)
 */

import { ethers } from 'ethers';
import { CHAIN, CONTRACTS, ADMIN_PRIVATE_KEY } from '../config.js';

const TOURNAMENT_ABI = [
    'function adminRegisterPlayer(uint256 tournamentId, address player, uint256[5] cardIds)',
    'function hasEntered(uint256 tournamentId, address user) view returns (bool)',
];

/**
 * Verify that the user signed the registration message
 */
function verifyRegistrationSignature(address, tournamentId, cardIds, signature) {
    // Message format: "AttentionX: Register for tournament {id} with cards [{ids}]"
    const message = `AttentionX: Register for tournament ${tournamentId} with cards [${cardIds.join(',')}]`;
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === address.toLowerCase();
}

/**
 * Register a player privately via admin transaction
 */
async function registerPlayerPrivately(address, tournamentId, cardIds, signature) {
    // 1. Verify signature
    if (!verifyRegistrationSignature(address, tournamentId, cardIds, signature)) {
        return { success: false, error: 'Invalid signature' };
    }

    if (!ADMIN_PRIVATE_KEY) {
        return { success: false, error: 'Server not configured for private registration' };
    }

    // 2. Submit on-chain via admin
    const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
    const wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACTS.TournamentManager, TOURNAMENT_ABI, wallet);

    // Check if already entered
    const alreadyEntered = await contract.hasEntered(tournamentId, address);
    if (alreadyEntered) {
        return { success: false, error: 'Already registered for this tournament' };
    }

    try {
        const tx = await contract.adminRegisterPlayer(tournamentId, address, cardIds);
        const receipt = await tx.wait();

        console.log(`[PRIVATE-REG] Registered ${address.substring(0, 10)}... for tournament #${tournamentId} (tx: ${tx.hash})`);

        return {
            success: true,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
        };
    } catch (err) {
        const reason = err.reason || err.message || 'Registration failed';
        console.error(`[PRIVATE-REG] Failed for ${address.substring(0, 10)}...: ${reason}`);
        return { success: false, error: reason };
    }
}

/**
 * Build the message that the user needs to sign
 */
function getRegistrationMessage(tournamentId, cardIds) {
    return `AttentionX: Register for tournament ${tournamentId} with cards [${cardIds.join(',')}]`;
}

export { registerPlayerPrivately, getRegistrationMessage, verifyRegistrationSignature };
