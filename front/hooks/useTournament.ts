// Tournament contract hook
import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { getTournamentContract, getPackOpenerContract } from '../lib/contracts';
import { blockchainCache, CacheKeys, CacheTTL } from '../lib/cache';

export interface Tournament {
    id: number;
    registrationStart: number;
    startTime: number;
    revealDeadline: number;
    endTime: number;
    prizePool: bigint;
    entryCount: number;
    status: 'Created' | 'Active' | 'Finalized' | 'Cancelled';
}

export interface Lineup {
    cardIds: number[];
    owner: string;
    timestamp: number;
    cancelled: boolean;
    claimed: boolean;
}

const STATUS_MAP: Record<number, Tournament['status']> = {
    0: 'Created',
    1: 'Active',
    2: 'Finalized',
    3: 'Cancelled',
};

export function useTournament() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Get active tournament ID from PackOpener - cache first
    const getActiveTournamentId = useCallback(async (): Promise<number> => {
        const key = CacheKeys.activeTournamentId();

        const cached = blockchainCache.get<number>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    try {
                        const contract = getPackOpenerContract();
                        return Number(await contract.activeTournamentId());
                    } catch { return 0; }
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            try {
                const contract = getPackOpenerContract();
                return Number(await contract.activeTournamentId());
            } catch { return 0; }
        }, CacheTTL.DEFAULT);
    }, []);

    // Get tournament info - cache first
    const getTournament = useCallback(async (tournamentId: number): Promise<Tournament | null> => {
        const key = CacheKeys.tournament(tournamentId);

        const cached = blockchainCache.get<Tournament>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getTournamentContract();
                    const t = await contract.getTournament(tournamentId);
                    return {
                        id: Number(t.id),
                        registrationStart: Number(t.registrationStart),
                        startTime: Number(t.startTime),
                        revealDeadline: Number(t.revealDeadline),
                        endTime: Number(t.endTime),
                        prizePool: t.prizePool,
                        entryCount: Number(t.entryCount),
                        status: STATUS_MAP[Number(t.status)] || 'Created',
                    };
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getTournamentContract();
            const t = await contract.getTournament(tournamentId);
            return {
                id: Number(t.id),
                registrationStart: Number(t.registrationStart),
                startTime: Number(t.startTime),
                revealDeadline: Number(t.revealDeadline),
                endTime: Number(t.endTime),
                prizePool: t.prizePool,
                entryCount: Number(t.entryCount),
                status: STATUS_MAP[Number(t.status)] || 'Created',
            };
        }, CacheTTL.DEFAULT);
    }, []);

    // Check if can register - cache with short TTL
    const canRegister = useCallback(async (tournamentId: number): Promise<boolean> => {
        const key = CacheKeys.canRegister(tournamentId);

        const cached = blockchainCache.get<boolean>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.SHORT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getTournamentContract();
                    return await contract.canRegister(tournamentId);
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getTournamentContract();
            return await contract.canRegister(tournamentId);
        }, CacheTTL.SHORT);
    }, []);

    // Check if user has entered - cache first
    const hasEntered = useCallback(async (tournamentId: number, address: string): Promise<boolean> => {
        const key = CacheKeys.userEntered(tournamentId, address);

        const cached = blockchainCache.get<boolean>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getTournamentContract();
                    return await contract.hasEntered(tournamentId, address);
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getTournamentContract();
            return await contract.hasEntered(tournamentId, address);
        }, CacheTTL.DEFAULT);
    }, []);

    // Get user's lineup - cache first
    const getUserLineup = useCallback(async (tournamentId: number, address: string): Promise<Lineup | null> => {
        const key = CacheKeys.userLineup(tournamentId, address);

        const cached = blockchainCache.get<Lineup>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getTournamentContract();
                    const lineup = await contract.getUserLineup(tournamentId, address);
                    return {
                        cardIds: lineup.cardIds.map((id: bigint) => Number(id)),
                        owner: lineup.owner,
                        timestamp: Number(lineup.timestamp),
                        cancelled: lineup.cancelled,
                        claimed: lineup.claimed,
                    };
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getTournamentContract();
            const lineup = await contract.getUserLineup(tournamentId, address);
            return {
                cardIds: lineup.cardIds.map((id: bigint) => Number(id)),
                owner: lineup.owner,
                timestamp: Number(lineup.timestamp),
                cancelled: lineup.cancelled,
                claimed: lineup.claimed,
            };
        }, CacheTTL.DEFAULT);
    }, []);

    // Enter tournament with 5 cards
    const enterTournament = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        cardIds: [number, number, number, number, number]
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);
            const tx = await contract.enterTournament(tournamentId, cardIds);
            await tx.wait();
            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to enter tournament';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Cancel tournament entry
    const cancelEntry = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);
            const tx = await contract.cancelEntry(tournamentId);
            await tx.wait();
            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to cancel entry';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Get tournament phase
    const getPhase = useCallback(async (tournamentId: number): Promise<string> => {
        try {
            const contract = getTournamentContract();
            return await contract.getTournamentPhase(tournamentId);
        } catch {
            return 'Unknown';
        }
    }, []);

    // Get user's score and prize info
    const getUserScoreInfo = useCallback(async (tournamentId: number, address: string): Promise<{ score: bigint; prize: bigint; totalScore: bigint } | null> => {
        try {
            const contract = getTournamentContract();
            const result = await contract.getUserScoreInfo(tournamentId, address);
            return {
                score: result.score,
                prize: result.prize,
                totalScore: result.totalScore,
            };
        } catch {
            return null;
        }
    }, []);

    // Get total tournament count (nextTournamentId = count + 1)
    const getNextTournamentId = useCallback(async (): Promise<number> => {
        const key = CacheKeys.nextTournamentId();

        const cached = blockchainCache.get<number>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.LONG)) {
                blockchainCache.fetchInBackground(key, async () => {
                    try {
                        const contract = getTournamentContract();
                        return Number(await contract.nextTournamentId());
                    } catch { return 1; }
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            try {
                const contract = getTournamentContract();
                return Number(await contract.nextTournamentId());
            } catch { return 1; }
        }, CacheTTL.LONG);
    }, []);

    // Claim prize after tournament finalized
    const claimPrize = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);
            const tx = await contract.claimPrize(tournamentId);
            await tx.wait();
            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to claim prize';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    return {
        isLoading,
        error,
        getActiveTournamentId,
        getNextTournamentId,
        getTournament,
        canRegister,
        hasEntered,
        getUserLineup,
        enterTournament,
        cancelEntry,
        getPhase,
        getUserScoreInfo,
        claimPrize,
    };
}
