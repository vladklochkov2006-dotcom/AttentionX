import React, { useState, useEffect, useCallback } from 'react';
import { Search, ShoppingCart, Loader2, Gavel, Clock, Tag, X, User, Activity, DollarSign, History, Plus, Package, CheckCircle, Shield, Lock, Eye, EyeOff } from 'lucide-react';
const ModelViewer3D = React.lazy(() => import('./ModelViewer3D'));
import { useMarketplaceV2, Listing, Auction, Bid, Sale } from '../hooks/useMarketplaceV2';
import { useNFT } from '../hooks/useNFT';
import { getSealedListings, getBidsForListing, listSealed, placeSealedBid, acceptSealedBid, cancelSealedListing, cancelSealedBid, SealedListing, SealedBidInfo } from '../hooks/useSealedBidMarketplace';
import { isFhenixNetwork } from '../lib/fhenix';
import { ethers } from 'ethers';
import { usePacks } from '../hooks/usePacks';
import { useWalletContext } from '../context/WalletContext';
import { usePollingData } from '../hooks/usePollingData';
import { formatXTZ } from '../lib/contracts';
import { currencySymbol } from '../lib/networks';
import { useNetwork } from '../context/NetworkContext';
import { blockchainCache, CacheKeys } from '../lib/cache';
import { CardData, Rarity, sortByRarity } from '../types';
import { useOnboarding } from '../hooks/useOnboarding';
import OnboardingGuide, { OnboardingStep } from './OnboardingGuide';

// Rarity colors
const RARITY_COLORS: Record<string, string> = {
    'Common': 'bg-gray-800 text-gray-300 border-white/20',
    'Rare': 'bg-green-600 text-white border-green-500',
    'Epic': 'bg-violet-600 text-white border-violet-500',
    'EpicRare': 'bg-cyan-600 text-white border-cyan-500',
    'Legendary': 'bg-cyan-500 text-white border-cyan-400',
};

// Safe formatting helpers
function safeFormatXTZ(amount: any): string {
    try {
        const formatted = formatXTZ(BigInt(amount));
        const num = parseFloat(formatted);
        if (isNaN(num) || num > 1_000_000) return '???';
        return num % 1 === 0 ? num.toString() : num.toFixed(2);
    } catch { return '???'; }
}

function safeFormatDate(timestamp: any): string {
    try {
        const date = new Date(Number(timestamp) * 1000);
        if (isNaN(date.getTime())) return '—';
        return date.toLocaleDateString();
    } catch { return '—'; }
}

type MarketTab = 'listings' | 'auctions' | 'sealed' | 'activity';

interface ListingWithMeta extends Listing {
    cardName?: string;
    cardImage?: string;
    rarity?: string;
    multiplier?: number;
    priceFormatted?: string;
    isPack?: boolean;
}

interface AuctionWithMeta extends Auction {
    cardName?: string;
    cardImage?: string;
    rarity?: string;
    multiplier?: number;
    timeLeft?: string;
    isEnded?: boolean;
    isPack?: boolean;
}

// Pack visual component — renders the 3D pack model
const PackVisual: React.FC<{ tokenId: number | bigint; className?: string; style?: React.CSSProperties }> = ({ tokenId, className = '', style }) => (
    <div className={`relative bg-gradient-to-b from-yc-purple/5 to-gray-50 dark:from-yc-purple/[0.06] dark:to-[#0a0a0a] overflow-hidden ${className}`} style={style}>
        <ModelViewer3D mode="static" cameraZ={3} modelScale={0.8} />
        <div className="absolute bottom-2 left-0 right-0 flex flex-col items-center pointer-events-none">
            <span className="text-gray-700 dark:text-white/50 text-[10px] font-mono bg-white/60 dark:bg-black/40 px-2 py-0.5 rounded">#{String(tokenId)}</span>
        </div>
    </div>
);

// Helper to format time remaining
function formatTimeLeft(endTime: bigint): { text: string; isEnded: boolean } {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (endTime <= now) return { text: 'Ended', isEnded: true };

    const diff = Number(endTime - now);
    const hours = Math.floor(diff / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        return { text: `${days}d ${hours % 24}h`, isEnded: false };
    }
    return { text: `${hours}h ${minutes}m ${seconds}s`, isEnded: false };
}

const MARKETPLACE_GUIDE: OnboardingStep[] = [
    {
        title: 'NFT Marketplace',
        description: 'Buy cards from other players or list yours for sale. Place bids through auctions to get the best deals and strengthen your deck.',
        icon: '\uD83D\uDECD\uFE0F',
    },
    {
        title: 'Auctions & Bidding',
        description: 'Place bids on cards you want. If you\'re the highest bidder when the timer runs out, the card is yours. Outbid others to secure rare cards.',
        icon: '\uD83D\uDD28',
    },
];

