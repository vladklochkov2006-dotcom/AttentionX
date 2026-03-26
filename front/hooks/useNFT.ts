// NFT contract hook with metadata fetching
import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { getNFTContract, STARTUPS } from '../lib/contracts';
import { CardData, Rarity } from '../types';
import { blockchainCache, CacheKeys, CacheTTL } from '../lib/cache';
import { apiUrl, metadataUrl } from '../lib/api';

// Map rarity strings to enum
const RARITY_STRING_MAP: Record<string, Rarity> = {
    'Common': Rarity.COMMON,
    'Rare': Rarity.RARE,
    'Epic': Rarity.EPIC,
    'Epic Rare': Rarity.EPIC_RARE,
    'EpicRare': Rarity.EPIC_RARE,
    'Legendary': Rarity.LEGENDARY,
};

// Fetch items in batches (used as fallback when batch endpoint fails)
async function fetchInBatches<T>(
    items: number[],
    fn: (id: number) => Promise<T>,
    batchSize = 5,
    delayMs = 200
): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
        if (i + batchSize < items.length) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return results;
}

// Deduplication for in-flight batch requests — prevents duplicate fetches from React re-renders
let pendingBatchRequest: Promise<Record<number, any>> | null = null;
let pendingBatchIds: string = '';

// Deduplication for getCards — if a fetch for an address is already running, reuse its promise
const pendingGetCards = new Map<string, Promise<CardData[]>>();

// Reset module-level dedup state (called on network switch to prevent cross-chain data leakage)
export function resetNFTModuleState(): void {
    pendingBatchRequest = null;
    pendingBatchIds = '';
    pendingGetCards.clear();
}

// Parse single token metadata response into CardData
function parseMetadataResponse(tokenId: number, data: any): CardData {
    const attributes = data.attributes || [];
    const getAttribute = (traitType: string) => {
        const attr = attributes.find((a: any) => a.trait_type === traitType);
        return attr?.value;
    };

    const rarityStr = getAttribute('Rarity') || 'Common';
    const multiplierStr = getAttribute('Multiplier') || '1x';
    const edition = parseInt(getAttribute('Edition')) || 1;
    const startupId = parseInt(getAttribute('Startup ID')) || 1;
    const isLocked = getAttribute('Locked') === 'Yes';

    return {
        tokenId,
        startupId,
        name: getAttribute('Startup') || data.name?.split(' #')[0] || 'Unknown',
        rarity: RARITY_STRING_MAP[rarityStr] || Rarity.COMMON,
        multiplier: parseInt(multiplierStr) || 1,
        isLocked,
        image: `/images/${startupId}.png`,
        edition,
        fundraising: data.fundraising || null,
        description: data.description || null,
    };
}

