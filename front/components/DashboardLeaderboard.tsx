import React, { useState, useEffect, useCallback } from 'react';
import { Trophy, ArrowRight, Crown, Medal, Award, Shield, Lock, Loader2 } from 'lucide-react';
import { NavSection } from '../types';
import { generatePixelAvatar } from '../lib/pixelAvatar';
import { useWalletContext } from '../context/WalletContext';
import { useActiveTournament, useSharedLeaderboard } from '../hooks/useSharedData';
import { isFhenixNetwork } from '../lib/fhenix';
import { getDarkLeaderboardContract, getReadProvider } from '../lib/contracts';
import { DarkLeaderboardEntry } from '../hooks/useTournamentFHE';

interface DashboardLeaderboardProps {
    onNavigate: (section: NavSection) => void;
}

const DashboardLeaderboard: React.FC<DashboardLeaderboardProps> = ({ onNavigate }) => {
    const { data: tournament } = useActiveTournament();
    const tournamentId = tournament?.id ?? null;
    const { data: players, isLoading: loading } = useSharedLeaderboard(tournamentId);
    const { address } = useWalletContext();

    // ── Dark Leaderboard (on-chain, FHE networks only) ─────────────────────
    const [darkEntries, setDarkEntries] = useState<DarkLeaderboardEntry[]>([]);
    const [darkLoading, setDarkLoading] = useState(false);
    const [darkError, setDarkError] = useState<string | null>(null);

    const fetchDarkLeaderboard = useCallback(async (tId: number) => {
        setDarkLoading(true);
        setDarkError(null);
        try {
            const provider = getReadProvider();
            const contract = getDarkLeaderboardContract(provider);
            const [addrs, ranks] = await contract.getLeaderboardPage(tId, 0, 3);
            const entries: DarkLeaderboardEntry[] = addrs.map((addr: string, i: number) => ({
                rank: Number(ranks[i]),
                address: addr,
            }));
            setDarkEntries(entries);
        } catch (e: any) {
            console.error('Dark leaderboard fetch failed:', e);
            setDarkError(e.reason || e.message || 'Failed to load dark leaderboard');
            setDarkEntries([]);
        } finally {
            setDarkLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isFhenixNetwork() && tournamentId !== null) {
            fetchDarkLeaderboard(tournamentId);
        }
    }, [tournamentId, fetchDarkLeaderboard]);

    const formatAddress = (addr: string) => {
        if (addr.length <= 12) return addr;
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
    };

    const getRankIcon = (rank: number) => {
        if (rank === 1) return <Crown className="w-4 h-4 text-yellow-500" />;
        if (rank === 2) return <Medal className="w-4 h-4 text-gray-400" />;
        if (rank === 3) return <Award className="w-4 h-4 text-amber-600" />;
        return <span className="text-xs font-bold text-gray-500 w-4 text-center">{rank}</span>;
    };

    if (loading) {
        return (
            <div className="my-8">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-lg text-gray-900 dark:text-white/80">
                        Leaderboard
                    </h3>
                </div>
                <div className="bg-white/60 dark:bg-zinc-900/60 backdrop-blur-2xl border border-white/40 dark:border-white/[0.08] rounded-2xl p-8 shadow-[0_8px_32px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.4)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.05)]">
                    <div className="flex items-center justify-center">
                        <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin"></div>
                        <span className="ml-3 text-gray-500 text-sm">Loading leaderboard...</span>
                    </div>
                </div>
            </div>
        );
    }

    if (!tournamentId || !players || players.length === 0) {
        return (
            <div className="my-8">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-lg text-gray-900 dark:text-white/80">
                        Leaderboard
                    </h3>
                </div>
                <div className="bg-white/60 dark:bg-zinc-900/60 backdrop-blur-2xl border border-white/40 dark:border-white/[0.08] rounded-2xl p-8 text-center shadow-[0_8px_32px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.4)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.05)]">
                    <Trophy className="w-10 h-10 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
                    <p className="text-gray-400 dark:text-gray-500 text-sm">No players yet. Be the first to enter the tournament!</p>
                </div>
            </div>
        );
    }

    return (
        <div className="my-8">
            <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-lg text-gray-900 dark:text-white/80 flex items-center gap-2">
                    {isFhenixNetwork() && <Shield className="w-4 h-4 text-green-400" />}
                    {isFhenixNetwork() ? 'Dark Leaderboard' : 'Leaderboard'}
                </h3>
                <button
                    onClick={() => onNavigate(NavSection.LEAGUES)}
                    className="text-xs font-medium text-gray-500 hover:text-yc-purple flex items-center transition-colors"
                >
                    View All
                    <ArrowRight className="w-3 h-3 ml-1" />
                </button>
            </div>

            {isFhenixNetwork() && (
                <div className="mb-2 px-3 py-2 bg-green-500/5 border border-green-500/20 rounded-xl">
                    <p className="text-[10px] text-green-400 text-center">
                        Scores encrypted via FHE — only ranks are visible
                    </p>
                </div>
            )}

            <div className="bg-white/60 dark:bg-zinc-900/60 backdrop-blur-2xl border border-white/40 dark:border-white/[0.08] rounded-2xl overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.4)] dark:shadow-[0_8px_32px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.05)]">
                <div className="divide-y divide-white/30 dark:divide-white/[0.04]">
                    {players.map((player) => {
                        const isCurrentUser = address && player.address.toLowerCase() === address.toLowerCase();

                        return (
                            <div
                                key={player.address}
                                className={`flex items-center px-4 py-3.5 hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors ${isCurrentUser ? 'bg-yc-purple/5 dark:bg-yc-purple/[0.06]' : ''
                                    }`}
                            >
                                {/* Rank */}
                                <div className={`w-8 h-8 flex items-center justify-center rounded-lg shrink-0 ${player.rank === 1 ? 'bg-yellow-500/10' :
                                        player.rank === 2 ? 'bg-gray-400/10' :
                                            player.rank === 3 ? 'bg-amber-700/10' : ''
                                    }`}>
                                    {getRankIcon(player.rank)}
                                </div>

                                {/* Avatar + Name */}
                                <div className="flex items-center ml-3 flex-1 min-w-0">
                                    <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 border border-gray-300 dark:border-white/[0.08] overflow-hidden shrink-0">
                                        <img
                                            src={player.avatar || generatePixelAvatar(player.address, 56)}
                                            alt=""
                                            className="w-full h-full object-cover"
                                            style={{ imageRendering: player.avatar ? 'auto' : 'pixelated' }}
                                        />
                                    </div>
                                    <div className="ml-2 min-w-0">
                                        <p className={`text-sm font-semibold truncate ${isCurrentUser ? 'text-yc-purple' : 'text-gray-900 dark:text-white'
                                            }`}>
                                            {player.username || formatAddress(player.address)}
                                            {isCurrentUser && <span className="text-[10px] text-gray-400 ml-1">(You)</span>}
                                        </p>
                                    </div>
                                </div>

                                {/* Score — hidden on FHE networks (Dark Leaderboard) */}
                                <div className="text-right shrink-0">
                                    {isFhenixNetwork() ? (
                                        <>
                                            <p className="text-sm font-bold font-mono text-green-400">
                                                #{player.rank}
                                            </p>
                                            <p className="text-[10px] text-green-500/60 font-mono">rank</p>
                                        </>
                                    ) : (
                                        <>
                                            <p className="text-sm font-bold font-mono text-gray-900 dark:text-white">
                                                {player.score.toFixed(1)}
                                            </p>
                                            <p className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">pts</p>
                                        </>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ── Dark Leaderboard (on-chain, FHE only) ──────────────────── */}
            {isFhenixNetwork() && (
                <div className="mt-6">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-semibold text-gray-900 dark:text-white/80 flex items-center gap-2">
                            <Lock className="w-3.5 h-3.5 text-green-400" />
                            Dark Leaderboard
                            <span className="px-1.5 py-0.5 rounded bg-green-500/10 border border-green-500/20 text-[9px] font-bold text-green-400 uppercase tracking-wider">
                                Encrypted
                            </span>
                        </h4>
                    </div>

                    <div className="bg-green-500/[0.03] border border-green-500/20 rounded-xl overflow-hidden">
                        {darkLoading ? (
                            <div className="flex items-center justify-center py-6">
                                <Loader2 className="w-4 h-4 animate-spin text-green-400" />
                                <span className="ml-2 text-xs text-green-400">Reading on-chain ranks...</span>
                            </div>
                        ) : darkError ? (
                            <div className="px-4 py-4 text-center">
                                <p className="text-xs text-red-400">{darkError}</p>
                            </div>
                        ) : darkEntries.length === 0 ? (
                            <div className="px-4 py-6 text-center">
                                <Shield className="w-6 h-6 mx-auto mb-2 text-green-500/40" />
                                <p className="text-xs text-green-500/60">No on-chain ranks published yet</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-green-500/10">
                                {darkEntries.map((entry) => {
                                    const isMe = address && entry.address.toLowerCase() === address.toLowerCase();
                                    return (
                                        <div
                                            key={entry.address}
                                            className={`flex items-center px-4 py-3 ${isMe ? 'bg-green-500/[0.06]' : ''}`}
                                        >
                                            {/* Rank */}
                                            <div className={`w-7 h-7 flex items-center justify-center rounded-lg shrink-0 ${
                                                entry.rank === 1 ? 'bg-yellow-500/10' :
                                                entry.rank === 2 ? 'bg-gray-400/10' :
                                                entry.rank === 3 ? 'bg-amber-700/10' : ''
                                            }`}>
                                                {getRankIcon(entry.rank)}
                                            </div>

                                            {/* Avatar + Address */}
                                            <div className="flex items-center ml-3 flex-1 min-w-0">
                                                <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-white/10 border border-green-500/20 overflow-hidden shrink-0">
                                                    <img
                                                        src={generatePixelAvatar(entry.address, 56)}
                                                        alt=""
                                                        className="w-full h-full object-cover"
                                                        style={{ imageRendering: 'pixelated' }}
                                                    />
                                                </div>
                                                <div className="ml-2 min-w-0">
                                                    <p className={`text-sm font-semibold truncate font-mono ${isMe ? 'text-green-400' : 'text-gray-900 dark:text-white'}`}>
                                                        {formatAddress(entry.address)}
                                                        {isMe && <span className="text-[10px] text-green-500/60 ml-1">(You)</span>}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Rank display — NO score */}
                                            <div className="text-right shrink-0">
                                                <p className="text-sm font-bold font-mono text-green-400">
                                                    #{entry.rank}
                                                </p>
                                                <p className="text-[10px] text-green-500/60 font-mono">rank</p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {/* Footer note */}
                        <div className="px-3 py-2 border-t border-green-500/10 bg-green-500/[0.02]">
                            <p className="text-[9px] text-green-500/50 text-center">
                                Scores are encrypted on-chain via FHE — only ranks are publicly visible
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DashboardLeaderboard;
