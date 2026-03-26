// Wallet context — Privy wallet only (Fhenix CoFHE on Sepolia)
import React, { createContext, useContext, ReactNode, useEffect, useState, useCallback, useRef } from 'react';
import { BrowserProvider, ethers, Eip1193Provider } from 'ethers';
import { getReadProvider } from '../lib/contracts';
import { getActiveNetwork } from '../lib/networks';
import { useNetwork } from './NetworkContext';
import { usePrivy, useWallets } from '@privy-io/react-auth';

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

function parseCaip2ChainId(caip2: string | undefined): number | null {
    if (!caip2) return null;
    const parts = caip2.split(':');
    const n = parseInt(parts[parts.length - 1]);
    return isNaN(n) ? null : n;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
    const { activeNetwork } = useNetwork();

    // ── Privy state ───────────────────────────────────────────────────────────
    const { ready, authenticated: privyAuthenticated, login, logout: privyLogout } = usePrivy();
    const { wallets } = useWallets();
    const privyWallet = wallets[0] ?? null;

    // ── Local state ───────────────────────────────────────────────────────────
    const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);
    const [privyChainId, setPrivyChainId] = useState<number | null>(null);
    const [balance, setBalance] = useState<bigint>(0n);
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const chainListenerRef = useRef<((hex: string) => void) | null>(null);
    const prevProviderRef = useRef<any>(null);

    // ── Derived state ─────────────────────────────────────────────────────────
    const address: string | null = privyWallet?.address ?? null;
    const isConnected = privyAuthenticated && !!privyWallet;
    const isConnecting = !ready;
    const chainId = privyChainId;
    const isCorrectChain = chainId === activeNetwork.chainId;

    // ── Privy: sync EIP-1193 provider ─────────────────────────────────────────
    useEffect(() => {
        if (!privyWallet) {
            if (prevProviderRef.current && chainListenerRef.current) {
                prevProviderRef.current.removeListener?.('chainChanged', chainListenerRef.current);
            }
            setWalletProvider(null);
            setPrivyChainId(null);
            return;
        }

        let cancelled = false;

        privyWallet.getEthereumProvider().then(eip1193 => {
            if (cancelled) return;

            if (prevProviderRef.current && chainListenerRef.current) {
                prevProviderRef.current.removeListener?.('chainChanged', chainListenerRef.current);
            }

            setPrivyChainId(parseCaip2ChainId(privyWallet.chainId));

            const onChain = (hex: string) => {
                setPrivyChainId(parseInt(typeof hex === 'string' ? hex : String(hex), 16));
            };
            eip1193.on?.('chainChanged', onChain);
            chainListenerRef.current = onChain;
            prevProviderRef.current = eip1193;

            setWalletProvider(eip1193 as Eip1193Provider);
        }).catch(() => {
            if (!cancelled) setWalletProvider(null);
        });

        return () => { cancelled = true; };
    }, [privyWallet?.address]);

    // ── Balance polling ───────────────────────────────────────────────────────
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

    // ── Connect via Privy ─────────────────────────────────────────────────────
    const connect = useCallback(() => {
        setError(null);
        login();
    }, [login]);

    // ── Disconnect ────────────────────────────────────────────────────────────
    const disconnect = useCallback(async () => {
        setError(null);
        if (privyAuthenticated) await privyLogout();
    }, [privyAuthenticated, privyLogout]);

    // ── Switch chain ──────────────────────────────────────────────────────────
    const switchChain = useCallback(async () => {
        const net = getActiveNetwork();

        if (!privyWallet) return;
        try {
            await privyWallet.switchChain(net.chainId);
            setPrivyChainId(net.chainId);
        } catch {
            const eip1193 = walletProvider;
            if (!eip1193) return;
            const hexChainId = '0x' + net.chainId.toString(16);
            try {
                await eip1193.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: hexChainId,
                        chainName: net.name,
                        nativeCurrency: net.nativeCurrency,
                        rpcUrls: [net.rpcUrl],
                        blockExplorerUrls: [net.explorerUrl],
                    }],
                });
                await privyWallet.switchChain(net.chainId);
                setPrivyChainId(net.chainId);
            } catch { /* user rejected */ }
        }
    }, [privyWallet, walletProvider]);

    // ── signMessage ───────────────────────────────────────────────────────────
    const signMessage = useCallback(async (message: string): Promise<string | null> => {
        if (!privyWallet) return null;
        try {
            const eip1193 = await privyWallet.getEthereumProvider();
            const signer = await new BrowserProvider(eip1193 as any).getSigner();
            return await signer.signMessage(message);
        } catch {
            return null;
        }
    }, [privyWallet]);

    // ── getSigner (with retry — provider may lag behind isConnected) ─────────
    const getSignerOnce = useCallback(async (): Promise<ethers.Signer | null> => {
        if (!privyWallet) return null;
        try {
            const eip1193 = await privyWallet.getEthereumProvider();
            return await new BrowserProvider(eip1193 as any).getSigner();
        } catch {
            return null;
        }
    }, [privyWallet]);

    const getSigner = useCallback(async (): Promise<ethers.Signer | null> => {
        // First attempt
        const signer = await getSignerOnce();
        if (signer) return signer;
        // Provider may not be ready yet (Privy async init) — retry after short delay
        await new Promise(r => setTimeout(r, 600));
        return getSignerOnce();
    }, [getSignerOnce]);

    // ── Context value ─────────────────────────────────────────────────────────
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
