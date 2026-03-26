// Pack opener contract hook — two-step: buy Pack NFT, then open it
import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { getPackOpenerContract, getPackNFTContract, getNFTContract, STARTUPS } from '../lib/contracts';
import { CardData, Rarity } from '../types';
import { blockchainCache, CacheKeys, CacheTTL } from '../lib/cache';
import { metadataUrl } from '../lib/api';
import { getActiveNetworkId } from '../lib/networks';

/** Extract maximum detail from an ethers/wallet error */
function serializeError(e: any): string {
    const parts: string[] = [];
    if (e.code) parts.push(`Code: ${e.code}`);
    if (e.reason) parts.push(`Reason: ${e.reason}`);
    if (e.message) parts.push(`Message: ${e.message}`);
    if (e.data) parts.push(`Data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`);
    if (e.shortMessage) parts.push(`Short: ${e.shortMessage}`);
    if (e.transaction?.hash) parts.push(`TX: ${e.transaction.hash}`);
    if (e.receipt?.hash) parts.push(`Receipt: ${e.receipt.hash}`);
    // Nested error (ethers v6 wraps errors)
    if (e.error) {
        parts.push(`Inner: ${e.error.message || JSON.stringify(e.error)}`);
        if (e.error.data) parts.push(`Inner data: ${typeof e.error.data === 'string' ? e.error.data : JSON.stringify(e.error.data)}`);
    }
    if (e.info?.error) {
        parts.push(`Info: ${e.info.error.message || JSON.stringify(e.info.error)}`);
        if (e.info.error.data) parts.push(`Info data: ${e.info.error.data}`);
    }
    if (parts.length === 0) {
        try { return JSON.stringify(e, null, 2); } catch { return String(e); }
    }
    return parts.join('\n');
}

// Map rarity strings to enum
const RARITY_STRING_MAP: Record<string, Rarity> = {
    'Common': Rarity.COMMON,
    'Rare': Rarity.RARE,
    'Epic': Rarity.EPIC,
    'Epic Rare': Rarity.EPIC_RARE,
    'EpicRare': Rarity.EPIC_RARE,
    'Legendary': Rarity.LEGENDARY,
};

// Fetch metadata from API with 5s timeout
async function fetchCardMetadata(tokenId: number): Promise<CardData | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(metadataUrl(`/${tokenId}`), { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) return null;

        const data = await response.json();

        const attributes = data.attributes || [];
        const getAttribute = (traitType: string) => {
            const attr = attributes.find((a: any) => a.trait_type === traitType);
            return attr?.value;
        };

        const rarityStr = getAttribute('Rarity') || 'Common';
        const multiplierStr = getAttribute('Multiplier') || '1x';

        const startupId = parseInt(getAttribute('Startup ID')) || 1;
        return {
            tokenId,
            startupId,
            name: getAttribute('Startup') || data.name?.split(' #')[0] || 'Unknown',
            rarity: RARITY_STRING_MAP[rarityStr] || Rarity.COMMON,
            multiplier: parseInt(multiplierStr) || 1,
            isLocked: getAttribute('Locked') === 'Yes',
            image: `/images/${startupId}.png`,
            edition: parseInt(getAttribute('Edition')) || 1,
        };
    } catch (e) {
        return null;
    }
}

