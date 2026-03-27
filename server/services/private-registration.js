/**
 * Private Tournament Registration with TX Queue
 *
 * User signs a message off-chain → sends to server → server queues and registers on-chain.
 * Cards are NEVER visible in user's transaction history.
 * TX queue ensures nonce conflicts don't happen under concurrent load.
 */

import { ethers } from 'ethers';
import { CHAIN, CONTRACTS, ADMIN_PRIVATE_KEY } from '../config.js';

const TOURNAMENT_ABI = [
    'function adminRegisterPlayer(uint256 tournamentId, address player, uint256[5] cardIds)',
    'function hasEntered(uint256 tournamentId, address user) view returns (bool)',
];

// ── TX Queue ──────────────────────────────────────────────────────────────────
// Sequential queue — one tx at a time, managed nonce

let _wallet = null;
let _contract = null;
let _nonce = null;
const _queue = [];
let _processing = false;

function getContract() {
    if (!_wallet) {
        const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
        _wallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
        _contract = new ethers.Contract(CONTRACTS.TournamentManager, TOURNAMENT_ABI, _wallet);
    }
    return _contract;
}

async function getNonce() {
    if (_nonce === null) {
        _nonce = await _wallet.getNonce();
    }
    return _nonce++;
}

// Reset nonce on error (re-sync with chain)
async function resetNonce() {
    _nonce = await _wallet.getNonce();
}

async function processQueue() {
    if (_processing) return;
    _processing = true;

    while (_queue.length > 0) {
        const job = _queue.shift();
        try {
            const result = await executeRegistration(job.tournamentId, job.address, job.cardIds);
            job.resolve(result);
        } catch (err) {
            job.resolve({ success: false, error: err.message || 'Queue processing error' });
        }
    }

    _processing = false;
}

async function executeRegistration(tournamentId, address, cardIds) {
    const contract = getContract();

    // Check if already entered (read — no nonce needed)
    const alreadyEntered = await contract.hasEntered(tournamentId, address);
    if (alreadyEntered) {
        return { success: false, error: 'Already registered for this tournament' };
    }

    // Send tx with managed nonce
    let retries = 2;
    while (retries > 0) {
        try {
            const nonce = await getNonce();
            const tx = await contract.adminRegisterPlayer(tournamentId, address, cardIds, { nonce });
            const receipt = await tx.wait();

            console.log(`[REG-QUEUE] ✓ ${address.substring(0, 10)}... → tournament #${tournamentId} (tx: ${tx.hash.substring(0, 14)}..., nonce: ${nonce})`);

            return {
                success: true,
                txHash: tx.hash,
                blockNumber: receipt.blockNumber,
            };
        } catch (err) {
            const msg = err.message || '';
            if (msg.includes('nonce') || msg.includes('replacement')) {
                console.warn(`[REG-QUEUE] Nonce conflict, resetting... (${retries - 1} retries left)`);
                await resetNonce();
                retries--;
                continue;
            }
            const reason = err.reason || msg;
            console.error(`[REG-QUEUE] ✗ ${address.substring(0, 10)}...: ${reason.substring(0, 100)}`);
            return { success: false, error: reason };
        }
    }

    return { success: false, error: 'Registration failed after retries' };
}

// ── Public API ────────────────────────────────────────────────────────────────

function verifyRegistrationSignature(address, tournamentId, cardIds, signature) {
    const message = `AttentionX: Register for tournament ${tournamentId} with cards [${cardIds.join(',')}]`;
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === address.toLowerCase();
}

/**
 * Queue a private registration. Returns a promise that resolves when the tx is confirmed.
 */
async function registerPlayerPrivately(address, tournamentId, cardIds, signature) {
    // 1. Verify signature
    if (!verifyRegistrationSignature(address, tournamentId, cardIds, signature)) {
        return { success: false, error: 'Invalid signature' };
    }

    if (!ADMIN_PRIVATE_KEY) {
        return { success: false, error: 'Server not configured for private registration' };
    }

    // 2. Add to queue
    return new Promise((resolve) => {
        _queue.push({ tournamentId, address, cardIds, resolve });
        console.log(`[REG-QUEUE] Queued ${address.substring(0, 10)}... (queue size: ${_queue.length})`);
        processQueue();
    });
}

function getRegistrationMessage(tournamentId, cardIds) {
    return `AttentionX: Register for tournament ${tournamentId} with cards [${cardIds.join(',')}]`;
}

function getQueueSize() {
    return _queue.length;
}

export { registerPlayerPrivately, getRegistrationMessage, verifyRegistrationSignature, getQueueSize };
