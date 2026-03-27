// Admin contract operations hook
import { useState, useCallback } from 'react';
import { ethers } from 'ethers';
import {
    getNFTContract,
    getPackOpenerContract,
    getTournamentContract,
    getMarketplaceV2Contract,
    formatXTZ,
    getActiveContracts,
    STARTUPS,
} from '../lib/contracts';
import { getActiveNetwork } from '../lib/networks';
import { TOURNAMENT_FHE_ABI } from './useTournamentFHE';

// Admin addresses (multi-admin support)
export const ADMIN_ADDRESSES = [
    '0x233c8C54F25734B744E522bdC1Eed9cbc8C97D0c',
    '0xB36402e87a86206D3a114a98B53f31362291fe1B',
    '0xd5C9B9a6E16112B8985280c07462E3b358C3844F', // deployer/owner
].map(a => a.toLowerCase());

export function isAdmin(address: string | null): boolean {
    if (!address) return false;
    return ADMIN_ADDRESSES.includes(address.toLowerCase());
}

export interface ContractBalances {
    nft: bigint;
    packOpener: bigint;
    tournament: bigint;
}

export interface RarityStats {
    common: number;
    rare: number;
    epic: number;
    legendary: number;
}

export interface AdminStats {
    packsSold: number;
    packPrice: bigint;
    totalNFTs: number;
    activeTournamentId: number;
    nextTournamentId: number;
    rarityStats: RarityStats;
    marketplaceVolume: bigint;
    marketplaceSales: number;
    royaltiesEarned: bigint;
    uniqueBuyers: number;
}

export interface TournamentData {
    id: number;
    registrationStart: number;
    startTime: number;
    endTime: number;
    prizePool: bigint;
    entryCount: number;
    status: number; // 0=Created, 1=Active, 2=Finalized, 3=Cancelled
}

// ABI extensions for FHE admin functions (not in the base TOURNAMENT_FHE_ABI)
const TOURNAMENT_FHE_ADMIN_ABI = [
    ...TOURNAMENT_FHE_ABI,
    // Admin write functions
    'function createTournament(uint256 registrationStart, uint256 startTime, uint256 endTime) returns (uint256)',
    'function setEncryptedPoints(uint256 tournamentId, tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)[19] inPoints)',
    'function setPointsFromPlaintext(uint256 tournamentId, uint32[19] rawPoints)',
    'function computeEncryptedScores(uint256 tournamentId, uint256 batchStart, uint256 batchSize)',
    'function finalizeScores(uint256 tournamentId)',
    'function computeDarkRanks(uint256 tournamentId, uint256 batchStart, uint256 batchSize)',
    'function finalizeWithPrizes(uint256 tournamentId, address[] winners, uint256[] amounts)',
    'function cancelTournament(uint256 tournamentId)',
    'function pointsFinalized(uint256 tournamentId) view returns (bool)',
    'function scoresComputed(uint256 tournamentId) view returns (bool)',
    'function pause()',
    'function unpause()',
    // Events
    'event TournamentCreated(uint256 indexed tournamentId, uint256 registrationStart, uint256 startTime, uint256 endTime)',
    'event EncryptedPointsSet(uint256 indexed tournamentId)',
    'event ScoresBatchComputed(uint256 indexed tournamentId, uint256 batchStart, uint256 batchEnd)',
    'event ScoresFinalized(uint256 indexed tournamentId, uint256 participantCount)',
    'event TournamentFinalized(uint256 indexed tournamentId, uint256 prizePool, uint256 participantCount)',
];

function getTournamentFHEAdminContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
    const network = getActiveNetwork();
    const addr = network.contracts.TournamentManagerFHE;
    if (!addr) throw new Error('TournamentManagerFHE not deployed on active network');
    const provider = signerOrProvider || new ethers.JsonRpcProvider(network.rpcUrl);
    return new ethers.Contract(addr, TOURNAMENT_FHE_ADMIN_ABI, provider);
}

export interface TournamentFHEData {
    id: number;
    registrationStart: number;
    startTime: number;
    revealDeadline: number;
    endTime: number;
    prizePool: bigint;
    entryCount: number;
    status: number;
    pointsFinalized?: boolean;
    scoresComputed?: boolean;
}