export function useNFT() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fetch metadata from backend API with caching + request deduplication
    // Card metadata is cached for 5 minutes — allows refresh after contract upgrades
    const fetchMetadata = useCallback(async (tokenId: number): Promise<CardData | null> => {
        const key = CacheKeys.cardMetadata(tokenId);

        const result = await blockchainCache.getOrFetch(key, async () => {
            try {
                const response = await fetch(metadataUrl(`/${tokenId}`));
                if (!response.ok) return null;
                const data = await response.json();
                return parseMetadataResponse(tokenId, data);
            } catch (e) {
                return null;
            }
        }, CacheTTL.LONG);

        if (result === null) {
            blockchainCache.invalidate(key);
        }
        return result;
    }, []);

    // Batch fetch: single request for all tokens, populates individual cache entries
    // Uses module-level dedup to prevent duplicate requests from React re-renders
    const fetchMetadataBatch = useCallback(async (tokenIds: number[]): Promise<(CardData | null)[]> => {
        if (tokenIds.length === 0) return [];

        // Check cache first — only fetch uncached tokens
        const results: (CardData | null)[] = new Array(tokenIds.length).fill(null);
        const uncachedIndices: number[] = [];

        for (let i = 0; i < tokenIds.length; i++) {
            const cached = blockchainCache.get<CardData>(CacheKeys.cardMetadata(tokenIds[i]));
            if (cached !== undefined) {
                results[i] = cached;
            } else {
                uncachedIndices.push(i);
            }
        }

        if (uncachedIndices.length === 0) {
            return results;
        }

        const uncachedIds = uncachedIndices.map(i => tokenIds[i]);

        try {
            // Chunk into batches of 50 (server limit)
            const BATCH_SIZE = 50;
            const allTokens: Record<string, any> = {};
            const allErrors: Record<string, string> = {};

            for (let ci = 0; ci < uncachedIds.length; ci += BATCH_SIZE) {
                const chunk = uncachedIds.slice(ci, ci + BATCH_SIZE);
                const chunkKey = chunk.sort((a, b) => a - b).join(',');

                let batchData: Record<string, any>;

                // Dedup: if identical batch is already in-flight, reuse it
                if (pendingBatchRequest && pendingBatchIds === chunkKey) {
                    batchData = await pendingBatchRequest;
                } else {
                    const request = fetch(metadataUrl(`/batch?tokenIds=${chunk.join(',')}`))
                        .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
                    pendingBatchIds = chunkKey;
                    pendingBatchRequest = request;
                    batchData = await request;
                    pendingBatchRequest = null;
                    pendingBatchIds = '';
                }

                Object.assign(allTokens, batchData.tokens || {});
                Object.assign(allErrors, batchData.errors || {});
            }


            for (const idx of uncachedIndices) {
                const tid = tokenIds[idx];
                const tokenMeta = allTokens[tid];
                if (tokenMeta) {
                    const card = parseMetadataResponse(tid, tokenMeta);
                    results[idx] = card;
                    blockchainCache.set(CacheKeys.cardMetadata(tid), card);
                } else if (allErrors[tid]) {
                }
            }

            return results;
        } catch (e) {
            pendingBatchRequest = null;
            pendingBatchIds = '';
            console.warn('[NFT] Batch metadata failed, falling back to individual fetches:', (e as Error).message);
            const fallbackCards = await fetchInBatches(uncachedIds, fetchMetadata, 10, 50);
            for (let fi = 0; fi < uncachedIndices.length; fi++) {
                results[uncachedIndices[fi]] = fallbackCards[fi];
            }
            return results;
        }
    }, [fetchMetadata]);

    // Get all tokens owned by address - with caching and polling
    const getOwnedTokens = useCallback(async (address: string): Promise<number[]> => {
        const key = CacheKeys.ownedTokens(address);

        // Check cache first
        const cached = blockchainCache.get<number[]>(key);
        if (cached !== undefined) {
            // Subscribe for updates if not already done (will handle polling)
            // We don't need a persistent subscription here as the hook consumer
            // should use usePollingData for that. This just ensures fresh data if stale
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getNFTContract();
                    const tokens = await contract.getOwnedTokens(address);
                    return tokens.map((t: bigint) => Number(t));
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getNFTContract();
            const tokens = await contract.getOwnedTokens(address);
            return tokens.map((t: bigint) => Number(t));
        }, CacheTTL.DEFAULT);
    }, []);

    // Fallback: read card info directly from the smart contract when metadata server is down
    const fetchCardFromContract = useCallback(async (tokenId: number): Promise<CardData | null> => {
        try {
            const contract = getNFTContract();
            const info = await contract.getCardInfo(tokenId);
            const startupId = Number(info.startupId);
            const startup = STARTUPS[startupId];
            if (!startup) return null;

            const rarityEnum = Number(info.rarity);
            const rarity = [Rarity.COMMON, Rarity.RARE, Rarity.EPIC, Rarity.EPIC_RARE, Rarity.LEGENDARY][rarityEnum] || Rarity.COMMON;

            return {
                tokenId,
                startupId,
                name: startup.name,
                rarity,
                multiplier: Number(info.multiplier),
                isLocked: info.isLocked,
                image: `/images/${startupId}.png`,
                edition: Number(info.edition),
                fundraising: null,
                description: null,
            };
        } catch (e) {
            return null;
        }
    }, []);

    // Get card info with retries + contract fallback (for merge results where metadata may be delayed)
    const getCardInfoWithRetry = useCallback(async (tokenId: number, retries = 3, delayMs = 2000): Promise<CardData | null> => {
        for (let i = 0; i < retries; i++) {
            const card = await fetchMetadata(tokenId);
            if (card) return card;
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
        // All retries failed — fall back to contract data
        return fetchCardFromContract(tokenId);
    }, [fetchMetadata, fetchCardFromContract]);

    // Get card info for a token (from API with proper metadata)
    const getCardInfo = useCallback(async (tokenId: number): Promise<CardData | null> => {
        return await fetchMetadata(tokenId);
    }, [fetchMetadata]);

    // Server API: fetch cards from DB cache (single HTTP request, ~50ms)
    const fetchCardsFromServer = useCallback(async (address: string): Promise<CardData[] | null> => {
        try {
            const res = await fetch(apiUrl(`/player/${address.toLowerCase()}/nfts`));
            if (!res.ok) return null;
            const json = await res.json();
            if (!json.success || !json.data) return null;

            return json.data.map((c: any) => ({
                tokenId: c.tokenId,
                startupId: c.startupId,
                name: c.name,
                rarity: RARITY_STRING_MAP[c.rarity] || Rarity.COMMON,
                multiplier: c.multiplier,
                edition: c.edition || 1,
                isLocked: c.isLocked || false,
                image: c.image || `/images/${c.startupId}.png`,
                fundraising: null,
                description: null,
            }));
        } catch {
            return null;
        }
    }, []);

    // Push full card list to server DB cache (for initial population)
    const pushCardsToServer = useCallback(async (address: string, cards: CardData[]): Promise<void> => {
        try {
            await fetch(apiUrl(`/player/${address.toLowerCase()}/nfts`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cards: cards.map(c => ({
                        tokenId: c.tokenId,
                        startupId: c.startupId,
                        name: c.name,
                        rarity: c.rarity,
                        multiplier: c.multiplier,
                        edition: c.edition || 1,
                        isLocked: c.isLocked || false,
                    })),
                }),
            });
        } catch { /* ignore */ }
    }, []);

    // Incremental server cache update (add new cards / remove burned cards)
    const updateServerCache = useCallback(async (
        address: string,
        add?: CardData[],
        remove?: number[]
    ): Promise<void> => {
        try {
            await fetch(apiUrl(`/player/${address.toLowerCase()}/nfts`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    add: add?.map(c => ({
                        tokenId: c.tokenId,
                        startupId: c.startupId,
                        name: c.name,
                        rarity: c.rarity,
                        multiplier: c.multiplier,
                        edition: c.edition || 1,
                        isLocked: c.isLocked || false,
                    })),
                    remove,
                }),
            });
        } catch { /* ignore */ }
    }, []);

    // Fetch cards from blockchain, cache everywhere, push to server
    const fetchCardsFromBlockchain = useCallback(async (address: string): Promise<CardData[]> => {
        const tokenIds = await getOwnedTokens(address);
        if (tokenIds.length === 0) return [];

        const cards = await fetchMetadataBatch(tokenIds);

        const nullIndices = cards.map((c, i) => c === null ? i : -1).filter(i => i >= 0);
        if (nullIndices.length > 0) {
            const fallbacks = await fetchInBatches(
                nullIndices.map(i => tokenIds[i]),
                fetchCardFromContract, 5, 100
            );
            fallbacks.forEach((card, fi) => {
                if (card) cards[nullIndices[fi]] = card;
            });
        }

        const validCards = cards.filter((c): c is CardData => c !== null);

        // Verify isLocked directly against the NFT contract for cards showing as locked.
        // The metadata server caches isLocked for up to 1 hour, so after tournament ends
        // or contract changes, the cached value can be stale. Direct contract call is real-time.
        const lockedCards = validCards.filter(c => c.isLocked);
        if (lockedCards.length > 0) {
            try {
                const contract = getNFTContract();
                const lockChecks = await Promise.all(
                    lockedCards.map(c => contract.isLocked(c.tokenId).catch(() => true))
                );
                let fixedCount = 0;
                lockedCards.forEach((card, i) => {
                    if (!lockChecks[i]) {
                        card.isLocked = false;
                        // Also fix the individual metadata cache entry
                        const metaKey = CacheKeys.cardMetadata(card.tokenId);
                        const cached = blockchainCache.get<CardData>(metaKey);
                        if (cached) {
                            blockchainCache.set(metaKey, { ...cached, isLocked: false });
                        }
                        fixedCount++;
                    }
                });
                if (fixedCount > 0) {
                    console.log(`[NFT] Fixed ${fixedCount} stale isLocked status from metadata cache`);
                }
            } catch (e) {
                // Contract call failed — keep metadata server values
            }
        }

        const cardsKey = CacheKeys.userCards(address);
        blockchainCache.set(cardsKey, validCards);
        blockchainCache.persistKeys('nft:');

        // Push to server DB cache in background
        pushCardsToServer(address, validCards);

        return validCards;
    }, [getOwnedTokens, fetchMetadataBatch, fetchCardFromContract, pushCardsToServer]);

    // Get all cards for an address — returns fast from cache/server, then validates against blockchain.
    // Pass forceRefresh=true after mutations (merge, pack open, purchase) to skip all caches.
    const getCards = useCallback(async (address: string, forceRefresh = false): Promise<CardData[]> => {
        const addrKey = address.toLowerCase();

        // If already fetching for this address, return the in-flight promise
        if (!forceRefresh) {
            const pending = pendingGetCards.get(addrKey);
            if (pending) {
                return pending;
            }
        }

        const doFetch = async (): Promise<CardData[]> => {
            setIsLoading(true);
            setError(null);

            try {
                if (forceRefresh) {
                    // Force: skip all caches, go straight to blockchain
                    return await fetchCardsFromBlockchain(address);
                }

                // Try fast sources first (server DB / local cache) for instant UI
                let fastCards: CardData[] | null = null;

                const serverCards = await fetchCardsFromServer(address);
                if (serverCards && serverCards.length > 0) {
                    fastCards = serverCards;
                } else {
                    const cardsKey = CacheKeys.userCards(address);
                    const localCached = blockchainCache.get<CardData[]>(cardsKey);
                    if (localCached && localCached.length > 0) {
                        fastCards = localCached;
                    }
                }

                if (fastCards) {
                    // Store in local cache for immediate use
                    const cardsKey = CacheKeys.userCards(address);
                    blockchainCache.set(cardsKey, fastCards);

                    // ALWAYS validate against blockchain in background.
                    // This catches stale server data after contract changes.
                    // If ownership count differs, the blockchain data will overwrite.
                    fetchCardsFromBlockchain(address).catch(() => {});

                    return fastCards;
                }

                // No cached data anywhere — must fetch from blockchain
                return await fetchCardsFromBlockchain(address);
            } catch (e: any) {
                const cardsKey = CacheKeys.userCards(address);
                const cached = blockchainCache.get<CardData[]>(cardsKey);
                if (cached && cached.length > 0) {
                    return cached;
                }
                setError(e.message);
                return [];
            } finally {
                setIsLoading(false);
                pendingGetCards.delete(addrKey);
            }
        };

        const promise = doFetch();
        pendingGetCards.set(addrKey, promise);
        return promise;
    }, [fetchCardsFromBlockchain, fetchCardsFromServer]);

    // Rarity names for logging
    const RARITY_NAMES = ['Common', 'Rare', 'Epic', 'EpicRare', 'Legendary'];

    // Merge 3 cards into 1 higher rarity
    const mergeCards = useCallback(async (
        signer: ethers.Signer,
        tokenIds: [number, number, number]
    ): Promise<{ success: boolean; newTokenId?: number; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getNFTContract(signer);

            // Pre-merge on-chain rarity verification to prevent RarityMismatch errors
            // The cached/metadata rarity might not match on-chain state after upgrades
            try {
                const readContract = getNFTContract(); // read-only provider
                const cardInfos = await Promise.all(
                    tokenIds.map(id => readContract.getCardInfo(id))
                );
                const onChainRarities = cardInfos.map(info => Number(info.rarity));

                // Check all cards have the same on-chain rarity
                if (onChainRarities[0] !== onChainRarities[1] || onChainRarities[0] !== onChainRarities[2]) {
                    // Fix stale cache: update individual card metadata with on-chain rarity
                    const rarityEnumMap = [Rarity.COMMON, Rarity.RARE, Rarity.EPIC, Rarity.EPIC_RARE, Rarity.LEGENDARY];
                    for (let i = 0; i < tokenIds.length; i++) {
                        const key = CacheKeys.cardMetadata(tokenIds[i]);
                        const cached = blockchainCache.get<CardData>(key);
                        if (cached && cached.rarity !== rarityEnumMap[onChainRarities[i]]) {
                            blockchainCache.set(key, {
                                ...cached,
                                rarity: rarityEnumMap[onChainRarities[i]],
                                multiplier: Number(cardInfos[i].multiplier),
                            });
                        }
                    }
                    blockchainCache.persistKeys('nft:');

                    const details = tokenIds.map((id, i) =>
                        `Token #${id}: ${RARITY_NAMES[onChainRarities[i]] || 'Unknown'}`
                    ).join(', ');
                    const errorMsg = `On-chain rarity mismatch! ${details}. Card data has been refreshed — please re-select cards.`;
                    setError(errorMsg);
                    return { success: false, error: errorMsg };
                }

                // Also check that multipliers are not all 0 (indicates startups mapping is uninitialized)
                const allMultipliersZero = cardInfos.every(info => Number(info.multiplier) === 0);
                if (allMultipliersZero) {
                    const errorMsg = 'Contract startup data appears uninitialized (all multipliers are 0). Admin must call reinitializeStartups().';
                    setError(errorMsg);
                    return { success: false, error: errorMsg };
                }
            } catch (verifyError: any) {
            }

            const tx = await contract.mergeCards(tokenIds);
            const receipt = await tx.wait();

            // Parse CardsMerged event to get new token ID
            let newTokenId: number | undefined;
            for (const log of receipt.logs) {
                try {
                    const parsed = contract.interface.parseLog(log);
                    if (parsed?.name === 'CardsMerged') {
                        newTokenId = Number(parsed.args.newTokenId);
                        break;
                    }
                } catch { }
            }

            // Clear cache for merged (burned) cards and invalidate user's card list
            tokenIds.forEach(id => blockchainCache.invalidate(CacheKeys.cardMetadata(id)));
            // Also invalidate the new card's cache to force fresh fetch
            if (newTokenId) {
                blockchainCache.invalidate(CacheKeys.cardMetadata(newTokenId));
            }
            const signerAddress = await signer.getAddress();
            blockchainCache.invalidatePrefix(`nft:owned:${signerAddress}`);
            blockchainCache.invalidatePrefix(`nft:cards:${signerAddress}`);
            blockchainCache.invalidatePrefix(`nft:prevTokenIds:${signerAddress}`);
            blockchainCache.persistKeys('nft:');

            return { success: true, newTokenId };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Merge failed';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Check if token is locked
    const isLocked = useCallback(async (tokenId: number): Promise<boolean> => {
        try {
            const contract = getNFTContract();
            return await contract.isLocked(tokenId);
        } catch {
            return false;
        }
    }, []);

    // Clear all NFT-related cache (in-memory + localStorage)
    const clearCache = useCallback(() => {
        blockchainCache.invalidatePrefix('nft:');
        blockchainCache.clearPersistedKeys('nft:');
    }, []);

    return {
        isLoading,
        error,
        getOwnedTokens,
        getCardInfo,
        getCardInfoWithRetry,
        getCards,
        mergeCards,
        isLocked,
        clearCache,
        pushCardsToServer,
        updateServerCache,
    };
}
