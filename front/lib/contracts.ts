// Contract addresses and ABIs for AttentionX
import { ethers } from 'ethers';
import { getActiveNetwork } from './networks';
import { TOURNAMENT_FHE_ABI, DARK_LEADERBOARD_ABI } from '../hooks/useTournamentFHE';

declare global { interface Window { ethereum?: ethers.Eip1193Provider } }

// ============ Dynamic Network Configuration ============
// These functions read from the active network (set by ChainToggle)
export function getChainConfig() {
    const net = getActiveNetwork();
    return {
        chainId: net.chainId,
        chainName: net.name,
        rpcUrl: net.rpcUrl,
        explorerUrl: net.explorerUrl,
        nativeCurrency: net.nativeCurrency,
    };
}

export function getActiveContracts() {
    return getActiveNetwork().contracts;
}

// ============ Legacy static defaults — use getActiveNetwork() / getChainConfig() instead ============
// These are evaluated once at module load and do NOT update on network switch.
// Kept only for backward compatibility; prefer the dynamic helpers above.
/** @deprecated Use getActiveNetwork().chainId */
export const CHAIN_ID = 11155111;
/** @deprecated Use getActiveNetwork().name */
export const CHAIN_NAME = 'Ethereum Sepolia (CoFHE)';
/** @deprecated Use getActiveNetwork().rpcUrl */
export const RPC_URL = 'https://sepolia.infura.io/v3/36f488b5117446bcbc2fc26e4658405b';
/** @deprecated Use getActiveNetwork().explorerUrl */
export const EXPLORER_URL = 'https://sepolia.etherscan.io';
/** @deprecated Use getActiveNetwork().metadataBase */
export const METADATA_API = '/metadata';

/** @deprecated Use getActiveContracts() instead — this does NOT update on network switch */
export const CONTRACTS = {
    AttentionX_NFT: '0x409384AF735AAe5AD58cE4dc70c9309E9f3E72aF',
    PackNFT: '0xe8BBC11b3CEFdC64D79af217f79497B7EAf34fa5',
    PackOpener: '0xB6F73D5172425B734E020073A80a44d8B22FfA39',
    TournamentManager: '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81',
    MarketplaceV2: '0x8C64e6380561496B278AC7Ab6f35AFf9aB88160C',
} as const;

