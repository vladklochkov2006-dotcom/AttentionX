import React, { useState } from 'react';
import { Trophy, ChevronDown, Gift, CheckCircle, Users, Clock, Loader2 } from 'lucide-react';
import { useWalletContext } from '../context/WalletContext';
import { useTournamentHistory, PastTournamentEntry } from '../hooks/useTournamentHistory';
import { formatXTZ } from '../lib/contracts';
import { currencySymbol } from '../lib/networks';

interface TournamentHistoryProps {
    activeTournamentId: number;
}

const STATUS_COLOR: Record<string, string> = {
    'Finalized': 'bg-yellow-500',
    'Created': 'bg-gray-500',
    'Active': 'bg-green-500',
    'Cancelled': 'bg-red-500',
};

function formatDateRange(startTime: number, endTime: number): string {
    const s = new Date(startTime * 1000);
    const e = new Date(endTime * 1000);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const startStr = s.toLocaleDateString('en-US', opts);
    const endStr = e.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
    return `${startStr} — ${endStr}`;
}

const TournamentHistory: React.FC<TournamentHistoryProps> = ({ activeTournamentId }) => {
    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [claimingId, setClaimingId] = useState<number | null>(null);

    const { isConnected, address, getSigner } = useWalletContext();
    const { entries, loading, claimPrize } = useTournamentHistory(activeTournamentId);

    if (!isConnected || !address) return null;
    if (loading && entries.length === 0) return null;
    if (entries.length === 0) return null;

    const handleClaim = async (tournamentId: number) => {
        setClaimingId(tournamentId);
        const signer = await getSigner();
        if (!signer) {
            setClaimingId(null);
            return;
        }
        await claimPrize(signer, tournamentId);
        setClaimingId(null);
    };

    return (
        <div className="mt-8">
            <h3 className="font-bold text-lg sm:text-xl text-yc-text-primary dark:text-white flex items-center mb-4">
                <Trophy className="w-5 h-5 mr-2 text-gray-400" />
                Past Tournaments
                {loading && <Loader2 className="w-4 h-4 ml-2 animate-spin text-gray-400" />}
            </h3>

            <div className="space-y-3">
                {entries.map((e) => {
                    const isExpanded = expandedId === e.tournamentId;
                    const isClaiming = claimingId === e.tournamentId;

                    return (
                        <div key={e.tournamentId} className="glass-panel rounded-xl overflow-hidden">
                            {/* Header — always visible */}
                            <div
                                onClick={() => setExpandedId(isExpanded ? null : e.tournamentId)}
                                className="flex items-center px-3 sm:px-5 py-3 sm:py-4 cursor-pointer hover:bg-white/5 transition-colors"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                        <span className="px-2 py-0.5 bg-yc-purple text-white text-[10px] font-bold uppercase rounded">
                                            #{e.tournamentId}
                                        </span>
                                        <span className={`px-2 py-0.5 text-white text-[10px] font-bold uppercase rounded ${STATUS_COLOR[e.status] || 'bg-gray-500'}`}>
                                            {e.status}
                                        </span>
                                        <span className="px-2 py-0.5 bg-yc-green/20 text-yc-green text-[10px] font-bold uppercase rounded flex items-center">
                                            <CheckCircle size={10} className="mr-1" /> Entered
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                                        <span className="flex items-center">
                                            <Clock size={11} className="mr-1" />
                                            {formatDateRange(e.startTime, e.endTime)}
                                        </span>
                                    </div>
                                </div>

                                <div className="text-right shrink-0 ml-3 flex items-center gap-3">
                                    <div>
                                        <p className="text-sm font-bold font-mono text-yc-purple">
                                            {formatXTZ(e.prizePool)} {currencySymbol()}
                                        </p>
                                        <p className="text-[10px] text-gray-400 flex items-center justify-end">
                                            <Users size={10} className="mr-1" /> {e.entryCount}
                                        </p>
                                    </div>
                                    <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                </div>
                            </div>

                            {/* Expanded detail */}
                            {isExpanded && (
                                <div className="px-3 sm:px-5 py-3 sm:py-4 border-t border-gray-200 dark:border-[#2A2A2A] bg-white/5">
                                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-6">
                                        <div className="flex items-center gap-4 sm:gap-6">
                                            <div>
                                                <p className="text-[10px] text-gray-500 uppercase font-bold">Your Score</p>
                                                <p className="text-lg font-black font-mono text-yc-text-primary dark:text-white">
                                                    {Number(e.userScore).toLocaleString()}
                                                </p>
                                            </div>
                                            <div className="w-px h-8 bg-gray-300 dark:bg-gray-700"></div>
                                            <div>
                                                <p className="text-[10px] text-gray-500 uppercase font-bold">Your Prize</p>
                                                <p className="text-lg font-black font-mono text-yc-purple">
                                                    {e.userPrize > 0n
                                                        ? `${formatXTZ(e.userPrize)} ${currencySymbol()}`
                                                        : '—'
                                                    }
                                                </p>
                                            </div>
                                        </div>

                                        <div className="sm:ml-auto">
                                            {e.claimed ? (
                                                <span className="text-yc-green font-bold text-sm flex items-center">
                                                    <CheckCircle className="w-4 h-4 mr-1.5" /> Prize claimed
                                                </span>
                                            ) : e.userPrize > 0n ? (
                                                <button
                                                    onClick={(ev) => {
                                                        ev.stopPropagation();
                                                        handleClaim(e.tournamentId);
                                                    }}
                                                    disabled={isClaiming}
                                                    className="bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded-lg font-black text-xs uppercase tracking-wide transition-all flex items-center shadow-lg"
                                                >
                                                    {isClaiming ? (
                                                        <span className="animate-pulse">Claiming...</span>
                                                    ) : (
                                                        <>
                                                            <Gift className="w-4 h-4 mr-1.5" />
                                                            Claim {formatXTZ(e.userPrize)} {currencySymbol()}
                                                        </>
                                                    )}
                                                </button>
                                            ) : (
                                                <span className="text-gray-500 text-sm font-bold">No prize earned</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default TournamentHistory;