export function useAdmin() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ============ READ FUNCTIONS ============

    // Get contract balances using CONTRACTS addresses directly
    const getContractBalances = useCallback(async (): Promise<ContractBalances> => {
        try {
            const network = getActiveNetwork();
            const contracts = getActiveContracts();
            const provider = new ethers.JsonRpcProvider(network.rpcUrl);

            const [nft, packOpener, tournament] = await Promise.all([
                provider.getBalance(contracts.AttentionX_NFT),
                provider.getBalance(contracts.PackOpener),
                provider.getBalance(contracts.TournamentManager),
            ]);

            return { nft, packOpener, tournament };
        } catch (e) {
            return { nft: BigInt(0), packOpener: BigInt(0), tournament: BigInt(0) };
        }
    }, []);

    // Get admin stats
    const getAdminStats = useCallback(async (): Promise<AdminStats> => {
        const emptyRarity: RarityStats = { common: 0, rare: 0, epic: 0, legendary: 0 };
        try {
            const packContract = getPackOpenerContract();
            const nftContract = getNFTContract();
            const tournamentContract = getTournamentContract();
            const marketplaceContract = getMarketplaceV2Contract();

            // Fetch basic stats + marketplace global stats in parallel
            const [packsSold, packPrice, totalNFTs, activeTournamentId, nextTournamentId, globalStats] = await Promise.all([
                packContract.packsSold(),
                packContract.currentPackPrice(),
                nftContract.totalSupply(),
                packContract.activeTournamentId(),
                tournamentContract.nextTournamentId(),
                marketplaceContract.getGlobalStats(),
            ]);

            // Fetch mint count for each of the 19 startups to build rarity breakdown
            const startupIds = Array.from({ length: 19 }, (_, i) => i + 1);
            const mintCounts = await Promise.all(
                startupIds.map(id => nftContract.startupMintCount(id).catch(() => 0n))
            );

            // Aggregate by rarity using the STARTUPS constant (no extra RPC calls needed)
            const rarityStats: RarityStats = { common: 0, rare: 0, epic: 0, legendary: 0 };
            startupIds.forEach((id, idx) => {
                const count = Number(mintCounts[idx]);
                const rarity = STARTUPS[id]?.rarity;
                if (rarity === 'Legendary') rarityStats.legendary += count;
                else if (rarity === 'Epic') rarityStats.epic += count;
                else if (rarity === 'Rare') rarityStats.rare += count;
                else rarityStats.common += count;
            });

            const marketplaceVolume = globalStats[0] as bigint;
            const marketplaceSales = Number(globalStats[1]);
            // Royalties = 2% of total marketplace volume (ERC-2981: ROYALTY_FEE = 200 bp)
            const royaltiesEarned = marketplaceVolume * 200n / 10000n;

            // Unique buyers — read directly from contract (added in upgrade v2)
            let uniqueBuyers = 0;
            try {
                uniqueBuyers = Number(await packContract.uniqueBuyerCount());
            } catch {
                // contract not yet upgraded — fallback to 0
            }

            return {
                packsSold: Number(packsSold),
                packPrice,
                totalNFTs: Number(totalNFTs),
                activeTournamentId: Number(activeTournamentId),
                nextTournamentId: Number(nextTournamentId),
                rarityStats,
                marketplaceVolume,
                marketplaceSales,
                royaltiesEarned,
                uniqueBuyers,
            };
        } catch (e) {
            return {
                packsSold: 0, packPrice: BigInt(5e18), totalNFTs: 0,
                activeTournamentId: 0, nextTournamentId: 0,
                rarityStats: emptyRarity, marketplaceVolume: 0n, marketplaceSales: 0, royaltiesEarned: 0n,
                uniqueBuyers: 0,
            };
        }
    }, []);

    // Get all tournaments
    const getTournaments = useCallback(async (): Promise<TournamentData[]> => {
        try {
            const contract = getTournamentContract();
            const nextId = await contract.nextTournamentId();
            const count = Number(nextId);


            const tournaments: TournamentData[] = [];
            for (let i = 0; i < count; i++) {
                try {
                    const t = await contract.getTournament(i);
                    tournaments.push({
                        id: Number(t.id),
                        registrationStart: Number(t.registrationStart),
                        startTime: Number(t.startTime),
                        endTime: Number(t.endTime),
                        prizePool: t.prizePool,
                        entryCount: Number(t.entryCount),
                        status: Number(t.status),
                    });
                } catch (e) {
                }
            }

            return tournaments;
        } catch (e) {
            return [];
        }
    }, []);

    // ============ PACK OPENER ADMIN ============

    // Withdraw funds from PackOpener
    const withdrawPackOpener = useCallback(async (signer: ethers.Signer): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getPackOpenerContract(signer);

            const tx = await contract.withdraw();
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Withdrawal failed';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Set pack price
    const setPackPrice = useCallback(async (
        signer: ethers.Signer,
        priceInXTZ: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getPackOpenerContract(signer);
            const priceWei = ethers.parseEther(priceInXTZ.toString());

            const tx = await contract.setPackPrice(priceWei);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to set price';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Set active tournament
    const setActiveTournament = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getPackOpenerContract(signer);

            const tx = await contract.setActiveTournament(tournamentId);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to set tournament';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // ============ TOURNAMENT ADMIN ============

    // Create tournament
    const createTournament = useCallback(async (
        signer: ethers.Signer,
        registrationStart: number, // Unix timestamp
        startTime: number,
        endTime: number
    ): Promise<{ success: boolean; tournamentId?: number; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);

            const tx = await contract.createTournament(
                registrationStart,
                startTime,
                endTime
            );
            const receipt = await tx.wait();

            // Parse event to get tournament ID
            let tournamentId: number | undefined;
            for (const log of receipt.logs) {
                try {
                    const parsed = contract.interface.parseLog(log);
                    if (parsed?.name === 'TournamentCreated') {
                        tournamentId = Number(parsed.args.tournamentId);
                        break;
                    }
                } catch { }
            }

            return { success: true, tournamentId };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to create tournament';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Finalize tournament with winners
    const finalizeTournament = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        winners: string[],
        amounts: bigint[]
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);

            const tx = await contract.finalizeTournament(
                tournamentId,
                winners,
                amounts
            );
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to finalize';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Finalize tournament with points-based distribution
    const finalizeWithPoints = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        points: bigint[] // Array of 19 points for startupIds 1-19
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            if (points.length !== 19) {
                throw new Error('Must provide exactly 19 points values');
            }

            const contract = getTournamentContract(signer);

            const tx = await contract.finalizeWithPoints(
                tournamentId,
                points
            );
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to finalize with points';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Cancel tournament
    const cancelTournament = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);

            const tx = await contract.cancelTournament(tournamentId);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to cancel';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Withdraw from specific tournament prize pool
    const withdrawFromPrizePool = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        amount: bigint,
        to: string
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);

            const tx = await contract.withdrawFromPrizePool(
                tournamentId,
                amount,
                to
            );
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Withdrawal failed';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Emergency withdraw from TournamentManager
    const emergencyWithdrawTournament = useCallback(async (
        signer: ethers.Signer,
        amount: bigint,
        to: string
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentContract(signer);

            const tx = await contract.emergencyWithdraw(amount, to);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Withdrawal failed';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // ============ PAUSE/UNPAUSE ============

    const pausePackOpener = useCallback(async (signer: ethers.Signer) => {
        const contract = getPackOpenerContract(signer);
        const tx = await contract.pause();
        await tx.wait();
    }, []);

    const unpausePackOpener = useCallback(async (signer: ethers.Signer) => {
        const contract = getPackOpenerContract(signer);
        const tx = await contract.unpause();
        await tx.wait();
    }, []);

    const pauseTournament = useCallback(async (signer: ethers.Signer) => {
        const contract = getTournamentContract(signer);
        const tx = await contract.pause();
        await tx.wait();
    }, []);

    const unpauseTournament = useCallback(async (signer: ethers.Signer) => {
        const contract = getTournamentContract(signer);
        const tx = await contract.unpause();
        await tx.wait();
    }, []);

    // ============ FHE TOURNAMENT ADMIN ============

    // Get tournaments from TournamentManagerFHE contract
    const getTournamentsFHE = useCallback(async (): Promise<TournamentFHEData[]> => {
        try {
            const contract = getTournamentFHEAdminContract();
            const nextId = await contract.nextTournamentId();
            const count = Number(nextId);

            const tournaments: TournamentFHEData[] = [];
            for (let i = 1; i <= count; i++) {
                try {
                    const t = await contract.getTournament(i);
                    const [ptsFinalized, scoresComp] = await Promise.all([
                        contract.pointsFinalized(i).catch(() => false),
                        contract.scoresComputed(i).catch(() => false),
                    ]);
                    tournaments.push({
                        id: Number(t.id),
                        registrationStart: Number(t.registrationStart),
                        startTime: Number(t.startTime),
                        revealDeadline: Number(t.revealDeadline),
                        endTime: Number(t.endTime),
                        prizePool: t.prizePool,
                        entryCount: Number(t.entryCount),
                        status: Number(t.status),
                        pointsFinalized: ptsFinalized,
                        scoresComputed: scoresComp,
                    });
                } catch (e) {
                    // skip invalid tournaments
                }
            }

            return tournaments;
        } catch (e) {
            return [];
        }
    }, []);

    // Create tournament on FHE contract
    const createTournamentFHE = useCallback(async (
        signer: ethers.Signer,
        registrationStart: number,
        startTime: number,
        endTime: number
    ): Promise<{ success: boolean; tournamentId?: number; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEAdminContract(signer);
            const tx = await contract.createTournament(registrationStart, startTime, endTime);
            const receipt = await tx.wait();

            let tournamentId: number | undefined;
            for (const log of receipt.logs) {
                try {
                    const parsed = contract.interface.parseLog(log);
                    if (parsed?.name === 'TournamentCreated') {
                        tournamentId = Number(parsed.args.tournamentId);
                        break;
                    }
                } catch { }
            }

            return { success: true, tournamentId };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to create FHE tournament';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Set encrypted points on FHE contract
    // Admin sends plaintext values (0-1000), contract encrypts on-chain via FHE.asEuint32()
    // Values are encrypted in storage and never stored as plaintext on-chain
    const setEncryptedPointsFHE = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        points: number[]
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            if (points.length !== 19) {
                throw new Error('Must provide exactly 19 points values');
            }

            // Validate range
            for (let i = 0; i < points.length; i++) {
                if (points[i] < 0 || points[i] > 1000) {
                    throw new Error(`Point value at index ${i} must be 0-1000, got ${points[i]}`);
                }
            }

            const contract = getTournamentFHEAdminContract(signer);
            const tx = await contract.setPointsFromPlaintext(tournamentId, points);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to set encrypted points';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Compute encrypted scores for a batch of participants
    const computeScoresFHE = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        batchStart: number,
        batchSize: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEAdminContract(signer);
            const tx = await contract.computeEncryptedScores(tournamentId, batchStart, batchSize);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to compute scores';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Finalize scores (mark all batches as done)
    const finalizeScoresFHE = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEAdminContract(signer);
            const tx = await contract.finalizeScores(tournamentId);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to finalize scores';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Compute dark ranks using FHE comparisons
    const computeRanksFHE = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        batchStart: number,
        batchSize: number
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEAdminContract(signer);
            const tx = await contract.computeDarkRanks(tournamentId, batchStart, batchSize);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to compute dark ranks';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Finalize tournament with prize distribution
    const finalizeWithPrizesFHE = useCallback(async (
        signer: ethers.Signer,
        tournamentId: number,
        winners: string[],
        amounts: bigint[]
    ): Promise<{ success: boolean; error?: string }> => {
        setIsLoading(true);
        setError(null);

        try {
            const contract = getTournamentFHEAdminContract(signer);
            const tx = await contract.finalizeWithPrizes(tournamentId, winners, amounts);
            await tx.wait();

            return { success: true };
        } catch (e: any) {
            const msg = e.reason || e.message || 'Failed to finalize with prizes';
            setError(msg);
            return { success: false, error: msg };
        } finally {
            setIsLoading(false);
        }
    }, []);

    return {
        isLoading,
        error,
        // Read
        getContractBalances,
        getAdminStats,
        getTournaments,
        // PackOpener
        withdrawPackOpener,
        setPackPrice,
        setActiveTournament,
        pausePackOpener,
        unpausePackOpener,
        // Tournament (old plaintext)
        createTournament,
        finalizeTournament,
        finalizeWithPoints,
        cancelTournament,
        withdrawFromPrizePool,
        emergencyWithdrawTournament,
        pauseTournament,
        unpauseTournament,
        // FHE Tournament
        getTournamentsFHE,
        createTournamentFHE,
        setEncryptedPointsFHE,
        computeScoresFHE,
        finalizeScoresFHE,
        computeRanksFHE,
        finalizeWithPrizesFHE,
    };
}