// ============ ABIs (minimal for frontend) ============
export const NFT_ABI = [
    // Read functions
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function balanceOf(address owner) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function tokenToStartup(uint256 tokenId) view returns (uint256)',
    'function tokenToEdition(uint256 tokenId) view returns (uint256)',
    'function isLocked(uint256 tokenId) view returns (bool)',
    'function startupMintCount(uint256 startupId) view returns (uint256)',
    'function getCardInfo(uint256 tokenId) view returns (tuple(uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool isLocked, string name))',
    'function getOwnedTokens(address owner) view returns (uint256[])',
    'function startups(uint256 id) view returns (tuple(string name, uint8 rarity, uint256 multiplier))',
    // Write functions
    'function mergeCards(uint256[3] tokenIds) returns (uint256)',
    'function approve(address to, uint256 tokenId)',
    'function setApprovalForAll(address operator, bool approved)',
    // Events
    'event CardMinted(address indexed to, uint256 indexed tokenId, uint256 indexed startupId, uint256 edition)',
    'event CardsMerged(address indexed owner, uint256[3] burnedTokenIds, uint256 indexed newTokenId, uint8 fromRarity, uint8 toRarity)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export const PACK_NFT_ABI = [
    // Read functions
    'function balanceOf(address owner) view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function totalSupply() view returns (uint256)',
    'function maxSupply() view returns (uint256)',
    'function getOwnedTokens(address owner) view returns (uint256[])',
    'function tokenURI(uint256 tokenId) view returns (string)',
    // Write functions
    'function approve(address to, uint256 tokenId)',
    'function setApprovalForAll(address operator, bool approved)',
    // Events
    'event PackMinted(address indexed to, uint256 indexed tokenId)',
    'event PackBurned(address indexed from, uint256 indexed tokenId)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export const PACK_OPENER_ABI = [
    // Read functions
    'function currentPackPrice() view returns (uint256)',
    'function packsSold() view returns (uint256)',
    'function MAX_PACKS() view returns (uint256)',
    'function MAX_MULTI_PACKS() view returns (uint256)',
    'function getPacksRemaining() view returns (uint256)',
    'function activeTournamentId() view returns (uint256)',
    'function pendingPrizePool() view returns (uint256)',
    'function getReferrer(address user) view returns (address)',
    'function getReferralStats(address referrer) view returns (uint256 count, uint256 totalEarned)',
    'function referralEarnings(address referrer) view returns (uint256)',
    'function referralCount(address referrer) view returns (uint256)',
    'function uniqueBuyerCount() view returns (uint256)',
    // Write functions — two-step: buy pack NFT, then open it
    'function buyPack(address referrer) payable returns (uint256)',
    'function buyMultiplePacks(address referrer, uint256 count) payable returns (uint256[])',
    'function openPack(uint256 packTokenId) returns (uint256[5], uint256[5])',
    'function batchOpenPacks(uint256[] packTokenIds) returns (uint256[], uint256[])',
    // Admin functions
    'function withdraw()',
    'function setPackPrice(uint256 newPrice)',
    'function setActiveTournament(uint256 tournamentId)',
    'function forwardPendingFunds()',
    'function pause()',
    'function unpause()',
    // Errors (for decoding reverts)
    'error InsufficientPayment()',
    'error MaxPacksReached()',
    'error NotPackOwner()',
    'error ZeroAddress()',
    'error WithdrawFailed()',
    'error InvalidPrice()',
    'error InvalidPackCount()',
    'error PackNftNotSet()',
    'error BatchTooLarge()',
    // Events
    'event PackPurchased(address indexed buyer, uint256 indexed packTokenId, uint256 price, uint256 timestamp)',
    'event PackOpened(address indexed owner, uint256 indexed packTokenId, uint256[5] cardIds, uint256[5] startupIds)',
    'event ReferralRegistered(address indexed user, address indexed referrer)',
    'event ReferralRewardPaid(address indexed referrer, address indexed buyer, uint256 amount)',
    'event MultiplePacksPurchased(address indexed buyer, uint256 packCount, uint256[] packTokenIds)',
    'event BatchPacksOpened(address indexed owner, uint256[] packTokenIds, uint256[] allCardIds)',
    'event FundsDistributed(uint256 prizePoolAmount, uint256 platformAmount, uint256 referralAmount)',
];

export const TOURNAMENT_ABI = [
    // Read functions
    'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    'function getUserLineup(uint256 tournamentId, address user) view returns (tuple(uint256[5] cardIds, address owner, uint256 timestamp, bool cancelled, bool claimed))',
    'function getTournamentParticipants(uint256 tournamentId) view returns (address[])',
    'function canRegister(uint256 tournamentId) view returns (bool)',
    'function canCancelEntry(uint256 tournamentId, address user) view returns (bool)',
    'function hasEntered(uint256 tournamentId, address user) view returns (bool)',
    'function getTournamentPhase(uint256 tournamentId) view returns (string)',
    'function getActiveEntryCount(uint256 tournamentId) view returns (uint256)',
    'function nextTournamentId() view returns (uint256)',
    'function getUserScoreInfo(uint256 tournamentId, address user) view returns (uint256 score, uint256 prize, uint256 totalScore)',
    'function getTournamentPoints(uint256 tournamentId) view returns (uint256[19])',
    'function totalTournamentScore(uint256 tournamentId) view returns (uint256)',
    'function userScores(uint256 tournamentId, address user) view returns (uint256)',
    'function getUserTournamentHistory(address user) view returns (tuple(uint256 tournamentId, uint256 startTime, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status, uint256 userScore, uint256 userPrize, bool claimed)[])',
    'function getAllTournamentsSummary() view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status)[])',
    // Write functions
    'function enterTournament(uint256 tournamentId, uint256[5] cardIds)',
    'function cancelEntry(uint256 tournamentId)',
    'function claimPrize(uint256 tournamentId)',
    // Admin functions
    'function createTournament(uint256 registrationStart, uint256 startTime, uint256 endTime) returns (uint256)',
    'function finalizeTournament(uint256 tournamentId, address[] winners, uint256[] amounts)',
    'function finalizeWithPoints(uint256 tournamentId, uint256[19] points)',
    'function cancelTournament(uint256 tournamentId)',
    'function withdrawFromPrizePool(uint256 tournamentId, uint256 amount, address to)',
    'function emergencyWithdraw(uint256 amount, address to)',
    'function pause()',
    'function unpause()',
    // Events
    'event TournamentCreated(uint256 indexed tournamentId, uint256 registrationStart, uint256 startTime, uint256 endTime)',
    'event LineupRegistered(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds)',
    'event LineupCancelled(uint256 indexed tournamentId, address indexed user)',
];

