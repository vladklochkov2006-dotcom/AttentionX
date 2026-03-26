// Wagmi config for Sepolia (CoFHE)
import { createConfig, http } from 'wagmi';
import { sepolia } from 'wagmi/chains';

export const wagmiConfig = createConfig({
    chains: [sepolia],
    transports: {
        [sepolia.id]: http('https://sepolia.infura.io/v3/36f488b5117446bcbc2fc26e4658405b'),
    },
});
