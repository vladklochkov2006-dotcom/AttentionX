-- AttentionX Database Schema

-- Tournaments table
CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY,
    blockchain_id INTEGER NOT NULL UNIQUE,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    prize_pool TEXT NOT NULL,
    entry_count INTEGER DEFAULT 0,
    status TEXT CHECK(status IN ('upcoming', 'registration', 'active', 'ended')) DEFAULT 'upcoming',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Players table
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tournament entries (who entered which tournament)
CREATE TABLE IF NOT EXISTS tournament_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    player_address TEXT NOT NULL,
    entry_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(blockchain_id),
    FOREIGN KEY (player_address) REFERENCES players(address),
    UNIQUE(tournament_id, player_address)
);

-- Player cards in tournament (locked cards)
CREATE TABLE IF NOT EXISTS tournament_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    player_address TEXT NOT NULL,
    token_id INTEGER NOT NULL,
    startup_name TEXT NOT NULL,
    rarity TEXT NOT NULL CHECK(rarity IN ('Common', 'Rare', 'Epic', 'EpicRare', 'Legendary')),
    multiplier INTEGER NOT NULL,
    locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(blockchain_id),
    FOREIGN KEY (player_address) REFERENCES players(address)
);

-- Daily scores for startups
CREATE TABLE IF NOT EXISTS daily_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    startup_name TEXT NOT NULL,
    date DATE NOT NULL,
    base_points REAL NOT NULL,
    tweets_analyzed INTEGER DEFAULT 0,
    events_detected TEXT, -- JSON array of events
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(blockchain_id),
    UNIQUE(tournament_id, startup_name, date)
);

-- Leaderboard (player scores per tournament)
CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    player_address TEXT NOT NULL,
    total_score REAL DEFAULT 0,
    rank INTEGER,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(blockchain_id),
    FOREIGN KEY (player_address) REFERENCES players(address),
    UNIQUE(tournament_id, player_address)
);

-- Score history (daily breakdown)
CREATE TABLE IF NOT EXISTS score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    player_address TEXT NOT NULL,
    date DATE NOT NULL,
    points_earned REAL NOT NULL,
    breakdown TEXT, -- JSON object with per-card breakdown
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(blockchain_id),
    FOREIGN KEY (player_address) REFERENCES players(address)
);

-- Live feed events (from tweet analysis)
CREATE TABLE IF NOT EXISTS live_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    startup_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    description TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    tweet_id TEXT,
    date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User profiles
CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Referrals tracking
CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_address TEXT NOT NULL,
    referred_address TEXT NOT NULL,
    pack_id INTEGER,
    amount_earned TEXT DEFAULT '0',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(referred_address)
);

-- Key-value store for server config tracking
CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Cached NFT ownership (synced from blockchain, serves frontend instantly)
CREATE TABLE IF NOT EXISTS nft_cards (
    token_id INTEGER NOT NULL,
    owner_address TEXT NOT NULL,
    startup_id INTEGER NOT NULL,
    startup_name TEXT NOT NULL,
    rarity TEXT NOT NULL CHECK(rarity IN ('Common', 'Rare', 'Epic', 'EpicRare', 'Legendary')),
    multiplier INTEGER NOT NULL,
    edition INTEGER DEFAULT 1,
    is_locked INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (token_id)
);

-- Waitlist (landing page signups)
CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    wallet_address TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_tournament ON tournament_entries(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_player ON tournament_entries(player_address);
CREATE INDEX IF NOT EXISTS idx_tournament_cards_tournament ON tournament_cards(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_cards_player ON tournament_cards(tournament_id, player_address);
CREATE INDEX IF NOT EXISTS idx_daily_scores_tournament ON daily_scores(tournament_id, date);
CREATE INDEX IF NOT EXISTS idx_leaderboard_tournament ON leaderboard(tournament_id, rank);
CREATE INDEX IF NOT EXISTS idx_score_history_player ON score_history(tournament_id, player_address);
CREATE INDEX IF NOT EXISTS idx_live_feed_date ON live_feed(date);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_address);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_address);
CREATE INDEX IF NOT EXISTS idx_user_profiles_address ON user_profiles(address);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
CREATE INDEX IF NOT EXISTS idx_nft_cards_owner ON nft_cards(owner_address);
CREATE INDEX IF NOT EXISTS idx_nft_cards_startup ON nft_cards(startup_id);
