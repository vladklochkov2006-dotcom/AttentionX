// Hook for wallet balance with auto-refresh
// Shows cached balance immediately, updates every 10 seconds

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import { blockchainCache, CacheKeys, POLLING_INTERVALS } from '../lib/cache';
import { getProvider } from '../lib/contracts';

type UseBalanceResult = {
    balance: bigint;
    formatted: string;
    isLoading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
};

export function useBalance(address?: string): UseBalanceResult {
    const cacheKey = address ? CacheKeys.balance(address) : '';

    const [balance, setBalance] = useState<bigint>(() => {
        if (!address) return 0n;
        return blockchainCache.get<bigint>(cacheKey) ?? 0n;
    });
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Format balance to readable string
    const formatted = useMemo(() => {
        try {
            const eth = ethers.formatEther(balance);
            // Show max 4 decimal places
            const num = parseFloat(eth);
            if (num === 0) return '0';
            if (num < 0.0001) return '<0.0001';
            return num.toFixed(4).replace(/\.?0+$/, '');
        } catch {
            return '0';
        }
    }, [balance]);

    // Fetcher function
    const fetchBalance = useCallback(async (): Promise<bigint> => {
        if (!address) return 0n;
        const provider = getProvider();
        return await provider.getBalance(address);
    }, [address]);

    // Manual refresh
    const refresh = useCallback(async () => {
        if (!address) return;
        setIsLoading(true);
        setError(null);
        try {
            const newBalance = await fetchBalance();
            blockchainCache.set(cacheKey, newBalance);
            setBalance(newBalance);
        } catch (e: any) {
            setError(e.message || 'Failed to fetch balance');
        } finally {
            setIsLoading(false);
        }
    }, [address, cacheKey, fetchBalance]);

    useEffect(() => {
        if (!address) {
            setBalance(0n);
            return;
        }

        // Get cached balance immediately
        const cached = blockchainCache.get<bigint>(cacheKey);
        if (cached !== undefined) {
            setBalance(cached);
        }

        // Subscribe to balance updates (fast interval - 10s)
        const unsubscribe = blockchainCache.subscribe<bigint>(
            cacheKey,
            fetchBalance,
            (newBalance) => {
                setBalance(newBalance);
            },
            POLLING_INTERVALS.FAST
        );

        // Initial fetch if no cache
        if (cached === undefined) {
            setIsLoading(true);
            fetchBalance()
                .then(newBalance => {
                    blockchainCache.set(cacheKey, newBalance);
                    setBalance(newBalance);
                })
                .catch(e => setError(e.message))
                .finally(() => setIsLoading(false));
        }

        return () => {
            unsubscribe();
        };
    }, [address, cacheKey, fetchBalance]);

    return {
        balance,
        formatted,
        isLoading,
        error,
        refresh
    };
}
