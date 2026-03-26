// Wagmi + RainbowKit config for Sepolia (CoFHE)
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { sepolia } from 'wagmi/chains';

// WalletConnect projectId — get one free at https://cloud.walletconnect.com
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '0b0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';

export const wagmiConfig = getDefaultConfig({
    appName: 'AttentionX',
    projectId,
    chains: [sepolia],
});
