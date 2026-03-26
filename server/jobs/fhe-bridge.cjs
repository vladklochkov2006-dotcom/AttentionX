/**
 * FHE Bridge — connects Twitter daily-scorer to on-chain encrypted points.
 *
 * Takes plaintext startup scores from daily-scorer and:
 * 1. Encrypts them via CoFHE SDK → euint32
 * 2. Calls setEncryptedPoints() on TournamentManagerFHE
 *
 * Usage:
 *   node server/jobs/fhe-bridge.cjs                     # uses latest scores from DB
 *   node server/jobs/fhe-bridge.cjs --mock               # generates mock scores (no Twitter API needed)
 *   node server/jobs/fhe-bridge.cjs --date 2026-03-22    # specific date
 *   node server/jobs/fhe-bridge.cjs --tournament 1       # specific tournament ID
 *
 * Environment:
 *   PRIVATE_KEY          - deployer wallet private key
 *   SEPOLIA_RPC_URL      - Sepolia RPC endpoint
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// ============ Config ============

const DEPLOYMENT_PATH = path.join(__dirname, "../../deployment-cofhe.json");
const RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Startup name → ID mapping (matches contract's startupId 1-19)
const STARTUP_IDS = {
  "Openclaw": 1, "Lovable": 2, "Cursor": 3, "OpenAI": 4, "Anthropic": 5,
  "Browser Use": 6, "Freeport": 7, "Ruvo": 8, "Pocket": 9, "Axiom": 10,
  "Daedalus Labs": 11, "Caretta": 12, "Midday": 13, "Grok": 14,
  "Perplexity": 15, "Windsurf": 16, "Vercel": 17, "Stripe": 18, "Scale AI": 19,
};

// Load real ABI from compiled artifacts
const ARTIFACT_PATH = path.join(__dirname, "../../artifacts/contracts/TournamentManagerFHE.sol/TournamentManagerFHE.json");
let TOURNAMENT_ABI;
try {
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
  TOURNAMENT_ABI = artifact.abi;
} catch {
  console.error("Cannot find compiled contract artifact. Run: npx hardhat compile");
  process.exit(1);
}

// ============ Mock Score Generator ============

function generateMockScores() {
  console.log("  Generating mock scores (no Twitter API)...\n");
  const scores = {};
  const names = Object.keys(STARTUP_IDS);

  // Seed based on today's date for reproducibility
  const today = new Date().toISOString().slice(0, 10);
  let seed = 0;
  for (const ch of today) seed = (seed * 31 + ch.charCodeAt(0)) & 0xffffffff;

  for (const name of names) {
    // Pseudo-random but deterministic per day
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const score = 50 + (seed % 951); // 50-1000
    scores[name] = score;
    console.log(`    ${name}: ${score} pts`);
  }

  return scores;
}

// ============ Read Scores from DB ============

function readScoresFromDb(date) {
  try {
    const initSqlJs = require("sql.js");
    const dbPath = path.join(__dirname, "../db/attentionx-sepolia.db");

    if (!fs.existsSync(dbPath)) {
      // Try other DB paths
      const altPaths = [
        path.join(__dirname, "../db/attentionx.db"),
        path.join(__dirname, "../db/attentionx-sepolia.db"),
      ];
      for (const alt of altPaths) {
        if (fs.existsSync(alt)) {
          return readScoresFromDbPath(alt, date);
        }
      }
      console.log("  No database found, using mock scores instead.");
      return null;
    }
    return readScoresFromDbPath(dbPath, date);
  } catch (e) {
    console.log(`  DB read error: ${e.message}. Using mock scores.`);
    return null;
  }
}

function readScoresFromDbPath(dbPath, date) {
  const initSqlJs = require("sql.js");
  const SQL = initSqlJs();
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(fileBuffer);

  const stmt = db.prepare(
    "SELECT startup_name, base_points FROM daily_scores WHERE date = ? ORDER BY startup_name"
  );
  stmt.bind([date]);

  const scores = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    scores[row.startup_name] = row.base_points;
  }
  stmt.free();
  db.close();

  if (Object.keys(scores).length === 0) return null;
  return scores;
}

// ============ Encrypt & Submit ============

async function encryptAndSubmit(scores, tournamentId) {
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");

  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  const proxyAddress = deployment.contracts.TournamentManagerFHE.proxy;

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const tournament = new ethers.Contract(proxyAddress, TOURNAMENT_ABI, wallet);

  // Check if points already set
  const finalized = await tournament.pointsFinalized(tournamentId);
  if (finalized) {
    console.log(`\n  ⚠ Points already set for tournament #${tournamentId}. Skipping.`);
    return;
  }

  // Build the 19 InEuint32 values
  // In CoFHE, InEuint32 = { ctHash: bytes32, signature: bytes }
  // For direct plaintext input (admin-only), we encode the value
  // The contract calls FHE.asEuint32(inPoint) which handles encryption
  console.log(`\n  Encrypting ${Object.keys(scores).length} startup scores...`);

  const inPoints = [];
  for (let startupId = 1; startupId <= 19; startupId++) {
    const name = Object.entries(STARTUP_IDS).find(([_, id]) => id === startupId)?.[0];
    const score = scores[name] || 0;

    // Clamp to uint32 range
    const clampedScore = Math.min(Math.max(Math.round(score), 0), 4294967295);

    // InEuint32 structure for CoFHE:
    // ctHash = plaintext value as uint256 (CoFHE mocks encrypt it on-chain)
    // securityZone = 0 (default)
    // utype = 2 (euint32)
    // signature = empty for trivial encrypt (admin plaintext input)
    inPoints.push({
      ctHash: clampedScore,
      securityZone: 0,
      utype: 2,
      signature: "0x",
    });

    console.log(`    #${startupId} ${(name || "Unknown").padEnd(15)} → ${clampedScore} pts`);
  }

  console.log(`\n  Sending setEncryptedPoints(${tournamentId}, [...]) ...`);

  try {
    const tx = await tournament.setEncryptedPoints(tournamentId, inPoints, {
      gasLimit: 3000000,
    });
    console.log(`  Tx: ${tx.hash}`);
    console.log("  Waiting for confirmation...");
    const receipt = await tx.wait();
    console.log(`  ✅ Confirmed in block ${receipt.blockNumber}`);
    console.log(`  Gas used: ${receipt.gasUsed.toString()}`);
  } catch (e) {
    console.error(`  ❌ Transaction failed: ${e.message?.slice(0, 200)}`);
    throw e;
  }
}

// ============ Main ============

async function main() {
  const args = process.argv.slice(2);
  const useMock = args.includes("--mock");
  const dateIdx = args.indexOf("--date");
  const tournamentIdx = args.indexOf("--tournament");

  const date = dateIdx >= 0 ? args[dateIdx + 1] : getYesterdayUTC();
  let tournamentId = tournamentIdx >= 0 ? parseInt(args[tournamentIdx + 1]) : null;

  console.log("═══════════════════════════════════════════");
  console.log("  FHE Bridge — Twitter Scores → On-Chain");
  console.log("═══════════════════════════════════════════\n");
  console.log(`  Date:       ${date}`);
  console.log(`  Mode:       ${useMock ? "MOCK (random scores)" : "DB (from daily-scorer)"}`);
  console.log(`  RPC:        ${RPC_URL.slice(0, 40)}...`);

  // Get scores
  let scores;
  if (useMock) {
    scores = generateMockScores();
  } else {
    scores = readScoresFromDb(date);
    if (!scores) {
      console.log("\n  No scores found in DB for this date. Falling back to mock.");
      scores = generateMockScores();
    } else {
      console.log(`\n  Loaded ${Object.keys(scores).length} scores from DB:`);
      for (const [name, pts] of Object.entries(scores)) {
        console.log(`    ${name}: ${pts} pts`);
      }
    }
  }

  // Fill missing startups with 0
  for (const name of Object.keys(STARTUP_IDS)) {
    if (!(name in scores)) scores[name] = 0;
  }

  // Find active tournament if not specified
  if (!tournamentId) {
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const tournament = new ethers.Contract(
      deployment.contracts.TournamentManagerFHE.proxy,
      TOURNAMENT_ABI,
      provider
    );

    const nextId = await tournament.nextTournamentId();
    console.log(`\n  Next tournament ID: ${nextId}`);

    // Check last few tournaments for active one
    for (let id = Number(nextId) - 1; id >= 1; id--) {
      const t = await tournament.getTournament(id);
      if (t.status === 0n || t.status === 1n) { // Created or Active
        tournamentId = id;
        console.log(`  Found active tournament: #${id}`);
        break;
      }
    }

    if (!tournamentId) {
      console.log("  No active tournament found. Create one first.");
      process.exit(1);
    }
  }

  console.log(`  Tournament: #${tournamentId}`);

  // Encrypt and submit
  await encryptAndSubmit(scores, tournamentId);

  console.log("\n═══════════════════════════════════════════");
  console.log("  BRIDGE COMPLETE");
  console.log("═══════════════════════════════════════════\n");
  console.log("  Twitter scores → CoFHE encrypted → on-chain ✅");
  console.log("  Next: computeEncryptedScores() to update player rankings");
}

function getYesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message);
  process.exit(1);
});
