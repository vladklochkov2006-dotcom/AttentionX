/**
 * React hook for SealedBidMarketplace — FHE sealed-bid trading.
 * Prices and bids are encrypted via CoFHE SDK.
 */

import { ethers } from 'ethers';
import { getSealedBidMarketplaceContract } from '../lib/contracts';
import { encryptUint32, isFhenixNetwork } from '../lib/fhenix';
import { getReadProvider } from '../lib/contracts';

export interface SealedListing {
    id: number;
    seller: string;
    tokenId: number;
    active: boolean;
    createdAt: number;
}

export interface SealedBidInfo {
    id: number;
    bidder: string;
    listingId: number;
    deposit: bigint;
    active: boolean;
}

/**
 * List an NFT with an encrypted minimum price.
 * The min price is encrypted client-side via CoFHE before submission.
 */
export async function listSealed(
    publicClient: any,
    walletClient: any,
    signer: ethers.Signer,
    tokenId: number,
    minPriceUnits: number
): Promise<string> {
    const contract = getSealedBidMarketplaceContract(signer);
    const encMinPrice = await encryptUint32(publicClient, walletClient, minPriceUnits);
    const tx = await contract.listSealed(tokenId, encMinPrice);
    const receipt = await tx.wait();
    return receipt.hash;
}

/**
 * Place a sealed bid on a listing.
 * The bid amount is encrypted; ETH deposit is sent as msg.value.
 */
export async function placeSealedBid(
    publicClient: any,
    walletClient: any,
    signer: ethers.Signer,
    listingId: number,
    bidAmountUnits: number,
    depositEth: string
): Promise<string> {
    const contract = getSealedBidMarketplaceContract(signer);
    const encBid = await encryptUint32(publicClient, walletClient, bidAmountUnits);
    const tx = await contract.placeSealedBid(listingId, encBid, {
        value: ethers.parseEther(depositEth),
    });
    const receipt = await tx.wait();
    return receipt.hash;
}

/**
 * Seller accepts a sealed bid — NFT goes to bidder, ETH to seller.
 */
export async function acceptSealedBid(
    signer: ethers.Signer,
    bidId: number
): Promise<string> {
    const contract = getSealedBidMarketplaceContract(signer);
    const tx = await contract.acceptSealedBid(bidId);
    const receipt = await tx.wait();
    return receipt.hash;
}

/**
 * Cancel a sealed listing — returns NFT, refunds all bids.
 */
export async function cancelSealedListing(
    signer: ethers.Signer,
    listingId: number
): Promise<string> {
    const contract = getSealedBidMarketplaceContract(signer);
    const tx = await contract.cancelSealedListing(listingId);
    const receipt = await tx.wait();
    return receipt.hash;
}

/**
 * Cancel a sealed bid — refunds ETH deposit.
 */
export async function cancelSealedBid(
    signer: ethers.Signer,
    bidId: number
): Promise<string> {
    const contract = getSealedBidMarketplaceContract(signer);
    const tx = await contract.cancelSealedBid(bidId);
    const receipt = await tx.wait();
    return receipt.hash;
}

/**
 * Fetch all active sealed listings.
 */
export async function getSealedListings(): Promise<SealedListing[]> {
    const contract = getSealedBidMarketplaceContract();
    const count = await contract.getListingCount();
    const listings: SealedListing[] = [];

    for (let i = 1; i <= Number(count); i++) {
        try {
            const [seller, tokenId, active, createdAt] = await contract.getListing(i);
            if (active) {
                listings.push({
                    id: i,
                    seller,
                    tokenId: Number(tokenId),
                    active,
                    createdAt: Number(createdAt),
                });
            }
        } catch {}
    }

    return listings;
}

/**
 * Fetch bids for a specific listing.
 */
export async function getBidsForListing(listingId: number): Promise<SealedBidInfo[]> {
    const contract = getSealedBidMarketplaceContract();
    const bidIds: bigint[] = await contract.getBidsForListing(listingId);
    const bids: SealedBidInfo[] = [];

    for (const bidId of bidIds) {
        try {
            const [bidder, lid, deposit, active] = await contract.getBid(Number(bidId));
            if (active) {
                bids.push({
                    id: Number(bidId),
                    bidder,
                    listingId: Number(lid),
                    deposit,
                    active,
                });
            }
        } catch {}
    }

    return bids;
}
