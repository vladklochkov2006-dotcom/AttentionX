// Wallet context — RainbowKit + wagmi (auto-detects all wallets)
import React, { createContext, useContext, ReactNode, useEffect, useState, useCallback } from 'react';
import { BrowserProvider, ethers, Eip1193Provider } from 'ethers';
import { getReadProvider } from '../lib/contracts';
import { getActiveNetwork } from '../lib/networks';
import { useNetwork } from './NetworkContext';
import { useAccount, useDisconnect, useSwitchChain, useConnectorClient } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';

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
    const { address: wagmiAddress, isConnected: wagmiConnected, isConnecting: wagmiConnecting, chainId: wagmiChainId } = useAccount();
    const { disconnect: wagmiDisconnect } = useDisconnect();
    const { switchChainAsync } = useSwitchChain();
    const { openConnectModal } = useConnectModal();
    const { data: connectorClient } = useConnectorClient();

    // ── Local state ────────────────────────────────────────────────────────────
    const [walletProvider, setWalletProvider] = useState<Eip1193Provider | null>(null);
    const [balance, setBalance] = useState<bigint>(0n);
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ── Derived state ──────────────────────────────────────────────────────────
    const address: string | null = wagmiAddress ?? null;
    const isConnected = wagmiConnected;
    const isConnecting = wagmiConnecting;
    const chainId = wagmiChainId ?? null;
    const isCorrectChain = chainId === activeNetwork.chainId;

    // ── Sync EIP-1193 provider from wagmi connector ────────────────────────────
    useEffect(() => {
        if (connectorClient?.transport) {
            setWalletProvider(connectorClient.transport as unknown as Eip1193Provider);
        } else {
            setWalletProvider(null);
        }
    }, [connectorClient]);

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

    // ── Connect via RainbowKit modal ──────────────────────────────────────────
    const connect = useCallback(() => {
        setError(null);
        openConnectModal?.();
    }, [openConnectModal]);

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

    // ── signMessage ────────────────────────────────────────────────────────────
    const signMessage = useCallback(async (message: string): Promise<string | null> => {
        if (!walletProvider) return null;
        try {
            const signer = await new BrowserProvider(walletProvider as any).getSigner();
            return await signer.signMessage(message);
        } catch {
            return null;
        }
    }, [walletProvider]);

    // ── getSigner ──────────────────────────────────────────────────────────────
    const getSigner = useCallback(async (): Promise<ethers.Signer | null> => {
        if (!walletProvider) return null;
        try {
            return await new BrowserProvider(walletProvider as any).getSigner();
        } catch {
            return null;
        }
    }, [walletProvider]);

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
