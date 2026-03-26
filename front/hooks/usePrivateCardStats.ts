// Hook for private card stats via EncryptedCardStats contract
// Only the card owner can see their card's encrypted power level.

import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import { getActiveNetwork } from '../lib/networks';
import { decryptForView, isFhenixNetwork } from '../lib/fhenix';

const ENCRYPTED_CARD_STATS_ABI = [
    'function getMyCardPower(uint256 tokenId) view returns (uint256)',
    'function statsSet(uint256 tokenId) view returns (bool)',
    'function updateOwnerPermission(uint256 tokenId)',
];

function getEncryptedCardStatsContract(signerOrProvider: ethers.Signer | ethers.Provider) {
    const network = getActiveNetwork();
    const addr = (network.contracts as any).EncryptedCardStats;
    if (!addr) throw new Error('EncryptedCardStats not deployed on this network');
    return new ethers.Contract(addr, ENCRYPTED_CARD_STATS_ABI, signerOrProvider);
}

/**
 * Hook for accessing private encrypted card stats.
 * - Only the card owner can view their card's hidden power level.
 * - Uses FHE re-encryption with a permit for off-chain decryption.
 */
export function usePrivateCardStats() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /**
     * Get the decrypted power level of a card you own.
     * Returns null if not on a Fhenix network or if stats aren't set.
     */
    const getMyCardPower = useCallback(async (
        publicClient: any,
        walletClient: any,
        signer: ethers.Signer,
        tokenId: number
    ): Promise<number | null> => {
        if (!isFhenixNetwork()) return null;
        setIsLoading(true);
        setError(null);

        try {
            const contract = getEncryptedCardStatsContract(signer);

            // Check if stats have been set for this card
            const hasStats = await contract.statsSet(tokenId);
            if (!hasStats) return null;

            // Get ciphertext handle
            const ctHash = await contract.getMyCardPower(tokenId);

            // Decrypt off-chain via CoFHE SDK
            const plaintext = await decryptForView(publicClient, walletClient, ctHash, 'Uint32');

            return Number(plaintext);
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to get card power';
            setError(msg);
            return null;
        } finally {
            setIsLoading(false);
        }
    }, []);

    /**
     * Update FHE permission after receiving a card via transfer.
     * New owners need to call this before they can decrypt stats.
     */
    const updatePermission = useCallback(async (
        signer: ethers.Signer,
        tokenId: number
    ): Promise<boolean> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getEncryptedCardStatsContract(signer);
            const tx = await contract.updateOwnerPermission(tokenId);
            await tx.wait();
            return true;
        } catch (e: any) {
            setError(e.reason || e.message || 'Failed to update permission');
            return false;
        } finally {
            setIsLoading(false);
        }
    }, []);

    return {
        isLoading,
        error,
        getMyCardPower,
        updatePermission,
        isFhenixNetwork: isFhenixNetwork(),
    };
}