export function usePacks() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Get current pack price - cache first, refresh in background
    const getPackPrice = useCallback(async (): Promise<bigint> => {
        const key = CacheKeys.packPrice();

        const cached = blockchainCache.get<bigint>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getPackOpenerContract();
                    return await contract.currentPackPrice();
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getPackOpenerContract();
            return await contract.currentPackPrice();
        }, CacheTTL.DEFAULT);
    }, []);

    // Get packs sold - cache first
    const getPacksSold = useCallback(async (): Promise<number> => {
        const key = CacheKeys.packsSold();

        const cached = blockchainCache.get<number>(key);
        if (cached !== undefined) {
            if (blockchainCache.isStale(key, CacheTTL.SHORT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const contract = getPackOpenerContract();
                    return Number(await contract.packsSold());
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const contract = getPackOpenerContract();
            return Number(await contract.packsSold());
        }, CacheTTL.SHORT);
    }, []);

    // Get user's owned (unopened) pack NFT token IDs — cache first, refresh in background
    const getUserPacks = useCallback(async (address: string): Promise<number[]> => {
        const key = CacheKeys.userUnopenedPacks(address);

        const cached = blockchainCache.get<number[]>(key);
        if (cached !== undefined) {
            // Refresh in background if stale
            if (blockchainCache.isStale(key, CacheTTL.DEFAULT)) {
                blockchainCache.fetchInBackground(key, async () => {
                    const packNft = getPackNFTContract();
                    const tokenIds = await packNft.getOwnedTokens(address);
                    return tokenIds.map((id: bigint) => Number(id));
                });
            }
            return cached;
        }

        return blockchainCache.getOrFetch(key, async () => {
            const packNft = getPackNFTContract();
            const tokenIds = await packNft.getOwnedTokens(address);
            return tokenIds.map((id: bigint) => Number(id));
        }, CacheTTL.DEFAULT);
    }, []);

    // Step 1: Buy pack(s) — mints Pack NFT(s) to buyer
    const buyPack = useCallback(async (
        signer: ethers.Signer,
        count: number = 1
    ): Promise<{ success: boolean; packTokenIds?: number[]; error?: string; rawError?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const packContract = getPackOpenerContract(signer);
            const signerAddress = await signer.getAddress();

            // Get referrer from localStorage or URL params
            let referrer = localStorage.getItem(`attentionx_referrer_${getActiveNetworkId()}`);
            if (!referrer) {
                const params = new URLSearchParams(window.location.search);
                const ref = params.get('ref');
                if (ref && ref.startsWith('0x') && ref.length === 42) {
                    referrer = ref.toLowerCase();
                }
            }
            if (referrer && referrer.toLowerCase() === signerAddress.toLowerCase()) {
                referrer = null;
            }

            const referrerAddress = referrer || ethers.ZeroAddress;
            const price = await packContract.currentPackPrice();

            let packTokenIds: number[];

            if (count === 1) {
                const tx = await packContract.buyPack(referrerAddress, {
                    value: BigInt(price.toString()),
                });
                const receipt = await tx.wait();

                // Parse PackMinted events from PackNFT to get token ID
                const packNft = getPackNFTContract(signer);
                const mintedIds: number[] = [];
                for (const log of receipt.logs) {
                    try {
                        const parsed = packNft.interface.parseLog(log);
                        if (parsed?.name === 'PackMinted') {
                            mintedIds.push(Number(parsed.args.tokenId));
                        }
                    } catch { }
                }
                // Fallback: parse PackPurchased event
                if (mintedIds.length === 0) {
                    for (const log of receipt.logs) {
                        try {
                            const parsed = packContract.interface.parseLog(log);
                            if (parsed?.name === 'PackPurchased') {
                                mintedIds.push(Number(parsed.args.packTokenId));
                            }
                        } catch { }
                    }
                }
                packTokenIds = mintedIds;
            } else {
                // Cap at 5 packs per tx to stay within block gas limit
                if (count > 5) {
                    return { success: false, error: 'Maximum 5 packs per transaction. Buy multiple times for more.' };
                }
                const totalPrice = BigInt(price.toString()) * BigInt(count);

                const tx = await packContract.buyMultiplePacks(referrerAddress, count, {
                    value: totalPrice,
                });
                const receipt = await tx.wait();

                const packNft = getPackNFTContract(signer);
                const mintedIds: number[] = [];
                for (const log of receipt.logs) {
                    try {
                        const parsed = packNft.interface.parseLog(log);
                        if (parsed?.name === 'PackMinted') {
                            mintedIds.push(Number(parsed.args.tokenId));
                        }
                    } catch { }
                }
                packTokenIds = mintedIds;
            }

            // Invalidate cache
            blockchainCache.invalidate(CacheKeys.packsSold());
            blockchainCache.invalidatePrefix(`pack:user:${signerAddress}`);
            blockchainCache.invalidate(CacheKeys.userUnopenedPacks(signerAddress));

            return { success: true, packTokenIds };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to buy pack';
            const raw = serializeError(e);
            setError(msg);
            return { success: false, error: msg, rawError: raw };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Step 2: Open a pack NFT — burns it and mints 5 card NFTs
    const openPack = useCallback(async (
        signer: ethers.Signer,
        packTokenId: number
    ): Promise<{ success: boolean; cards?: CardData[]; error?: string; rawError?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const packContract = getPackOpenerContract(signer);
            const nftContract = getNFTContract(signer);
            const signerAddress = await signer.getAddress();

            // Manual gas limit — each pack mints 5 ERC721Enumerable tokens (~150k each)
            const tx = await packContract.openPack(packTokenId, { gasLimit: 2_500_000 });

            const receipt = await tx.wait();

            // Parse CardMinted events to get token IDs + startup data
            const mintedTokens: { tokenId: number; startupId: number; edition: number }[] = [];
            for (const log of receipt.logs) {
                try {
                    const parsed = nftContract.interface.parseLog(log);
                    if (parsed?.name === 'CardMinted') {
                        mintedTokens.push({
                            tokenId: Number(parsed.args.tokenId),
                            startupId: Number(parsed.args.startupId),
                            edition: Number(parsed.args.edition),
                        });
                    }
                } catch { }
            }

            // Invalidate cache
            blockchainCache.invalidatePrefix(`nft:owned:${signerAddress}`);
            blockchainCache.invalidatePrefix(`nft:cards:${signerAddress}`);
            blockchainCache.invalidatePrefix(`pack:user:${signerAddress}`);
            blockchainCache.invalidate(CacheKeys.userUnopenedPacks(signerAddress));

            // Fetch metadata for all cards in parallel, fallback to event data
            const metadataResults = await Promise.all(
                mintedTokens.map(mt => fetchCardMetadata(mt.tokenId))
            );
            const cards: CardData[] = mintedTokens.map((mt, i) => {
                const card = metadataResults[i];
                if (card) return card;
                // Fallback: construct from on-chain event data
                const startup = STARTUPS[mt.startupId];
                return {
                    tokenId: mt.tokenId,
                    startupId: mt.startupId,
                    name: startup?.name || 'Unknown',
                    rarity: RARITY_STRING_MAP[startup?.rarity || 'Common'] || Rarity.COMMON,
                    multiplier: startup?.multiplier || 1,
                    isLocked: false,
                    image: `/images/${mt.startupId}.png`,
                    edition: mt.edition,
                };
            });
            cards.forEach(card => blockchainCache.set(CacheKeys.cardMetadata(card.tokenId), card));

            return { success: true, cards };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to open pack';
            const raw = serializeError(e);
            setError(msg);
            return { success: false, error: msg, rawError: raw };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Batch open multiple packs in a single transaction
    const batchOpenPacks = useCallback(async (
        signer: ethers.Signer,
        packTokenIds: number[]
    ): Promise<{ success: boolean; cards?: CardData[]; error?: string; rawError?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const packContract = getPackOpenerContract(signer);
            const nftContract = getNFTContract(signer);
            const signerAddress = await signer.getAddress();

            const gasLimit = 500_000 + packTokenIds.length * 2_000_000;
            const tx = await packContract.batchOpenPacks(packTokenIds, { gasLimit });
            const receipt = await tx.wait();

            // Parse CardMinted events to get all minted card info
            const mintedTokens: { tokenId: number; startupId: number; edition: number }[] = [];
            for (const log of receipt.logs) {
                try {
                    const parsed = nftContract.interface.parseLog(log);
                    if (parsed?.name === 'CardMinted') {
                        mintedTokens.push({
                            tokenId: Number(parsed.args.tokenId),
                            startupId: Number(parsed.args.startupId),
                            edition: Number(parsed.args.edition),
                        });
                    }
                } catch { }
            }

            // Invalidate cache
            blockchainCache.invalidatePrefix(`nft:owned:${signerAddress}`);
            blockchainCache.invalidatePrefix(`nft:cards:${signerAddress}`);
            blockchainCache.invalidatePrefix(`pack:user:${signerAddress}`);
            blockchainCache.invalidate(CacheKeys.userUnopenedPacks(signerAddress));

            // Fetch metadata for all cards in parallel, fallback to event data
            const metadataResults = await Promise.all(
                mintedTokens.map(mt => fetchCardMetadata(mt.tokenId))
            );
            const cards: CardData[] = mintedTokens.map((mt, i) => {
                const card = metadataResults[i];
                if (card) return card;
                const startup = STARTUPS[mt.startupId];
                return {
                    tokenId: mt.tokenId,
                    startupId: mt.startupId,
                    name: startup?.name || 'Unknown',
                    rarity: RARITY_STRING_MAP[startup?.rarity || 'Common'] || Rarity.COMMON,
                    multiplier: startup?.multiplier || 1,
                    isLocked: false,
                    image: `/images/${mt.startupId}.png`,
                    edition: mt.edition,
                };
            });
            cards.forEach(card => blockchainCache.set(CacheKeys.cardMetadata(card.tokenId), card));

            return { success: true, cards };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to open packs';
            const raw = serializeError(e);
            setError(msg);
            return { success: false, error: msg, rawError: raw };
        } finally {
            setIsLoading(false);
        }
    }, []);

    return {
        isLoading,
        error,
        getPackPrice,
        getPacksSold,
        getUserPacks,
        buyPack,
        openPack,
        batchOpenPacks,
    };
}