// Old MARKETPLACE_ABI removed - using MarketplaceV2 exclusively

export const MARKETPLACE_V2_ABI = [
    // ===== Listings =====
    'function listCard(uint256 tokenId, uint256 price) returns (uint256)',
    'function listPack(uint256 tokenId, uint256 price) returns (uint256)',
    'function buyCard(uint256 listingId) payable',
    'function cancelListing(uint256 listingId)',
    'function getActiveListings() view returns (tuple(uint256 listingId, address seller, uint256 tokenId, uint256 price, uint256 listedAt, bool active, address nftAddr)[])',
    'function getListing(uint256 listingId) view returns (tuple(uint256 listingId, address seller, uint256 tokenId, uint256 price, uint256 listedAt, bool active, address nftAddr))',
    'function getListingsBySeller(address seller) view returns (tuple(uint256 listingId, address seller, uint256 tokenId, uint256 price, uint256 listedAt, bool active, address nftAddr)[])',
    'function getActiveListingCount() view returns (uint256)',
    'function isTokenListed(uint256 tokenId) view returns (bool)',
    'function isPackListed(uint256 tokenId) view returns (bool)',

    // ===== Bids =====
    'function placeBid(uint256 tokenId, uint256 expiration) payable returns (uint256)',
    'function placeBidOnPack(uint256 tokenId, uint256 expiration) payable returns (uint256)',
    'function cancelBid(uint256 bidId)',
    'function acceptBid(uint256 bidId)',
    'function getActiveBidsForToken(uint256 tokenId) view returns (tuple(uint256 bidId, address bidder, uint256 tokenId, uint256 amount, uint256 expiration, bool active, address nftAddr)[])',
    'function getBidsOnToken(uint256 tokenId) view returns (tuple(uint256 bidId, address bidder, uint256 tokenId, uint256 amount, uint256 expiration, bool active, address nftAddr)[])',
    'function getBidsOnPack(uint256 tokenId) view returns (tuple(uint256 bidId, address bidder, uint256 tokenId, uint256 amount, uint256 expiration, bool active, address nftAddr)[])',
    'function getUserBids(address user) view returns (tuple(uint256 bidId, address bidder, uint256 tokenId, uint256 amount, uint256 expiration, bool active, address nftAddr)[])',

    // ===== Auctions =====
    'function createAuction(uint256 tokenId, uint256 startPrice, uint256 reservePrice, uint256 duration) returns (uint256)',
    'function createPackAuction(uint256 tokenId, uint256 startPrice, uint256 reservePrice, uint256 duration) returns (uint256)',
    'function bidOnAuction(uint256 auctionId) payable',
    'function finalizeAuction(uint256 auctionId)',
    'function cancelAuction(uint256 auctionId)',
    'function getActiveAuctions() view returns (tuple(uint256 auctionId, address seller, uint256 tokenId, uint256 startPrice, uint256 reservePrice, uint256 highestBid, address highestBidder, uint256 startTime, uint256 endTime, uint8 status, address nftAddr)[])',
    'function getAuction(uint256 auctionId) view returns (tuple(uint256 auctionId, address seller, uint256 tokenId, uint256 startPrice, uint256 reservePrice, uint256 highestBid, address highestBidder, uint256 startTime, uint256 endTime, uint8 status, address nftAddr))',
    'function getActiveAuctionCount() view returns (uint256)',

    // ===== History & Stats =====
    'function getTokenSaleHistory(uint256 tokenId) view returns (tuple(uint256 saleId, uint256 tokenId, address seller, address buyer, uint256 price, uint256 timestamp, uint8 saleType)[])',
    'function getUserSaleHistory(address user) view returns (tuple(uint256 saleId, uint256 tokenId, address seller, address buyer, uint256 price, uint256 timestamp, uint8 saleType)[])',
    'function getTokenStats(uint256 tokenId) view returns (tuple(uint256 lastSalePrice, uint256 totalVolume, uint256 salesCount, uint256 highestSale, uint256 lowestSale))',
    'function getGlobalStats() view returns (uint256 _totalVolume, uint256 _totalSales, uint256 _activeListings, uint256 _activeAuctions)',

    // Events
    'event CardListed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId, uint256 price)',
    'event CardSold(uint256 indexed listingId, address indexed seller, address indexed buyer, uint256 tokenId, uint256 price)',
    'event ListingCancelled(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId)',
    'event BidPlaced(uint256 indexed bidId, address indexed bidder, uint256 indexed tokenId, uint256 amount)',
    'event BidCancelled(uint256 indexed bidId, address indexed bidder, uint256 indexed tokenId)',
    'event BidAccepted(uint256 indexed bidId, address indexed seller, address indexed bidder, uint256 tokenId, uint256 amount)',
    'event AuctionCreated(uint256 indexed auctionId, address indexed seller, uint256 indexed tokenId, uint256 startPrice, uint256 reservePrice, uint256 endTime)',
    'event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount)',
    'event AuctionFinalized(uint256 indexed auctionId, address indexed winner, uint256 finalPrice)',
    'event AuctionCancelled(uint256 indexed auctionId, address indexed seller, uint256 indexed tokenId)',
];

