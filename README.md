# AttentionX

A privacy-first fantasy trading game for YC startups on Ethereum Sepolia, powered by **Fhenix CoFHE (Fully Homomorphic Encryption)**.

Players collect NFT startup cards, enter tournaments with secret lineups, and compete based on real Twitter/X performance scored by AI. Nobody can see your cards or scores until the tournament ends.

## How It Works

### 1. Collect Cards
Buy packs (0.01 ETH each) containing 5 random NFT cards from 19 YC startups. Each card has a rarity tier (Common → Legendary) with score multipliers.

### 2. Enter Tournaments (Private)
Pick 5 cards for your lineup. The CoFHE SDK **encrypts your card IDs in the browser** before submitting to the smart contract. Your transaction contains only FHE ciphertext — nobody can read which cards you picked.

```
Browser: CoFHE SDK encrypts cardIds → InEuint32[5]
Contract: stores euint32[5] (encrypted, unreadable on-chain)
Server: decrypts via CoFHE permit for scoring (admin-only access)
```

### 3. Daily Scoring (Automatic)
Every day at 00:00 UTC, the server:
- Fetches tweets for all 19 startups via Twitter API
- AI (Grok/OpenRouter) scores each tweet for relevance and impact
- Computes encrypted scores on-chain via FHE: `score = FHE.mul(encrypted_points, encrypted_multiplier)`
- Updates the Dark Leaderboard using `FHE.gt()` comparisons on encrypted data

### 4. Privacy During Tournament
- API hides individual scores (`score: null, encrypted: true`)
- On-chain storage contains only FHE ciphertext
- Dark Leaderboard shows rank positions without revealing point values
- No card locking — sell a tournament card and you get disqualified (score = 0)

### 5. Finalization
After the tournament ends, the server reveals everything: cards, scores, rankings, and distributes prizes proportionally.

## Privacy Architecture

| Data | Other Players | Blockchain Explorer | Server |
|------|:---:|:---:|:---:|
| Your card selection | Hidden | FHE ciphertext | Knows (for scoring) |
| Your score | Hidden | FHE encrypted | Knows |
| Your rank | Hidden | FHE comparison | Knows |
| Startup daily points | Hidden | Hidden | Source of truth |

## FHE Operations

| Operation | Purpose |
|-----------|---------|
| `FHE.asEuint32(input)` | Encrypt startup points on-chain |
| `FHE.mul(points, multiplier)` | Card score = encrypted points x encrypted rarity multiplier |
| `FHE.add(total, cardScore)` | Accumulate 5 card scores per player |
| `FHE.gt(scoreA, scoreB)` | Rank players without revealing scores |
| `FHE.allow(handle, admin)` | Grant server decryption access |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Smart Contracts | Solidity 0.8.28, UUPS Proxy, OpenZeppelin |
| FHE | Fhenix CoFHE (`@fhenixprotocol/cofhe-contracts`) |
| Client Encryption | `@cofhe/sdk` (browser + Node.js) |
| Frontend | React, TypeScript, Vite, wagmi, Tailwind CSS |
| Backend | Node.js, Express, SQLite |
| AI Scoring | Twitter API + Grok/OpenRouter |
| Network | Ethereum Sepolia (Chain ID: 11155111) |

## Project Structure

```
attentionx/
├── contracts/           # Solidity smart contracts (UUPS upgradeable)
│   ├── TournamentManagerFHE.sol  # FHE tournament with encrypted lineups + scoring
│   ├── AttentionX_NFT.sol        # ERC-721 NFT with rarity system
│   ├── PackOpener.sol            # Pack buying + random card minting
│   ├── MarketplaceV2.sol         # NFT marketplace with auctions
│   ├── DarkLeaderboard.sol       # Encrypted ranking storage
│   └── EncryptedCardStats.sol    # FHE card statistics
├── front/               # React + TypeScript frontend
│   ├── components/      # UI components (Leagues, Portfolio, Marketplace...)
│   ├── context/         # Wallet, Network, Theme providers
│   ├── hooks/           # Contract interaction hooks
│   └── lib/             # Contracts, networks, CoFHE utils
├── server/              # Express.js API server
│   ├── jobs/            # Daily scorer, FHE automation, lineup verification
│   ├── services/        # AI summarizer, private registration
│   └── middleware/      # Auth, rate limiting, HMAC integrity
├── backend/             # NFT metadata server
├── scripts/             # Deployment, upgrade, test scripts
└── deploy/              # Nginx, systemd, backup configs
```

## Deployed Contracts (Sepolia)

| Contract | Address |
|----------|---------|
| AttentionX_NFT | `0x409384AF735AAe5AD58cE4dc70c9309E9f3E72aF` |
| PackNFT | `0xe8BBC11b3CEFdC64D79af217f79497B7EAf34fa5` |
| PackOpener | `0xB6F73D5172425B734E020073A80A44d8B22FfA39` |
| TournamentManagerFHE (Proxy) | `0x1B0e40BbB6b436866cf64882DBcECb01F5207f81` |
| MarketplaceV2 | `0x8C64e6380561496B278AC7Ab6f35AFf9aB88160C` |
| DarkLeaderboard | `0xf08e22e350026c670D86ef0A794064e9D301d5eE` |
| EncryptedCardStats | `0x412bE266fA5e3f78Af950bb96860D839699d3822` |

## Quick Start

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Deploy to Sepolia
PRIVATE_KEY=... npx hardhat run scripts/deploy.js --network eth-sepolia

# Run frontend
cd front && npm install && npm run dev

# Run server
cd server && npm install && node index.js
```

## Live

**https://fhe.attnx.fun**
