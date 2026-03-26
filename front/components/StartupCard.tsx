import React from 'react';
import { Startup } from '../types';
import { TrendingUp, TrendingDown, MoreHorizontal, Activity } from 'lucide-react';
import { currencySymbol } from '../lib/networks';

interface StartupCardProps {
  startup: Startup;
  onClick?: () => void;
}

const StartupCard: React.FC<StartupCardProps> = ({ startup, onClick }) => {
  const isPositive = startup.change >= 0;

  return (
    <div 
        onClick={onClick}
        className={`flex flex-col bg-white dark:bg-[#09090b] border border-gray-200 dark:border-[#27272a] rounded-xl overflow-hidden hover:border-gray-300 dark:hover:border-gray-600 transition-all duration-200 group relative h-full ${onClick ? 'cursor-pointer' : ''}`}
    >
      
      {/* Image Container */}
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: '591/1004' }}>
        <img
            src={startup.coverImage}
            alt={startup.name}
            className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-105"
        />
      </div>

      {/* Content Section */}
      <div className="p-1.5 md:p-4 flex flex-col flex-1 bg-white dark:bg-[#09090b]">

        {/* Mobile: just price */}
        <p className="text-gray-900 dark:text-white font-bold text-[11px] md:text-lg leading-tight font-mono">
            ${startup.value} {currencySymbol()}
        </p>

        {/* Desktop only: full details */}
        <div className="hidden md:block">
          <div className="flex justify-between items-start mb-2 mt-1">
              <div>
                   <h3 className="text-lg font-bold text-gray-900 dark:text-white leading-tight">{startup.name}</h3>
                   <p className="text-[10px] text-gray-400 font-mono mt-0.5">{startup.batch}</p>
              </div>
              <Activity className="w-4 h-4 text-gray-300" />
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mb-6 leading-relaxed">
              {startup.description}
          </p>

          {/* Bottom Stats - Grid Layout */}
          <div className="mt-auto grid grid-cols-2 gap-px bg-gray-100 dark:bg-[#27272a] border border-gray-100 dark:border-[#27272a] rounded-lg overflow-hidden">
              <div className="bg-white dark:bg-[#121212] p-2.5">
                  <span className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-0.5">Valuation</span>
                  <span className="block text-sm font-bold text-gray-900 dark:text-white font-mono">${startup.value}B</span>
              </div>
              <div className="bg-white dark:bg-[#121212] p-2.5">
                  <span className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-0.5">24h Change</span>
                  <div className={`flex items-center text-sm font-bold font-mono ${isPositive ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {isPositive ? '+' : ''}{startup.change}%
                      {isPositive ? <TrendingUp className="w-3 h-3 ml-1" /> : <TrendingDown className="w-3 h-3 ml-1" />}
                  </div>
              </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StartupCard;