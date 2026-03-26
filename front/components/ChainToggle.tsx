// Network indicator bar — currently single chain (Ethereum Sepolia)

import React from 'react';
import { useNetwork } from '../context/NetworkContext';
import { useWalletContext } from '../context/WalletContext';

const ChainToggle: React.FC = () => {
    const { activeNetwork, networkId, allNetworks, switchNetwork } = useNetwork();
    const { isConnected, switchChain, refreshBalance } = useWalletContext();

    const handleSwitch = (id: string) => {
        if (id === networkId) return;
        switchNetwork(id);
        // switchNetwork updates the module-level active network synchronously,
        // so switchChain/refreshBalance read the correct new network
        if (isConnected) {
            switchChain().catch(() => {});
            refreshBalance();
        }
    };

    return (
        <div className="flex items-center justify-center gap-1.5 py-1.5 px-3 mb-2 bg-gray-100 dark:bg-[#0a0a0a] rounded-xl border border-gray-200 dark:border-[#1a1a1a]">
            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mr-2 hidden sm:inline">
                Network
            </span>
            {allNetworks.map((net) => (
                <button
                    key={net.id}
                    onClick={() => handleSwitch(net.id)}
                    className={`
                        flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 active:scale-95
                        ${networkId === net.id
                            ? 'bg-yc-purple text-white shadow-md shadow-yc-purple/20'
                            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/5 hover:text-gray-700 dark:hover:text-gray-200'
                        }
                    `}
                >
                    <span className="text-sm">{net.icon}</span>
                    <span>{net.shortName}</span>
                    {!net.deployed && networkId === net.id && (
                        <span className="text-[8px] bg-white/20 px-1 py-0.5 rounded font-bold">SOON</span>
                    )}
                </button>
            ))}
        </div>
    );
};

export default ChainToggle;