const Marketplace: React.FC = () => {
    const {
        getActiveListings,
        buyCard,
        getActiveAuctions,
        bidOnAuction,
        finalizeAuction,
        placeBid,
        acceptBid,
        getBidsForToken,
        getUserListings,
        getMyBids,
        cancelBid,
        listCard,
        listPack,
        createAuction,
        createPackAuction,
        cancelListing,
        cancelAuction,
        getTokenStats,
        getTokenSaleHistory,
        getUserSoldItems,
        loading: isLoading,
        error
    } = useMarketplaceV2();
    const { getCardInfo, getCards, clearCache } = useNFT();
    const { getUserPacks } = usePacks();
    const { address, isConnected, getSigner, walletProvider } = useWalletContext();
    const { networkId } = useNetwork();
    const { isVisible: showGuide, currentStep: guideStep, nextStep: guideNext, dismiss: guideDismiss } = useOnboarding('marketplace');

    // State
    const [activeTab, setActiveTab] = useState<MarketTab>('listings');
    type TypeFilter = 'all' | 'cards' | 'packs';
    const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
    const [listings, setListings] = useState<ListingWithMeta[]>([]);
    const [auctions, setAuctions] = useState<AuctionWithMeta[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'price_asc' | 'price_desc' | 'recent'>('recent');
    const [rarityFilter, setRarityFilter] = useState<string>('All');
    const [buyingId, setBuyingId] = useState<number | null>(null);
    const [biddingId, setBiddingId] = useState<number | null>(null);
    const [cancellingId, setCancellingId] = useState<number | null>(null);
    const [loadingListings, setLoadingListings] = useState(true);
    const [loadingAuctions, setLoadingAuctions] = useState(true);

    // Modal state
    const [bidModal, setBidModal] = useState<{ auction?: AuctionWithMeta; listing?: ListingWithMeta } | null>(null);
    const [bidAmount, setBidAmount] = useState('');

    // Stats Modal state
    const [statsModalOpen, setStatsModalOpen] = useState(false);
    const [statsItem, setStatsItem] = useState<ListingWithMeta | AuctionWithMeta | null>(null);
    const [statsTab, setStatsTab] = useState<'bids' | 'sales' | 'stats'>('bids');
    const [cardBids, setCardBids] = useState<any[]>([]);
    const [cardSales, setCardSales] = useState<any[]>([]);
    const [cardStats, setCardStats] = useState<any | null>(null);
    const [loadingStats, setLoadingStats] = useState(false);

    // List/Sell Modal state
    const [listModalOpen, setListModalOpen] = useState(false);
    const [myNFTs, setMyNFTs] = useState<CardData[]>([]);
    const [myPackTokenIds, setMyPackTokenIds] = useState<number[]>([]);
    const [selectedNFT, setSelectedNFT] = useState<CardData | null>(null);
    const [selectedPackId, setSelectedPackId] = useState<number | null>(null);
    const [sellMode, setSellMode] = useState<'fixed' | 'auction'>('fixed');
    const [sellPrice, setSellPrice] = useState('');
    const [auctionStartPrice, setAuctionStartPrice] = useState('');
    const [auctionReservePrice, setAuctionReservePrice] = useState('');
    const [auctionDuration, setAuctionDuration] = useState('1');
    const [isSelling, setIsSelling] = useState(false);
    const [loadingNFTs, setLoadingNFTs] = useState(false);

    // Activity tab state
    type ActivityFilter = 'all' | 'listings' | 'auctions' | 'bids' | 'sold';
    const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
    const [myListings, setMyListings] = useState<ListingWithMeta[]>([]);
    const [myAuctions, setMyAuctions] = useState<AuctionWithMeta[]>([]);
    const [myBids, setMyBids] = useState<(Bid & { cardName?: string; cardImage?: string; rarity?: string })[]>([]);
    const [mySales, setMySales] = useState<(Sale & { cardName?: string; cardImage?: string; rarity?: string })[]>([]);
    const [loadingActivity, setLoadingActivity] = useState(false);
    const [cancellingBidId, setCancellingBidId] = useState<number | null>(null);

    // Sealed bid state
    const [sealedListings, setSealedListings] = useState<(SealedListing & { cardName?: string; cardImage?: string; rarity?: string })[]>([]);
    const [loadingSealed, setLoadingSealed] = useState(false);
    const [sealedBidsMap, setSealedBidsMap] = useState<Record<number, SealedBidInfo[]>>({});
    const [expandedSealedListing, setExpandedSealedListing] = useState<number | null>(null);
    const [sealedBidAmount, setSealedBidAmount] = useState('');
    const [sealedBidDeposit, setSealedBidDeposit] = useState('');
    const [sealedMinPrice, setSealedMinPrice] = useState('');
    const [sealedActionLoading, setSealedActionLoading] = useState<string | null>(null); // 'list-{id}' | 'bid-{id}' | 'accept-{id}' | 'cancel-listing-{id}' | 'cancel-bid-{id}'
    const [sealedListModal, setSealedListModal] = useState(false);
    const [sealedSelectedNFT, setSealedSelectedNFT] = useState<CardData | null>(null);
    const [sealedMyNFTs, setSealedMyNFTs] = useState<CardData[]>([]);
    const [loadingSealedNFTs, setLoadingSealedNFTs] = useState(false);

    const rarityTabs = ['All', 'Common', 'Rare', 'Epic', 'Legendary'];

    // Fetcher functions for polling
    const fetchListings = useCallback(async (): Promise<ListingWithMeta[]> => {
        try {
            const rawListings = await getActiveListings();
            const listingsWithMetadata = await Promise.all(
                rawListings.map(async (listing) => {
                    // Pack listings: use fixed metadata
                    if (listing.isPack) {
                        return {
                            ...listing,
                            cardName: `Pack #${listing.tokenId}`,
                            cardImage: undefined,
                            rarity: undefined,
                            multiplier: undefined,
                            priceFormatted: formatXTZ(listing.price),
                            isPack: true,
                        };
                    }
                    try {
                        const cardInfo = await getCardInfo(Number(listing.tokenId));
                        return {
                            ...listing,
                            cardName: cardInfo?.name || `Card #${listing.tokenId}`,
                            cardImage: cardInfo?.image || '/placeholder-card.png',
                            rarity: cardInfo?.rarity || 'Common',
                            multiplier: cardInfo?.multiplier || 1,
                            priceFormatted: formatXTZ(listing.price),
                        };
                    } catch {
                        return {
                            ...listing,
                            cardName: `Card #${listing.tokenId}`,
                            cardImage: '/placeholder-card.png',
                            rarity: 'Common',
                            multiplier: 1,
                            priceFormatted: formatXTZ(listing.price),
                        };
                    }
                })
            );
            return listingsWithMetadata;
        } catch (e) {
            return [];
        }
    }, [getActiveListings, getCardInfo]);

    const fetchAuctions = useCallback(async (): Promise<AuctionWithMeta[]> => {
        try {
            const rawAuctions = await getActiveAuctions();
            const auctionsWithMetadata = await Promise.all(
                rawAuctions.map(async (auction) => {
                    // Pack auctions: use fixed metadata
                    if (auction.isPack) {
                        const { text, isEnded } = formatTimeLeft(auction.endTime);
                        return {
                            ...auction,
                            cardName: `Pack #${auction.tokenId}`,
                            cardImage: undefined,
                            rarity: undefined,
                            multiplier: undefined,
                            timeLeft: text,
                            isEnded,
                            isPack: true,
                        };
                    }
                    try {
                        const cardInfo = await getCardInfo(Number(auction.tokenId));
                        const { text, isEnded } = formatTimeLeft(auction.endTime);
                        return {
                            ...auction,
                            cardName: cardInfo?.name || `Card #${auction.tokenId}`,
                            cardImage: cardInfo?.image || '/placeholder-card.png',
                            rarity: cardInfo?.rarity || 'Common',
                            multiplier: cardInfo?.multiplier || 1,
                            timeLeft: text,
                            isEnded,
                        };
                    } catch {
                        const { text, isEnded } = formatTimeLeft(auction.endTime);
                        return {
                            ...auction,
                            cardName: `Card #${auction.tokenId}`,
                            cardImage: '/placeholder-card.png',
                            rarity: 'Common',
                            multiplier: 1,
                            timeLeft: text,
                            isEnded,
                        };
                    }
                })
            );
            return auctionsWithMetadata;
        } catch (e) {
            return [];
        }
    }, [getActiveAuctions, getCardInfo]);

    // Auto-refresh listings with polling
    const {
        data: polledListings,
        isLoading: pollingListingsLoading,
        refresh: refreshListings
    } = usePollingData<ListingWithMeta[]>(fetchListings, {
        cacheKey: `marketplace:active-listings:${networkId}`,
        interval: 30000,
        enabled: true
    });

    // Auto-refresh auctions with polling
    const {
        data: polledAuctions,
        isLoading: pollingAuctionsLoading,
        refresh: refreshAuctions
    } = usePollingData<AuctionWithMeta[]>(fetchAuctions, {
        cacheKey: `marketplace:active-auctions:${networkId}`,
        interval: 30000,
        enabled: true
    });

    // Clear stale data on network switch
    useEffect(() => {
        setListings([]);
        setAuctions([]);
        setMyListings([]);
        setMyAuctions([]);
        setMyBids([]);
        setSealedListings([]);
        setSealedBidsMap({});
        setLoadingListings(true);
        setLoadingAuctions(true);
    }, [networkId]);

    // Update listings/auctions when polled data changes
    useEffect(() => {
        if (polledListings) {
            setListings(polledListings);
            setLoadingListings(false);
        }
    }, [polledListings]);

    useEffect(() => {
        if (polledAuctions) {
            setAuctions(polledAuctions);
            setLoadingAuctions(false);
        }
    }, [polledAuctions]);

    // Update auction timers every second
    useEffect(() => {
        if (activeTab !== 'auctions') return;
        const interval = setInterval(() => {
            setAuctions(prev => prev.map(a => {
                const { text, isEnded } = formatTimeLeft(a.endTime);
                return { ...a, timeLeft: text, isEnded };
            }));
        }, 1000);
        return () => clearInterval(interval);
    }, [activeTab]);

    // Refresh both listings and auctions with a delayed re-fetch for RPC lag.
    const refreshAfterAction = useCallback(async () => {
        // Invalidate cache so refresh fetches fresh data from blockchain
        blockchainCache.invalidate(CacheKeys.activeListings());
        blockchainCache.invalidate(CacheKeys.activeAuctions());
        if (address) blockchainCache.invalidate(CacheKeys.userListings(address));
        await Promise.all([refreshListings(), refreshAuctions()]);
        // Second fetch after 3s handles RPC node indexing lag
        setTimeout(() => {
            blockchainCache.invalidate(CacheKeys.activeListings());
            blockchainCache.invalidate(CacheKeys.activeAuctions());
            refreshListings();
            refreshAuctions();
        }, 3000);
    }, [refreshListings, refreshAuctions, address]);

    // Handle buy listing
    const handleBuy = async (listing: ListingWithMeta) => {
        if (!isConnected) {
            alert('Please connect your wallet first');
            return;
        }
        if (listing.seller.toLowerCase() === address?.toLowerCase()) {
            alert("You can't buy your own listing");
            return;
        }

        setBuyingId(Number(listing.listingId));
        try {
            await buyCard(listing.listingId, listing.price);
            await refreshAfterAction();
            // Force refresh NFT cache so Portfolio shows new card
            if (address) {
                clearCache();
                getCards(address, true);
            }
            alert('Purchase successful! The card is now in your portfolio.');
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setBuyingId(null);
    };

    // Handle listing bid (for offers on Buy Now listings)
    const handleListingBid = async () => {
        if (!bidModal?.listing || !bidAmount) return;

        setBiddingId(Number(bidModal.listing.listingId));
        try {
            await placeBid(bidModal.listing.tokenId, bidAmount);
            await refreshAfterAction();
            setBidModal(null);
            setBidAmount('');
            alert('Bid placed successfully!');
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setBiddingId(null);
    };

    // Handle accept bid
    const handleAcceptBid = async (bidId: bigint) => {
        setLoadingStats(true);
        try {
            await acceptBid(bidId);
            await refreshAfterAction();
            setStatsModalOpen(false);
            alert('Bid accepted successfully!');
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setLoadingStats(false);
    };

    // Handle cancel listing
    const handleCancelListing = async (listing: ListingWithMeta) => {
        setCancellingId(Number(listing.listingId));
        try {
            await cancelListing(listing.listingId);
            await refreshAfterAction();
            if (activeTab === 'activity') fetchActivity(true);
            alert('Listing cancelled successfully!');
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setCancellingId(null);
    };

    // Handle auction bid
    const handleAuctionBid = async () => {
        if (!bidModal?.auction || !bidAmount) return;

        setBiddingId(Number(bidModal.auction.auctionId));
        try {
            await bidOnAuction(bidModal.auction.auctionId, bidAmount);
            await refreshAfterAction();
            setBidModal(null);
            setBidAmount('');
            alert('Bid placed successfully!');
        } catch (e: any) {
            const msg = e.message || '';
            if (msg.includes('0xa0d26eb6') || msg.includes('BidTooLow')) {
                const hb = bidModal.auction.highestBid;
                const min = hb === 0n ? bidModal.auction.startPrice : hb + hb / 20n;
                alert(`Bid too low! Minimum: ${safeFormatXTZ(min)} ${currencySymbol()} (+5% above current bid)`);
            } else if (msg.includes('user rejected') || msg.includes('denied')) {
                // User cancelled — no alert needed
            } else {
                alert(`Error: ${msg}`);
            }
        }
        setBiddingId(null);
    };

    // Handle finalize auction
    const handleFinalizeAuction = async (auction: AuctionWithMeta) => {
        setBiddingId(Number(auction.auctionId));
        try {
            await finalizeAuction(auction.auctionId);
            await refreshAfterAction();
            alert('Auction finalized successfully!');
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setBiddingId(null);
    };

    // Handle cancel auction
    const handleCancelAuction = async (auction: AuctionWithMeta) => {
        if (!confirm('Cancel this auction? NFT will be returned to you.')) return;
        setCancellingId(Number(auction.auctionId));
        try {
            await cancelAuction(auction.auctionId);
            await refreshAfterAction();
            if (activeTab === 'activity') fetchActivity(true);
            alert('Auction cancelled!');
        } catch (e: any) {
            const msg = e.message || '';
            if (msg.includes('AuctionHasBids') || msg.includes('0x')) {
                alert('Cannot cancel — auction already has bids.');
            } else {
                alert(`Error: ${msg}`);
            }
        }
        setCancellingId(null);
    };

    // Open Stats modal
    const openStatsModal = async (item: ListingWithMeta | AuctionWithMeta) => {
        setStatsItem(item);
        setStatsModalOpen(true);
        setLoadingStats(true);
        setStatsTab('bids');
        setCardBids([]);
        setCardSales([]);
        setCardStats(null);

        try {
            const tokenId = BigInt(item.tokenId);
            const [bids, sales, stats] = await Promise.all([
                getBidsForToken(tokenId),
                getTokenSaleHistory(tokenId),
                getTokenStats(tokenId)
            ]);
            setCardBids(bids || []);
            setCardSales(sales || []);
            setCardStats(stats);
        } catch (e) {
        }
        setLoadingStats(false);
    };

    // Open List/Sell modal
    const openListModal = async () => {
        setListModalOpen(true);
        setLoadingNFTs(true);
        setSelectedNFT(null);
        setSelectedPackId(null);
        setSellPrice('');
        setAuctionStartPrice('');
        setAuctionReservePrice('');

        try {
            const [cards, packs] = await Promise.all([
                getCards(address || ''),
                getUserPacks(address || ''),
            ]);
            // Filter out cards that are already listed
            setMyNFTs(sortByRarity(cards.filter(c => !c.isLocked)));
            setMyPackTokenIds(packs);
        } catch (e) {
        }
        setLoadingNFTs(false);
    };

    // Handle listing NFT (card or pack)
    const handleListNFT = async () => {
        // Pack listing
        if (selectedPackId !== null) {
            setIsSelling(true);
            try {
                if (sellMode === 'fixed') {
                    if (!sellPrice || parseFloat(sellPrice) <= 0) {
                        alert('Please enter a valid price');
                        setIsSelling(false);
                        return;
                    }
                    await listPack(BigInt(selectedPackId), sellPrice);
                    alert('Pack listed successfully!');
                } else {
                    if (!auctionStartPrice || parseFloat(auctionStartPrice) <= 0) {
                        alert('Please enter a valid start price');
                        setIsSelling(false);
                        return;
                    }
                    const duration = parseInt(auctionDuration) || 1;
                    await createPackAuction(
                        BigInt(selectedPackId),
                        auctionStartPrice,
                        auctionReservePrice || auctionStartPrice,
                        duration
                    );
                    alert('Pack auction created successfully!');
                }
                setListModalOpen(false);
                await refreshAfterAction();
                if (activeTab === 'activity') fetchActivity(true);
            } catch (e: any) {
                alert(`Error: ${e.message}`);
            }
            setIsSelling(false);
            return;
        }

        // Card listing
        if (!selectedNFT) return;
        setIsSelling(true);

        try {
            if (sellMode === 'fixed') {
                if (!sellPrice || parseFloat(sellPrice) <= 0) {
                    alert('Please enter a valid price');
                    setIsSelling(false);
                    return;
                }
                await listCard(BigInt(selectedNFT.tokenId), sellPrice);
                alert('NFT listed successfully!');
            } else {
                if (!auctionStartPrice || parseFloat(auctionStartPrice) <= 0) {
                    alert('Please enter a valid start price');
                    setIsSelling(false);
                    return;
                }
                const duration = parseInt(auctionDuration) || 1;
                await createAuction(
                    BigInt(selectedNFT.tokenId),
                    auctionStartPrice,
                    auctionReservePrice || auctionStartPrice,
                    duration
                );
                alert('Auction created successfully!');
            }
            setListModalOpen(false);
            await refreshAfterAction();
            if (activeTab === 'activity') fetchActivity(true);
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setIsSelling(false);
    };

    // Fetch activity data when tab is active
    const fetchActivity = useCallback(async (forceRefresh = false) => {
        if (!isConnected || !address) return;
        setLoadingActivity(true);
        try {
            // Invalidate caches to get fresh data
            if (forceRefresh) {
                blockchainCache.invalidate(CacheKeys.userListings(address));
                blockchainCache.invalidate(CacheKeys.userBids(address));
                blockchainCache.invalidate(CacheKeys.activeAuctions());
            }
            const [userListings, userBids, allAuctions, soldItems] = await Promise.all([
                getUserListings(address),
                getMyBids(),
                getActiveAuctions(),
                getUserSoldItems(address),
            ]);

            // Enrich listings with card metadata
            const enrichedListings = await Promise.all(
                userListings.map(async (l) => {
                    if (l.isPack) {
                        return { ...l, cardName: `Pack #${l.tokenId}`, cardImage: undefined, rarity: undefined, priceFormatted: formatXTZ(l.price), isPack: true };
                    }
                    try {
                        const info = await getCardInfo(Number(l.tokenId));
                        return { ...l, cardName: info?.name || `Card #${l.tokenId}`, cardImage: info?.image, rarity: info?.rarity, priceFormatted: formatXTZ(l.price) };
                    } catch { return { ...l, cardName: `Card #${l.tokenId}`, priceFormatted: formatXTZ(l.price) }; }
                })
            );

            // Filter auctions where user is the seller
            const userAuctions = allAuctions.filter(a => a.seller.toLowerCase() === address.toLowerCase());
            const enrichedAuctions = await Promise.all(
                userAuctions.map(async (a) => {
                    if (a.isPack) {
                        const { text, isEnded } = formatTimeLeft(a.endTime);
                        return { ...a, cardName: `Pack #${a.tokenId}`, cardImage: undefined, rarity: undefined, timeLeft: text, isEnded, isPack: true };
                    }
                    try {
                        const info = await getCardInfo(Number(a.tokenId));
                        const { text, isEnded } = formatTimeLeft(a.endTime);
                        return { ...a, cardName: info?.name || `Card #${a.tokenId}`, cardImage: info?.image, rarity: info?.rarity, timeLeft: text, isEnded };
                    } catch {
                        const { text, isEnded } = formatTimeLeft(a.endTime);
                        return { ...a, cardName: `Card #${a.tokenId}`, timeLeft: text, isEnded };
                    }
                })
            );

            // Enrich bids with card metadata
            const enrichedBids = await Promise.all(
                userBids.map(async (b) => {
                    try {
                        const info = await getCardInfo(Number(b.tokenId));
                        return { ...b, cardName: info?.name || `Card #${b.tokenId}`, cardImage: info?.image, rarity: info?.rarity };
                    } catch { return { ...b, cardName: `Card #${b.tokenId}` }; }
                })
            );

            // Enrich sold items with card metadata
            const enrichedSales = await Promise.all(
                soldItems.map(async (s) => {
                    try {
                        const info = await getCardInfo(Number(s.tokenId));
                        return { ...s, cardName: info?.name || `Card #${s.tokenId}`, cardImage: info?.image, rarity: info?.rarity };
                    } catch { return { ...s, cardName: `Card #${s.tokenId}` }; }
                })
            );

            setMyListings(enrichedListings);
            setMyAuctions(enrichedAuctions);
            setMyBids(enrichedBids);
            setMySales(enrichedSales);
        } catch (e) {
        }
        setLoadingActivity(false);
    }, [isConnected, address, getUserListings, getMyBids, getActiveAuctions, getUserSoldItems, getCardInfo]);

    useEffect(() => {
        if (activeTab === 'activity') fetchActivity(true);
    }, [activeTab, fetchActivity, networkId]);

    // Handle cancel bid from activity
    const handleCancelBid = async (bidId: bigint) => {
        setCancellingBidId(Number(bidId));
        try {
            await cancelBid(bidId);
            await refreshAfterAction();
            await fetchActivity();
            alert('Bid cancelled successfully!');
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setCancellingBidId(null);
    };

    // ── Sealed Bid helpers ──────────────────────────────────────────────────────

    /** Create viem publicClient + walletClient for CoFHE encryption */
    const getViemClients = useCallback(async () => {
        const viem = await import('viem');
        const { sepolia: viemSepolia } = await import('viem/chains');
        const publicClient = viem.createPublicClient({
            chain: viemSepolia,
            transport: viem.http(),
        });
        const walletClient = viem.createWalletClient({
            chain: viemSepolia,
            transport: viem.custom(walletProvider as any),
        });
        return { publicClient, walletClient };
    }, [walletProvider]);

    /** Fetch active sealed listings with card metadata */
    const fetchSealedListings = useCallback(async () => {
        setLoadingSealed(true);
        try {
            const raw = await getSealedListings();
            const enriched = await Promise.all(
                raw.map(async (listing) => {
                    try {
                        const info = await getCardInfo(listing.tokenId);
                        return { ...listing, cardName: info?.name || `Card #${listing.tokenId}`, cardImage: info?.image || '/placeholder-card.png', rarity: info?.rarity || 'Common' };
                    } catch {
                        return { ...listing, cardName: `Card #${listing.tokenId}`, cardImage: '/placeholder-card.png', rarity: 'Common' };
                    }
                })
            );
            setSealedListings(enriched);
        } catch (e) {
            console.error('Failed to fetch sealed listings:', e);
        }
        setLoadingSealed(false);
    }, [getCardInfo]);

    /** Fetch bids for a given sealed listing */
    const fetchSealedBids = useCallback(async (listingId: number) => {
        try {
            const bids = await getBidsForListing(listingId);
            setSealedBidsMap(prev => ({ ...prev, [listingId]: bids }));
        } catch (e) {
            console.error('Failed to fetch sealed bids:', e);
        }
    }, []);

    // Load sealed listings when the sealed tab is active
    useEffect(() => {
        if (activeTab === 'sealed' && isFhenixNetwork()) {
            fetchSealedListings();
        }
    }, [activeTab, fetchSealedListings, networkId]);

    /** Open modal to list an NFT with sealed bid */
    const openSealedListModal = async () => {
        setSealedListModal(true);
        setLoadingSealedNFTs(true);
        setSealedSelectedNFT(null);
        setSealedMinPrice('');
        try {
            const cards = await getCards(address || '');
            setSealedMyNFTs(sortByRarity(cards.filter(c => !c.isLocked)));
        } catch (e) {
            console.error('Failed to load NFTs:', e);
        }
        setLoadingSealedNFTs(false);
    };

    /** List an NFT with encrypted minimum price */
    const handleSealedList = async () => {
        if (!sealedSelectedNFT || !sealedMinPrice || !isConnected) return;
        const minPriceNum = Math.round(parseFloat(sealedMinPrice) * 1000); // convert to milliunits for uint32
        if (minPriceNum <= 0) { alert('Please enter a valid minimum price'); return; }

        setSealedActionLoading(`list-${sealedSelectedNFT.tokenId}`);
        try {
            const signer = await getSigner();
            if (!signer) throw new Error('No signer available');
            const { publicClient, walletClient } = await getViemClients();
            await listSealed(publicClient, walletClient, signer, sealedSelectedNFT.tokenId, minPriceNum);
            setSealedListModal(false);
            alert('NFT listed with sealed minimum price! The minimum price is encrypted on-chain.');
            await fetchSealedListings();
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setSealedActionLoading(null);
    };

    /** Place a sealed bid on a listing */
    const handlePlaceSealedBid = async (listingId: number) => {
        if (!sealedBidAmount || !sealedBidDeposit || !isConnected) return;
        const bidAmountNum = Math.round(parseFloat(sealedBidAmount) * 1000);
        if (bidAmountNum <= 0) { alert('Please enter a valid bid amount'); return; }

        setSealedActionLoading(`bid-${listingId}`);
        try {
            const signer = await getSigner();
            if (!signer) throw new Error('No signer available');
            const { publicClient, walletClient } = await getViemClients();
            await placeSealedBid(publicClient, walletClient, signer, listingId, bidAmountNum, sealedBidDeposit);
            setSealedBidAmount('');
            setSealedBidDeposit('');
            alert('Sealed bid placed! Your bid amount is encrypted on-chain.');
            await fetchSealedBids(listingId);
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setSealedActionLoading(null);
    };

    /** Seller accepts a sealed bid */
    const handleAcceptSealedBid = async (bidId: number) => {
        setSealedActionLoading(`accept-${bidId}`);
        try {
            const signer = await getSigner();
            if (!signer) throw new Error('No signer available');
            await acceptSealedBid(signer, bidId);
            alert('Bid accepted! NFT transferred to bidder.');
            await fetchSealedListings();
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setSealedActionLoading(null);
    };

    /** Cancel a sealed listing */
    const handleCancelSealedListing = async (listingId: number) => {
        setSealedActionLoading(`cancel-listing-${listingId}`);
        try {
            const signer = await getSigner();
            if (!signer) throw new Error('No signer available');
            await cancelSealedListing(signer, listingId);
            alert('Sealed listing cancelled. NFT returned.');
            await fetchSealedListings();
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setSealedActionLoading(null);
    };

    /** Cancel a sealed bid */
    const handleCancelSealedBid = async (bidId: number, listingId: number) => {
        setSealedActionLoading(`cancel-bid-${bidId}`);
        try {
            const signer = await getSigner();
            if (!signer) throw new Error('No signer available');
            await cancelSealedBid(signer, bidId);
            alert('Bid cancelled. ETH deposit refunded.');
            await fetchSealedBids(listingId);
        } catch (e: any) {
            alert(`Error: ${e.message}`);
        }
        setSealedActionLoading(null);
    };

    /** Toggle expanded listing and fetch its bids */
    const toggleSealedListingExpand = async (listingId: number) => {
        if (expandedSealedListing === listingId) {
            setExpandedSealedListing(null);
        } else {
            setExpandedSealedListing(listingId);
            setSealedBidAmount('');
            setSealedBidDeposit('');
            if (!sealedBidsMap[listingId]) {
                await fetchSealedBids(listingId);
            }
        }
    };

    // Filter and sort listings
    const filteredListings = listings
        .filter(l => {
            if (typeFilter === 'cards' && l.isPack) return false;
            if (typeFilter === 'packs' && !l.isPack) return false;
            if (typeFilter !== 'packs' && rarityFilter !== 'All' && l.rarity !== rarityFilter) return false;
            if (searchQuery && !l.cardName?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
            return true;
        })
        .sort((a, b) => {
            if (sortBy === 'price_asc') return Number(a.price - b.price);
            if (sortBy === 'price_desc') return Number(b.price - a.price);
            return Number(b.listedAt - a.listedAt);
        });

    // Filter auctions
    const filteredAuctions = auctions
        .filter(a => {
            if (typeFilter === 'cards' && a.isPack) return false;
            if (typeFilter === 'packs' && !a.isPack) return false;
            if (typeFilter !== 'packs' && rarityFilter !== 'All' && a.rarity !== rarityFilter) return false;
            if (searchQuery && !a.cardName?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
            return true;
        });

    // Sort activity items
    const sortedMyListings = [...myListings].sort((a, b) => {
        if (sortBy === 'price_asc') return Number(a.price - b.price);
        if (sortBy === 'price_desc') return Number(b.price - a.price);
        return Number(b.listedAt - a.listedAt);
    });

    const sortedMyAuctions = [...myAuctions].sort((a, b) => {
        const aPrice = a.highestBid > 0n ? a.highestBid : a.startPrice;
        const bPrice = b.highestBid > 0n ? b.highestBid : b.startPrice;
        if (sortBy === 'price_asc') return Number(aPrice - bPrice);
        if (sortBy === 'price_desc') return Number(bPrice - aPrice);
        return Number(b.startTime - a.startTime);
    });

    const sortedMyBids = [...myBids].sort((a, b) => {
        if (sortBy === 'price_asc') return Number(a.amount - b.amount);
        if (sortBy === 'price_desc') return Number(b.amount - a.amount);
        return Number(b.expiration - a.expiration);
    });

    const sortedMySales = [...mySales].sort((a, b) => {
        if (sortBy === 'price_asc') return Number(a.price - b.price);
        if (sortBy === 'price_desc') return Number(b.price - a.price);
        return Number(b.timestamp - a.timestamp);
    });

    return (
        <div className="overflow-x-hidden">

            {/* Header */}
            <div className="flex flex-col space-y-4 md:space-y-6 mb-6 md:mb-8">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-xl md:text-3xl font-black text-yc-text-primary dark:text-white uppercase tracking-tight">Marketplace</h2>
                        <p className="text-gray-500 dark:text-gray-400 text-xs md:text-sm mt-1">
                            Buy, bid, and auction NFT cards.
                        </p>
                    </div>
                    {isConnected && (
                        <button
                            onClick={openListModal}
                            className="flex items-center gap-1.5 px-3 py-2 md:px-4 md:py-2.5 bg-yc-purple hover:bg-yc-purple/80 text-white rounded-lg font-bold text-xs md:text-sm transition-all shrink-0"
                        >
                            <Plus className="w-4 h-4" />
                            <span className="hidden sm:inline">List NFT</span>
                            <span className="sm:hidden">List</span>
                        </button>
                    )}
                </div>

                {/* Tab navigation */}
                <div className="flex items-center space-x-1 bg-white/50 dark:bg-white/[0.04] backdrop-blur-xl border border-white/40 dark:border-white/[0.06] p-1 rounded-2xl w-full md:w-fit flex-wrap">
                    <button
                        onClick={() => setActiveTab('listings')}
                        className={`flex items-center gap-1.5 px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${activeTab === 'listings'
                            ? 'bg-yc-purple/10 dark:bg-yc-purple/[0.12] text-yc-purple'
                            : 'text-gray-500 dark:text-gray-500 hover:text-black dark:hover:text-gray-300'
                            }`}
                    >
                        <Tag className="w-3.5 h-3.5 md:w-4 md:h-4" />
                        Buy Now
                        {listings.length > 0 && <span className="bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded text-[10px] md:text-xs">{listings.length}</span>}
                    </button>
                    <button
                        onClick={() => setActiveTab('auctions')}
                        className={`flex items-center gap-1.5 px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${activeTab === 'auctions'
                            ? 'bg-yc-purple/10 dark:bg-yc-purple/[0.12] text-yc-purple'
                            : 'text-gray-500 dark:text-gray-500 hover:text-black dark:hover:text-gray-300'
                            }`}
                    >
                        <Gavel className="w-3.5 h-3.5 md:w-4 md:h-4" />
                        Auctions
                        {auctions.length > 0 && <span className="bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded text-[10px] md:text-xs">{auctions.length}</span>}
                    </button>
                    {isFhenixNetwork() && (
                        <button
                            onClick={() => setActiveTab('sealed')}
                            className={`flex items-center gap-1.5 px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${activeTab === 'sealed'
                                ? 'bg-green-500/10 text-green-400'
                                : 'text-gray-500 dark:text-gray-500 hover:text-black dark:hover:text-gray-300'
                                }`}
                        >
                            <Shield className="w-3.5 h-3.5 md:w-4 md:h-4" />
                            Sealed Bids
                            {sealedListings.length > 0 && <span className="bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded text-[10px] md:text-xs">{sealedListings.length}</span>}
                        </button>
                    )}
                    <button
                        onClick={() => setActiveTab('activity')}
                        className={`flex items-center gap-1.5 px-3 md:px-4 py-2 rounded-xl text-xs md:text-sm font-semibold transition-all whitespace-nowrap ${activeTab === 'activity'
                            ? 'bg-yc-purple/10 dark:bg-yc-purple/[0.12] text-yc-purple'
                            : 'text-gray-500 dark:text-gray-500 hover:text-black dark:hover:text-gray-300'
                            }`}
                    >
                        <User className="w-3.5 h-3.5 md:w-4 md:h-4" />
                        Activity
                    </button>
                </div>

                {/* Filters */}
                <div className="flex flex-col gap-3">
                    {/* Type filter */}
                    <div className="flex items-center gap-2">
                        {(['all', 'cards', 'packs'] as TypeFilter[]).map((t) => (
                            <button
                                key={t}
                                onClick={() => { setTypeFilter(t); if (t === 'packs') setRarityFilter('All'); }}
                                className={`
                                    whitespace-nowrap px-3 md:px-5 py-1.5 md:py-2 rounded-full text-[10px] md:text-sm font-bold transition-all duration-300 transform active:scale-95 flex items-center gap-1.5
                                    ${typeFilter === t
                                        ? 'bg-[#06B6D4] text-white shadow-lg shadow-[#06B6D4]/30'
                                        : 'bg-white/50 dark:bg-white/[0.04] backdrop-blur-xl text-gray-600 dark:text-gray-400 hover:bg-white/70 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white'}
                                `}
                            >
                                {t === 'packs' && <Package className="w-3.5 h-3.5" />}
                                {t === 'all' ? 'All' : t === 'cards' ? 'Cards' : 'Packs'}
                            </button>
                        ))}
                    </div>

                    {/* Rarity tabs (hidden when filtering packs only) */}
                    {typeFilter !== 'packs' && (
                        <div className="flex items-center flex-wrap gap-1.5">
                            {rarityTabs.map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setRarityFilter(tab)}
                                    className={`
                                        whitespace-nowrap px-3 md:px-5 py-1 md:py-1.5 rounded-full text-[10px] md:text-xs font-bold transition-all duration-300 transform active:scale-95
                                        ${rarityFilter === tab
                                            ? 'bg-white/80 dark:bg-white/15 text-gray-900 dark:text-white border border-white/60 dark:border-white/20 backdrop-blur-xl'
                                            : 'bg-white/40 dark:bg-white/[0.04] text-gray-600 dark:text-gray-400 hover:bg-white/60 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white'}
                                    `}
                                >
                                    {tab}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Search & Sort */}
                    <div className="flex items-center gap-2 md:gap-3">
                        <div className="relative flex-1 min-w-0 group">
                            <Search className="absolute left-3 md:left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-yc-purple transition-colors" />
                            <input
                                type="text"
                                placeholder="Search..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full bg-white dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-full pl-9 md:pl-10 pr-3 md:pr-4 py-2 md:py-2.5 text-sm font-medium text-yc-text-primary dark:text-white focus:outline-none focus:border-yc-purple focus:ring-1 focus:ring-yc-purple transition-all placeholder-gray-400 shadow-sm"
                            />
                        </div>
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as any)}
                            className="px-3 md:px-5 py-2 md:py-2.5 bg-white dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-full text-xs md:text-sm font-bold text-yc-text-primary dark:text-white hover:border-yc-purple transition-all shadow-sm cursor-pointer shrink-0"
                        >
                            <option value="recent">Recent</option>
                            <option value="price_asc">Price ↑</option>
                            <option value="price_desc">Price ↓</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* LISTINGS TAB */}
            {activeTab === 'listings' && (
                <>
                    {loadingListings && (
                        <div className="flex flex-col items-center justify-center py-20">
                            <Loader2 className="w-8 h-8 text-yc-purple animate-spin mb-4" />
                            <p className="text-gray-400">Loading listings...</p>
                        </div>
                    )}

                    {!loadingListings && filteredListings.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 glass-panel rounded-xl">
                            <ShoppingCart className="w-16 h-16 text-gray-400 dark:text-gray-600 mb-4" />
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">No listings found</h3>
                            <p className="text-gray-500 dark:text-gray-400 text-center max-w-md">
                                {listings.length === 0
                                    ? "There are no cards listed for sale yet. Be the first to list!"
                                    : "No cards match your current filters."}
                            </p>
                        </div>
                    )}

                    {!loadingListings && filteredListings.length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 md:gap-4">
                            {filteredListings.map((listing) => (
                                <div
                                    key={listing.listingId}
                                    className="glass-panel glass-panel-hover rounded-xl overflow-hidden transition-all duration-300 group"
                                >
                                    <div
                                        className="relative overflow-hidden cursor-pointer"
                                        style={{ aspectRatio: '591/1004' }}
                                        onClick={() => !listing.isPack && openStatsModal(listing)}
                                    >
                                        {listing.isPack ? (
                                            <PackVisual tokenId={listing.tokenId} className="w-full h-full rounded-none" />
                                        ) : (
                                            <img
                                                src={listing.cardImage}
                                                alt={listing.cardName}
                                                className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500"
                                            />
                                        )}
                                    </div>
                                    <div className="p-1.5 md:p-4">
                                        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-lg leading-tight">{listing.priceFormatted} {currencySymbol()}</p>
                                        {listing.seller.toLowerCase() === address?.toLowerCase() ? (
                                            <button
                                                onClick={() => handleCancelListing(listing)}
                                                disabled={cancellingId === Number(listing.listingId)}
                                                className={`
                                                    w-full mt-1.5 md:mt-3 px-2 py-1 md:px-4 md:py-2 rounded-lg font-bold text-[10px] md:text-sm transition-all
                                                    ${cancellingId === Number(listing.listingId)
                                                        ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                                                        : 'bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white active:scale-95'}
                                                `}
                                            >
                                                {cancellingId === Number(listing.listingId) ? (
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                ) : (
                                                    'Cancel'
                                                )}
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => handleBuy(listing)}
                                                disabled={buyingId === Number(listing.listingId) || !isConnected}
                                                className={`
                                                    w-full mt-1.5 md:mt-3 px-2 py-1 md:px-4 md:py-2 rounded-lg font-bold text-[10px] md:text-sm transition-all
                                                    ${buyingId === Number(listing.listingId)
                                                        ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                                                        : 'bg-yc-purple text-white hover:bg-yc-purple/80 active:scale-95'}
                                                `}
                                            >
                                                {buyingId === Number(listing.listingId) ? (
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                ) : (
                                                    'Buy'
                                                )}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}

            {/* AUCTIONS TAB */}
            {activeTab === 'auctions' && (
                <>
                    {loadingAuctions && (
                        <div className="flex flex-col items-center justify-center py-20">
                            <Loader2 className="w-8 h-8 text-yc-purple animate-spin mb-4" />
                            <p className="text-gray-400">Loading auctions...</p>
                        </div>
                    )}

                    {!loadingAuctions && filteredAuctions.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 glass-panel rounded-xl">
                            <Gavel className="w-16 h-16 text-gray-400 dark:text-gray-600 mb-4" />
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">No auctions found</h3>
                            <p className="text-gray-500 dark:text-gray-400 text-center max-w-md">
                                There are no active auctions. Create one from your Portfolio!
                            </p>
                        </div>
                    )}

                    {!loadingAuctions && filteredAuctions.length > 0 && (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 md:gap-4">
                            {filteredAuctions.map((auction) => (
                                <div
                                    key={auction.auctionId}
                                    className="glass-panel glass-panel-hover rounded-xl overflow-hidden transition-all duration-300 group"
                                >
                                    <div
                                        className="relative overflow-hidden cursor-pointer"
                                        style={{ aspectRatio: '591/1004' }}
                                        onClick={() => !auction.isPack && openStatsModal(auction)}
                                    >
                                        {auction.isPack ? (
                                            <PackVisual tokenId={auction.tokenId} className="w-full h-full rounded-none" />
                                        ) : (
                                            <img
                                                src={auction.cardImage}
                                                alt={auction.cardName}
                                                className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500"
                                            />
                                        )}
                                        {/* Timer */}
                                        <div className={`absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 text-xs font-bold rounded ${auction.isEnded ? 'bg-red-600 text-white' : 'bg-black/80 dark:bg-black/80 text-yc-purple'}`}>
                                            <Clock className="w-3 h-3" />
                                            {auction.timeLeft}
                                        </div>
                                    </div>
                                    <div className="p-1.5 md:p-4">
                                        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-base leading-tight">{safeFormatXTZ(auction.highestBid)} {currencySymbol()}</p>
                                        {auction.isEnded ? (
                                            <button
                                                onClick={() => handleFinalizeAuction(auction)}
                                                disabled={biddingId === Number(auction.auctionId)}
                                                className="w-full mt-1.5 md:mt-3 px-2 py-1 md:px-4 md:py-2 rounded-lg font-bold text-[10px] md:text-sm bg-green-600 text-white hover:bg-green-700 transition-all"
                                            >
                                                {biddingId === Number(auction.auctionId) ? (
                                                    <Loader2 className="w-3 h-3 animate-spin mx-auto" />
                                                ) : 'Finalize'}
                                            </button>
                                        ) : auction.seller.toLowerCase() === address?.toLowerCase() ? (
                                            // Seller: show Cancel (no bids) or Yours (has bids)
                                            auction.highestBidder === '0x0000000000000000000000000000000000000000' || !auction.highestBidder ? (
                                                <button
                                                    onClick={() => handleCancelAuction(auction)}
                                                    disabled={cancellingId === Number(auction.auctionId)}
                                                    className="w-full mt-1.5 md:mt-3 px-2 py-1 md:px-4 md:py-2 rounded-lg font-bold text-[10px] md:text-sm bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all"
                                                >
                                                    {cancellingId === Number(auction.auctionId) ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Cancel'}
                                                </button>
                                            ) : (
                                                <p className="mt-1.5 md:mt-3 px-2 py-1 md:px-4 md:py-2 text-center font-bold text-[10px] md:text-sm text-gray-400">Has bids</p>
                                            )
                                        ) : (
                                            <button
                                                onClick={() => { setBidModal({ auction }); setBidAmount(''); }}
                                                className="w-full mt-1.5 md:mt-3 px-2 py-1 md:px-4 md:py-2 rounded-lg font-bold text-[10px] md:text-sm transition-all bg-white dark:bg-white/[0.08] text-black dark:text-white border border-gray-200 dark:border-white/[0.1] hover:bg-gray-100 dark:hover:bg-white/[0.15]"
                                            >
                                                {'Bid'}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}

            {/* SEALED BIDS TAB */}
            {activeTab === 'sealed' && (
                <div className="space-y-4">
                    {/* Info banner */}
                    <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <Shield className="w-5 h-5 text-green-400" />
                                    <h3 className="text-sm font-bold text-green-400 uppercase">Sealed-Bid Marketplace</h3>
                                    <span className="bg-green-500/20 text-green-400 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                                        <Lock className="w-3 h-3" /> FHE Encrypted
                                    </span>
                                </div>
                                <p className="text-xs text-green-500/70">
                                    Prices are encrypted with FHE. Sellers set a hidden minimum — bidders submit sealed offers.
                                    The contract compares encrypted values without revealing numbers to anyone.
                                </p>
                            </div>
                            {isConnected && (
                                <button
                                    onClick={openSealedListModal}
                                    className="flex items-center gap-1.5 px-3 py-2 md:px-4 md:py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg font-bold text-xs md:text-sm transition-all shrink-0 ml-4"
                                >
                                    <Plus className="w-4 h-4" />
                                    <span className="hidden sm:inline">Sealed List</span>
                                    <span className="sm:hidden">List</span>
                                </button>
                            )}
                        </div>
                    </div>

                    {/* How it works */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 text-center">
                            <EyeOff className="w-6 h-6 text-green-400 mx-auto mb-2" />
                            <h4 className="text-xs font-bold text-white mb-1">Hidden Min Price</h4>
                            <p className="text-[10px] text-gray-400">Seller sets encrypted minimum via FHE</p>
                        </div>
                        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 text-center">
                            <Lock className="w-6 h-6 text-green-400 mx-auto mb-2" />
                            <h4 className="text-xs font-bold text-white mb-1">Sealed Bids</h4>
                            <p className="text-[10px] text-gray-400">Bid amounts encrypted on-chain</p>
                        </div>
                        <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 text-center">
                            <Shield className="w-6 h-6 text-green-400 mx-auto mb-2" />
                            <h4 className="text-xs font-bold text-white mb-1">Private Comparison</h4>
                            <p className="text-[10px] text-gray-400">FHE.gt compares without revealing values</p>
                        </div>
                    </div>

                    {/* Loading state */}
                    {loadingSealed && (
                        <div className="flex flex-col items-center justify-center py-20">
                            <Loader2 className="w-8 h-8 text-green-400 animate-spin mb-4" />
                            <p className="text-gray-400">Loading sealed listings...</p>
                        </div>
                    )}

                    {/* Empty state */}
                    {!loadingSealed && sealedListings.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 glass-panel rounded-xl">
                            <Shield className="w-12 h-12 text-gray-400 dark:text-gray-600 mb-3" />
                            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">No Sealed Listings</h3>
                            <p className="text-gray-500 dark:text-gray-400 text-sm text-center max-w-sm">
                                {isConnected
                                    ? 'Be the first to list an NFT with a hidden minimum price!'
                                    : 'Connect your wallet to list NFTs with sealed bids.'}
                            </p>
                        </div>
                    )}

                    {/* Active sealed listings */}
                    {!loadingSealed && sealedListings.length > 0 && (
                        <div className="space-y-3">
                            {sealedListings.map((listing) => {
                                const isOwner = listing.seller.toLowerCase() === address?.toLowerCase();
                                const isExpanded = expandedSealedListing === listing.id;
                                const bids = sealedBidsMap[listing.id] || [];

                                return (
                                    <div key={listing.id} className="glass-panel rounded-xl overflow-hidden border border-white/[0.06]">
                                        {/* Listing row */}
                                        <div
                                            className="flex items-center gap-3 p-3 md:p-4 cursor-pointer hover:bg-white/[0.02] transition-colors"
                                            onClick={() => toggleSealedListingExpand(listing.id)}
                                        >
                                            <img
                                                src={listing.cardImage}
                                                alt={listing.cardName}
                                                className="w-14 h-14 md:w-16 md:h-16 rounded-lg object-contain bg-gray-100 dark:bg-white/[0.02]"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="text-gray-900 dark:text-white font-bold text-sm md:text-base truncate">{listing.cardName}</h4>
                                                    {listing.rarity && (
                                                        <span className={`text-[9px] px-1.5 py-0.5 rounded ${RARITY_COLORS[listing.rarity]}`}>{listing.rarity}</span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2 mt-1">
                                                    <span className="bg-green-500/20 text-green-400 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                                                        <Lock className="w-2.5 h-2.5" /> Encrypted Min Price
                                                    </span>
                                                    <span className="text-gray-500 dark:text-gray-400 text-[10px]">
                                                        by {listing.seller.slice(0, 6)}...{listing.seller.slice(-4)}
                                                    </span>
                                                    {isOwner && (
                                                        <span className="bg-yc-purple/20 text-yc-purple text-[10px] font-bold px-1.5 py-0.5 rounded">You</span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <span className="text-gray-500 dark:text-gray-400 text-xs">{isExpanded ? 'Hide' : 'View'}</span>
                                                <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                                            </div>
                                        </div>

                                        {/* Expanded section */}
                                        {isExpanded && (
                                            <div className="border-t border-white/[0.06] p-3 md:p-4 space-y-4">
                                                {/* Seller actions */}
                                                {isOwner && (
                                                    <div className="flex items-center justify-between bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3">
                                                        <div>
                                                            <p className="text-yellow-400 text-xs font-bold">Your Listing</p>
                                                            <p className="text-yellow-500/60 text-[10px]">Accept a bid below or cancel this listing.</p>
                                                        </div>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleCancelSealedListing(listing.id); }}
                                                            disabled={sealedActionLoading === `cancel-listing-${listing.id}`}
                                                            className="px-3 py-1.5 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white rounded-lg text-xs font-bold transition-all"
                                                        >
                                                            {sealedActionLoading === `cancel-listing-${listing.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Cancel Listing'}
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Existing bids */}
                                                <div>
                                                    <h5 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                                        <Gavel className="w-3.5 h-3.5" /> Sealed Bids ({bids.length})
                                                    </h5>
                                                    {bids.length === 0 ? (
                                                        <p className="text-gray-500 dark:text-gray-500 text-xs py-2">No bids yet.</p>
                                                    ) : (
                                                        <div className="space-y-2">
                                                            {bids.map((bid) => {
                                                                const isBidOwner = bid.bidder.toLowerCase() === address?.toLowerCase();
                                                                return (
                                                                    <div key={bid.id} className="flex items-center justify-between p-2.5 bg-gray-50 dark:bg-white/[0.02] rounded-lg border border-gray-200 dark:border-white/[0.06]">
                                                                        <div className="flex items-center gap-2">
                                                                            <div className="flex items-center gap-1.5">
                                                                                <Lock className="w-3 h-3 text-green-400" />
                                                                                <span className="text-green-400 text-xs font-bold">Encrypted Bid</span>
                                                                            </div>
                                                                            <span className="text-gray-400 text-[10px]">|</span>
                                                                            <span className="text-gray-500 dark:text-gray-400 text-xs">
                                                                                Deposit: {ethers.formatEther(bid.deposit)} {currencySymbol()}
                                                                            </span>
                                                                            <span className="text-gray-400 text-[10px]">|</span>
                                                                            <span className="text-gray-500 dark:text-gray-400 text-[10px]">
                                                                                {bid.bidder.slice(0, 6)}...{bid.bidder.slice(-4)}
                                                                            </span>
                                                                            {isBidOwner && (
                                                                                <span className="bg-blue-500/20 text-blue-400 text-[9px] font-bold px-1.5 py-0.5 rounded">You</span>
                                                                            )}
                                                                        </div>
                                                                        <div className="flex gap-2">
                                                                            {isOwner && (
                                                                                <button
                                                                                    onClick={() => handleAcceptSealedBid(bid.id)}
                                                                                    disabled={sealedActionLoading === `accept-${bid.id}`}
                                                                                    className="px-2.5 py-1 bg-green-600 text-white rounded-lg text-[10px] font-bold hover:bg-green-700 transition-all"
                                                                                >
                                                                                    {sealedActionLoading === `accept-${bid.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Accept'}
                                                                                </button>
                                                                            )}
                                                                            {isBidOwner && (
                                                                                <button
                                                                                    onClick={() => handleCancelSealedBid(bid.id, listing.id)}
                                                                                    disabled={sealedActionLoading === `cancel-bid-${bid.id}`}
                                                                                    className="px-2.5 py-1 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white rounded-lg text-[10px] font-bold transition-all"
                                                                                >
                                                                                    {sealedActionLoading === `cancel-bid-${bid.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Cancel'}
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Place bid form (non-owners only) */}
                                                {!isOwner && isConnected && (
                                                    <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3 space-y-3">
                                                        <h5 className="text-xs font-bold text-green-400 flex items-center gap-1.5">
                                                            <Lock className="w-3 h-3" /> Place a Sealed Bid
                                                        </h5>
                                                        <p className="text-[10px] text-green-500/60">
                                                            Your bid amount will be encrypted. The ETH deposit is held in escrow and refunded if your bid is not accepted.
                                                        </p>
                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div>
                                                                <label className="text-gray-500 dark:text-gray-400 text-[10px] mb-1 block">Bid Amount (encrypted, in milli-{currencySymbol()})</label>
                                                                <input
                                                                    type="number"
                                                                    step="0.001"
                                                                    value={sealedBidAmount}
                                                                    onChange={(e) => setSealedBidAmount(e.target.value)}
                                                                    placeholder="e.g. 0.1"
                                                                    className="w-full bg-white dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-3 py-2 text-gray-900 dark:text-white font-bold text-sm focus:border-green-500 focus:outline-none"
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="text-gray-500 dark:text-gray-400 text-[10px] mb-1 block">ETH Deposit (visible, sent as escrow)</label>
                                                                <input
                                                                    type="number"
                                                                    step="0.001"
                                                                    value={sealedBidDeposit}
                                                                    onChange={(e) => setSealedBidDeposit(e.target.value)}
                                                                    placeholder="e.g. 0.01"
                                                                    className="w-full bg-white dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-3 py-2 text-gray-900 dark:text-white font-bold text-sm focus:border-green-500 focus:outline-none"
                                                                />
                                                            </div>
                                                        </div>
                                                        <button
                                                            onClick={() => handlePlaceSealedBid(listing.id)}
                                                            disabled={!sealedBidAmount || !sealedBidDeposit || sealedActionLoading === `bid-${listing.id}`}
                                                            className="w-full bg-green-600 text-white font-bold py-2 rounded-lg hover:bg-green-700 disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed transition-all text-sm"
                                                        >
                                                            {sealedActionLoading === `bid-${listing.id}` ? (
                                                                <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Encrypting & Submitting...</span>
                                                            ) : (
                                                                <span className="flex items-center justify-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Submit Sealed Bid</span>
                                                            )}
                                                        </button>
                                                    </div>
                                                )}

                                                {!isConnected && (
                                                    <p className="text-gray-500 text-xs text-center py-2">Connect your wallet to place a bid.</p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* SEALED LIST MODAL */}
            {sealedListModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSealedListModal(false)}>
                    <div className="glass-panel rounded-2xl w-full max-w-md max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-gray-200 dark:border-white/[0.06] flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <Shield className="w-5 h-5 text-green-400" />
                                <h3 className="text-gray-900 dark:text-white font-bold text-lg">Sealed Bid Listing</h3>
                            </div>
                            <button onClick={() => setSealedListModal(false)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 max-h-[calc(80vh-80px)] overflow-y-auto">
                            {loadingSealedNFTs ? (
                                <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-green-400 animate-spin" /></div>
                            ) : !sealedSelectedNFT ? (
                                <>
                                    <p className="text-gray-500 dark:text-gray-400 text-sm mb-4">Select a card to list with a hidden minimum price:</p>
                                    {sealedMyNFTs.length === 0 ? (
                                        <p className="text-gray-500 dark:text-gray-500 text-center py-4">No cards available to list.</p>
                                    ) : (
                                        <div className="grid grid-cols-2 gap-3">
                                            {sealedMyNFTs.map(nft => (
                                                <div
                                                    key={nft.tokenId}
                                                    onClick={() => setSealedSelectedNFT(nft)}
                                                    className="cursor-pointer rounded-xl glass-panel glass-panel-hover overflow-hidden transition-colors"
                                                >
                                                    <img src={nft.image} alt={nft.name} className="w-full object-contain" style={{ aspectRatio: '591/1004' }} />
                                                    <div className="p-1.5">
                                                        <p className="text-gray-900 dark:text-white text-[10px] font-bold truncate">{nft.name}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="flex gap-4 mb-4">
                                        <img src={sealedSelectedNFT.image} alt={sealedSelectedNFT.name} className="w-20 h-20 rounded-lg object-contain" />
                                        <div>
                                            <h4 className="text-gray-900 dark:text-white font-bold">{sealedSelectedNFT.name}</h4>
                                            <p className="text-gray-500 dark:text-gray-400 text-sm">#{sealedSelectedNFT.tokenId}</p>
                                            <button onClick={() => setSealedSelectedNFT(null)} className="text-green-400 text-xs hover:underline">Change</button>
                                        </div>
                                    </div>

                                    <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3 mb-4">
                                        <div className="flex items-center gap-1.5 mb-1">
                                            <Lock className="w-3.5 h-3.5 text-green-400" />
                                            <span className="text-green-400 text-xs font-bold">Encrypted Minimum Price</span>
                                        </div>
                                        <p className="text-green-500/60 text-[10px]">
                                            This price is encrypted with FHE before being stored on-chain. Nobody can see it -- the smart contract compares bids to your minimum using encrypted computation.
                                        </p>
                                    </div>

                                    <div className="mb-4">
                                        <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block">Hidden Minimum Price ({currencySymbol()})</label>
                                        <input
                                            type="number"
                                            step="0.001"
                                            value={sealedMinPrice}
                                            onChange={(e) => setSealedMinPrice(e.target.value)}
                                            placeholder="0.00"
                                            className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold text-lg focus:border-green-500 focus:outline-none"
                                        />
                                        <p className="text-gray-500 dark:text-gray-500 text-[10px] mt-1">
                                            Only bids above this amount can be accepted by the contract.
                                        </p>
                                    </div>

                                    <button
                                        onClick={handleSealedList}
                                        disabled={!sealedMinPrice || sealedActionLoading?.startsWith('list-')}
                                        className="w-full bg-green-600 text-white font-bold py-3 rounded-2xl hover:bg-green-700 disabled:bg-gray-300 dark:disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all"
                                    >
                                        {sealedActionLoading?.startsWith('list-') ? (
                                            <span className="flex items-center justify-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Encrypting & Listing...</span>
                                        ) : (
                                            <span className="flex items-center justify-center gap-1.5"><Shield className="w-4 h-4" /> List with Hidden Price</span>
                                        )}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ACTIVITY TAB */}
            {activeTab === 'activity' && (
                <>
                    <>
                        {/* Activity sub-filters */}
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
                            <div className="flex items-center gap-1.5 flex-wrap w-full sm:w-auto">
                                {([
                                    { key: 'all', label: 'All', count: myListings.length + myAuctions.length + myBids.length + mySales.length },
                                    { key: 'listings', label: 'Listings', count: myListings.length },
                                    { key: 'auctions', label: 'Auctions', count: myAuctions.length },
                                    { key: 'bids', label: 'Bids', count: myBids.length },
                                    { key: 'sold', label: 'Sold', count: mySales.length },
                                ] as { key: ActivityFilter; label: string; count: number }[]).map(f => (
                                    <button
                                        key={f.key}
                                        onClick={() => setActivityFilter(f.key)}
                                        className={`px-3 md:px-4 py-1 md:py-1.5 rounded-full text-[10px] md:text-xs font-bold transition-all ${activityFilter === f.key
                                                ? 'bg-[#06B6D4] text-white shadow-lg shadow-[#06B6D4]/30'
                                                : 'bg-white/50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-400 hover:bg-white/70 dark:hover:bg-white/10'
                                            }`}
                                    >
                                        {f.label}
                                        {!loadingActivity && f.count > 0 && (
                                            <span className="ml-1.5 bg-black/20 px-1.5 py-0.5 rounded text-[10px]">{f.count}</span>
                                        )}
                                    </button>
                                ))}
                            </div>

                            {/* Sort dropdown for activity */}
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value as any)}
                                className="px-4 py-2 bg-white dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-full text-xs font-bold text-yc-text-primary dark:text-white hover:border-yc-purple focus:border-yc-purple focus:ring-1 focus:ring-yc-purple transition-all shadow-sm cursor-pointer shrink-0 w-full sm:w-auto"
                            >
                                <option value="recent">Recent First</option>
                                <option value="price_asc">Price: Low to High</option>
                                <option value="price_desc">Price: High to Low</option>
                            </select>
                        </div>

                        {loadingActivity ? (
                            <div className="flex flex-col items-center justify-center py-20">
                                <Loader2 className="w-8 h-8 text-yc-purple animate-spin mb-4" />
                                <p className="text-gray-400">Loading your activity...</p>
                            </div>
                        ) : (
                            <div className="space-y-6">
                                {/* My Listings */}
                                {(activityFilter === 'all' || activityFilter === 'listings') && sortedMyListings.length > 0 && (
                                    <div>
                                        {activityFilter === 'all' && <h3 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2"><Tag className="w-3.5 h-3.5" /> My Listings</h3>}
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 md:gap-4">
                                            {sortedMyListings.map(listing => (
                                                <div key={`l-${listing.listingId}`} className="glass-panel glass-panel-hover rounded-xl overflow-hidden transition-all group">
                                                    <div className="relative overflow-hidden" style={{ aspectRatio: '591/1004' }}>
                                                        {listing.isPack ? (
                                                            <PackVisual tokenId={listing.tokenId} className="w-full h-full rounded-none" />
                                                        ) : (
                                                            <img src={listing.cardImage || '/placeholder-card.png'} alt={listing.cardName} className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500" />
                                                        )}
                                                        <div className="absolute top-2 left-2 bg-yc-purple/90 text-white text-[9px] font-bold px-2 py-0.5 rounded">Listed</div>
                                                    </div>
                                                    <div className="p-1.5 md:p-3">
                                                        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-sm">{listing.priceFormatted} {currencySymbol()}</p>
                                                        <button
                                                            onClick={() => handleCancelListing(listing)}
                                                            disabled={cancellingId === Number(listing.listingId)}
                                                            className="w-full mt-1.5 px-2 py-1 md:py-1.5 rounded-lg font-bold text-[10px] md:text-xs bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all"
                                                        >
                                                            {cancellingId === Number(listing.listingId) ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Cancel Listing'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* My Auctions */}
                                {(activityFilter === 'all' || activityFilter === 'auctions') && sortedMyAuctions.length > 0 && (
                                    <div>
                                        {activityFilter === 'all' && <h3 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2"><Gavel className="w-3.5 h-3.5" /> My Auctions</h3>}
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 md:gap-4">
                                            {sortedMyAuctions.map(auction => (
                                                <div key={`a-${auction.auctionId}`} className="glass-panel glass-panel-hover rounded-xl overflow-hidden transition-all group">
                                                    <div className="relative overflow-hidden" style={{ aspectRatio: '591/1004' }}>
                                                        {auction.isPack ? (
                                                            <PackVisual tokenId={auction.tokenId} className="w-full h-full rounded-none" />
                                                        ) : (
                                                            <img src={auction.cardImage || '/placeholder-card.png'} alt={auction.cardName} className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500" />
                                                        )}
                                                        <div className={`absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold rounded ${auction.isEnded ? 'bg-red-600 text-white' : 'bg-black/80 text-yc-purple'}`}>
                                                            <Clock className="w-2.5 h-2.5" />
                                                            {auction.timeLeft}
                                                        </div>
                                                        <div className="absolute top-2 left-2 bg-cyan-600/90 text-white text-[9px] font-bold px-2 py-0.5 rounded">Auction</div>
                                                    </div>
                                                    <div className="p-1.5 md:p-3">
                                                        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-sm">{safeFormatXTZ(auction.highestBid > 0n ? auction.highestBid : auction.startPrice)} {currencySymbol()}</p>
                                                        <p className="text-[9px] text-gray-400">{auction.highestBid > 0n ? 'Current bid' : 'Starting price'}</p>
                                                        {auction.isEnded ? (
                                                            <button
                                                                onClick={() => handleFinalizeAuction(auction)}
                                                                disabled={biddingId === Number(auction.auctionId)}
                                                                className="w-full mt-1.5 px-2 py-1 md:py-1.5 rounded-lg font-bold text-[10px] md:text-xs bg-green-600 text-white hover:bg-green-700 transition-all"
                                                            >
                                                                {biddingId === Number(auction.auctionId) ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Finalize'}
                                                            </button>
                                                        ) : auction.highestBidder === '0x0000000000000000000000000000000000000000' || !auction.highestBidder ? (
                                                            <button
                                                                onClick={() => handleCancelAuction(auction)}
                                                                disabled={cancellingId === Number(auction.auctionId)}
                                                                className="w-full mt-1.5 px-2 py-1 md:py-1.5 rounded-lg font-bold text-[10px] md:text-xs bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all"
                                                            >
                                                                {cancellingId === Number(auction.auctionId) ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Cancel Auction'}
                                                            </button>
                                                        ) : (
                                                            <p className="mt-1.5 text-[10px] text-gray-400 text-center">Has bids</p>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* My Bids */}
                                {(activityFilter === 'all' || activityFilter === 'bids') && sortedMyBids.length > 0 && (
                                    <div>
                                        {activityFilter === 'all' && <h3 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2"><DollarSign className="w-3.5 h-3.5" /> My Bids</h3>}
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 md:gap-4">
                                            {sortedMyBids.map(bid => (
                                                <div key={`b-${bid.bidId}`} className="glass-panel glass-panel-hover rounded-xl overflow-hidden transition-all group">
                                                    <div className="relative overflow-hidden" style={{ aspectRatio: '591/1004' }}>
                                                        <img src={bid.cardImage || '/placeholder-card.png'} alt={bid.cardName} className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500" />
                                                        <div className="absolute top-2 left-2 bg-blue-600/90 text-white text-[9px] font-bold px-2 py-0.5 rounded">Bid</div>
                                                    </div>
                                                    <div className="p-1.5 md:p-3">
                                                        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-sm">{safeFormatXTZ(bid.amount)} {currencySymbol()}</p>
                                                        <p className="text-[9px] text-gray-400">Expires: {safeFormatDate(bid.expiration)}</p>
                                                        <button
                                                            onClick={() => handleCancelBid(bid.bidId)}
                                                            disabled={cancellingBidId === Number(bid.bidId)}
                                                            className="w-full mt-1.5 px-2 py-1 md:py-1.5 rounded-lg font-bold text-[10px] md:text-xs bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all"
                                                        >
                                                            {cancellingBidId === Number(bid.bidId) ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : 'Cancel Bid'}
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Sold Items */}
                                {(activityFilter === 'all' || activityFilter === 'sold') && sortedMySales.length > 0 && (
                                    <div>
                                        {activityFilter === 'all' && <h3 className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2"><CheckCircle className="w-3.5 h-3.5 text-green-500" /> Sold</h3>}
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1.5 md:gap-4">
                                            {sortedMySales.map((sale, idx) => (
                                                <div key={`sold-${idx}`} className="glass-panel rounded-xl overflow-hidden">
                                                    <div className="relative overflow-hidden" style={{ aspectRatio: '591/1004' }}>
                                                        <img src={(sale as any).cardImage || '/placeholder-card.png'} alt={(sale as any).cardName} className="w-full h-full object-contain opacity-75" />
                                                        <div className="absolute top-2 left-2 bg-green-600/90 text-white text-[9px] font-bold px-2 py-0.5 rounded">Sold</div>
                                                        <div className="absolute top-2 right-2 bg-black/60 text-white text-[9px] px-2 py-0.5 rounded">{sale.saleType === 0 ? 'Listing' : 'Bid'}</div>
                                                    </div>
                                                    <div className="p-1.5 md:p-3">
                                                        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-sm">{safeFormatXTZ(sale.price)} {currencySymbol()}</p>
                                                        <p className="text-[9px] text-gray-400 truncate">To: {sale.buyer.slice(0, 6)}…{sale.buyer.slice(-4)}</p>
                                                        <p className="text-[9px] text-gray-500">{new Date(Number(sale.timestamp) * 1000).toLocaleDateString()}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Empty state */}
                                {!loadingActivity && (
                                    (activityFilter === 'all' && myListings.length === 0 && myAuctions.length === 0 && myBids.length === 0 && mySales.length === 0) ||
                                    (activityFilter === 'listings' && myListings.length === 0) ||
                                    (activityFilter === 'auctions' && myAuctions.length === 0) ||
                                    (activityFilter === 'bids' && myBids.length === 0) ||
                                    (activityFilter === 'sold' && mySales.length === 0)
                                ) && (
                                        <div className="flex flex-col items-center justify-center py-16 glass-panel rounded-xl">
                                            <Activity className="w-12 h-12 text-gray-400 dark:text-gray-600 mb-3" />
                                            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">No Activity</h3>
                                            <p className="text-gray-500 dark:text-gray-400 text-sm text-center max-w-sm">
                                                {!isConnected ? 'Connect your wallet to see your marketplace activity.' :
                                                    activityFilter === 'listings' ? "You haven't listed any NFTs yet." :
                                                        activityFilter === 'auctions' ? "You haven't created any auctions yet." :
                                                            activityFilter === 'bids' ? "You haven't placed any bids yet." :
                                                                activityFilter === 'sold' ? "No sold NFTs found." :
                                                                    "No marketplace activity yet. List an NFT or place a bid to get started!"}
                                            </p>
                                        </div>
                                    )}
                            </div>
                        )}
                    </>
                </>
            )}

            {/* BID MODAL */}
            {bidModal && (
                <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={() => setBidModal(null)}>
                    <div className="glass-panel rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">{bidModal.auction ? 'Place Bid' : 'Make Offer'}</h3>
                            <button onClick={() => setBidModal(null)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {bidModal.auction ? (
                            <>
                                <div className="flex items-center gap-4 mb-6">
                                    <img src={bidModal.auction.cardImage} alt="" className="w-20 h-20 rounded-lg object-cover" />
                                    <div>
                                        <h4 className="text-gray-900 dark:text-white font-bold">{bidModal.auction.cardName}</h4>
                                        <p className="text-gray-500 dark:text-gray-400 text-sm">Current: {safeFormatXTZ(bidModal.auction.highestBid)} {currencySymbol()}</p>
                                    </div>
                                </div>

                                <div className="mb-6">
                                    <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block">Your Bid ({currencySymbol()})</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={bidAmount}
                                        onChange={(e) => setBidAmount(e.target.value)}
                                        placeholder={(() => {
                                            const hb = bidModal.auction!.highestBid;
                                            const min = hb === 0n ? bidModal.auction!.startPrice : hb + hb / 20n;
                                            return safeFormatXTZ(min);
                                        })()}
                                        className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold text-lg focus:border-yc-purple focus:outline-none"
                                    />
                                    <p className="text-gray-500 dark:text-gray-500 text-xs mt-1">
                                        Min bid: {(() => {
                                            const hb = bidModal.auction!.highestBid;
                                            const min = hb === 0n ? bidModal.auction!.startPrice : hb + hb / 20n;
                                            return safeFormatXTZ(min);
                                        })()} {currencySymbol()} {bidModal.auction!.highestBid > 0n && '(+5%)'}
                                    </p>
                                </div>

                                <button
                                    onClick={handleAuctionBid}
                                    disabled={!bidAmount || biddingId !== null}
                                    className="w-full bg-yc-purple text-white font-bold py-3 rounded-2xl hover:bg-yc-purple/80 disabled:bg-gray-300 dark:disabled:bg-gray-800 disabled:text-gray-500 disabled:cursor-not-allowed transition-all"
                                >
                                    {biddingId !== null ? (
                                        <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                                    ) : 'Confirm Bid'}
                                </button>
                            </>
                        ) : bidModal.listing && (
                            <>
                                <div className="flex items-center gap-4 mb-4">
                                    <img src={bidModal.listing.cardImage} alt="" className="w-20 h-20 rounded-lg object-cover" />
                                    <div>
                                        <h4 className="text-gray-900 dark:text-white font-bold">{bidModal.listing.cardName}</h4>
                                        <p className="text-gray-500 dark:text-gray-400 text-sm">Listed: {bidModal.listing.priceFormatted} {currencySymbol()}</p>
                                    </div>
                                </div>

                                <div className="mb-4 p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-lg">
                                    <p className="text-cyan-600 dark:text-cyan-300 text-xs">
                                        💡 Make an offer below the listing price. The seller can accept your offer at any time.
                                    </p>
                                </div>

                                <div className="mb-6">
                                    <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block">Your Offer ({currencySymbol()})</label>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={bidAmount}
                                        onChange={(e) => setBidAmount(e.target.value)}
                                        placeholder="0.00"
                                        className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold text-lg focus:border-yc-purple focus:outline-none"
                                    />
                                    <p className="text-gray-500 dark:text-gray-500 text-xs mt-1">Offer valid for 7 days</p>
                                </div>

                                <button
                                    onClick={handleListingBid}
                                    disabled={!bidAmount || biddingId !== null}
                                    className="w-full bg-cyan-600 text-white font-bold py-3 rounded-lg hover:bg-cyan-700 disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed transition-all"
                                >
                                    {biddingId !== null ? (
                                        <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                                    ) : 'Submit Offer'}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Stats Modal */}
            {statsModalOpen && statsItem && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="glass-panel rounded-2xl max-w-lg w-full max-h-[80vh] overflow-hidden">
                        <div className="p-4 border-b border-gray-200 dark:border-white/[0.06] flex justify-between items-center">
                            <h3 className="text-gray-900 dark:text-white font-bold text-lg">NFT Statistics</h3>
                            <button onClick={() => setStatsModalOpen(false)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Card preview */}
                        <div className="p-4 flex gap-4 border-b border-gray-200 dark:border-white/[0.06]">
                            <img src={statsItem.cardImage} alt={statsItem.cardName} className="w-20 h-20 rounded-lg object-cover" />
                            <div>
                                <h4 className="text-gray-900 dark:text-white font-bold">{statsItem.cardName}</h4>
                                <p className="text-gray-500 dark:text-gray-400 text-sm">Token #{String(statsItem.tokenId)}</p>
                                <span className={`text-xs px-2 py-0.5 rounded ${RARITY_COLORS[statsItem.rarity || 'Common']}`}>{statsItem.rarity}</span>
                            </div>
                        </div>

                        {/* Tabs */}
                        <div className="flex border-b border-gray-200 dark:border-white/[0.06]">
                            {['bids', 'sales', 'stats'].map(tab => (
                                <button
                                    key={tab}
                                    onClick={() => setStatsTab(tab as any)}
                                    className={`flex-1 py-3 text-sm font-bold transition-colors ${statsTab === tab ? 'text-yc-purple border-b-2 border-yc-purple' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
                                >
                                    {tab === 'bids' && <><Activity className="w-4 h-4 inline mr-1" />Bids</>}
                                    {tab === 'sales' && <><History className="w-4 h-4 inline mr-1" />Sales</>}
                                    {tab === 'stats' && <><DollarSign className="w-4 h-4 inline mr-1" />Stats</>}
                                </button>
                            ))}
                        </div>

                        {/* Content */}
                        <div className="p-4 max-h-64 overflow-y-auto">
                            {loadingStats ? (
                                <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-yc-purple animate-spin" /></div>
                            ) : (
                                <>
                                    {statsTab === 'bids' && (
                                        cardBids.length === 0 ? (
                                            <div className="py-4">
                                                {/* Show auction bid if this is an auction with a bid */}
                                                {statsItem && 'highestBid' in statsItem && (statsItem as AuctionWithMeta).highestBid > 0n ? (
                                                    <div className="p-3 bg-gray-50 dark:bg-white/[0.02] rounded-lg border border-gray-200 dark:border-white/[0.06]">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-gray-900 dark:text-white font-bold">{safeFormatXTZ((statsItem as AuctionWithMeta).highestBid)} {currencySymbol()}</span>
                                                            <span className="text-gray-500 dark:text-gray-500 text-xs">from</span>
                                                            <span className="text-gray-500 dark:text-gray-400 text-xs">{(statsItem as AuctionWithMeta).highestBidder?.slice(0, 6)}...{(statsItem as AuctionWithMeta).highestBidder?.slice(-4)}</span>
                                                            <span className="text-xs bg-yc-purple/20 text-yc-purple px-2 py-0.5 rounded-full font-bold">Auction bid</span>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <p className="text-gray-500 dark:text-gray-500 text-center">No active offers</p>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {cardBids.map((bid: any, i: number) => (
                                                    <div key={i} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-white/[0.02] rounded-lg border border-gray-200 dark:border-white/[0.06]">
                                                        <div className="flex-1">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-gray-900 dark:text-white font-bold">{safeFormatXTZ(bid.amount)} {currencySymbol()}</span>
                                                                <span className="text-gray-500 dark:text-gray-500 text-xs">from</span>
                                                                <span className="text-gray-500 dark:text-gray-400 text-xs">{bid.bidder?.slice(0, 6)}...{bid.bidder?.slice(-4)}</span>
                                                            </div>
                                                            <p className="text-gray-500 dark:text-gray-500 text-xs mt-1">
                                                                Expires: {safeFormatDate(bid.expiration)}
                                                            </p>
                                                        </div>
                                                        {statsItem && 'seller' in statsItem && statsItem.seller?.toLowerCase() === address?.toLowerCase() && (
                                                            <button
                                                                onClick={() => handleAcceptBid(bid.bidId)}
                                                                className="ml-3 px-3 py-1.5 bg-yc-purple text-white rounded-lg text-xs font-bold hover:bg-yc-purple/80 transition-all"
                                                            >
                                                                Accept
                                                            </button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )
                                    )}
                                    {statsTab === 'sales' && (
                                        cardSales.length === 0 ? <p className="text-gray-500 dark:text-gray-500 text-center py-4">No sales history</p> :
                                            cardSales.map((sale, i) => (
                                                <div key={i} className="py-2 border-b border-gray-200 dark:border-white/[0.06] last:border-0">
                                                    <div className="flex justify-between">
                                                        <span className="text-gray-900 dark:text-white font-bold">{safeFormatXTZ(sale.price)} {currencySymbol()}</span>
                                                        <span className="text-gray-500 dark:text-gray-400 text-xs">{safeFormatDate(sale.timestamp)}</span>
                                                    </div>
                                                    <p className="text-gray-500 dark:text-gray-500 text-xs">{sale.seller?.slice(0, 6)}... → {sale.buyer?.slice(0, 6)}...</p>
                                                </div>
                                            ))
                                    )}
                                    {statsTab === 'stats' && cardStats && (
                                        <div className="space-y-3">
                                            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Total Sales</span><span className="text-gray-900 dark:text-white font-bold">{String(cardStats.totalSales || 0)}</span></div>
                                            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Total Volume</span><span className="text-gray-900 dark:text-white font-bold">{safeFormatXTZ(cardStats.totalVolume || 0n)} {currencySymbol()}</span></div>
                                            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Highest Sale</span><span className="text-yc-green font-bold">{safeFormatXTZ(cardStats.highestSale || 0n)} {currencySymbol()}</span></div>
                                            <div className="flex justify-between"><span className="text-gray-500 dark:text-gray-400">Lowest Sale</span><span className="text-red-400 font-bold">{safeFormatXTZ(cardStats.lowestSale || 0n)} {currencySymbol()}</span></div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* List NFT Modal */}
            {listModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="glass-panel rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden">
                        <div className="p-4 border-b border-gray-200 dark:border-white/[0.06] flex justify-between items-center">
                            <h3 className="text-gray-900 dark:text-white font-bold text-lg">List NFT for Sale</h3>
                            <button onClick={() => setListModalOpen(false)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 max-h-[calc(85vh-120px)] overflow-y-auto">
                            {loadingNFTs ? (
                                <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 text-yc-purple animate-spin" /></div>
                            ) : !selectedNFT && selectedPackId === null ? (
                                <>
                                    <p className="text-gray-500 dark:text-gray-400 text-sm mb-4">Select an NFT to list:</p>
                                    {myNFTs.length === 0 && myPackTokenIds.length === 0 ? <p className="text-gray-500 dark:text-gray-500 text-center py-4">No NFTs available to list</p> : (
                                        <div className="grid grid-cols-2 gap-3">
                                            {/* Packs first */}
                                            {myPackTokenIds.map(packId => (
                                                <div
                                                    key={`pack-${packId}`}
                                                    onClick={() => { setSelectedPackId(packId); setSelectedNFT(null); }}
                                                    className="cursor-pointer rounded-xl glass-panel glass-panel-hover overflow-hidden transition-colors"
                                                >
                                                    <PackVisual tokenId={packId} className="w-full" style={{ aspectRatio: '591/1004' }} />
                                                </div>
                                            ))}
                                            {/* Cards */}
                                            {myNFTs.map(nft => (
                                                <div
                                                    key={nft.tokenId}
                                                    onClick={() => { setSelectedNFT(nft); setSelectedPackId(null); }}
                                                    className="cursor-pointer rounded-xl glass-panel glass-panel-hover overflow-hidden transition-colors"
                                                >
                                                    <img src={nft.image} alt={nft.name} className="w-full object-contain" style={{ aspectRatio: '591/1004' }} />
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="flex gap-4 mb-4">
                                        {selectedPackId !== null ? (
                                            <>
                                                <div className="w-20 h-20 rounded-lg overflow-hidden shrink-0 bg-gradient-to-b from-gray-100 to-gray-50 dark:from-[#111] dark:to-[#0a0a0a]">
                                                    <ModelViewer3D mode="static" cameraZ={3.2} modelScale={0.7} />
                                                </div>
                                                <div>
                                                    <h4 className="text-gray-900 dark:text-white font-bold">AttentionX Pack</h4>
                                                    <p className="text-gray-500 dark:text-gray-400 text-sm">Pack #{selectedPackId}</p>
                                                    <button onClick={() => setSelectedPackId(null)} className="text-yc-purple text-xs hover:underline">Change</button>
                                                </div>
                                            </>
                                        ) : selectedNFT && (
                                            <>
                                                <img src={selectedNFT.image} alt={selectedNFT.name} className="w-20 h-20 rounded-lg object-contain" />
                                                <div>
                                                    <h4 className="text-gray-900 dark:text-white font-bold">{selectedNFT.name}</h4>
                                                    <p className="text-gray-500 dark:text-gray-400 text-sm">#{selectedNFT.tokenId}</p>
                                                    <button onClick={() => setSelectedNFT(null)} className="text-yc-purple text-xs hover:underline">Change</button>
                                                </div>
                                            </>
                                        )}
                                    </div>

                                    {/* Sale Mode Tabs */}
                                    <div className="flex bg-gray-100 dark:bg-white/[0.03] rounded-2xl p-1 mb-4 border border-transparent dark:border-white/[0.06]">
                                        <button onClick={() => setSellMode('fixed')} className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${sellMode === 'fixed' ? 'bg-yc-purple/10 dark:bg-yc-purple/[0.12] text-yc-purple' : 'text-gray-500 dark:text-gray-500'}`}>
                                            <Tag className="w-4 h-4 inline mr-1" />Fixed Price
                                        </button>
                                        <button onClick={() => setSellMode('auction')} className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-all ${sellMode === 'auction' ? 'bg-yc-purple/10 dark:bg-yc-purple/[0.12] text-yc-purple' : 'text-gray-500 dark:text-gray-500'}`}>
                                            <Gavel className="w-4 h-4 inline mr-1" />Auction
                                        </button>
                                    </div>

                                    {sellMode === 'fixed' ? (
                                        <div>
                                            <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block">Price ({currencySymbol()})</label>
                                            <input type="number" step="0.01" value={sellPrice} onChange={e => setSellPrice(e.target.value)} placeholder="0.00" className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold focus:border-yc-purple focus:outline-none" />
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            <div>
                                                <label className="text-gray-500 dark:text-gray-400 text-sm mb-1 block">Start Price ({currencySymbol()})</label>
                                                <input type="number" step="0.01" value={auctionStartPrice} onChange={e => setAuctionStartPrice(e.target.value)} placeholder="0.00" className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold focus:border-yc-purple focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="text-gray-500 dark:text-gray-400 text-sm mb-1 block">Reserve Price ({currencySymbol()}, optional)</label>
                                                <input type="number" step="0.01" value={auctionReservePrice} onChange={e => setAuctionReservePrice(e.target.value)} placeholder="0.00" className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold focus:border-yc-purple focus:outline-none" />
                                            </div>
                                            <div>
                                                <label className="text-gray-500 dark:text-gray-400 text-sm mb-1 block">Duration (days)</label>
                                                <select value={auctionDuration} onChange={e => setAuctionDuration(e.target.value)} className="w-full bg-gray-50 dark:bg-white/[0.02] border border-gray-200 dark:border-white/[0.06] rounded-lg px-4 py-3 text-gray-900 dark:text-white font-bold focus:border-yc-purple focus:outline-none">
                                                    <option value="1">1 day</option>
                                                    <option value="3">3 days</option>
                                                    <option value="7">7 days</option>
                                                    <option value="14">14 days</option>
                                                </select>
                                            </div>
                                        </div>
                                    )}

                                    <button
                                        onClick={handleListNFT}
                                        disabled={isSelling || (sellMode === 'fixed' ? !sellPrice : !auctionStartPrice)}
                                        className="w-full mt-4 bg-yc-purple text-white font-bold py-3 rounded-2xl hover:bg-yc-purple/80 disabled:bg-gray-300 dark:disabled:bg-gray-800 disabled:text-gray-500 transition-all"
                                    >
                                        {isSelling ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : sellMode === 'fixed' ? 'List for Sale' : 'Create Auction'}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Onboarding Guide */}
            {showGuide && (
                <OnboardingGuide
                    steps={MARKETPLACE_GUIDE}
                    currentStep={guideStep}
                    onNext={() => guideNext(MARKETPLACE_GUIDE.length)}
                    onDismiss={guideDismiss}
                />
            )}
        </div>
    );
};

export default Marketplace;