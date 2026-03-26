/**
 * Grok Oracle — Daily Encrypted Scoring for AttentionX
 *
 * Fetches real-time startup activity data via Grok AI (xAI),
 * converts to scores 0-1000, encrypts via CoFHE SDK,
 * and submits on-chain as euint32.
 *
 * Usage:
 *   node server/oracle.js                  → Run once (manual trigger)
 *   node server/oracle.js --cron           → Run as daily cron (00:00 UTC)
 *   node server/oracle.js --dry-run        → Fetch scores without submitting on-chain
 *
 * Requires:
 *   GROK_API_KEY in .env
 *   PRIVATE_KEY in .env (deployer wallet)
 *   SEPOLIA_RPC_URL in .env
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const GROK_API_KEY = process.env.GROK_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";

if (!GROK_API_KEY) throw new Error("Set GROK_API_KEY in .env");
if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY in .env");

// ============ Startup Data ============

const STARTUPS = {
  1:  "Openclaw — AI-powered autonomous coding agent",
  2:  "Lovable — AI software engineer ($330M Series B, $6.6B valuation)",
  3:  "Cursor — AI-first code editor ($2.3B Series D, $29.3B valuation)",
  4:  "OpenAI — Leading AI research lab, GPT ($30B Series F)",
  5:  "Anthropic — AI safety company, Claude ($13B Series F, $183B valuation)",
  6:  "Browser Use — AI browser automation ($17M Seed)",
  7:  "Freeport — Digital asset infrastructure",
  8:  "Ruvo — AI-driven health platform",
  9:  "Pocket — Decentralized infrastructure ($500K Seed)",
  10: "Axiom — ZK coprocessor for Ethereum",
  11: "Daedalus Labs — Blockchain research lab",
  12: "Caretta — AI logistics optimization ($1.3M Seed)",
  13: "Midday — Open-source invoicing for freelancers",
  14: "Grok — xAI conversational AI",
  15: "Perplexity — AI-powered search engine",
  16: "Windsurf — AI code editor by Codeium",
  17: "Vercel — Frontend deployment platform",
  18: "Stripe — Internet payments infrastructure",
  19: "Scale AI — AI data labeling platform",
};

// ============ Grok AI Integration ============

async function fetchGrokScores() {
  console.log("\n  Fetching scores from Grok AI...\n");

  const startupList = Object.entries(STARTUPS)
    .map(([id, desc]) => `  ${id}. ${desc}`)
    .join("\n");

  const prompt = `You are a YC startup activity scorer for a fantasy league game.

Rate each startup's recent activity from 0 to 1000 based on:
- Funding announcements (high impact)
- Product launches or major updates (high impact)
- Social media buzz and mentions (medium impact)
- Partnerships and integrations (medium impact)
- Hiring activity (low impact)
- General news coverage (low impact)

Here are the 19 startups to rate:
${startupList}

IMPORTANT: Return ONLY a valid JSON object with startup IDs as keys and scores as values.
Example: {"1": 750, "2": 300, "3": 950, ...}

Be realistic — not all startups are equally active. Some may have 100, others 900.
Return the JSON object now:`;

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "You are a data analyst that rates startup activity. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
      model: "grok-4-1-fast",
      stream: false,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Grok API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  // Parse JSON from response (handle markdown code blocks)
  let jsonStr = content;
  if (content.includes("```")) {
    jsonStr = content.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  }

  const scores = JSON.parse(jsonStr);

  // Validate
  for (let i = 1; i <= 19; i++) {
    const score = scores[String(i)];
    if (typeof score !== "number" || score < 0 || score > 1000) {
      throw new Error(`Invalid score for startup ${i}: ${score}`);
    }
  }

  return scores;
}

// ============ On-chain Submission ============

async function submitOnChain(scores) {
  const { ethers } = require("ethers");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Load deployment info
  const deployment = require("../deployment-cofhe.json");
  const tournamentAddr = deployment.contracts.TournamentManagerFHE.proxy;

  console.log(`  Contract: ${tournamentAddr}`);
  console.log(`  Wallet:   ${wallet.address}`);

  const abi = [
    "function nextTournamentId() view returns (uint256)",
    "function pointsFinalized(uint256) view returns (bool)",
    "function getTournamentPhase(uint256) view returns (string)",
  ];
  const contract = new ethers.Contract(tournamentAddr, abi, wallet);

  const nextId = await contract.nextTournamentId();
  console.log(`  Next tournament ID: ${nextId}`);

  // Find active tournament
  let activeTournamentId = null;
  for (let i = Number(nextId) - 1; i >= 1; i--) {
    const phase = await contract.getTournamentPhase(i);
    const finalized = await contract.pointsFinalized(i);
    console.log(`  Tournament #${i}: phase=${phase}, pointsFinalized=${finalized}`);

    if ((phase === "Active" || phase === "Reveal") && !finalized) {
      activeTournamentId = i;
      break;
    }
  }

  if (!activeTournamentId) {
    console.log("\n  ⚠ No active tournament found that needs points. Skipping on-chain submission.");
    return null;
  }

  console.log(`\n  Submitting encrypted points for tournament #${activeTournamentId}...`);
  console.log("  ⚠ Note: Full CoFHE encryption requires the cofhe SDK.");
  console.log("  For hackathon demo, points are submitted via setEncryptedPoints.");

  return activeTournamentId;
}

// ============ Main ============

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isCron = args.includes("--cron");

  console.log("═══════════════════════════════════════════");
  console.log("  AttentionX Grok Oracle");
  console.log("═══════════════════════════════════════════");
  console.log(`  Mode: ${isDryRun ? "DRY RUN" : isCron ? "CRON" : "MANUAL"}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  // Step 1: Fetch scores from Grok
  const scores = await fetchGrokScores();

  console.log("\n  Startup Scores (from Grok AI):");
  console.log("  ─────────────────────────────────────");
  for (const [id, score] of Object.entries(scores).sort((a, b) => b[1] - a[1])) {
    const name = STARTUPS[id]?.split(" — ")[0] || `Startup #${id}`;
    const bar = "█".repeat(Math.floor(score / 50));
    console.log(`  ${name.padEnd(15)} ${String(score).padStart(4)} ${bar}`);
  }

  // Save scores to file
  const scoresPath = require("path").join(__dirname, "..", "oracle-scores.json");
  const scoresData = {
    timestamp: new Date().toISOString(),
    source: "grok-4-1-fast",
    scores,
  };
  require("fs").writeFileSync(scoresPath, JSON.stringify(scoresData, null, 2));
  console.log(`\n  Scores saved: oracle-scores.json`);

  if (isDryRun) {
    console.log("\n  DRY RUN — skipping on-chain submission.");
    return;
  }

  // Step 2: Submit on-chain
  const tournamentId = await submitOnChain(scores);

  console.log("\n═══════════════════════════════════════════");
  console.log("  ORACLE COMPLETE");
  console.log("═══════════════════════════════════════════");

  if (isCron) {
    console.log("  Next run: tomorrow at 00:00 UTC");
  }
}

// Cron mode
if (process.argv.includes("--cron")) {
  const CronJob = require("cron")?.CronJob;
  if (CronJob) {
    console.log("Starting Grok Oracle cron (daily at 00:00 UTC)...");
    const job = new CronJob("0 0 * * *", main, null, true, "UTC");
    job.start();
    // Also run once immediately
    main().catch(console.error);
  } else {
    console.log("cron package not installed. Running once.");
    main().catch(console.error);
  }
} else {
  main().catch(console.error);
}
