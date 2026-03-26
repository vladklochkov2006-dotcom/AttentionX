/**
 * AttentionX Server Configuration
 * Single source of truth for all contract addresses and chain config.
 * Both server/index.js and server/jobs/daily-scorer.js import from here.
 * When contracts are redeployed, update ONLY this file and restart the server.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load admin key from scripts/.env (for tournament finalization)
function loadAdminKey() {
    if (process.env.ADMIN_PRIVATE_KEY) return process.env.ADMIN_PRIVATE_KEY;
    const envPath = join(__dirname, '..', 'scripts', '.env');
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        const match = content.match(/PRIVATE_KEY=(.+)/);
        if (match) return match[1].trim();
    }
    return null;
}

export const ADMIN_PRIVATE_KEY = loadAdminKey();

// Load admin API key (for HTTP endpoint auth, separate from blockchain signing key)
function loadAdminApiKey() {
    if (process.env.ADMIN_API_KEY) return process.env.ADMIN_API_KEY;
    const envPath = join(__dirname, '..', 'scripts', '.env');
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        const match = content.match(/ADMIN_API_KEY=(.+)/);
        if (match) return match[1].trim();
    }
    return null;
}

export const ADMIN_API_KEY = loadAdminApiKey();

// Load all security env vars from scripts/.env into process.env
function loadEnvVars() {
    const envPath = join(__dirname, '..', 'scripts', '.env');
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.substring(0, eq).trim();
        const val = line.substring(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
}
loadEnvVars();

// Fhenix CoFHE on Ethereum Sepolia
const CHAIN_CONFIGS = {
    fhenix: {
        RPC_URL: process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org',
        CHAIN_ID: 11155111,
        EXPLORER: 'https://sepolia.etherscan.io',
        SERVER_PORT: 3007,
    },
};

const CONTRACT_CONFIGS = {
    fhenix: {
        AttentionX_NFT: '0x409384AF735AAe5AD58cE4dc70c9309E9f3E72aF',
        PackNFT: '0xe8BBC11b3CEFdC64D79af217f79497B7EAf34fa5',
        PackOpener: '0xB6F73D5172425B734E020073A80A44d8B22FfA39',
        TournamentManager: '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81',
        TournamentManagerFHE: '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81',
        MarketplaceV2: '0x8C64e6380561496B278AC7Ab6f35AFf9aB88160C',
        DarkLeaderboard: '0xf08e22e350026c670D86ef0A794064e9D301d5eE',
        EncryptedCardStats: '0x412bE266fA5e3f78Af950bb96860D839699d3822',
        SealedBidMarketplace: '0x1bA2BA3B00096924dDf2fE18b328387beafaBF5E',
    },
};

export const NETWORK_NAME = process.env.CHAIN_NETWORK || 'fhenix';
export const CHAIN = CHAIN_CONFIGS[NETWORK_NAME] || CHAIN_CONFIGS.fhenix;
export const CONTRACTS = CONTRACT_CONFIGS[NETWORK_NAME] || CONTRACT_CONFIGS.fhenix;

// DB filename
export const DB_FILENAME = 'attentionx.db';

// Expose all network configs for the unified scorer
export { CHAIN_CONFIGS, CONTRACT_CONFIGS };

/** All supported network IDs */
export const ALL_NETWORKS = Object.keys(CHAIN_CONFIGS);

/** Get absolute DB path for a given network */
export function dbPathForNetwork(networkName) {
    return join(__dirname, 'db', 'attentionx.db');
}

/** Get schema.sql path */
export function schemaPath() {
    return join(__dirname, 'db', 'schema.sql');
}
