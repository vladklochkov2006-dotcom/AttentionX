// FHE-enabled tournament hook for CoFHE-enabled networks
// Extends the base tournament hook with encrypted score viewing and dark leaderboard

import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { getActiveNetwork } from '../lib/networks';
import { decryptForView, isFhenixNetwork } from '../lib/fhenix';

// ABI for TournamentManagerFHE (CoFHE version)
export const TOURNAMENT_FHE_ABI = [
    // Base tournament functions
    'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function getUserLineup(uint256 tournamentId, address user) view returns (uint256[5] cardIds, address owner, uint256 timestamp, bool cancelled, bool claimed)',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
    'function canRegister(uint256 tournamentId, address user) view returns (bool)',
    'function canCancelEntry(uint256 tournamentId, address user) view returns (bool)',
    'function hasEntered(uint256 tournamentId, address user) view returns (bool)',
    'function getTournamentPhase(uint256 tournamentId) view returns (string)',
    'function getActiveEntryCount(uint256 tournamentId) view returns (uint256)',
    'function nextTournamentId() view returns (uint256)',
    'function getMyPrize(uint256 tournamentId) view returns (uint256)',
    'function getParticipantCount(uint256 tournamentId) view returns (uint256)',

    // Commit-Reveal
    'function commitLineup(uint256 tournamentId, bytes32 commitHash)',
    'function revealLineup(uint256 tournamentId, uint256[5] cardIds, bytes32 salt)',
    'function lineupCommitments(uint256 tournamentId, address user) view returns (bytes32)',
    'function lineupRevealed(uint256 tournamentId, address user) view returns (bool)',

    // Write functions
    'function enterTournament(uint256 tournamentId, uint256[5] cardIds)',
    'function cancelEntry(uint256 tournamentId)',
    'function claimPrize(uint256 tournamentId)',

    // CoFHE: Returns ciphertext handles (euint32 = uint256 on-chain)
    // Decryption happens off-chain via the CoFHE SDK
    'function getMyScore(uint256 tournamentId) view returns (uint256)',
    'function getMyRank(uint256 tournamentId) view returns (uint256)',

    // Custom errors — required for ethers v6 to decode revert reasons
    'error TournamentDoesNotExist()',
    'error TournamentNotInRegistration()',
    'error TournamentNotActive()',
    'error TournamentAlreadyFinalized()',
    'error TournamentAlreadyStarted()',
    'error AlreadyEntered()',
    'error NotCardOwner()',
    'error CardAlreadyLocked()',
    'error AlreadyClaimed()',
    'error NotEntered()',
    'error TournamentCancelledError()',
    'error RegistrationNotOpen()',
    'error CommitmentMissing()',
    'error InvalidReveal()',
    'error RevealPeriodNotActive()',
    'error AlreadyCommitted()',
    'error NotRevealed()',
    'error PointsNotSet()',
    'error ScoresNotComputed()',
];

// Map of known custom error selectors → error name
const ERROR_SELECTORS: Record<string, string> = {
    '0x2d08b910': 'CardAlreadyLocked',
    '0x6a259937': 'TournamentNotInRegistration',
    '0x3a08551a': 'TournamentNotActive',
    '0x78636683': 'AlreadyEntered',
    '0x8f0f029b': 'NotCardOwner',
    '0xbfec5558': 'AlreadyCommitted',
    '0xe28486c8': 'RevealPeriodNotActive',
    '0x9ea6d127': 'InvalidReveal',
    '0x7a3e9f14': 'CommitmentMissing',
    '0xb2c9bc88': 'NotRevealed',
    '0x153745d3': 'RegistrationNotOpen',
    '0x7a30a6cf': 'TournamentDoesNotExist',
    '0xd74e0cd5': 'TournamentCancelled',
};

/** Extract a meaningful error name from an ethers v6 exception */
function extractContractError(e: any, fallback: string): string {
    // 1. ethers v6 decoded custom error
    if (e.revert?.name) return e.revert.name;
    // 2. raw 4-byte selector from error data
    const rawData: string | undefined = e.data ?? e.info?.error?.data ?? e.error?.data;
    if (rawData && rawData.length >= 10) {
        const sel = rawData.slice(0, 10).toLowerCase();
        if (ERROR_SELECTORS[sel]) return ERROR_SELECTORS[sel];
    }
    // 3. user rejected
    if (e.code === 'ACTION_REJECTED' || e.message?.includes('user rejected')) return 'ACTION_REJECTED';
    // 4. fallback to ethers message
    return e.reason || e.shortMessage || e.message || fallback;
}

// ABI for DarkLeaderboard
export const DARK_LEADERBOARD_ABI = [
    'function getLeaderboard(uint256 tournamentId) view returns (address[] players, uint256[] ranks)',
    'function getLeaderboardPage(uint256 tournamentId, uint256 offset, uint256 limit) view returns (address[] players, uint256[] ranks)',
    'function getPlayerRank(uint256 tournamentId, address player) view returns (uint256)',
    'function ranksPublished(uint256 tournamentId) view returns (bool)',
    'function rankedCount(uint256 tournamentId) view returns (uint256)',
];

function getTournamentFHEContract(signerOrProvider: ethers.Signer | ethers.Provider) {
    const addr = getActiveNetwork().contracts.TournamentManagerFHE;
    if (!addr) throw new Error('TournamentManagerFHE not deployed on this network');
    return new ethers.Contract(addr, TOURNAMENT_FHE_ABI, signerOrProvider);
}

