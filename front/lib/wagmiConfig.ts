// Wagmi config for Sepolia — injected wallets only
import { createConfig, http, fallback } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected, coinbaseWallet } from 'wagmi/connectors';

export const wagmiConfig = createConfig({
    chains: [sepolia],
    connectors: [
        injected(),
        coinbaseWallet({ appName: 'AttentionX' }),
    ],
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
