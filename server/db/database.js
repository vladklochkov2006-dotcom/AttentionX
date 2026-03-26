/**
 * Database module using sql.js (pure JavaScript, no Python needed)
 */

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DB_FILENAME } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, DB_FILENAME);

let SQL;
let db;
let currentDbPath = DB_PATH;

/**
 * Initialize database connection
 */
export async function initDatabase(forceReload = false) {
    if (db && !forceReload) return db;

    if (!SQL) {
        SQL = await initSqlJs();
    }

    // Load existing database or create new one
    if (existsSync(DB_PATH)) {
        const buffer = readFileSync(DB_PATH);
        db = new SQL.Database(buffer);
        console.log('✅ Database loaded from file');
    } else {
        db = new SQL.Database();
        console.log('✅ New database created');
    }

    return db;
}

/**
 * Save database to disk
 */
export function saveDatabase() {
    if (!db) return;
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(currentDbPath, buffer);
}

/**
 * Switch the active database to a different file.
 * Saves current DB first, then loads the new one.
 * Used by the unified scorer to write to multiple network DBs.
 * @param {string} newPath - Absolute path to the new DB file
 * @param {string} schemaPath - Optional path to schema.sql to apply if DB is new
 */
export async function switchToDb(newPath, schemaPath) {
    saveDatabase();
    if (!SQL) SQL = await initSqlJs();
    if (existsSync(newPath)) {
        db = new SQL.Database(readFileSync(newPath));
    } else {
        db = new SQL.Database();
        // Apply schema to new DB
        if (schemaPath && existsSync(schemaPath)) {
            const schema = readFileSync(schemaPath, 'utf-8');
            schema.split(';').filter(s => s.trim()).forEach(stmt => {
                if (stmt.trim()) db.run(stmt);
            });
        }
    }
    currentDbPath = newPath;
}

/**
 * Get the current DB file path.
 */
export function getCurrentDbPath() {
    return currentDbPath;
}

/**
 * Execute a query that doesn't return data (INSERT, UPDATE, DELETE)
 */
function exec(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    db.run(sql, params);
}

/**
 * Execute a query that returns a single row
 */
function get(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return result;
}

/**
 * Execute a query that returns multiple rows
 */
