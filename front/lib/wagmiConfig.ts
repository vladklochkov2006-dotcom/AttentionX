// Wagmi + RainbowKit config for Sepolia (CoFHE)
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { sepolia } from 'wagmi/chains';
import { http, fallback } from 'wagmi';

// WalletConnect projectId — get one free at https://cloud.walletconnect.com
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '0b0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';

export const wagmiConfig = getDefaultConfig({
    appName: 'AttentionX',
    projectId,
    chains: [sepolia],
    transports: {
        [sepolia.id]: fallback([
            http('https://ethereum-sepolia-rpc.publicnode.com'),
            http('https://rpc.sepolia.org'),
            http('https://sepolia.gateway.tenderly.co'),
            http('https://1rpc.io/sepolia'),
            http('https://eth-sepolia.public.blastapi.io'),
            http('https://rpc2.sepolia.org'),
        ]),
    },
});
