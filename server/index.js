/**
 * AttentionX API Server
 * Provides leaderboard and tournament data to frontend
 */

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ethers } from 'ethers';
import * as db from './db/database.js';
import { CHAIN, CONTRACTS, NETWORK_NAME } from './config.js';
import { requireAdmin, isValidAddress, isValidTournamentId, isValidDate } from './middleware/auth.js';
import { computeLeaderboardHmac, verifyHmac } from './middleware/integrity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3007;

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Rate limiting
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later' }
});
app.use(globalLimiter);

const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { success: false, error: 'Too many write requests' }
});

const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { success: false, error: 'Admin rate limit exceeded' }
});

// ── Server-side in-memory response cache ──
// Prevents redundant DB reads on hot read endpoints.
// Scorer updates data once/day — 30s TTL is safe.
// On DB errors: serve stale cache so users see data instead of errors.
const _sc = new Map(); // key → { data, exp }

const SRV_TTL = {
    TOURNAMENT:   20_000,    // 20s
    LEADERBOARD:  30_000,    // 30s
    TOP_STARTUPS: 30_000,    // 30s
    STATS:        60_000,    // 60s
    FEED:         20_000,    // 20s
    DAILY_SCORES: 300_000,   // 5min — only changes when scorer runs
};

function sc_get(key) {
    const e = _sc.get(key);
    if (!e || Date.now() > e.exp) return null;
    return e.data;
}

function sc_get_stale(key) {
    return _sc.get(key)?.data ?? null; // returns even if expired (for DB error fallback)
}

function sc_set(key, data, ttl) {
    _sc.set(key, { data, exp: Date.now() + ttl });
}

function sc_del(prefix) {
    for (const k of _sc.keys()) {
        if (k.startsWith(prefix)) _sc.delete(k);
    }
}

// ============= API ROUTES =============

/**
 * GET /api/tournaments/active
 * Get current active tournament
 */