function all(sql, params = []) {
    if (!db) throw new Error('Database not initialized');
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

// ============ KV Store Functions ============

export function getConfig(key) {
    const row = get('SELECT value FROM kv_store WHERE key = ?', [key]);
    return row ? row.value : null;
}

export function setConfig(key, value) {
    exec('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)', [key, value]);
}

/**
 * Wipe all tournament-related data (scores, leaderboard, entries, etc.)
 * Called when contract addresses change to start fresh.
 * Preserves: user_profiles, referrals, players.
 */
export function wipeTournamentData() {
    exec('DELETE FROM tournaments');
    exec('DELETE FROM tournament_entries');
    exec('DELETE FROM tournament_cards');
    exec('DELETE FROM daily_scores');
    exec('DELETE FROM leaderboard');
    exec('DELETE FROM score_history');
    // NOTE: live_feed is NOT cleared — it's used by AI recommendations independent of tournaments
    console.log('   Wiped all tournament data (contract change detected, live_feed preserved)');
}

/**
 * Wipe all cached NFT card data.
 * Called when contract addresses change so stale card metadata doesn't persist.
 */
export function wipeNFTCards() {
    exec('DELETE FROM nft_cards');
    console.log('   Wiped all NFT card cache (contract change detected)');
}

// ============ Tournament Functions ============

export function saveTournament(tournament) {
    const sql = `
        INSERT OR REPLACE INTO tournaments
        (blockchain_id, start_time, end_time, prize_pool, entry_count, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `;
    exec(sql, [
        tournament.id,
        tournament.startTime,
        tournament.endTime,
        tournament.prizePool,
        tournament.entryCount,
        tournament.status
    ]);
}

export function getTournament(blockchainId) {
    return get('SELECT * FROM tournaments WHERE blockchain_id = ?', [blockchainId]);
}

export const getTournamentById = getTournament;

export function getAllTournaments() {
    return all('SELECT * FROM tournaments ORDER BY blockchain_id DESC');
}

export function getActiveTournament() {
    return get(`
        SELECT * FROM tournaments
        WHERE status IN ('active', 'registration')
        ORDER BY blockchain_id DESC
        LIMIT 1
    `);
}

export function getLatestTournament() {
    return get(`
        SELECT * FROM tournaments
        ORDER BY blockchain_id DESC
        LIMIT 1
    `);
}

export function deactivateOtherTournaments(activeBlockchainId) {
    exec(
        `UPDATE tournaments SET status = 'ended', updated_at = CURRENT_TIMESTAMP
         WHERE blockchain_id != ? AND status IN ('active', 'registration')`,
        [activeBlockchainId]
    );
}

export function updateTournamentStatus(blockchainId, status) {
    exec('UPDATE tournaments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE blockchain_id = ?',
        [status, blockchainId]);
}

export function updateTournamentEntryCount(blockchainId, count) {
    exec('UPDATE tournaments SET entry_count = ?, updated_at = CURRENT_TIMESTAMP WHERE blockchain_id = ?',
        [count, blockchainId]);
}

// ============ Player Functions ============

export function savePlayer(address) {
    exec('INSERT OR IGNORE INTO players (address) VALUES (?)', [address]);
}

export function getPlayer(address) {
    return get('SELECT * FROM players WHERE address = ?', [address]);
}

// ============ Tournament Entry Functions ============

export function saveTournamentEntry(tournamentId, playerAddress) {
    exec('INSERT OR IGNORE INTO tournament_entries (tournament_id, player_address) VALUES (?, ?)',
        [tournamentId, playerAddress]);
}

export function getTournamentEntries(tournamentId) {
    return all('SELECT * FROM tournament_entries WHERE tournament_id = ?', [tournamentId]);
}

export function hasPlayerEntered(tournamentId, playerAddress) {
    const result = get(
        'SELECT COUNT(*) as count FROM tournament_entries WHERE tournament_id = ? AND player_address = ?',
        [tournamentId, playerAddress]
    );
    return result.count > 0;
}

// ============ Tournament Cards Functions ============

export function savePlayerCards(tournamentId, playerAddress, cards) {
    if (!db) throw new Error('Database not initialized');

    // First delete existing cards for this player in this tournament
    db.run('DELETE FROM tournament_cards WHERE tournament_id = ? AND player_address = ?',
        [tournamentId, playerAddress]);

    // Insert new cards in batch (no save between each)
    for (const card of cards) {
        db.run(`
            INSERT INTO tournament_cards
            (tournament_id, player_address, token_id, startup_name, rarity, multiplier)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [tournamentId, playerAddress, card.tokenId, card.name, card.rarity, card.multiplier]);
    }
}

export function getPlayerCards(tournamentId, playerAddress) {
    return all(`
        SELECT * FROM tournament_cards
        WHERE tournament_id = ? AND player_address = ?
    `, [tournamentId, playerAddress]);
}

export function getAllTournamentCards(tournamentId) {
    return all('SELECT * FROM tournament_cards WHERE tournament_id = ?', [tournamentId]);
}

// ============ Daily Scores Functions ============

export function saveDailyScore(tournamentId, startupName, date, basePoints, tweetsAnalyzed, events, hmac = null, integrityHash = null) {
    const eventsJson = JSON.stringify(events);
    exec(`
        INSERT OR REPLACE INTO daily_scores
        (tournament_id, startup_name, date, base_points, tweets_analyzed, events_detected, hmac, integrity_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [tournamentId, startupName, date, basePoints, tweetsAnalyzed, eventsJson, hmac, integrityHash]);
}

export function clearDailyScoresForDate(tournamentId, date) {
    exec('DELETE FROM daily_scores WHERE tournament_id = ? AND date = ?', [tournamentId, date]);
}

export function getDailyScores(tournamentId, date) {
    const rows = all(`
        SELECT * FROM daily_scores
        WHERE tournament_id = ? AND date = ?
    `, [tournamentId, date]);

    return rows.map(row => ({
        ...row,
        events_detected: row.events_detected ? JSON.parse(row.events_detected) : []
    }));
}

export function getStartupScoreHistory(tournamentId, startupName) {
    return all(`
        SELECT * FROM daily_scores
        WHERE tournament_id = ? AND startup_name = ?
        ORDER BY date DESC
    `, [tournamentId, startupName]);
}

// ============ Leaderboard Functions ============

export function updateLeaderboard(tournamentId, playerAddress, totalScore, hmac = null) {
    exec(`
        INSERT OR REPLACE INTO leaderboard
        (tournament_id, player_address, total_score, last_updated, hmac)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    `, [tournamentId, playerAddress, totalScore, hmac]);

    // Update ranks
    updateRanks(tournamentId);
}

function updateRanks(tournamentId) {
    // Get all players sorted by score
    const players = all(`
        SELECT player_address, total_score
        FROM leaderboard
        WHERE tournament_id = ?
        ORDER BY total_score DESC
    `, [tournamentId]);

    // Update each player's rank in batch
    players.forEach((player, index) => {
        db.run(
            'UPDATE leaderboard SET rank = ? WHERE tournament_id = ? AND player_address = ?',
            [index + 1, tournamentId, player.player_address]
        );
    });
}

export function getLeaderboard(tournamentId, limit = 100) {
    const rows = all(`
        SELECT
            rank,
            player_address,
            total_score,
            last_updated,
            hmac
        FROM leaderboard
        WHERE tournament_id = ?
        ORDER BY total_score DESC
        LIMIT ?
    `, [tournamentId, limit]);

    // Map to expected format
    return rows.map(row => ({
        rank: row.rank,
        address: row.player_address,
        score: row.total_score,
        lastUpdated: row.last_updated,
        hmac: row.hmac || null
    }));
}

export function getPlayerRank(tournamentId, playerAddress) {
    const row = get(`
        SELECT rank, total_score, player_address
        FROM leaderboard
        WHERE tournament_id = ? AND player_address = ?
    `, [tournamentId, playerAddress]);

    if (!row) return null;

    // Map to expected format
    return {
        rank: row.rank,
        score: row.total_score,
        address: row.player_address
    };
}

export function getTournamentStats(tournamentId) {
    return get(`
        SELECT
            COUNT(*) as total_players,
            AVG(total_score) as avg_score,
            MAX(total_score) as max_score,
            MIN(total_score) as min_score
        FROM leaderboard
        WHERE tournament_id = ?
    `, [tournamentId]);
}

// ============ Score History Functions ============

export function saveScoreHistory(tournamentId, playerAddress, date, pointsEarned, breakdown, hmac = null) {
    const breakdownJson = JSON.stringify(breakdown);
    exec(`
        INSERT INTO score_history
        (tournament_id, player_address, date, points_earned, breakdown, hmac)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [tournamentId, playerAddress, date, pointsEarned, breakdownJson, hmac]);
}

export function getPlayerScoreHistory(tournamentId, playerAddress) {
    const rows = all(`
        SELECT * FROM score_history
        WHERE tournament_id = ? AND player_address = ?
        ORDER BY date DESC
    `, [tournamentId, playerAddress]);

    return rows.map(row => ({
        ...row,
        breakdown: row.breakdown ? JSON.parse(row.breakdown) : {}
    }));
}

// ============ User Profile Functions ============

export function saveUserProfile(address, username, avatarUrl = null) {
    exec(`
        INSERT OR REPLACE INTO user_profiles
        (address, username, avatar_url, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `, [address.toLowerCase(), username, avatarUrl]);
}

export function getUserProfile(address) {
    return get('SELECT * FROM user_profiles WHERE address = ?', [address.toLowerCase()]);
}

export function isUserRegistered(address) {
    const result = get('SELECT COUNT(*) as count FROM user_profiles WHERE address = ?', [address.toLowerCase()]);
    return result && result.count > 0;
}

export function getUserProfiles(addresses) {
    if (!addresses || addresses.length === 0) return [];
    const placeholders = addresses.map(() => '?').join(',');
    return all(
        `SELECT * FROM user_profiles WHERE address IN (${placeholders})`,
        addresses.map(a => a.toLowerCase())
    );
}

export function updateUserProfile(address, username, avatarUrl) {
    exec(`
        UPDATE user_profiles
        SET username = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP
        WHERE address = ?
    `, [username, avatarUrl, address.toLowerCase()]);
}

// ============ Aggregated Scores (for finalization) ============

export function getAggregatedStartupScores(tournamentId) {
    return all(`
        SELECT startup_name, SUM(base_points) as total_points
        FROM daily_scores
        WHERE tournament_id = ?
        GROUP BY startup_name
    `, [tournamentId]);
}

export function getTopStartups(tournamentId, limit = 5) {
    return all(`
        SELECT startup_name, SUM(base_points) as total_points
        FROM daily_scores
        WHERE tournament_id = ?
        GROUP BY startup_name
        ORDER BY total_points DESC
        LIMIT ?
    `, [tournamentId, limit]);
}

// ============ Live Feed Functions ============

export function saveLiveFeedEvent(startupName, eventType, description, points, tweetId, date, headline = null) {
    exec(`
        INSERT INTO live_feed
        (startup_name, event_type, description, points, tweet_id, date, ai_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [startupName, eventType, description, points, tweetId || null, date, headline]);
}

export function clearLiveFeedForDate(date) {
    exec('DELETE FROM live_feed WHERE date = ?', [date]);
}

export function clearAllLiveFeed() {
    exec('DELETE FROM live_feed');
}

export function resetAllScores() {
    exec('DELETE FROM daily_scores');
    exec('DELETE FROM score_history');
    exec('DELETE FROM leaderboard');
}

export function getLiveFeed(limit = 20) {
    return all(`
        SELECT * FROM live_feed
        ORDER BY id DESC
        LIMIT ?
    `, [limit]);
}

export function getLiveFeedByDate(date) {
    return all(`
        SELECT * FROM live_feed
        WHERE date = ?
        ORDER BY points DESC
    `, [date]);
}

// ============ Referral Functions ============

export function saveReferral(referrerAddress, referredAddress, packId, amountEarned) {
    exec(`
        INSERT OR IGNORE INTO referrals
        (referrer_address, referred_address, pack_id, amount_earned)
        VALUES (?, ?, ?, ?)
    `, [referrerAddress, referredAddress, packId || null, amountEarned || '0']);
}

export function getReferralsByReferrer(referrerAddress) {
    return all(`
        SELECT * FROM referrals
        WHERE referrer_address = ?
        ORDER BY created_at DESC
    `, [referrerAddress]);
}

export function getReferrer(referredAddress) {
    return get(`
        SELECT * FROM referrals
        WHERE referred_address = ?
    `, [referredAddress]);
}

export function getReferralStats(referrerAddress) {
    return get(`
        SELECT
            COUNT(*) as total_referrals,
            SUM(CAST(amount_earned AS REAL)) as total_earned
        FROM referrals
        WHERE referrer_address = ?
    `, [referrerAddress]);
}

// ============ NFT Cards Cache Functions ============

export function saveNFTCards(ownerAddress, cards) {
    if (!db) throw new Error('Database not initialized');
    const addr = ownerAddress.toLowerCase();

    // Remove cards this owner no longer has
    const currentTokenIds = cards.map(c => c.tokenId);
    if (currentTokenIds.length > 0) {
        const placeholders = currentTokenIds.map(() => '?').join(',');
        db.run(
            `DELETE FROM nft_cards WHERE owner_address = ? AND token_id NOT IN (${placeholders})`,
            [addr, ...currentTokenIds]
        );
    } else {
        db.run('DELETE FROM nft_cards WHERE owner_address = ?', [addr]);
    }

    // Upsert each card
    for (const card of cards) {
        db.run(`
            INSERT OR REPLACE INTO nft_cards
            (token_id, owner_address, startup_id, startup_name, rarity, multiplier, edition, is_locked, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [card.tokenId, addr, card.startupId, card.name, card.rarity, card.multiplier, card.edition || 1, card.isLocked ? 1 : 0]);
    }
}

export function getNFTCards(ownerAddress) {
    return all(`
        SELECT * FROM nft_cards
        WHERE owner_address = ?
        ORDER BY
            CASE rarity
                WHEN 'Legendary' THEN 0
                WHEN 'Epic' THEN 1
                WHEN 'EpicRare' THEN 2
                WHEN 'Rare' THEN 3
                WHEN 'Common' THEN 4
            END,
            token_id
    `, [ownerAddress.toLowerCase()]);
}

export function hasNFTCards(ownerAddress) {
    const row = get('SELECT COUNT(*) as count FROM nft_cards WHERE owner_address = ?', [ownerAddress.toLowerCase()]);
    return row && row.count > 0;
}

// Add cards to cache (upsert, no deletes — for incremental updates after pack open)
export function addNFTCards(ownerAddress, cards) {
    if (!db) throw new Error('Database not initialized');
    const addr = ownerAddress.toLowerCase();
    for (const card of cards) {
        db.run(`
            INSERT OR REPLACE INTO nft_cards
            (token_id, owner_address, startup_id, startup_name, rarity, multiplier, edition, is_locked, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [card.tokenId, addr, card.startupId, card.name, card.rarity, card.multiplier, card.edition || 1, card.isLocked ? 1 : 0]);
    }
}

// Remove specific cards from cache (for merge — burned cards)
export function removeNFTCards(ownerAddress, tokenIds) {
    if (!db) throw new Error('Database not initialized');
    if (tokenIds.length === 0) return;
    const addr = ownerAddress.toLowerCase();
    const placeholders = tokenIds.map(() => '?').join(',');
    db.run(`DELETE FROM nft_cards WHERE owner_address = ? AND token_id IN (${placeholders})`, [addr, ...tokenIds]);
}

// ============ HMAC Migration ============

/**
 * Add HMAC columns to existing tables (idempotent).
 * Call during server startup after schema is applied.
 */
export function runHmacMigrations() {
    if (!db) throw new Error('Database not initialized');
    const migrations = [
        'ALTER TABLE daily_scores ADD COLUMN hmac TEXT',
        'ALTER TABLE daily_scores ADD COLUMN integrity_hash TEXT',
        'ALTER TABLE score_history ADD COLUMN hmac TEXT',
        'ALTER TABLE leaderboard ADD COLUMN hmac TEXT',
    ];
    for (const sql of migrations) {
        try { db.run(sql); } catch (e) { /* column already exists */ }
    }
}

/**
 * Get the latest integrity hash for the hash chain.
 */
export function getLatestIntegrityHash(tournamentId) {
    const row = get(
        `SELECT value FROM kv_store WHERE key = ?`,
        [`integrity_latest_${tournamentId}`]
    );
    if (!row) return null;
    try {
        const data = JSON.parse(row.value);
        return data.hash;
    } catch { return null; }
}

// ============ AI Summary Migration ============

/**
 * Add ai_summary column to live_feed table (idempotent).
 */
export function runAiSummaryMigrations() {
    if (!db) throw new Error('Database not initialized');
    const migrations = [
        'ALTER TABLE live_feed ADD COLUMN ai_summary TEXT',
    ];
    for (const sql of migrations) {
        try { db.run(sql); } catch (e) { /* column already exists */ }
    }
}

/**
 * Get feed events that haven't been summarized yet.
 */
export function getUnsummarizedFeedEvents(limit = 50) {
    return all(`
        SELECT id, startup_name, event_type, description, points, date
        FROM live_feed
        WHERE ai_summary IS NULL
        ORDER BY created_at DESC
        LIMIT ?
    `, [limit]);
}

/**
 * Batch update AI summaries for feed events.
 */
export function batchUpdateFeedSummaries(updates) {
    if (!db) throw new Error('Database not initialized');
    for (const { id, summary } of updates) {
        db.run('UPDATE live_feed SET ai_summary = ? WHERE id = ?', [summary, id]);
    }
}

/**
 * Get paginated live feed with AI summaries.
 */
export function getLiveFeedPaginated(limit = 20, offset = 0) {
    return all(`
        SELECT * FROM live_feed
        ORDER BY id DESC
        LIMIT ? OFFSET ?
    `, [limit, offset]);
}

/**
 * Get recent startup news for the last N days (for AI recommendations).
 * Returns events grouped by startup, ordered by date desc.
 */
export function getRecentStartupNews(days = 10) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    const cutoffDate = d.toISOString().split('T')[0];
    return all(`
        SELECT startup_name, points, date, ai_summary
        FROM live_feed
        WHERE date >= ? AND ai_summary IS NOT NULL AND ai_summary != ''
        ORDER BY startup_name, date DESC
    `, [cutoffDate]);
}

/**
 * Get total count of live feed events.
 */
export function getLiveFeedCount() {
    const row = get('SELECT COUNT(*) as count FROM live_feed');
    return row ? row.count : 0;
}

// ============ Waitlist Functions ============

export function addWaitlistEntry(email, walletAddress) {
    exec('INSERT INTO waitlist (email, wallet_address) VALUES (?, ?)', [email.toLowerCase(), walletAddress]);
}

export function isEmailInWaitlist(email) {
    const row = get('SELECT COUNT(*) as count FROM waitlist WHERE email = ?', [email.toLowerCase()]);
    return row && row.count > 0;
}

export function getWaitlistEntries() {
    return all('SELECT * FROM waitlist ORDER BY created_at DESC');
}

export function getWaitlistCount() {
    const row = get('SELECT COUNT(*) as count FROM waitlist');
    return row ? row.count : 0;
}

// Auto-save database every 5 seconds if there were changes
setInterval(() => {
    if (db) {
        saveDatabase();
    }
}, 5000);

// Save on exit
process.on('exit', saveDatabase);
process.on('SIGINT', () => {
    saveDatabase();
    process.exit();
});
