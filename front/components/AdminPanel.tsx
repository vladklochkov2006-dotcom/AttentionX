import React, { useState, useEffect } from 'react';
import {
    Shield,
    DollarSign,
    Trophy,
    Settings,
    RefreshCw,
    AlertTriangle,
    Play,
    Pause,
    Download,
    Plus,
    X,
    Check,
    Calendar,
    Users,
    Clock,
    Trash2,
    Database,
    Key,
    Lock
} from 'lucide-react';
import { useWalletContext } from '../context/WalletContext';
import { useAdmin, isAdmin, ContractBalances, AdminStats, TournamentData, TournamentFHEData } from '../hooks/useAdmin';
import { useNFT } from '../hooks/useNFT';
import { formatXTZ } from '../lib/contracts';
import { apiUrl } from '../lib/api';
import { currencySymbol } from '../lib/networks';
import { ethers } from 'ethers';

const AdminPanel: React.FC = () => {
    const { address, getSigner, isConnected } = useWalletContext();
    const admin = useAdmin();
    const { clearCache: clearNFTCache } = useNFT();

    const [balances, setBalances] = useState<ContractBalances | null>(null);
    const [stats, setStats] = useState<AdminStats | null>(null);
    const [tournaments, setTournaments] = useState<TournamentData[]>([]);
    const [isRefreshing, setIsRefreshing] = useState(false);

    // Form states
    const [newPackPrice, setNewPackPrice] = useState('5');
    const [newActiveTournament, setNewActiveTournament] = useState('0');
    const [showCreateTournament, setShowCreateTournament] = useState(false);
    const [tournamentForm, setTournamentForm] = useState({
        regStart: '',
        start: '',
        end: ''
    });

    // Tournament management modal state
    const [manageTournament, setManageTournament] = useState<TournamentData | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);

    // Points finalization modal
    const [showPointsModal, setShowPointsModal] = useState<TournamentData | null>(null);
    const [pointsValues, setPointsValues] = useState<string[]>(Array(19).fill('0'));

    // Database management
    const [adminKey, setAdminKey] = useState('');
    const [dbActionLoading, setDbActionLoading] = useState<string | null>(null);
    const [confirmAction, setConfirmAction] = useState<string | null>(null);

    // Waitlist
    const [waitlistEntries, setWaitlistEntries] = useState<{ id: number; email: string; wallet_address: string; created_at: string }[]>([]);
    const [waitlistLoading, setWaitlistLoading] = useState(false);

    // FHE Operations state
    const [fheTournaments, setFheTournaments] = useState<TournamentFHEData[]>([]);
    const [fheLoading, setFheLoading] = useState(false);
    const [fheSelectedTournament, setFheSelectedTournament] = useState<number>(0);
    const [fhePointsValues, setFhePointsValues] = useState<string[]>(Array(19).fill('0'));
    const [showFheCreateTournament, setShowFheCreateTournament] = useState(false);
    const [fheTournamentForm, setFheTournamentForm] = useState({ regStart: '', start: '', end: '' });
    const [showFhePointsModal, setShowFhePointsModal] = useState(false);
    const [fheFinalizeWinners, setFheFinalizeWinners] = useState('');
    const [fheFinalizeAmounts, setFheFinalizeAmounts] = useState('');
    // Tracks highest completed step per tournament (for steps 3+ which have no on-chain flag)
    const [fheCompletedStep, setFheCompletedStep] = useState<Record<number, number>>({});

    // Startup names for points UI (from AttentionX_NFT.sol)
    const startupNames = [
        // Legendary (10x multiplier) - IDs 1-5
        'Openclaw', 'Lovable', 'Cursor', 'OpenAI', 'Anthropic',
        // Epic (5x multiplier) - IDs 6-8
        'Browser Use', 'Dedalus Labs', 'Autumn',
        // Rare (3x multiplier) - IDs 9-13
        'Axiom', 'Multifactor', 'Dome', 'GrazeMate', 'Tornyol Systems',
        // Common (1x multiplier) - IDs 14-19
        'Pocket', 'Caretta', 'AxionOrbital Space', 'Freeport Markets', 'Ruvo', 'Lightberry'
    ];

    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Check if user is admin
    const userIsAdmin = isAdmin(address);

    // Load data
    const loadData = async () => {
        setIsRefreshing(true);
        const [b, s, t] = await Promise.all([
            admin.getContractBalances(),
            admin.getAdminStats(),
            admin.getTournaments()
        ]);
        setBalances(b);
        setStats(s);
        setTournaments(t);
        setIsRefreshing(false);
    };

    useEffect(() => {
        if (userIsAdmin) {
            loadData();
            loadFheTournaments();
        }
    }, [userIsAdmin]);

    // Helper to format date
    const formatDate = (timestamp: number) => {
        if (!timestamp) return '-';
        return new Date(timestamp * 1000).toLocaleString('uk-UA', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    // Helper to get status text
    const getStatusInfo = (status: number) => {
        switch (status) {
            case 0: return { text: 'Created', color: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 dark:bg-blue-500/20' };
            case 1: return { text: 'Active', color: 'text-green-600 dark:text-green-400 bg-green-500/10 dark:bg-green-500/20' };
            case 2: return { text: 'Finalized', color: 'text-gray-600 dark:text-gray-400 bg-gray-500/10 dark:bg-gray-500/20' };
            case 3: return { text: 'Cancelled', color: 'text-red-600 dark:text-red-400 bg-red-500/10 dark:bg-red-500/20' };
            default: return { text: 'Unknown', color: 'text-gray-500 bg-gray-500/10 dark:bg-gray-500/20' };
        }
    };

    const showMessage = (type: 'success' | 'error', text: string) => {
        setMessage({ type, text });
        setTimeout(() => setMessage(null), 5000);
    };

    // Helper: get signer or show error
    const requireSigner = async () => {
        const signer = await requireSigner();
        if (!signer) {
            showMessage('error', 'Wallet not connected or signer unavailable. Reconnect your wallet.');
            console.error('[Admin] getSigner() returned null. isConnected:', isConnected, 'address:', address);
            return null;
        }
        return signer;
    };

    // Action handlers
    const handleWithdraw = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        const result = await admin.withdrawPackOpener(signer);
        if (result.success) {
            showMessage('success', 'Withdrawal successful!');
            loadData();
        } else {
            showMessage('error', result.error || 'Withdrawal failed');
        }
    };

    const handleSetPackPrice = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        const price = parseFloat(newPackPrice);
        if (isNaN(price) || price <= 0) {
            showMessage('error', 'Invalid price');
            return;
        }

        const result = await admin.setPackPrice(signer, price);
        if (result.success) {
            showMessage('success', `Pack price set to ${price} ${currencySymbol()}`);
            loadData();
        } else {
            showMessage('error', result.error || 'Failed to set price');
        }
    };

    const handleSetActiveTournament = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        const id = parseInt(newActiveTournament);
        if (isNaN(id)) {
            showMessage('error', 'Invalid tournament ID');
            return;
        }

        const result = await admin.setActiveTournament(signer, id);
        if (result.success) {
            showMessage('success', `Active tournament set to ${id}`);
            loadData();
        } else {
            showMessage('error', result.error || 'Failed to set tournament');
        }
    };

    const handleCreateTournament = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        const regStart = new Date(tournamentForm.regStart).getTime() / 1000;
        const start = new Date(tournamentForm.start).getTime() / 1000;
        const end = new Date(tournamentForm.end).getTime() / 1000;

        if (!regStart || !start || !end) {
            showMessage('error', 'Invalid dates');
            return;
        }

        const result = await admin.createTournament(signer, regStart, start, end);
        if (result.success && result.tournamentId) {
            // Auto-set as active tournament in PackOpener so backend sync picks it up
            const setResult = await admin.setActiveTournament(signer, result.tournamentId);
            if (setResult.success) {
                showMessage('success', `Tournament #${result.tournamentId} created & set as active!`);
            } else {
                showMessage('success', `Tournament #${result.tournamentId} created! (Set active manually)`);
            }
            setShowCreateTournament(false);
            loadData();
        } else {
            showMessage('error', result.error || 'Failed to create tournament');
        }
    };

    const handlePausePackOpener = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        try {
            await admin.pausePackOpener(signer);
            showMessage('success', 'PackOpener paused');
        } catch (e: any) {
            showMessage('error', e.message);
        }
    };

    const handleUnpausePackOpener = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        try {
            await admin.unpausePackOpener(signer);
            showMessage('success', 'PackOpener unpaused');
        } catch (e: any) {
            showMessage('error', e.message);
        }
    };

    // Tournament management handlers
    const handleCancelTournament = async (tournamentId: number) => {
        const signer = await requireSigner();
        if (!signer) return;

        setActionLoading('cancel');
        const result = await admin.cancelTournament(signer, tournamentId);
        if (result.success) {
            clearNFTCache(); // Invalidate cached lock status so cards show as unlocked
            showMessage('success', `Tournament #${tournamentId} cancelled!`);
            setManageTournament(null);
            loadData();
        } else {
            showMessage('error', result.error || 'Failed to cancel');
        }
        setActionLoading(null);
    };

    const handleFinalizeTournament = async (tournamentId: number) => {
        const signer = await requireSigner();
        if (!signer) return;

        setActionLoading('finalize');
        // Finalize with empty winners (just unlock NFTs)
        const result = await admin.finalizeTournament(signer, tournamentId, [], []);
        if (result.success) {
            clearNFTCache(); // Invalidate cached lock status so cards show as unlocked
            showMessage('success', `Tournament #${tournamentId} finalized!`);
            setManageTournament(null);
            loadData();
        } else {
            showMessage('error', result.error || 'Failed to finalize');
        }
        setActionLoading(null);
    };

    const handleEmergencyWithdraw = async () => {
        const signer = await requireSigner();
        if (!signer || !balances) return;

        setActionLoading('withdraw');
        try {
            const result = await admin.emergencyWithdrawTournament(
                signer,
                balances.tournament,
                address || ''
            );
            if (result.success) {
                showMessage('success', 'Funds withdrawn from TournamentManager!');
                // Emergency withdraw doesn't update prizePool in contract — zero out locally
                setTournaments(prev => prev.map(t => ({ ...t, prizePool: 0n })));
                loadData();
            } else {
                showMessage('error', result.error || 'Withdrawal failed');
            }
        } catch (e: any) {
            showMessage('error', e.message);
        }
        setActionLoading(null);
    };

    // Withdraw from cancelled tournament prize pool
    const handleWithdrawFromTournament = async (tournament: TournamentData) => {
        const signer = await requireSigner();
        if (!signer) return;

        setActionLoading('withdraw-' + tournament.id);
        const result = await admin.withdrawFromPrizePool(
            signer,
            tournament.id,
            tournament.prizePool,
            address || ''
        );
        if (result.success) {
            showMessage('success', `Withdrew ${formatXTZ(tournament.prizePool)} ${currencySymbol()} from tournament #${tournament.id}`);
            // Update local state immediately (we withdrew the full prizePool)
            setTournaments(prev => prev.map(t =>
                t.id === tournament.id ? { ...t, prizePool: 0n } : t
            ));
            // Also refresh from chain in background
            loadData();
        } else {
            showMessage('error', result.error || 'Withdrawal failed');
        }
        setActionLoading(null);
    };

    // Finalize tournament with points
    const handleFinalizeWithPoints = async () => {
        const signer = await requireSigner();
        if (!signer || !showPointsModal) return;

        setActionLoading('finalize-points');
        try {
            // Convert string points to bigint array
            const points = pointsValues.map(p => BigInt(parseInt(p) || 0));

            const result = await admin.finalizeWithPoints(signer, showPointsModal.id, points);
            if (result.success) {
                clearNFTCache(); // Invalidate cached lock status so cards show as unlocked
                showMessage('success', `Tournament #${showPointsModal.id} finalized with points!`);
                setShowPointsModal(null);
                setPointsValues(Array(19).fill('0'));
                loadData();
            } else {
                showMessage('error', result.error || 'Failed to finalize with points');
            }
        } catch (e: any) {
            showMessage('error', e.message);
        }
        setActionLoading(null);
    };

    // Database management handlers
    const handleDbAction = async (action: 'clear-news' | 'reset-scores') => {
        if (!adminKey.trim()) {
            showMessage('error', 'Enter admin key first');
            return;
        }
        if (confirmAction !== action) {
            setConfirmAction(action);
            return;
        }
        setDbActionLoading(action);
        setConfirmAction(null);
        try {
            const res = await fetch(apiUrl(`/admin/${action}`), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Admin-Key': adminKey.trim(),
                },
            });
            const data = await res.json();
            if (data.success) {
                showMessage('success', data.message);
            } else {
                showMessage('error', data.error || 'Action failed');
            }
        } catch {
            showMessage('error', 'Network error');
        }
        setDbActionLoading(null);
    };

    const loadWaitlist = async () => {
        if (!adminKey.trim()) { showMessage('error', 'Enter admin key first'); return; }
        setWaitlistLoading(true);
        try {
            const res = await fetch(apiUrl('/admin/waitlist'), {
                headers: { 'X-Admin-Key': adminKey.trim() },
            });
            const data = await res.json();
            if (data.success) {
                setWaitlistEntries(data.data);
                showMessage('success', `Loaded ${data.total} waitlist entries`);
            } else {
                showMessage('error', data.error || 'Failed to load waitlist');
            }
        } catch {
            showMessage('error', 'Network error loading waitlist');
        }
        setWaitlistLoading(false);
    };

    const downloadWaitlistTxt = () => {
        if (waitlistEntries.length === 0) return;
        const lines = waitlistEntries.map((e, i) =>
            `${i + 1}\t${e.email}\t${e.wallet_address}\t${e.created_at}`
        );
        const content = `#\tEmail\tWallet\tDate\n${lines.join('\n')}`;
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `waitlist-${new Date().toISOString().split('T')[0]}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // ============ FHE HANDLERS ============

    const loadFheTournaments = async () => {
        setFheLoading(true);
        try {
            const t = await admin.getTournamentsFHE();
            setFheTournaments(t);
        } catch { }
        setFheLoading(false);
    };

    const handleCreateTournamentFHE = async () => {
        const signer = await requireSigner();
        if (!signer) return;

        const regStart = new Date(fheTournamentForm.regStart).getTime() / 1000;
        const start = new Date(fheTournamentForm.start).getTime() / 1000;
        const end = new Date(fheTournamentForm.end).getTime() / 1000;

        if (!regStart || !start || !end) {
            showMessage('error', 'Invalid dates');
            return;
        }

        setActionLoading('fhe-create');
        const result = await admin.createTournamentFHE(signer, regStart, start, end);
        if (result.success && result.tournamentId) {
            // Auto-set as active tournament in PackOpener
            const setResult = await admin.setActiveTournament(signer, result.tournamentId);
            if (setResult.success) {
                showMessage('success', `FHE Tournament #${result.tournamentId} created & set as active!`);
            } else {
                showMessage('success', `FHE Tournament #${result.tournamentId} created! (Set active manually if needed)`);
            }
            setFheSelectedTournament(result.tournamentId);
            setShowFheCreateTournament(false);
            loadFheTournaments();
            loadData();
        } else {
            showMessage('error', result.error || 'Failed to create FHE tournament');
        }
        setActionLoading(null);
    };

    const handleSetEncryptedPointsFHE = async () => {
        const signer = await requireSigner();
        if (!signer || !fheSelectedTournament) return;

        setActionLoading('fhe-points');
        try {
            // Convert string inputs to numbers
            const points = fhePointsValues.map(p => parseInt(p) || 0);

            // Validate
            for (let i = 0; i < points.length; i++) {
                if (points[i] < 0 || points[i] > 1000) {
                    showMessage('error', `Point value for startup ${i + 1} must be 0-1000`);
                    setActionLoading(null);
                    return;
                }
            }

            // Try CoFHE SDK browser encryption first (fully encrypted calldata)
            let usedCofhe = false;
            try {
                showMessage('success', 'Encrypting with CoFHE SDK (ZK proof generation ~10s)...');

                const { createCofheConfig, createCofheClient } = await import('@cofhe/sdk/web');
                const { Encryptable } = await import('@cofhe/sdk');
                const { sepolia: cofheSepolia } = await import('@cofhe/sdk/chains');
                const viem = await import('viem');
                const { sepolia: viemSepolia } = await import('viem/chains');

                const publicClient = viem.createPublicClient({
                    chain: viemSepolia,
                    transport: viem.http(),
                });
                const walletClient = viem.createWalletClient({
                    chain: viemSepolia,
                    transport: viem.custom(window.ethereum as any),
                });

                const config = createCofheConfig({
                    supportedChains: [cofheSepolia] as any,
                });
                const cofheClient = createCofheClient(config);

                const [account] = await walletClient.getAddresses();
                await cofheClient.connect(publicClient as any, walletClient as any);

                // Encrypt all 19 values
                const encryptables = points.map(p => Encryptable.uint32(BigInt(p)));
                const encrypted = await cofheClient.encryptInputs(encryptables)
                    .setAccount(account)
                    .onStep((step: any) => console.log('[CoFHE] Step:', step))
                    .execute();

                // Map to InEuint32 format: { ctHash: bytes32, signature: bytes }
                const inPoints = (encrypted as any[]).map((enc: any) => ({
                    ctHash: '0x' + enc.ctHash.toString(16).padStart(64, '0'),
                    signature: enc.signature,
                }));

                // Call setEncryptedPoints with real encrypted data
                const { getActiveNetwork: getNet } = await import('../lib/networks');
                const network = getNet();
                const contract = new ethers.Contract(
                    network.contracts.TournamentManagerFHE,
                    ['function setEncryptedPoints(uint256 tournamentId, tuple(bytes32 ctHash, bytes signature)[19] inPoints)'],
                    signer
                );
                const tx = await contract.setEncryptedPoints(fheSelectedTournament, inPoints);
                await tx.wait();
                usedCofhe = true;

                showMessage('success', `Encrypted points set for tournament #${fheSelectedTournament}! Fully encrypted via CoFHE SDK.`);
            } catch (cofheErr: any) {
                console.warn('[CoFHE] Browser encryption failed, falling back to on-chain encryption:', cofheErr.message);
                // Fallback: contract encrypts on-chain
                const result = await admin.setEncryptedPointsFHE(signer, fheSelectedTournament, points);
                if (result.success) {
                    showMessage('success', `Points set for tournament #${fheSelectedTournament}. Encrypted on-chain via FHE.asEuint32().`);
                } else {
                    throw new Error(result.error || 'Failed to set points');
                }
            }

            setShowFhePointsModal(false);
            loadFheTournaments();
        } catch (e: any) {
            showMessage('error', e.message || 'Failed to set encrypted points');
        }
        setActionLoading(null);
    };

    const handleComputeScoresFHE = async () => {
        const signer = await requireSigner();
        if (!signer || !fheSelectedTournament) return;

        setActionLoading('fhe-scores');
        const result = await admin.computeScoresFHE(signer, fheSelectedTournament, 0, 100);
        if (result.success) {
            showMessage('success', `Scores computed for tournament #${fheSelectedTournament}`);
            loadFheTournaments();
        } else {
            showMessage('error', result.error || 'Failed to compute scores');
        }
        setActionLoading(null);
    };

    const handleFinalizeScoresFHE = async () => {
        const signer = await requireSigner();
        if (!signer || !fheSelectedTournament) return;

        setActionLoading('fhe-finalize-scores');
        const result = await admin.finalizeScoresFHE(signer, fheSelectedTournament);
        if (result.success) {
            showMessage('success', `Scores finalized for tournament #${fheSelectedTournament}`);
            setFheCompletedStep(prev => ({ ...prev, [fheSelectedTournament]: Math.max(prev[fheSelectedTournament] ?? 0, 3) }));
            loadFheTournaments();
        } else {
            showMessage('error', result.error || 'Failed to finalize scores');
        }
        setActionLoading(null);
    };

    const handleComputeDarkRanksFHE = async () => {
        const signer = await requireSigner();
        if (!signer || !fheSelectedTournament) return;

        setActionLoading('fhe-ranks');
        const result = await admin.computeRanksFHE(signer, fheSelectedTournament, 0, 100);
        if (result.success) {
            showMessage('success', `Dark ranks computed for tournament #${fheSelectedTournament}`);
            setFheCompletedStep(prev => ({ ...prev, [fheSelectedTournament]: Math.max(prev[fheSelectedTournament] ?? 0, 4) }));
            loadFheTournaments();
        } else {
            showMessage('error', result.error || 'Failed to compute dark ranks');
        }
        setActionLoading(null);
    };

    const handleFinalizeWithPrizesFHE = async () => {
        const signer = await requireSigner();
        if (!signer || !fheSelectedTournament) return;

        setActionLoading('fhe-finalize-prizes');
        try {
            const winners = fheFinalizeWinners.split(',').map(w => w.trim()).filter(Boolean);
            const amounts = fheFinalizeAmounts.split(',').map(a => ethers.parseEther(a.trim()));

            if (winners.length !== amounts.length) {
                showMessage('error', 'Winners and amounts arrays must have the same length');
                setActionLoading(null);
                return;
            }

            const result = await admin.finalizeWithPrizesFHE(signer, fheSelectedTournament, winners, amounts);
            if (result.success) {
                showMessage('success', `Tournament #${fheSelectedTournament} finalized with prizes!`);
                loadFheTournaments();
            } else {
                showMessage('error', result.error || 'Failed to finalize with prizes');
            }
        } catch (e: any) {
            showMessage('error', e.message || 'Failed to finalize with prizes');
        }
        setActionLoading(null);
    };

    // Don't render if not admin
    if (!isConnected || !userIsAdmin) {
        return null;
    }

    return (
        <>
            <div className="animate-[fadeInUp_0.5s_ease-out]">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-3">
                        <div className="p-3 bg-red-500/10 dark:bg-red-500/20 rounded-xl">
                            <Shield className="w-8 h-8 text-red-500" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-black text-gray-900 dark:text-white">Admin Panel</h2>
                            <p className="text-gray-500 text-sm font-mono">{address?.slice(0, 10)}...</p>
                        </div>
                    </div>
                    <button
                        onClick={loadData}
                        disabled={isRefreshing}
                        className="p-2 rounded-lg bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                    >
                        <RefreshCw className={`w-5 h-5 text-gray-400 ${isRefreshing ? 'animate-spin' : ''}`} />
                    </button>
                </div>

                {/* Message */}
                {message && (
                    <div className={`mb-6 p-4 rounded-xl flex items-center gap-3 ${message.type === 'success'
                        ? 'bg-green-50 dark:bg-green-500/20 border border-green-200 dark:border-green-500/30 text-green-700 dark:text-green-400'
                        : 'bg-red-50 dark:bg-red-500/20 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400'
                        }`}>
                        {message.type === 'success' ? <Check className="w-5 h-5" /> : <X className="w-5 h-5" />}
                        {message.text}
                    </div>
                )}

                {/* Stats Cards */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Packs Sold</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white font-mono">{stats?.packsSold || 0}</p>
                    </div>
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Pack Price</p>
                        <p className="text-2xl font-bold text-yc-purple font-mono">{stats ? formatXTZ(stats.packPrice) : '5'} {currencySymbol()}</p>
                    </div>
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Total NFTs</p>
                        <p className="text-2xl font-bold text-gray-900 dark:text-white font-mono">{stats?.totalNFTs || 0}</p>
                    </div>
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Active Tournament</p>
                        <p className="text-2xl font-bold text-yc-green font-mono">#{stats?.activeTournamentId || 0}</p>
                    </div>
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1 flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            Unique Users
                        </p>
                        <p className="text-2xl font-bold text-[#00D4FF] font-mono">{stats?.uniqueBuyers ?? '—'}</p>
                        <p className="text-gray-400 text-xs mt-0.5">bought ≥1 pack</p>
                    </div>
                </div>

                {/* Marketplace Stats + Royalties */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Marketplace Volume</p>
                        <p className="text-2xl font-bold text-yc-purple font-mono">
                            {stats ? Number(ethers.formatEther(stats.marketplaceVolume)).toFixed(3) : '0'} {currencySymbol()}
                        </p>
                        <p className="text-gray-400 text-xs mt-1">{stats?.marketplaceSales || 0} sales total</p>
                    </div>
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Royalties Earned (2%)</p>
                        <p className="text-2xl font-bold text-yc-green font-mono">
                            {stats ? Number(ethers.formatEther(stats.royaltiesEarned)).toFixed(4) : '0'} {currencySymbol()}
                        </p>
                        <p className="text-gray-400 text-xs mt-1">From secondary market sales</p>
                    </div>
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-4">
                        <p className="text-gray-500 text-xs uppercase mb-1">Cards by Rarity</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-1">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-yellow-500">Legendary</span>
                                <span className="text-[13px] font-mono font-bold text-gray-900 dark:text-white">{stats?.rarityStats.legendary ?? '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-cyan-400">Epic</span>
                                <span className="text-[13px] font-mono font-bold text-gray-900 dark:text-white">{stats?.rarityStats.epic ?? '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-blue-400">Rare</span>
                                <span className="text-[13px] font-mono font-bold text-gray-900 dark:text-white">{stats?.rarityStats.rare ?? '—'}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-gray-400">Common</span>
                                <span className="text-[13px] font-mono font-bold text-gray-900 dark:text-white">{stats?.rarityStats.common ?? '—'}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Contract Balances */}
                <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-6 mb-6">
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <DollarSign className="w-5 h-5 text-yc-green" />
                        Contract Balances
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-gray-50 dark:bg-black/50 rounded-lg p-4">
                            <p className="text-gray-500 text-xs mb-1">PackOpener</p>
                            <p className="text-xl font-mono font-bold text-gray-900 dark:text-white mb-2">
                                {balances ? formatXTZ(balances.packOpener) : '0'} {currencySymbol()}
                            </p>
                            {balances && balances.packOpener > 0n && (
                                <button
                                    onClick={handleWithdraw}
                                    disabled={admin.isLoading}
                                    className="w-full bg-yc-green/10 dark:bg-yc-green/20 hover:bg-yc-green text-yc-green hover:text-white py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                >
                                    {admin.isLoading ? 'Withdrawing...' : 'Withdraw'}
                                </button>
                            )}
                        </div>
                        <div className="bg-gray-50 dark:bg-black/50 rounded-lg p-4">
                            <p className="text-gray-500 text-xs mb-1">TournamentManager</p>
                            <p className="text-xl font-mono font-bold text-gray-900 dark:text-white mb-2">
                                {balances ? formatXTZ(balances.tournament) : '0'} {currencySymbol()}
                            </p>
                            {balances && balances.tournament > 0n && (
                                <button
                                    onClick={handleEmergencyWithdraw}
                                    disabled={actionLoading === 'withdraw'}
                                    className="w-full bg-yc-purple/10 dark:bg-yc-purple/20 hover:bg-yc-purple text-yc-purple hover:text-white py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                >
                                    {actionLoading === 'withdraw' ? 'Withdrawing...' : 'Withdraw'}
                                </button>
                            )}
                        </div>
                        <div className="bg-gray-50 dark:bg-black/50 rounded-lg p-4">
                            <p className="text-gray-500 text-xs mb-1">NFT Contract</p>
                            <p className="text-xl font-mono font-bold text-gray-900 dark:text-white">
                                {balances ? formatXTZ(balances.nft) : '0'} {currencySymbol()}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Actions Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                    {/* PackOpener Controls */}
                    <div className="bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-6">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                            <Settings className="w-5 h-5 text-yc-purple" />
                            PackOpener Controls
                        </h3>

                        {/* Withdraw */}
                        <button
                            onClick={handleWithdraw}
                            disabled={admin.isLoading}
                            className="w-full mb-4 bg-yc-green hover:bg-green-600 text-white py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                        >
                            <Download className="w-5 h-5" />
                            Withdraw Funds
                        </button>

                        {/* Set Pack Price */}
                        <div className="mb-4">
                            <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block">Pack Price ({currencySymbol()})</label>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    value={newPackPrice}
                                    onChange={(e) => setNewPackPrice(e.target.value)}
                                    className="flex-1 bg-gray-50 dark:bg-black border border-gray-200 dark:border-[#333] rounded-lg px-4 py-2 text-gray-900 dark:text-white font-mono"
                                    placeholder="5"
                                />
                                <button
                                    onClick={handleSetPackPrice}
                                    disabled={admin.isLoading}
                                    className="bg-yc-purple hover:bg-cyan-600 text-white px-4 py-2 rounded-lg font-bold disabled:opacity-50"
                                >
                                    Set
                                </button>
                            </div>
                        </div>

                        {/* Set Active Tournament */}
                        <div className="mb-4">
                            <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block">Active Tournament ID</label>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    value={newActiveTournament}
                                    onChange={(e) => setNewActiveTournament(e.target.value)}
                                    className="flex-1 bg-gray-50 dark:bg-black border border-gray-200 dark:border-[#333] rounded-lg px-4 py-2 text-gray-900 dark:text-white font-mono"
                                    placeholder="0"
                                />
                                <button
                                    onClick={handleSetActiveTournament}
                                    disabled={admin.isLoading}
                                    className="bg-yc-purple hover:bg-cyan-600 text-white px-4 py-2 rounded-lg font-bold disabled:opacity-50"
                                >
                                    Set
                                </button>
                            </div>
                        </div>

                        {/* Pause/Unpause */}
                        <div className="flex gap-2">
                            <button
                                onClick={handlePausePackOpener}
                                className="flex-1 bg-red-50 dark:bg-red-500/20 hover:bg-red-100 dark:hover:bg-red-500/30 text-red-600 dark:text-red-400 py-2 rounded-lg font-bold flex items-center justify-center gap-2"
                            >
                                <Pause className="w-4 h-4" /> Pause
                            </button>
                            <button
                                onClick={handleUnpausePackOpener}
                                className="flex-1 bg-green-50 dark:bg-green-500/20 hover:bg-green-100 dark:hover:bg-green-500/30 text-green-600 dark:text-green-400 py-2 rounded-lg font-bold flex items-center justify-center gap-2"
                            >
                                <Play className="w-4 h-4" /> Unpause
                            </button>
                        </div>
                    </div>

                    {/* FHE Tournament Controls */}
                    <div className="bg-white dark:bg-[#121212] border border-cyan-200 dark:border-cyan-500/30 rounded-xl p-6 overflow-y-auto max-h-[700px]">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                                <Lock className="w-5 h-5 text-cyan-500" />
                                FHE Tournament Controls
                            </h3>
                            <button
                                onClick={loadFheTournaments}
                                disabled={fheLoading}
                                className="p-2 rounded-lg bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 transition-colors"
                            >
                                <RefreshCw className={`w-4 h-4 text-gray-400 ${fheLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        {/* Create FHE Tournament */}
                        {!showFheCreateTournament ? (
                            <button
                                onClick={() => setShowFheCreateTournament(true)}
                                className="w-full mb-4 bg-cyan-500 hover:bg-cyan-600 text-white py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors text-sm"
                            >
                                <Plus className="w-4 h-4" />
                                Create FHE Tournament
                            </button>
                        ) : (
                            <div className="mb-4 bg-gray-50 dark:bg-black/50 rounded-lg p-4">
                                <div className="flex justify-between items-center mb-3">
                                    <span className="text-gray-900 dark:text-white font-bold text-sm">New FHE Tournament</span>
                                    <button onClick={() => setShowFheCreateTournament(false)}>
                                        <X className="w-4 h-4 text-gray-500" />
                                    </button>
                                </div>
                                <div className="space-y-2.5">
                                    <div>
                                        <label className="text-gray-500 dark:text-gray-400 text-xs">Registration Start</label>
                                        <input type="datetime-local" value={fheTournamentForm.regStart}
                                            onChange={(e) => setFheTournamentForm({ ...fheTournamentForm, regStart: e.target.value })}
                                            className="w-full bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#333] rounded px-3 py-2 text-gray-900 dark:text-white text-sm" />
                                    </div>
                                    <div>
                                        <label className="text-gray-500 dark:text-gray-400 text-xs">Start Time</label>
                                        <input type="datetime-local" value={fheTournamentForm.start}
                                            onChange={(e) => setFheTournamentForm({ ...fheTournamentForm, start: e.target.value })}
                                            className="w-full bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#333] rounded px-3 py-2 text-gray-900 dark:text-white text-sm" />
                                    </div>
                                    <div>
                                        <label className="text-gray-500 dark:text-gray-400 text-xs">End Time</label>
                                        <input type="datetime-local" value={fheTournamentForm.end}
                                            onChange={(e) => setFheTournamentForm({ ...fheTournamentForm, end: e.target.value })}
                                            className="w-full bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#333] rounded px-3 py-2 text-gray-900 dark:text-white text-sm" />
                                    </div>
                                    <p className="text-gray-400 text-[10px]">Reveal window = 25% of duration after Start Time (min 1h). Auto-set as active.</p>
                                    <button
                                        onClick={handleCreateTournamentFHE}
                                        disabled={actionLoading === 'fhe-create'}
                                        className="w-full bg-cyan-500 hover:bg-cyan-600 text-white py-2 rounded-lg font-bold disabled:opacity-50 text-sm"
                                    >
                                        {actionLoading === 'fhe-create' ? 'Creating...' : 'Create'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Tournament Selector */}
                        {fheTournaments.length > 0 && (
                            <div className="mb-4">
                                <label className="text-gray-500 dark:text-gray-400 text-xs mb-1 block">Select Tournament</label>
                                <select
                                    value={fheSelectedTournament}
                                    onChange={(e) => setFheSelectedTournament(Number(e.target.value))}
                                    className="w-full bg-gray-50 dark:bg-black border border-gray-200 dark:border-[#333] rounded-lg px-3 py-2 text-gray-900 dark:text-white font-mono text-sm"
                                >
                                    <option value={0}>-- Select Tournament --</option>
                                    {fheTournaments.map((t) => {
                                        const statusLabels = ['Created', 'Active', 'Finalized', 'Cancelled'];
                                        return (
                                            <option key={t.id} value={t.id}>
                                                #{t.id} · {statusLabels[t.status] || 'Unknown'} · {t.entryCount} entries
                                                {t.pointsFinalized ? ' ✓pts' : ''}
                                                {t.scoresComputed ? ' ✓scores' : ''}
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        )}

                        {/* FHE Steps (only when tournament selected) */}
                        {fheSelectedTournament > 0 && (() => {
                            const selT = fheTournaments.find(t => t.id === fheSelectedTournament);
                            const ptsSet = selT?.pointsFinalized ?? false;
                            const scoresSet = selT?.scoresComputed ?? false;
                            const isCancelled = selT?.status === 3;
                            const isFinalized = selT?.status === 2;
                            // completedStep: derived from on-chain flags + local tracker
                            const localStep = fheCompletedStep[fheSelectedTournament] ?? 0;
                            const completedStep = isFinalized ? 5 : scoresSet ? Math.max(2, localStep) : ptsSet ? Math.max(1, localStep) : localStep;
                            return (
                                <div className="space-y-2">
                                    {/* Step 1 */}
                                    <div className="flex items-center justify-between bg-gray-50 dark:bg-black/40 rounded-lg px-3 py-2.5">
                                        <span className="text-gray-800 dark:text-gray-200 text-sm flex items-center gap-2">
                                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${completedStep >= 1 ? 'bg-green-500' : 'bg-cyan-500'}`}>{completedStep >= 1 ? '✓' : '1'}</span>
                                            Set Encrypted Points
                                        </span>
                                        <button
                                            onClick={() => { setShowFhePointsModal(true); setFhePointsValues(Array(19).fill('0')); }}
                                            disabled={completedStep >= 1 || isCancelled || isFinalized}
                                            className="bg-cyan-500 hover:bg-cyan-600 text-white px-3 py-1 rounded-lg text-xs font-bold disabled:opacity-30"
                                        >
                                            {completedStep >= 1 ? 'Done' : 'Set Points'}
                                        </button>
                                    </div>

                                    {/* Step 2 */}
                                    <div className="flex items-center justify-between bg-gray-50 dark:bg-black/40 rounded-lg px-3 py-2.5">
                                        <span className="text-gray-800 dark:text-gray-200 text-sm flex items-center gap-2">
                                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${completedStep >= 2 ? 'bg-green-500' : 'bg-blue-500'}`}>{completedStep >= 2 ? '✓' : '2'}</span>
                                            Compute Scores
                                        </span>
                                        <button
                                            onClick={handleComputeScoresFHE}
                                            disabled={completedStep !== 1 || actionLoading === 'fhe-scores' || isCancelled || isFinalized}
                                            className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded-lg text-xs font-bold disabled:opacity-30"
                                        >
                                            {actionLoading === 'fhe-scores' ? '...' : completedStep >= 2 ? 'Done' : 'Compute'}
                                        </button>
                                    </div>

                                    {/* Step 3 */}
                                    <div className="flex items-center justify-between bg-gray-50 dark:bg-black/40 rounded-lg px-3 py-2.5">
                                        <span className="text-gray-800 dark:text-gray-200 text-sm flex items-center gap-2">
                                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${completedStep >= 3 ? 'bg-green-500' : 'bg-green-600'}`}>{completedStep >= 3 ? '✓' : '3'}</span>
                                            Finalize Scores
                                        </span>
                                        <button
                                            onClick={handleFinalizeScoresFHE}
                                            disabled={completedStep !== 2 || actionLoading === 'fhe-finalize-scores' || isCancelled || isFinalized}
                                            className="bg-green-500 hover:bg-green-600 text-white px-3 py-1 rounded-lg text-xs font-bold disabled:opacity-30"
                                        >
                                            {actionLoading === 'fhe-finalize-scores' ? '...' : completedStep >= 3 ? 'Done' : 'Finalize'}
                                        </button>
                                    </div>

                                    {/* Step 4 */}
                                    <div className="flex items-center justify-between bg-gray-50 dark:bg-black/40 rounded-lg px-3 py-2.5">
                                        <span className="text-gray-800 dark:text-gray-200 text-sm flex items-center gap-2">
                                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${completedStep >= 4 ? 'bg-green-500' : 'bg-indigo-500'}`}>{completedStep >= 4 ? '✓' : '4'}</span>
                                            Compute Dark Ranks
                                        </span>
                                        <button
                                            onClick={handleComputeDarkRanksFHE}
                                            disabled={completedStep !== 3 || actionLoading === 'fhe-ranks' || isCancelled || isFinalized}
                                            className="bg-indigo-500 hover:bg-indigo-600 text-white px-3 py-1 rounded-lg text-xs font-bold disabled:opacity-30"
                                        >
                                            {actionLoading === 'fhe-ranks' ? '...' : completedStep >= 4 ? 'Done' : 'Compute'}
                                        </button>
                                    </div>

                                    {/* Step 5 */}
                                    <div className="bg-gray-50 dark:bg-black/40 rounded-lg px-3 py-2.5">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-gray-800 dark:text-gray-200 text-sm flex items-center gap-2">
                                                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${completedStep >= 5 ? 'bg-green-500 text-white' : 'bg-yellow-500 text-black'}`}>{completedStep >= 5 ? '✓' : '5'}</span>
                                                Finalize + Prizes
                                            </span>
                                        </div>
                                        <div className="space-y-1.5">
                                            <input type="text" value={fheFinalizeWinners}
                                                onChange={(e) => setFheFinalizeWinners(e.target.value)}
                                                placeholder="0xAddr1, 0xAddr2, ..."
                                                className="w-full bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#333] rounded px-2.5 py-1.5 text-gray-900 dark:text-white text-xs font-mono" />
                                            <input type="text" value={fheFinalizeAmounts}
                                                onChange={(e) => setFheFinalizeAmounts(e.target.value)}
                                                placeholder="0.1, 0.05, ... (ETH)"
                                                className="w-full bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#333] rounded px-2.5 py-1.5 text-gray-900 dark:text-white text-xs font-mono" />
                                            <button
                                                onClick={handleFinalizeWithPrizesFHE}
                                                disabled={completedStep !== 4 || actionLoading === 'fhe-finalize-prizes' || isCancelled || isFinalized}
                                                className="w-full bg-yellow-500 hover:bg-yellow-600 text-black py-1.5 rounded-lg text-xs font-bold disabled:opacity-50"
                                            >
                                                {actionLoading === 'fhe-finalize-prizes' ? 'Finalizing...' : isFinalized ? '✓ Finalized' : 'Finalize with Prizes'}
                                            </button>
                                        </div>
                                    </div>

                                    {/* Cancel */}
                                    {!isCancelled && !isFinalized && (
                                        <button
                                            onClick={() => handleCancelTournament(fheSelectedTournament)}
                                            disabled={actionLoading === 'cancel'}
                                            className="w-full bg-red-50 dark:bg-red-500/10 hover:bg-red-500 text-red-600 dark:text-red-400 hover:text-white py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                        >
                                            {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Tournament'}
                                        </button>
                                    )}
                                </div>
                            );
                        })()}

                        {/* Tournaments mini-list */}
                        {fheTournaments.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-[#2A2A2A]">
                                <p className="text-gray-400 text-xs uppercase font-bold mb-2">All FHE Tournaments</p>
                                <div className="space-y-1.5">
                                    {fheTournaments.map((t) => {
                                        const statusLabels = ['Created', 'Active', 'Finalized', 'Cancelled'];
                                        const statusColors = ['text-blue-500 bg-blue-500/10', 'text-green-500 bg-green-500/10', 'text-gray-400 bg-gray-500/10', 'text-red-500 bg-red-500/10'];
                                        return (
                                            <div key={t.id}
                                                onClick={() => setFheSelectedTournament(t.id)}
                                                className={`flex items-center justify-between rounded-lg px-3 py-2 cursor-pointer transition-colors ${fheSelectedTournament === t.id ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-gray-50 dark:bg-black/30 hover:bg-gray-100 dark:hover:bg-black/50'}`}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span className="text-gray-900 dark:text-white font-bold text-sm">#{t.id}</span>
                                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${statusColors[t.status]}`}>{statusLabels[t.status]}</span>
                                                    {t.pointsFinalized && <span className="text-[10px] text-cyan-400">pts✓</span>}
                                                    {t.scoresComputed && <span className="text-[10px] text-green-400">scores✓</span>}
                                                </div>
                                                <span className="text-xs text-gray-400 font-mono">{t.entryCount} entries</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Database Management */}
                <div className="mt-6 bg-white dark:bg-[#121212] border border-red-200 dark:border-red-500/30 rounded-xl p-6">
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <Database className="w-5 h-5 text-red-500" />
                        Database Management
                    </h3>
                    <p className="text-gray-500 text-sm mb-4">
                        Dangerous actions. Enter admin API key to unlock.
                    </p>

                    <div className="mb-4">
                        <label className="text-gray-500 dark:text-gray-400 text-sm mb-2 block flex items-center gap-1">
                            <Key className="w-3.5 h-3.5" /> Admin API Key
                        </label>
                        <input
                            type="password"
                            value={adminKey}
                            onChange={(e) => { setAdminKey(e.target.value); setConfirmAction(null); }}
                            placeholder="Paste admin key..."
                            className="w-full bg-gray-50 dark:bg-black border border-gray-200 dark:border-[#333] rounded-lg px-4 py-2 text-gray-900 dark:text-white font-mono text-sm"
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <button
                            onClick={() => handleDbAction('clear-news')}
                            disabled={!adminKey.trim() || dbActionLoading !== null}
                            className={`py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-40 ${
                                confirmAction === 'clear-news'
                                    ? 'bg-red-500 text-white animate-pulse'
                                    : 'bg-red-50 dark:bg-red-500/20 hover:bg-red-500 text-red-600 dark:text-red-400 hover:text-white'
                            }`}
                        >
                            <Trash2 className="w-4 h-4" />
                            {dbActionLoading === 'clear-news'
                                ? 'Clearing...'
                                : confirmAction === 'clear-news'
                                    ? 'Click again to confirm'
                                    : 'Clear All News'}
                        </button>
                        <button
                            onClick={() => handleDbAction('reset-scores')}
                            disabled={!adminKey.trim() || dbActionLoading !== null}
                            className={`py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-40 ${
                                confirmAction === 'reset-scores'
                                    ? 'bg-red-500 text-white animate-pulse'
                                    : 'bg-red-50 dark:bg-red-500/20 hover:bg-red-500 text-red-600 dark:text-red-400 hover:text-white'
                            }`}
                        >
                            <Trash2 className="w-4 h-4" />
                            {dbActionLoading === 'reset-scores'
                                ? 'Resetting...'
                                : confirmAction === 'reset-scores'
                                    ? 'Click again to confirm'
                                    : 'Reset All Scores'}
                        </button>
                    </div>
                </div>

                {/* Waitlist */}
                <div className="mt-6 bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-6">
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <Users className="w-5 h-5 text-cyan-500" />
                        Waitlist {waitlistEntries.length > 0 && `(${waitlistEntries.length})`}
                    </h3>
                    <div className="flex gap-3 mb-4">
                        <button
                            onClick={loadWaitlist}
                            disabled={waitlistLoading || !adminKey.trim()}
                            className="bg-cyan-500 hover:bg-cyan-600 text-white font-bold py-2 px-4 rounded-lg transition-all disabled:opacity-40 flex items-center gap-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${waitlistLoading ? 'animate-spin' : ''}`} />
                            {waitlistLoading ? 'Loading...' : 'Load Waitlist'}
                        </button>
                        {waitlistEntries.length > 0 && (
                            <button
                                onClick={downloadWaitlistTxt}
                                className="bg-gray-100 dark:bg-[#1A1A1A] hover:bg-gray-200 dark:hover:bg-[#222] text-gray-900 dark:text-white font-bold py-2 px-4 rounded-lg transition-all flex items-center gap-2"
                            >
                                <Download className="w-4 h-4" />
                                Download TXT
                            </button>
                        )}
                    </div>
                    {waitlistEntries.length > 0 && (
                        <div className="overflow-x-auto max-h-80 overflow-y-auto border border-gray-200 dark:border-[#333] rounded-lg">
                            <table className="w-full text-sm">
                                <thead className="bg-gray-50 dark:bg-[#0A0A0A] sticky top-0">
                                    <tr>
                                        <th className="text-left px-3 py-2 text-gray-500 font-medium">#</th>
                                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Email</th>
                                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Wallet</th>
                                        <th className="text-left px-3 py-2 text-gray-500 font-medium">Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {waitlistEntries.map((entry, i) => (
                                        <tr key={entry.id} className="border-t border-gray-100 dark:border-[#222]">
                                            <td className="px-3 py-2 text-gray-400">{i + 1}</td>
                                            <td className="px-3 py-2 text-gray-900 dark:text-white font-mono text-xs">{entry.email}</td>
                                            <td className="px-3 py-2 text-gray-500 font-mono text-xs">{entry.wallet_address?.slice(0, 6)}...{entry.wallet_address?.slice(-4)}</td>
                                            <td className="px-3 py-2 text-gray-400 text-xs">{new Date(entry.created_at).toLocaleDateString()}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Tournament List */}
                <div className="mt-6 bg-white dark:bg-[#121212] border border-gray-200 dark:border-[#2A2A2A] rounded-xl p-6">
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <Calendar className="w-5 h-5 text-cyan-500" />
                        All Tournaments ({tournaments.length})
                    </h3>

                    {tournaments.length === 0 ? (
                        <p className="text-gray-500 text-center py-8">No tournaments created yet</p>
                    ) : (
                        <div className="space-y-3">
                            {tournaments.map((t) => {
                                const statusInfo = getStatusInfo(t.status);
                                const now = Date.now() / 1000;
                                const isEnded = t.endTime < now;
                                const isActive = t.startTime <= now && t.endTime >= now;
                                const isRegistration = t.registrationStart <= now && t.startTime > now;

                                return (
                                    <div
                                        key={t.id}
                                        className={`bg-gray-50 dark:bg-black/50 rounded-lg p-4 border ${stats?.activeTournamentId === t.id
                                            ? 'border-yc-green'
                                            : 'border-transparent'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-3">
                                                <span className="text-gray-900 dark:text-white font-bold text-lg">#{t.id}</span>
                                                <span className={`px-2 py-0.5 rounded text-xs font-bold ${statusInfo.color}`}>
                                                    {statusInfo.text}
                                                </span>
                                                {stats?.activeTournamentId === t.id && (
                                                    <span className="px-2 py-0.5 rounded text-xs font-bold text-yc-green bg-yc-green/10 dark:bg-yc-green/20">
                                                        Active Prize Pool
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-4 text-sm">
                                                <div className="flex items-center gap-1 text-yc-purple">
                                                    <DollarSign className="w-4 h-4" />
                                                    <span className="font-mono">{formatXTZ(t.prizePool)} {currencySymbol()}</span>
                                                </div>
                                                <div className="flex items-center gap-1 text-gray-400">
                                                    <Users className="w-4 h-4" />
                                                    <span className="font-mono">{t.entryCount} entries</span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-3 gap-4 text-sm">
                                            <div>
                                                <p className="text-gray-500 text-xs uppercase mb-1">Registration</p>
                                                <p className={`font-mono ${isRegistration ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
                                                    {formatDate(t.registrationStart)}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-gray-500 text-xs uppercase mb-1">Start</p>
                                                <p className={`font-mono ${isActive ? 'text-green-500 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
                                                    {formatDate(t.startTime)}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-gray-500 text-xs uppercase mb-1">End</p>
                                                <p className={`font-mono ${isEnded ? 'text-red-500 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
                                                    {formatDate(t.endTime)}
                                                    {!isEnded && t.endTime > now && (
                                                        <span className="ml-2 text-xs text-yc-purple">
                                                            ({Math.ceil((t.endTime - now) / 3600)}h left)
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Action Buttons - show for Created (0) and Active (1) */}
                                        {(t.status === 0 || t.status === 1) && (
                                            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-[#2A2A2A] flex flex-wrap gap-2">
                                                <button
                                                    onClick={() => handleCancelTournament(t.id)}
                                                    disabled={actionLoading === 'cancel'}
                                                    className="flex-1 bg-red-50 dark:bg-red-500/20 hover:bg-red-500 text-red-600 dark:text-red-400 hover:text-white py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                                >
                                                    {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Tournament'}
                                                </button>
                                                <button
                                                    onClick={() => handleFinalizeTournament(t.id)}
                                                    disabled={actionLoading === 'finalize'}
                                                    className="flex-1 bg-green-50 dark:bg-green-500/20 hover:bg-green-500 text-green-600 dark:text-green-400 hover:text-white py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                                >
                                                    {actionLoading === 'finalize' ? 'Finalizing...' : 'Finalize & Unlock NFTs'}
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setShowPointsModal(t);
                                                        setPointsValues(Array(19).fill('0'));
                                                    }}
                                                    disabled={actionLoading?.startsWith('finalize')}
                                                    className="flex-1 bg-cyan-50 dark:bg-yc-purple/20 hover:bg-yc-purple text-yc-purple hover:text-white py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                                >
                                                    Finalize with Points
                                                </button>
                                            </div>
                                        )}

                                        {/* Admin Withdraw - Available for any tournament with prize pool */}
                                        {t.prizePool > 0n && (
                                            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-[#2A2A2A]">
                                                <button
                                                    onClick={() => handleWithdrawFromTournament(t)}
                                                    disabled={actionLoading === 'withdraw-' + t.id}
                                                    className="w-full bg-cyan-50 dark:bg-cyan-500/20 hover:bg-cyan-500 text-cyan-600 dark:text-cyan-400 hover:text-white py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                                                >
                                                    {actionLoading === 'withdraw-' + t.id
                                                        ? 'Withdrawing...'
                                                        : `Withdraw ${formatXTZ(t.prizePool)} ${currencySymbol()}`}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* FHE Set Points Modal */}
            {showFhePointsModal && (
                <div className="fixed inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-[#0A0A0A] border border-gray-200 dark:border-[#2A2A2A] rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                        <div className="p-6 border-b border-gray-200 dark:border-[#2A2A2A] sticky top-0 bg-white dark:bg-[#0A0A0A]">
                            <div className="flex justify-between items-center">
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">Set Encrypted Points - Tournament #{fheSelectedTournament}</h3>
                                    <p className="text-gray-500 text-sm">Enter points (0-1000) for each startup. Values will be encrypted via CoFHE.</p>
                                </div>
                                <button onClick={() => setShowFhePointsModal(false)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-2">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-6 space-y-3">
                            {startupNames.map((name, i) => (
                                <div key={i} className="flex items-center gap-4">
                                    <div className="w-8 h-8 bg-cyan-500/10 dark:bg-cyan-500/20 rounded-lg flex items-center justify-center text-cyan-500 font-bold text-sm">
                                        {i + 1}
                                    </div>
                                    <span className="flex-1 text-gray-900 dark:text-white font-medium">{name}</span>
                                    <input
                                        type="number"
                                        min="0"
                                        max="1000"
                                        value={fhePointsValues[i]}
                                        onChange={(e) => {
                                            const newPoints = [...fhePointsValues];
                                            newPoints[i] = e.target.value;
                                            setFhePointsValues(newPoints);
                                        }}
                                        className="w-24 px-3 py-2 bg-gray-50 dark:bg-black border border-gray-200 dark:border-[#2A2A2A] rounded-lg text-gray-900 dark:text-white font-mono text-right focus:border-cyan-500 outline-none"
                                        placeholder="0"
                                    />
                                </div>
                            ))}
                        </div>

                        <div className="p-6 border-t border-gray-200 dark:border-[#2A2A2A] sticky bottom-0 bg-white dark:bg-[#0A0A0A] flex gap-3">
                            <button
                                onClick={() => setShowFhePointsModal(false)}
                                className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 font-bold transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSetEncryptedPointsFHE}
                                disabled={actionLoading === 'fhe-points'}
                                className="flex-1 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-600 text-white font-bold transition-all disabled:opacity-50"
                            >
                                {actionLoading === 'fhe-points' ? 'Encrypting & Sending...' : 'Set Encrypted Points'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Points Finalization Modal */}
            {
                showPointsModal && (
                    <div className="fixed inset-0 bg-black/60 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                        <div className="bg-white dark:bg-[#0A0A0A] border border-gray-200 dark:border-[#2A2A2A] rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                            <div className="p-6 border-b border-gray-200 dark:border-[#2A2A2A] sticky top-0 bg-white dark:bg-[#0A0A0A]">
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h3 className="text-xl font-bold text-gray-900 dark:text-white">Finalize Tournament #{showPointsModal.id}</h3>
                                        <p className="text-gray-500 text-sm">Enter points for each startup (higher = better performance)</p>
                                    </div>
                                    <button
                                        onClick={() => setShowPointsModal(null)}
                                        className="text-gray-400 hover:text-gray-900 dark:hover:text-white p-2"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>

                            <div className="p-6 space-y-3">
                                {startupNames.map((name, i) => (
                                    <div key={i} className="flex items-center gap-4">
                                        <div className="w-8 h-8 bg-yc-purple/10 dark:bg-yc-purple/20 rounded-lg flex items-center justify-center text-yc-purple font-bold text-sm">
                                            {i + 1}
                                        </div>
                                        <span className="flex-1 text-gray-900 dark:text-white font-medium">{name}</span>
                                        <input
                                            type="number"
                                            min="0"
                                            value={pointsValues[i]}
                                            onChange={(e) => {
                                                const newPoints = [...pointsValues];
                                                newPoints[i] = e.target.value;
                                                setPointsValues(newPoints);
                                            }}
                                            className="w-24 px-3 py-2 bg-gray-50 dark:bg-black border border-gray-200 dark:border-[#2A2A2A] rounded-lg text-gray-900 dark:text-white font-mono text-right focus:border-yc-purple outline-none"
                                            placeholder="0"
                                        />
                                    </div>
                                ))}
                            </div>

                            <div className="p-6 border-t border-gray-200 dark:border-[#2A2A2A] sticky bottom-0 bg-white dark:bg-[#0A0A0A] flex gap-3">
                                <button
                                    onClick={() => setShowPointsModal(null)}
                                    className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-white/5 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400 font-bold transition-all"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleFinalizeWithPoints}
                                    disabled={actionLoading === 'finalize-points'}
                                    className="flex-1 py-3 rounded-xl bg-yc-purple hover:bg-yc-purple/80 text-white font-bold transition-all disabled:opacity-50"
                                >
                                    {actionLoading === 'finalize-points' ? 'Finalizing...' : 'Finalize Tournament'}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }
        </>
    );
};

export default AdminPanel;