// ============ Startup Data (matches contract) ============
export const STARTUPS: Record<number, { name: string; rarity: string; multiplier: number }> = {
    // Legendary (10x multiplier) - IDs 1-5
    1: { name: 'Openclaw', rarity: 'Legendary', multiplier: 10 },
    2: { name: 'Lovable', rarity: 'Legendary', multiplier: 10 },
    3: { name: 'Cursor', rarity: 'Legendary', multiplier: 10 },
    4: { name: 'OpenAI', rarity: 'Legendary', multiplier: 10 },
    5: { name: 'Anthropic', rarity: 'Legendary', multiplier: 10 },

    // Epic (5x multiplier) - IDs 6-8
    6: { name: 'Browser Use', rarity: 'Epic', multiplier: 5 },
    7: { name: 'Dedalus Labs', rarity: 'Epic', multiplier: 5 },
    8: { name: 'Autumn', rarity: 'Epic', multiplier: 5 },

    // Rare (3x multiplier) - IDs 9-13
    9: { name: 'Axiom', rarity: 'Rare', multiplier: 3 },
    10: { name: 'Multifactor', rarity: 'Rare', multiplier: 3 },
    11: { name: 'Dome', rarity: 'Rare', multiplier: 3 },
    12: { name: 'GrazeMate', rarity: 'Rare', multiplier: 3 },
    13: { name: 'Tornyol Systems', rarity: 'Rare', multiplier: 3 },

    // Common (1x multiplier) - IDs 14-19
    14: { name: 'Pocket', rarity: 'Common', multiplier: 1 },
    15: { name: 'Caretta', rarity: 'Common', multiplier: 1 },
    16: { name: 'AxionOrbital Space', rarity: 'Common', multiplier: 1 },
    17: { name: 'Freeport Markets', rarity: 'Common', multiplier: 1 },
    18: { name: 'Ruvo', rarity: 'Common', multiplier: 1 },
    19: { name: 'Lightberry', rarity: 'Common', multiplier: 1 },
};

