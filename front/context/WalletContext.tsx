// Wallet context — wagmi only (no RainbowKit)
import React, { createContext, useContext, ReactNode, useEffect, useState, useCallback, useRef } from 'react';
import { BrowserProvider, ethers, Eip1193Provider } from 'ethers';
import { getReadProvider } from '../lib/contracts';
import { getActiveNetwork } from '../lib/networks';
import { useNetwork } from './NetworkContext';
import { useAccount, useDisconnect, useSwitchChain, useConnect } from 'wagmi';
import { injected } from 'wagmi/connectors';

// ── Interface ─────────────────────────────────────────────────────────────────

interface WalletContextType {
    isConnected: boolean;
    address: string | null;
    balance: bigint;
    balanceLoading: boolean;
    chainId: number | null;
    isCorrectChain: boolean;
    isConnecting: boolean;
    error: string | null;
    connect: () => void;
    disconnect: () => void;
    switchChain: () => Promise<void>;
    getSigner: () => Promise<ethers.Signer | null>;
    signMessage: (message: string) => Promise<string | null>;
    refreshBalance: () => void;
    formatAddress: (address: string) => string;
    formatBalance: (wei: bigint, decimals?: number) => string;
    walletProvider: Eip1193Provider | null;
}

const WalletContext = createContext<WalletContextType | null>(null);

// ── Pure helpers ──────────────────────────────────────────────────────────────

function formatAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatBalance(wei: bigint, decimals = 4): string {
    const eth = Number(ethers.formatEther(wei));
    return eth.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
    const { activeNetwork } = useNetwork();

    // ── wagmi state ────────────────────────────────────────────────────────────
    const { address: wagmiAddress, isConnected: wagmiConnected, isConnecting: wagmiConnecting, chainId: wagmiChainId, connector } = useAccount();
    const { disconnect: wagmiDisconnect } = useDisconnect();
    const { switchChainAsync } = useSwitchChain();
    const { connectAsync } = useConnect();

    // ── Local state ────────────────────────────────────────────────────────────
    const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);
    const [balance, setBalance] = useState<bigint>(0n);
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const providerRef = useRef<Eip1193Provider | null>(null);

    // ── Derived state ──────────────────────────────────────────────────────────
    const address: string | null = wagmiAddress ?? null;
    const isConnected = wagmiConnected;
    const isConnecting = wagmiConnecting;
    const chainId = wagmiChainId ?? null;
    const isCorrectChain = chainId === activeNetwork.chainId;

    // ── Sync EIP-1193 provider from wagmi connector ────────────────────────────
    useEffect(() => {
        if (!connector || !wagmiConnected) {
            setWalletProvider(null);
            providerRef.current = null;
            return;
        }

        let cancelled = false;
        connector.getProvider().then((p: any) => {
            if (cancelled) return;
            providerRef.current = p as Eip1193Provider;
            setWalletProvider(p as Eip1193Provider);
        }).catch(() => {
            if (!cancelled) {
                setWalletProvider(null);
                providerRef.current = null;
            }
        });

        return () => { cancelled = true; };
    }, [connector, wagmiConnected, wagmiAddress]);

    // ── Balance polling ────────────────────────────────────────────────────────
    const updateBalance = useCallback(async (addr: string) => {
        try {
            const provider = getReadProvider();
            const bal = await provider.getBalance(addr);
            setBalance(bal);
        } catch {
            // keep previous balance on error
        } finally {
            setBalanceLoading(false);
        }
    }, [activeNetwork]);

    useEffect(() => {
        if (!address) {
            setBalance(0n);
            setBalanceLoading(false);
            return;
        }
        setBalance(0n);
        setBalanceLoading(true);
        updateBalance(address);
        const interval = setInterval(() => updateBalance(address), 10_000);
        return () => clearInterval(interval);
    }, [address, updateBalance, activeNetwork]);

    const refreshBalance = useCallback(() => {
        if (address) updateBalance(address);
    }, [address, updateBalance]);

    // ── Connect — uses injected wallet (MetaMask, Rabby, etc.) ────────────────
    const connect = useCallback(async () => {
        setError(null);
        try {
            await connectAsync({ connector: injected() });
        } catch (e: any) {
            const msg = e?.message || 'Failed to connect';
            if (!msg.includes('rejected')) {
                setError(msg);
            }
        }
    }, [connectAsync]);

    // ── Disconnect ─────────────────────────────────────────────────────────────
    const disconnect = useCallback(async () => {
        setError(null);
        wagmiDisconnect();
    }, [wagmiDisconnect]);

    // ── Switch chain ───────────────────────────────────────────────────────────
    const switchChain = useCallback(async () => {
        const net = getActiveNetwork();
        try {
            await switchChainAsync({ chainId: net.chainId });
        } catch {
            // user rejected or chain not supported
        }
    }, [switchChainAsync]);

    // ── getSigner ──────────────────────────────────────────────────────────────
    const getSigner = useCallback(async (): Promise<ethers.Signer | null> => {
        let eip1193 = providerRef.current || walletProvider;

        if (!eip1193 && connector) {
            try {
                eip1193 = await connector.getProvider() as any;
            } catch {
                return null;
            }
        }

        if (!eip1193) return null;

        try {
            return await new BrowserProvider(eip1193 as any).getSigner();
        } catch {
            await new Promise(r => setTimeout(r, 500));
            try {
                const p = connector ? await connector.getProvider() as any : eip1193;
                return await new BrowserProvider(p).getSigner();
            } catch {
                return null;
            }
        }
    }, [walletProvider, connector]);

    // ── signMessage ────────────────────────────────────────────────────────────
    const signMessage = useCallback(async (message: string): Promise<string | null> => {
        const signer = await getSigner();
        if (!signer) return null;
        try {
            return await signer.signMessage(message);
        } catch {
            return null;
        }
    }, [getSigner]);

    // ── Context value ──────────────────────────────────────────────────────────
    const value: WalletContextType = {
        isConnected,
        address,
        balance,
        balanceLoading,
        chainId,
        isCorrectChain,
        isConnecting,
        error,
        connect,
        disconnect,
        switchChain,
        getSigner,
        signMessage,
        refreshBalance,
        formatAddress,
        formatBalance,
        walletProvider,
    };

    return (
        <WalletContext.Provider value={value}>
            {children}
        </WalletContext.Provider>
    );
}

export function useWalletContext() {
    const context = useContext(WalletContext);
    if (!context) {
        throw new Error('useWalletContext must be used within WalletProvider');
    }
    return context;
}
