// Network registry — Ethereum Sepolia (Fhenix CoFHE)

export interface NetworkConfig {
    id: string;
    name: string;
    shortName: string;
    chainId: number;
    rpcUrl: string;
    explorerUrl: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    contracts: {
        AttentionX_NFT: string;
        PackNFT: string;
        PackOpener: string;
        TournamentManager: string;
        MarketplaceV2: string;
        TournamentManagerFHE?: string;
        DarkLeaderboard?: string;
        EncryptedCardStats?: string;
        SealedBidMarketplace?: string;
    };
    apiBase: string;
    metadataBase: string;   // prefix for metadata server routes
    packPrice: bigint;      // default pack price in wei (avoids RPC call on load)
    icon: string;
    deployed: boolean;
    isFhenix?: boolean;     // true for CoFHE-enabled networks (enables FHE features)
}

export const NETWORKS: Record<string, NetworkConfig> = {
    sepolia: {
        id: 'sepolia',
        name: 'Ethereum Sepolia (CoFHE)',
        shortName: 'Sepolia',
        chainId: 11155111,
        rpcUrl: 'https://sepolia.infura.io/v3/36f488b5117446bcbc2fc26e4658405b',
        explorerUrl: 'https://sepolia.etherscan.io',
        nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
        contracts: {
            AttentionX_NFT: '0x409384AF735AAe5AD58cE4dc70c9309E9f3E72aF',
            PackNFT: '0xe8BBC11b3CEFdC64D79af217f79497B7EAf34fa5',
            PackOpener: '0xB6F73D5172425B734E020073A80A44d8B22FfA39',
            TournamentManager: '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81',
            MarketplaceV2: '0x8C64e6380561496B278AC7Ab6f35AFf9aB88160C',
            TournamentManagerFHE: '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81',
            DarkLeaderboard: '0xf08e22e350026c670D86ef0A794064e9D301d5eE',
            EncryptedCardStats: '0x412bE266fA5e3f78Af950bb96860D839699d3822',
            SealedBidMarketplace: '0x1bA2BA3B00096924dDf2fE18b328387beafaBF5E',
        },
        apiBase: '/api',
        metadataBase: '/metadata',
        packPrice: BigInt('900000000000000'),
        icon: '',
        deployed: true,
        isFhenix: true,
    },
};

// Module-level active network state — default to Sepolia (CoFHE)
let _activeId: string = 'sepolia';

export function getActiveNetwork(): NetworkConfig {
    return NETWORKS[_activeId] || NETWORKS.sepolia;
}

export function setActiveNetwork(id: string) {
    if (!NETWORKS[id]) return;
    _activeId = id;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('attentionx:network', id);
    }
}

export function getActiveNetworkId(): string {
    return _activeId;
}

export function getAllNetworks(): NetworkConfig[] {
    return Object.values(NETWORKS);
}

/** Short currency symbol for the active network (e.g. "ETH") */
export function currencySymbol(): string {
    return getActiveNetwork().nativeCurrency.symbol;
}