// ============ Provider ============
export function getProvider() {
    if (typeof window !== 'undefined' && window.ethereum) {
        return new ethers.BrowserProvider(window.ethereum);
    }
    return new ethers.JsonRpcProvider(getActiveNetwork().rpcUrl);
}

// Read-only provider that always uses the active network's RPC (no wallet)
// Singleton cache: one provider per RPC URL to avoid 429 rate limits
const _providerCache = new Map<string, ethers.JsonRpcProvider>();
export function getReadProvider() {
    const url = getActiveNetwork().rpcUrl;
    let provider = _providerCache.get(url);
    if (!provider) {
        provider = new ethers.JsonRpcProvider(url);
        _providerCache.set(url, provider);
    }
    return provider;
}

// ============ Contract Instances ============
// Default to getReadProvider() (JSON-RPC) for reads — works without wallet.
// Pass a signer explicitly for write operations.
export function getNFTContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    return new ethers.Contract(getActiveContracts().AttentionX_NFT, NFT_ABI, provider);
}

export function getPackNFTContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    return new ethers.Contract(getActiveContracts().PackNFT, PACK_NFT_ABI, provider);
}

export function getPackOpenerContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    return new ethers.Contract(getActiveContracts().PackOpener, PACK_OPENER_ABI, provider);
}

export function getTournamentContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    return new ethers.Contract(getActiveContracts().TournamentManager, TOURNAMENT_ABI, provider);
}

export function getMarketplaceV2Contract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    return new ethers.Contract(getActiveContracts().MarketplaceV2, MARKETPLACE_V2_ABI, provider);
}

// ============ FHE Contract Instances (Fhenix only) ============

export function getTournamentFHEContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    const addr = getActiveNetwork().contracts.TournamentManagerFHE;
    if (!addr) throw new Error('TournamentManagerFHE not deployed on active network');
    return new ethers.Contract(addr, TOURNAMENT_FHE_ABI, provider);
}

export function getDarkLeaderboardContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    const addr = getActiveNetwork().contracts.DarkLeaderboard;
    if (!addr) throw new Error('DarkLeaderboard not deployed on active network');
    return new ethers.Contract(addr, DARK_LEADERBOARD_ABI, provider);
}

// ============ SealedBidMarketplace ============

export const SEALED_BID_MARKETPLACE_ABI = [
    "function listSealed(uint256 tokenId, (bytes32 ctHash, bytes signature) encMinPrice) returns (uint256)",
    "function placeSealedBid(uint256 listingId, (bytes32 ctHash, bytes signature) encBid) payable returns (uint256)",
    "function acceptSealedBid(uint256 bidId)",
    "function cancelSealedListing(uint256 listingId)",
    "function cancelSealedBid(uint256 bidId)",
    "function getListing(uint256 listingId) view returns (address seller, uint256 tokenId, bool active, uint256 createdAt)",
    "function getBid(uint256 bidId) view returns (address bidder, uint256 listingId, uint256 deposit, bool active)",
    "function getBidsForListing(uint256 listingId) view returns (uint256[])",
    "function getListingCount() view returns (uint256)",
    "event SealedListed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId)",
    "event SealedBidPlaced(uint256 indexed bidId, uint256 indexed listingId, address indexed bidder)",
    "event SealedBidAccepted(uint256 indexed bidId, uint256 indexed listingId, address indexed buyer)",
    "event SealedListingCancelled(uint256 indexed listingId)",
    "event SealedBidCancelled(uint256 indexed bidId)",
];

export function getSealedBidMarketplaceContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const provider = signerOrProvider || getReadProvider();
    const addr = (getActiveNetwork().contracts as any).SealedBidMarketplace;
    if (!addr) throw new Error('SealedBidMarketplace not deployed on active network');
    return new ethers.Contract(addr, SEALED_BID_MARKETPLACE_ABI, provider);
}

// ============ Utils ============
export function formatXTZ(wei: bigint): string {
    return ethers.formatEther(wei);
}

export function parseXTZ(xtz: string): bigint {
    return ethers.parseEther(xtz);
}