app.get('/api/tournaments/active', (req, res) => {
    const cacheKey = 'tournament:active';
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        let tournament = db.getActiveTournament();
        // Fallback: when no active tournament, return the latest one (e.g. finalized)
        if (!tournament) {
            tournament = db.getLatestTournament();
        }
        if (!tournament) {
            return res.json({ success: false, message: 'No active tournament' });
        }
        const resp = {
            success: true,
            data: {
                id: tournament.blockchain_id,
                startTime: tournament.start_time,
                endTime: tournament.end_time,
                prizePool: tournament.prize_pool,
                entryCount: tournament.entry_count,
                status: tournament.status
            }
        };
        sc_set(cacheKey, resp, SRV_TTL.TOURNAMENT);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/tournaments/:id
 * Get specific tournament by ID
 */
app.get('/api/tournaments/:id', (req, res) => {
    if (!isValidTournamentId(req.params.id)) {
        return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
    }
    const cacheKey = `tournament:${req.params.id}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const tournament = db.getTournament(parseInt(req.params.id));
        if (!tournament) {
            return res.status(404).json({ success: false, message: 'Tournament not found' });
        }
        const resp = {
            success: true,
            data: {
                id: tournament.blockchain_id,
                startTime: tournament.start_time,
                endTime: tournament.end_time,
                prizePool: tournament.prize_pool,
                entryCount: tournament.entry_count,
                status: tournament.status
            }
        };
        sc_set(cacheKey, resp, SRV_TTL.TOURNAMENT);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/leaderboard/:tournamentId
 * Get leaderboard for a tournament
 */
app.get('/api/leaderboard/:tournamentId', (req, res) => {
    if (!isValidTournamentId(req.params.tournamentId)) {
        return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
    }
    const tournamentId = parseInt(req.params.tournamentId);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const cacheKey = `leaderboard:${tournamentId}:${limit}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const leaderboard = db.getLeaderboard(tournamentId, limit);

        const addresses = leaderboard.map(e => e.address);
        const profiles = db.getUserProfiles(addresses);
        const profileMap = {};
        profiles.forEach(p => { profileMap[p.address] = p; });

        const enriched = leaderboard.map(entry => {
            let integrityVerified = null;
            if (entry.hmac) {
                integrityVerified = verifyHmac(computeLeaderboardHmac, {
                    tournamentId,
                    playerAddress: entry.address,
                    totalScore: entry.score
                }, entry.hmac);
            }
            return {
                rank: entry.rank,
                address: entry.address,
                score: entry.score,
                lastUpdated: entry.lastUpdated,
                username: profileMap[entry.address]?.username || null,
                avatar: profileMap[entry.address]?.avatar_url || null,
                integrityVerified,
            };
        });

        const resp = { success: true, data: enriched };
        sc_set(cacheKey, resp, SRV_TTL.LEADERBOARD);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/player/:address/rank/:tournamentId
 * Get player's rank in a tournament
 */
app.get('/api/player/:address/rank/:tournamentId', (req, res) => {
    try {
        const { address, tournamentId } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });
        if (!isValidTournamentId(tournamentId)) return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
        const rank = db.getPlayerRank(parseInt(tournamentId), address.toLowerCase());

        if (!rank) {
            return res.json({
                success: false,
                message: 'Player not found in tournament'
            });
        }

        // getPlayerRank already returns mapped data
        return res.json({
            success: true,
            data: rank
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/player/:address/history/:tournamentId
 * Get player's score history
 */
app.get('/api/player/:address/history/:tournamentId', (req, res) => {
    try {
        const { address, tournamentId } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });
        if (!isValidTournamentId(tournamentId)) return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
        const history = db.getPlayerScoreHistory(parseInt(tournamentId), address.toLowerCase());

        return res.json({
            success: true,
            data: history.map(h => ({
                date: h.date,
                points: h.points_earned,
                breakdown: h.breakdown || {}
            }))
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/player/:address/cards/:tournamentId
 * Get player's cards in tournament
 */
app.get('/api/player/:address/cards/:tournamentId', (req, res) => {
    try {
        const { address, tournamentId } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });
        if (!isValidTournamentId(tournamentId)) return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
        const cards = db.getPlayerCards(parseInt(tournamentId), address.toLowerCase());

        return res.json({
            success: true,
            data: cards.map(c => ({
                tokenId: c.token_id,
                name: c.startup_name,
                rarity: c.rarity,
                multiplier: c.multiplier,
                lockedAt: c.locked_at
            }))
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/player/:address/card-scores/:tournamentId
 * Aggregated per-startup scores for a player (for portfolio analytics)
 */
app.get('/api/player/:address/card-scores/:tournamentId', (req, res) => {
    try {
        const { address, tournamentId } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });
        if (!isValidTournamentId(tournamentId)) return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
        const history = db.getPlayerScoreHistory(parseInt(tournamentId), address.toLowerCase());

        const aggregated = {};
        let latestDate = null;

        for (const entry of history) {
            if (!latestDate || entry.date > latestDate) latestDate = entry.date;

            const breakdown = entry.breakdown || {};
            for (const [startup, data] of Object.entries(breakdown)) {
                if (!aggregated[startup]) {
                    aggregated[startup] = { totalPoints: 0, todayPoints: 0, daysScored: 0 };
                }
                aggregated[startup].totalPoints += data.totalPoints || 0;
                aggregated[startup].daysScored += 1;
            }
        }

        // Set todayPoints from latest scored entry
        if (latestDate) {
            const latestEntry = history.find(h => h.date === latestDate);
            if (latestEntry?.breakdown) {
                for (const [startup, data] of Object.entries(latestEntry.breakdown)) {
                    if (aggregated[startup]) {
                        aggregated[startup].todayPoints = data.totalPoints || 0;
                    }
                }
            }
        }

        return res.json({ success: true, data: aggregated });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/stats/:tournamentId
 * Get tournament statistics
 */
app.get('/api/stats/:tournamentId', (req, res) => {
    if (!isValidTournamentId(req.params.tournamentId)) {
        return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
    }
    const cacheKey = `stats:${req.params.tournamentId}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const stats = db.getTournamentStats(parseInt(req.params.tournamentId));
        const resp = { success: true, data: stats };
        sc_set(cacheKey, resp, SRV_TTL.STATS);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/daily-scores/:tournamentId/:date
 * Get daily startup scores for a specific date
 */
app.get('/api/daily-scores/:tournamentId/:date', (req, res) => {
    const { tournamentId, date } = req.params;
    if (!isValidTournamentId(tournamentId)) return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
    if (!isValidDate(date)) return res.status(400).json({ success: false, error: 'Invalid date format (YYYY-MM-DD)' });
    const cacheKey = `dailyScores:${tournamentId}:${date}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const scores = db.getDailyScores(parseInt(tournamentId), date);
        const resp = {
            success: true,
            data: scores.map(s => ({
                startup: s.startup_name,
                points: s.base_points,
                tweetsAnalyzed: s.tweets_analyzed,
                events: s.events_detected || []
            }))
        };
        sc_set(cacheKey, resp, SRV_TTL.DAILY_SCORES);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/top-startups/:tournamentId
 * Get top startups by points in a tournament
 */
app.get('/api/top-startups/:tournamentId', (req, res) => {
    if (!isValidTournamentId(req.params.tournamentId)) {
        return res.status(400).json({ success: false, error: 'Invalid tournament ID' });
    }
    const tournamentId = parseInt(req.params.tournamentId);
    const limit = Math.min(parseInt(req.query.limit) || 5, 50);
    const cacheKey = `topStartups:${tournamentId}:${limit}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const startups = db.getTopStartups(tournamentId, limit);
        const resp = {
            success: true,
            data: startups.map(s => ({
                name: s.startup_name,
                points: s.total_points
            }))
        };
        sc_set(cacheKey, resp, SRV_TTL.TOP_STARTUPS);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/live-feed
 * Get latest live feed events from tweet analysis
 */
app.get('/api/live-feed', (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const cacheKey = `liveFeed:${limit}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const events = db.getLiveFeed(limit);
        const resp = {
            success: true,
            data: events.map(e => ({
                id: e.id,
                startup: e.startup_name,
                eventType: e.event_type,
                description: e.description,
                points: e.points,
                tweetId: e.tweet_id || null,
                date: e.date,
                createdAt: e.created_at,
                summary: e.ai_summary || null
            }))
        };
        sc_set(cacheKey, resp, SRV_TTL.FEED);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/feed
 * Paginated feed with full details and AI summaries
 */
app.get('/api/feed', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const cacheKey = `feed:${limit}:${offset}`;
    const hit = sc_get(cacheKey);
    if (hit) return res.json(hit);
    try {
        const events = db.getLiveFeedPaginated(limit, offset);
        const total = db.getLiveFeedCount();
        const resp = {
            success: true,
            data: events.map(e => ({
                id: e.id,
                startup: e.startup_name,
                eventType: e.event_type,
                description: e.description,
                points: e.points,
                tweetId: e.tweet_id || null,
                date: e.date,
                createdAt: e.created_at,
                summary: e.ai_summary || null
            })),
            pagination: { total, limit, offset, hasMore: offset + limit < total }
        };
        sc_set(cacheKey, resp, SRV_TTL.FEED);
        return res.json(resp);
    } catch (error) {
        const stale = sc_get_stale(cacheKey);
        if (stale) return res.json(stale);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/users/register
 * Register a new user profile
 */
app.post('/api/users/register', writeLimiter, (req, res) => {
    try {
        const { address: rawAddress, username, avatar, referrer } = req.body;

        if (!rawAddress || !isValidAddress(rawAddress)) {
            return res.status(400).json({ success: false, error: 'Invalid or missing address' });
        }
        const address = rawAddress.toLowerCase();

        if (!username) {
            return res.status(400).json({
                success: false,
                error: 'Missing username'
            });
        }

        if (username.length < 3 || username.length > 20) {
            return res.status(400).json({
                success: false,
                error: 'Username must be 3-20 characters'
            });
        }

        const isNew = !db.isUserRegistered(address);
        db.saveUserProfile(address, username, avatar || null);

        // Also save to players table
        db.savePlayer(address.toLowerCase());

        // Track referral if this is a new user with a referrer
        if (isNew && referrer && referrer.toLowerCase() !== address.toLowerCase()) {
            db.saveReferral(
                referrer.toLowerCase(),
                address.toLowerCase(),
                null,
                '0'
            );
        }

        // Persist immediately so data survives server restarts
        db.saveDatabase();

        return res.json({
            success: true,
            isNew,
            data: {
                address: address.toLowerCase(),
                username,
                avatar: avatar || null
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/users/:address
 * Get user profile
 */
app.get('/api/users/:address', (req, res) => {
    try {
        const address = req.params.address.toLowerCase();
        const profile = db.getUserProfile(address);

        if (!profile) {
            return res.json({
                success: false,
                message: 'User not found'
            });
        }

        return res.json({
            success: true,
            data: {
                address: profile.address,
                username: profile.username,
                avatar: profile.avatar_url,
                createdAt: profile.created_at
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * PUT /api/users/:address
 * Update user profile
 */
app.put('/api/users/:address', writeLimiter, (req, res) => {
    try {
        const address = req.params.address.toLowerCase();
        const { username, avatar } = req.body;

        if (!username || username.length < 3 || username.length > 20) {
            return res.status(400).json({
                success: false,
                error: 'Username must be 3-20 characters'
            });
        }

        if (!db.isUserRegistered(address)) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        db.updateUserProfile(address, username, avatar || null);

        // Persist immediately
        db.saveDatabase();

        return res.json({
            success: true,
            data: {
                address,
                username,
                avatar: avatar || null
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/users/bulk
 * Get multiple user profiles by addresses
 */
app.post('/api/users/bulk', (req, res) => {
    try {
        const { addresses } = req.body;

        if (!addresses || !Array.isArray(addresses)) {
            return res.status(400).json({
                success: false,
                error: 'Missing addresses array'
            });
        }

        // Limit to prevent abuse
        const limitedAddresses = addresses.slice(0, 100);
        const profiles = db.getUserProfiles(limitedAddresses);

        return res.json({
            success: true,
            data: profiles.map(p => ({
                address: p.address,
                username: p.username,
                avatar: p.avatar_url
            }))
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/referrals/:address
 * Get referral stats for a user
 */
app.get('/api/referrals/:address', (req, res) => {
    try {
        if (!isValidAddress(req.params.address)) return res.status(400).json({ success: false, error: 'Invalid address' });
        const address = req.params.address.toLowerCase();
        const stats = db.getReferralStats(address);
        const referrals = db.getReferralsByReferrer(address);

        return res.json({
            success: true,
            data: {
                totalReferrals: stats?.total_referrals || 0,
                totalEarned: stats?.total_earned || 0,
                referrals: referrals.map(r => ({
                    referred: r.referred_address,
                    earned: r.amount_earned,
                    date: r.created_at
                }))
            }
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/referrals/track
 * Track a referral from pack purchase
 */
app.post('/api/referrals/track', writeLimiter, (req, res) => {
    try {
        const { address: rawReferred, referrer, packId, amount } = req.body;

        if (!rawReferred || !isValidAddress(rawReferred)) {
            return res.status(400).json({ success: false, error: 'Invalid or missing address' });
        }
        const referred = rawReferred.toLowerCase();

        if (!referrer) {
            return res.status(400).json({
                success: false,
                error: 'Missing referrer address'
            });
        }

        if (!isValidAddress(referrer)) {
            return res.status(400).json({ success: false, error: 'Invalid referrer address' });
        }

        db.saveReferral(
            referrer.toLowerCase(),
            referred,
            packId,
            amount || '0'
        );

        return res.json({
            success: true,
            message: 'Referral tracked'
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============= WAITLIST =============

/**
 * POST /api/waitlist
 * Public endpoint — landing page waitlist signup
 */
app.post('/api/waitlist', writeLimiter, (req, res) => {
    try {
        const { email, wallet } = req.body;

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' });
        }

        if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
            return res.status(400).json({ success: false, error: 'Valid wallet address is required (0x...)' });
        }

        if (db.isEmailInWaitlist(email)) {
            return res.status(409).json({ success: false, error: 'This email is already on the waitlist!' });
        }

        db.addWaitlistEntry(email, wallet);
        db.saveDatabase();

        return res.json({ success: true, message: "You're on the list! We'll be in touch." });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/admin/waitlist
 * Admin-only — get all waitlist entries
 */
app.get('/api/admin/waitlist', adminLimiter, requireAdmin, (req, res) => {
    try {
        const entries = db.getWaitlistEntries();
        const total = db.getWaitlistCount();
        return res.json({ success: true, data: entries, total });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============= NFT CARDS CACHE =============
// Server is a pure DB cache — no RPC calls.
// Frontend fetches from blockchain (via user's wallet) and pushes data here.

const VALID_RARITIES = ['Common', 'Rare', 'Epic', 'EpicRare', 'Legendary'];

/**
 * GET /api/player/:address/nfts
 * Returns cached NFT cards for a player (instant, from DB).
 */
app.get('/api/player/:address/nfts', async (req, res) => {
    try {
        const { address } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });

        const cached = db.getNFTCards(address.toLowerCase());
        return res.json({
            success: true,
            data: cached.map(c => ({
                tokenId: c.token_id,
                startupId: c.startup_id,
                name: c.startup_name,
                rarity: c.rarity,
                multiplier: c.multiplier,
                edition: c.edition,
                isLocked: !!c.is_locked,
                image: `/images/${c.startup_id}.png`,
            }))
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/player/:address/nfts
 * Frontend pushes card data after fetching from blockchain.
 * Body: { cards: [{ tokenId, startupId, name, rarity, multiplier, edition, isLocked }] }
 */
app.post('/api/player/:address/nfts', writeLimiter, async (req, res) => {
    try {
        const { address } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });

        const { cards } = req.body;
        if (!Array.isArray(cards)) return res.status(400).json({ success: false, error: 'cards must be an array' });

        // Validate and sanitize each card
        const sanitized = [];
        for (const c of cards) {
            if (!c.tokenId || !c.startupId || !c.name || !c.rarity) continue;
            if (!VALID_RARITIES.includes(c.rarity)) continue;
            sanitized.push({
                tokenId: Number(c.tokenId),
                startupId: Number(c.startupId),
                name: String(c.name).slice(0, 100),
                rarity: c.rarity,
                multiplier: Number(c.multiplier) || 1,
                edition: Number(c.edition) || 1,
                isLocked: !!c.isLocked,
            });
        }

        db.saveNFTCards(address.toLowerCase(), sanitized);
        console.log(`[NFT cache] Saved ${sanitized.length} cards for ${address.toLowerCase()}`);

        return res.json({ success: true, saved: sanitized.length });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PATCH /api/player/:address/nfts
 * Incremental update: add new cards and/or remove burned cards.
 * Body: { add?: [CardData], remove?: [tokenId] }
 */
app.patch('/api/player/:address/nfts', writeLimiter, async (req, res) => {
    try {
        const { address } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });

        const addr = address.toLowerCase();
        const { add, remove } = req.body;

        // Remove burned cards
        if (Array.isArray(remove) && remove.length > 0) {
            const tokenIds = remove.map(Number).filter(n => n > 0);
            if (tokenIds.length > 0) {
                db.removeNFTCards(addr, tokenIds);
                console.log(`[NFT cache] Removed ${tokenIds.length} cards for ${addr}`);
            }
        }

        // Add new cards
        let added = 0;
        if (Array.isArray(add) && add.length > 0) {
            const sanitized = [];
            for (const c of add) {
                if (!c.tokenId || !c.startupId || !c.name || !c.rarity) continue;
                if (!VALID_RARITIES.includes(c.rarity)) continue;
                sanitized.push({
                    tokenId: Number(c.tokenId),
                    startupId: Number(c.startupId),
                    name: String(c.name).slice(0, 100),
                    rarity: c.rarity,
                    multiplier: Number(c.multiplier) || 1,
                    edition: Number(c.edition) || 1,
                    isLocked: !!c.isLocked,
                });
            }
            if (sanitized.length > 0) {
                db.addNFTCards(addr, sanitized);
                added = sanitized.length;
                console.log(`[NFT cache] Added ${added} cards for ${addr}`);
            }
        }

        return res.json({ success: true, added, removed: Array.isArray(remove) ? remove.length : 0 });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/contracts
 * Returns contract addresses so frontend can auto-configure
 */
app.get('/api/contracts', (req, res) => {
    res.json({
        success: true,
        data: {
            chain: CHAIN,
            contracts: CONTRACTS,
            // Hash of contract addresses — frontend uses this to detect redeployments
            // and clear stale caches
            contractHash: JSON.stringify(CONTRACTS),
        }
    });
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

/**
 * POST /api/run-scorer
 * Trigger daily scoring (runs within server process to share DB).
 * Body: { date?: "YYYY-MM-DD" } - optional, defaults to yesterday UTC.
 */
app.post('/api/run-scorer', adminLimiter, requireAdmin, async (req, res) => {
    try {
        const { runDailyScoring } = await import('./jobs/daily-scorer.js');
        const date = req.body?.date || undefined;
        const force = req.body?.force === true;
        console.log(`Scorer triggered via API${date ? ` for date ${date}` : ''}${force ? ' [FORCE]' : ''}`);
        // Run scorer async, respond immediately
        // Note: daily-scorer step [7] already runs the AI summarizer internally
        runDailyScoring(date, force).then(() => {
            db.saveDatabase();
            // Invalidate server cache so next request returns fresh scored data
            sc_del('leaderboard:'); sc_del('topStartups:'); sc_del('stats:');
            sc_del('feed:'); sc_del('liveFeed:'); sc_del('dailyScores:'); sc_del('tournament:');
            console.log('Scorer complete, DB saved, cache invalidated.');
        }).catch(err => {
            console.error('Scorer error:', err.message);
        });
        return res.json({ success: true, message: 'Scorer started', date: date || 'yesterday' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/admin/clear-nft-cache
 * Clear all cached NFT cards. Frontend will re-fetch from blockchain.
 */
app.post('/api/admin/clear-nft-cache', adminLimiter, requireAdmin, (req, res) => {
    try {
        db.wipeNFTCards();
        db.saveDatabase();
        console.log('[Admin] NFT card cache cleared');
        return res.json({ success: true, message: 'NFT cache cleared. Cards will re-sync when users visit.' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/reload-db
 * Reload the database from disk. Used by the unified scorer to notify
 * secondary servers after writing to their DB files.
 */
app.post('/api/reload-db', adminLimiter, requireAdmin, async (req, res) => {
    try {
        await db.initDatabase(true);
        _sc.clear(); // full cache wipe — DB may have completely new data
        console.log('[RELOAD] Database reloaded from disk, cache cleared');
        return res.json({ success: true, message: 'Database reloaded' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/finalize
 * Manually trigger tournament finalization check.
 */
app.post('/api/finalize', adminLimiter, requireAdmin, async (req, res) => {
    try {
        const { checkAndFinalize } = await import('./jobs/finalize-tournament.js');
        console.log('Finalization triggered via API');
        const result = await checkAndFinalize();
        return res.json({ success: true, ...result });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/admin/clear-news
 * Clear all live feed / news events from DB.
 */
app.post('/api/admin/clear-news', adminLimiter, requireAdmin, (req, res) => {
    try {
        db.clearAllLiveFeed();
        db.saveDatabase();
        sc_del('feed:'); sc_del('liveFeed:');
        console.log('[Admin] All live feed events cleared');
        return res.json({ success: true, message: 'All news cleared' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/admin/reset-scores
 * Reset all scores: daily_scores, score_history, leaderboard.
 */
app.post('/api/admin/reset-scores', adminLimiter, requireAdmin, (req, res) => {
    try {
        db.resetAllScores();
        db.saveDatabase();
        sc_del('leaderboard:'); sc_del('topStartups:'); sc_del('stats:');
        sc_del('feed:'); sc_del('liveFeed:'); sc_del('dailyScores:');
        console.log('[Admin] All scores reset (daily_scores, score_history, leaderboard)');
        return res.json({ success: true, message: 'All scores reset' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/ai/card-recommendation/:address
 * Generate AI recommendation for which 5 cards to pick for tournament.
 * Fetches player's cached NFTs + last 10 days of startup news, calls AI.
 */
app.get('/api/ai/card-recommendation/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!isValidAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });

        const addr = address.toLowerCase();

        // Get player's cards from cache
        const cards = db.getNFTCards(addr);
        if (cards.length === 0) {
            return res.json({
                success: false,
                error: 'No cards found. Buy packs first!'
            });
        }

        // Map to simplified format (only unlocked cards)
        const playerCards = cards
            .filter(c => !c.is_locked)
            .map(c => ({
                tokenId: c.token_id,
                name: c.startup_name,
                rarity: c.rarity,
                multiplier: c.multiplier
            }));

        if (playerCards.length < 5) {
            return res.json({
                success: true,
                data: {
                    recommended: playerCards.map(c => c.tokenId),
                    reasoning: `You have ${playerCards.length} unlocked card(s) but need 5 to enter. Buy more packs!`,
                    insights: [],
                    source: 'insufficient_cards'
                }
            });
        }

        // Get recent startup news
        const recentNews = db.getRecentStartupNews(10);

        // Generate AI recommendation
        const { generateRecommendation } = await import('./services/ai-recommender.js');
        const recommendation = await generateRecommendation(playerCards, recentNews);

        return res.json({
            success: true,
            data: recommendation
        });
    } catch (error) {
        console.error('[AI Recommender] Endpoint error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============= BLOCKCHAIN SYNC =============

async function syncTournamentFromBlockchain() {
    try {
        const provider = new ethers.JsonRpcProvider(CHAIN.RPC_URL);
        const packOpener = new ethers.Contract(CONTRACTS.PackOpener, [
            'function activeTournamentId() view returns (uint256)',
        ], provider);
        const tournamentContract = new ethers.Contract(CONTRACTS.TournamentManager, [
            'function getTournament(uint256 id) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
            'function nextTournamentId() view returns (uint256)',
        ], provider);

        // Check PackOpener active tournament first
        let activeId = Number(await packOpener.activeTournamentId());

        // If PackOpener has no active tournament, sync the latest tournament from TournamentManager
        if (activeId === 0) {
            const nextId = Number(await tournamentContract.nextTournamentId());
            if (nextId > 1) {
                activeId = nextId - 1;
                console.log(`   PackOpener has no active tournament, syncing latest Tournament #${activeId}`);
            }
        }

        if (activeId === 0) {
            console.log('   No active tournament on chain');
            return;
        }

        const t = await tournamentContract.getTournament(activeId);
        const contractStatus = Number(t.status); // 0=Created, 1=Active, 2=Finalized, 3=Cancelled
        const currentTime = Math.floor(Date.now() / 1000);
        const startTime = Number(t.startTime);
        const endTime = Number(t.endTime);
        const registrationStart = Number(t.registrationStart);

        // Use contract status for finalized/cancelled, otherwise determine from timestamps
        let status = 'upcoming';
        if (contractStatus === 2) status = 'finalized';
        else if (contractStatus === 3) status = 'cancelled';
        else if (currentTime < registrationStart) status = 'upcoming';
        else if (currentTime >= registrationStart && currentTime < startTime) status = 'registration';
        else if (currentTime >= startTime && currentTime < endTime) status = 'active';
        else if (currentTime >= endTime) status = 'ended';

        // Mark any other tournaments as ended (handles contract redeployments)
        db.deactivateOtherTournaments(activeId);

        db.saveTournament({
            id: activeId,
            startTime,
            endTime,
            prizePool: ethers.formatEther(t.prizePool),
            entryCount: Number(t.entryCount),
            status,
        });

        console.log(`   Tournament #${activeId}: ${status}, pool=${ethers.formatEther(t.prizePool)} XTZ, players=${Number(t.entryCount)}`);
    } catch (error) {
        console.error('   Failed to sync tournament:', error.message);
    }
}

// ============= DAILY SCORER SCHEDULER =============

function scheduleDailyScorer() {
    function msUntilMidnightUTC() {
        const now = new Date();
        const nextMidnight = new Date(Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0, 0, 10 // 10 seconds past midnight to be safe
        ));
        return nextMidnight.getTime() - now.getTime();
    }

    async function runScorer() {
        try {
            const { runDailyScoring } = await import('./jobs/daily-scorer.js');
            console.log('[CRON] Daily scorer triggered at', new Date().toISOString());
            await runDailyScoring(); // defaults to yesterday
            db.saveDatabase();
            console.log('[CRON] Daily scorer complete, running AI summarizer...');
            await runAiSummarizer();
        } catch (err) {
            console.error('[CRON] Scorer error:', err.message);
        }
    }

    const delay = msUntilMidnightUTC();
    const hours = Math.floor(delay / 3600000);
    const mins = Math.floor((delay % 3600000) / 60000);
    console.log(`Daily scorer scheduled: next run in ${hours}h ${mins}m (00:00 UTC)`);

    // First run at next midnight, then every 24h
    setTimeout(() => {
        runScorer();
        setInterval(runScorer, 24 * 60 * 60 * 1000);
    }, delay);

    // Finalization check every hour
    async function checkFinalization() {
        try {
            const { checkAndFinalize } = await import('./jobs/finalize-tournament.js');
            console.log('[CRON] Checking tournament finalization...');
            const result = await checkAndFinalize();
            console.log(`[CRON] Finalization: ${result.reason}`);
        } catch (err) {
            console.error('[CRON] Finalization check error:', err.message);
        }
    }

    // First check after 10 seconds, then every hour
    setTimeout(checkFinalization, 10000);
    setInterval(checkFinalization, 60 * 60 * 1000);
    console.log('Finalization checker: every 1h');
}

// ============= AI FEED SUMMARIZER =============

/** Summarize all unsummarized feed events. Called after scorer completes. */
async function runAiSummarizer() {
    try {
        const { summarizeFeedEvents, setSummarizerContext } = await import('./services/ai-summarizer.js');
        setSummarizerContext('manual');
        // Process all unsummarized events in batches of 20
        let total = 0;
        while (true) {
            const unsummarized = db.getUnsummarizedFeedEvents(20);
            if (unsummarized.length === 0) break;

            console.log(`[AI] Summarizing ${unsummarized.length} feed events...`);
            const results = await summarizeFeedEvents(unsummarized);
            db.batchUpdateFeedSummaries(results);
            total += results.length;
        }
        if (total > 0) {
            console.log(`[AI] Done — ${total} summaries generated`);
        }
    } catch (err) {
        console.error('[AI] Summarizer error:', err.message);
    }
}

// Start server with database initialization
async function startServer() {
    try {
        // Initialize database
        const rawDb = await db.initDatabase();
        console.log('✅ Database initialized');

        // Run schema to ensure all tables exist
        const schema = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf-8');
        const statements = schema.split(';').filter(s => s.trim());
        statements.forEach(statement => {
            if (statement.trim()) {
                rawDb.run(statement);
            }
        });
        db.saveDatabase();
        console.log('✅ Schema applied');

        // Run HMAC column migrations (idempotent)
        db.runHmacMigrations();
        console.log('✅ HMAC migrations applied');

        // Run AI summary migrations (idempotent)
        db.runAiSummaryMigrations();
        console.log('✅ AI summary migrations applied');

        // Detect contract changes → wipe stale tournament data AND NFT cache
        const contractHash = JSON.stringify(CONTRACTS);
        const storedHash = db.getConfig('contract_addresses');
        if (storedHash && storedHash !== contractHash) {
            console.log('⚠️  Contract addresses changed! Wiping old tournament data + NFT cache...');
            db.wipeTournamentData();
            db.wipeNFTCards();
            db.saveDatabase();
        }
        db.setConfig('contract_addresses', contractHash);
        console.log(`📋 Contracts: TM=${CONTRACTS.TournamentManager.substring(0, 10)}... PO=${CONTRACTS.PackOpener.substring(0, 10)}...`);

        // Sync tournament from blockchain
        console.log('🔗 Syncing tournament from blockchain...');
        await syncTournamentFromBlockchain();
        console.log('✅ Blockchain sync complete');

        // Periodic sync every 60 seconds
        setInterval(syncTournamentFromBlockchain, 60000);

        // Schedule daily scorer at 00:00 UTC
        scheduleDailyScorer();

        // AI summarizer runs automatically after daily scorer (no separate schedule)

        // Start Express server
        app.listen(PORT, () => {
            console.log(`🚀 AttentionX API Server running on port ${PORT} [${NETWORK_NAME}]`);
            console.log(`📊 Endpoints:`);
            console.log(`   GET /api/tournaments/active`);
            console.log(`   GET /api/tournaments/:id`);
            console.log(`   GET /api/leaderboard/:tournamentId`);
            console.log(`   GET /api/player/:address/rank/:tournamentId`);
            console.log(`   GET /api/player/:address/history/:tournamentId`);
            console.log(`   GET /api/player/:address/cards/:tournamentId`);
            console.log(`   GET /api/player/:address/card-scores/:tournamentId`);
            console.log(`   GET /api/stats/:tournamentId`);
            console.log(`   GET /api/daily-scores/:tournamentId/:date`);
            console.log(`   GET /api/live-feed`);
            console.log(`   GET /api/feed`);
            console.log(`   POST /api/users/register`);
            console.log(`   GET /api/users/:address`);
            console.log(`   PUT /api/users/:address`);
            console.log(`   POST /api/users/bulk`);
            console.log(`   GET /api/referrals/:address`);
            console.log(`   POST /api/referrals/track`);
            console.log(`   GET /api/player/:address/nfts`);
            console.log(`   POST /api/player/:address/nfts/sync`);
            console.log(`   GET /api/contracts`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();

export default app;
