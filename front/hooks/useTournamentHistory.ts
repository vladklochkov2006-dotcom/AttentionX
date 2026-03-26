// Tournament history hook — single contract call via getUserTournamentHistory()
import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { getTournamentContract } from '../lib/contracts';
import { useTournament } from './useTournament';
import { useWalletContext } from '../context/WalletContext';
import { useNetwork } from '../context/NetworkContext';
import { blockchainCache, CacheKeys, CacheTTL } from '../lib/cache';

const STATUS_MAP: Record<number, string> = {
    0: 'Created',
    1: 'Active',
    2: 'Finalized',
    3: 'Cancelled',
};

export interface PastTournamentEntry {
    tournamentId: number;
    startTime: number;
    endTime: number;
    prizePool: bigint;
    entryCount: number;
    status: string;
    userScore: bigint;
    userPrize: bigint;
    claimed: boolean;
}

export function useTournamentHistory(activeTournamentId: number) {
    const [entries, setEntries] = useState<PastTournamentEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const fetchedRef = useRef<string>('');

    const { address } = useWalletContext();
    const { networkId } = useNetwork();
    const { claimPrize: contractClaimPrize } = useTournament();

    // Single contract call to get full user history
    useEffect(() => {
        if (!address || activeTournamentId <= 0) {
            setEntries([]);
            return;
        }

        const fetchKey = `${networkId}:${activeTournamentId}:${address}`;
        if (fetchedRef.current === fetchKey) return;
        fetchedRef.current = fetchKey;

        let cancelled = false;

        const load = async () => {
            setLoading(true);
            try {
                const contract = getTournamentContract();
                const raw = await contract.getUserTournamentHistory(address);

                if (cancelled) return;

                const parsed: PastTournamentEntry[] = raw
                    .map((r: any) => ({
                        tournamentId: Number(r.tournamentId),
                        startTime: Number(r.startTime),
                        endTime: Number(r.endTime),
                        prizePool: r.prizePool,
                        entryCount: Number(r.entryCount),
                        status: STATUS_MAP[Number(r.status)] || 'Unknown',
                        userScore: r.userScore,
                        userPrize: r.userPrize,
                        claimed: r.claimed,
                    }))
                    // Exclude the currently active tournament
                    .filter((e: PastTournamentEntry) => e.tournamentId !== activeTournamentId)
                    // Newest first
                    .sort((a: PastTournamentEntry, b: PastTournamentEntry) => b.tournamentId - a.tournamentId);

                setEntries(parsed);
            } catch {
                // silently fail — contract may not be upgraded yet
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [activeTournamentId, address, networkId]);

    // Claim prize for a past tournament
    const claimPrize = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<{ success: boolean; error?: string }> => {
        const result = await contractClaimPrize(signer, tournamentId);
        if (result.success) {
            // Update local state immediately
            setEntries(prev =>
                prev.map(e =>
                    e.tournamentId === tournamentId ? { ...e, claimed: true } : e
                )
            );
        }
        return result;
    }, [contractClaimPrize]);

    return { entries, loading, claimPrize };
}