function getDarkLeaderboardContract(signerOrProvider: ethers.Signer | ethers.Provider) {
    const addr = getActiveNetwork().contracts.DarkLeaderboard;
    if (!addr) throw new Error('DarkLeaderboard not deployed on this network');
    return new ethers.Contract(addr, DARK_LEADERBOARD_ABI, signerOrProvider);
}

export interface DarkLeaderboardEntry {
    rank: number;
    address: string;
    // score is NOT included — it's private!
}

/**
 * Hook for FHE-specific tournament features.
 * Uses CoFHE SDK for off-chain decryption via permits.
 */
export function useTournamentFHE() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * View your own encrypted score.
     * 1. Calls getMyScore() to get the ciphertext handle
     * 2. Uses CoFHE SDK decryptForView with a self-permit to decrypt off-chain
     */
    const getMyScore = useCallback(async (
        publicClient: any,
        walletClient: any,
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<number | null> => {
        if (!isFhenixNetwork()) return null;
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEContract(signer);

            // Get the ciphertext handle from the contract
            const ctHash = await contract.getMyScore(tournamentId);

            // Decrypt off-chain using CoFHE SDK with a permit
            const plaintext = await decryptForView(publicClient, walletClient, ctHash, 'Uint32');

            return Number(plaintext);
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to get score';
            setError(msg);
            return null;
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * View your own encrypted rank.
     */
    const getMyRank = useCallback(async (
        publicClient: any,
        walletClient: any,
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<number | null> => {
        if (!isFhenixNetwork()) return null;
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEContract(signer);
            const ctHash = await contract.getMyRank(tournamentId);
            const plaintext = await decryptForView(publicClient, walletClient, ctHash, 'Uint32');

            return Number(plaintext);
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to get rank';
            setError(msg);
            return null;
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Get the dark leaderboard (ranks only, no scores).
     */
    const getDarkLeaderboard = useCallback(async (
        provider: ethers.Provider,
        tournamentId: number,
        offset: number = 0,
        limit: number = 100
    ): Promise<DarkLeaderboardEntry[]> => {
        if (!isFhenixNetwork()) return [];

        try {
            const contract = getDarkLeaderboardContract(provider);
            const [players, ranks] = await contract.getLeaderboardPage(
                tournamentId, offset, limit
            );

            return players.map((addr: string, i: number) => ({
                rank: Number(ranks[i]),
                address: addr,
            }));
        } catch (e: any) {
            setError(e.reason || e.message || 'Failed to fetch dark leaderboard');
            return [];
        }
    }, []);

    /**
     * Check if ranks have been published for a tournament
     */
    const areRanksPublished = useCallback(async (
        provider: ethers.Provider,
        tournamentId: number
    ): Promise<boolean> => {
        if (!isFhenixNetwork()) return false;

        try {
            const contract = getDarkLeaderboardContract(provider);
            return await contract.ranksPublished(tournamentId);
        } catch {
            return false;
        }
    }, []);

    /**
     * Commit a sealed lineup hash (Registration phase).
     * Cards stay hidden until reveal.
     */
    const commitLineup = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        cardIds: number[],
        salt: string
    ): Promise<{ hash: string | null; error: string | null }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEContract(signer);
            const commitHash = ethers.solidityPackedKeccak256(
                ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32'],
                [cardIds[0], cardIds[1], cardIds[2], cardIds[3], cardIds[4], salt]
            );
            const tx = await contract.commitLineup(tournamentId, commitHash);
            const receipt = await tx.wait();
            return { hash: receipt.hash, error: null };
        } catch (e: any) {
            const msg = extractContractError(e, 'Failed to commit lineup');
            setError(msg);
            return { hash: null, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Reveal your committed lineup (Reveal phase).
     * Verifies the hash, locks NFTs, stores lineup.
     */
    const revealLineup = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        cardIds: number[],
        salt: string
    ): Promise<{ hash: string | null; error: string | null }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEContract(signer);
            const tx = await contract.revealLineup(tournamentId, cardIds, salt);
            const receipt = await tx.wait();
            return { hash: receipt.hash, error: null };
        } catch (e: any) {
            const msg = extractContractError(e, 'Failed to reveal lineup');
            setError(msg);
            return { hash: null, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Generate a random salt for commit-reveal.
     * MUST be stored by the frontend (localStorage) until reveal.
     */
    const generateSalt = useCallback((): string => {
        return ethers.hexlify(ethers.randomBytes(32));
    }, []);

    /**
     * Check if a player has committed but not yet revealed.
     */
    const getCommitStatus = useCallback(async (
        provider: ethers.Provider,
        tournamentId: number,
        userAddress: string
    ): Promise<{ committed: boolean; revealed: boolean }> => {
        try {
            const contract = getTournamentFHEContract(provider);
            const [commitment, revealed] = await Promise.all([
                contract.lineupCommitments(tournamentId, userAddress),
                contract.lineupRevealed(tournamentId, userAddress),
            ]);
            return {
                committed: commitment !== ethers.ZeroHash,
                revealed,
            };
        } catch {
            return { committed: false, revealed: false };
        }
    }, []);

    return {
        isLoading,
        error,
        getMyScore,
        getMyRank,
        getDarkLeaderboard,
        areRanksPublished,
        commitLineup,
        revealLineup,
        generateSalt,
        getCommitStatus,
        isFhenixNetwork: isFhenixNetwork(),
    };
}
