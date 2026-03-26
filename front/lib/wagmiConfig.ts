// Wagmi + RainbowKit config for Sepolia (CoFHE)
import { connectorsForWallets } from '@rainbow-me/rainbowkit';
import { injectedWallet, metaMaskWallet, coinbaseWallet, rabbyWallet } from '@rainbow-me/rainbowkit/wallets';
import { createConfig, http, fallback } from 'wagmi';
import { sepolia } from 'wagmi/chains';

// Connectors without WalletConnect (no projectId needed)
const connectors = connectorsForWallets(
    [
        {
            groupName: 'Popular',
            wallets: [injectedWallet, metaMaskWallet, coinbaseWallet, rabbyWallet],
        },
    ],
    {
        appName: 'AttentionX',
        projectId: 'none', // not used since we don't include walletConnectWallet
    }
);

export const wagmiConfig = createConfig({
    connectors,
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
