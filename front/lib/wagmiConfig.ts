// Wagmi + RainbowKit config for Sepolia (CoFHE)
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { sepolia } from 'wagmi/chains';
import { http, fallback } from 'wagmi';

export const wagmiConfig = getDefaultConfig({
    appName: 'AttentionX',
    projectId: 'attentionx', // placeholder — WalletConnect QR won't work without real ID
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
