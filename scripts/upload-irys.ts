/**
 * Upload NFT images + metadata to Irys (permanent Arweave storage).
 *
 * Usage:
 *   npx ts-node scripts/upload-irys.ts
 *
 * Prerequisites:
 *   - PRIVATE_KEY in .env (same deployer wallet with Sepolia ETH)
 *   - Irys uses Sepolia ETH for payment on devnet
 *
 * Flow:
 *   1. Upload 19 startup images → get permanent URLs
 *   2. Generate metadata JSON for each possible token (startup × rarity combos)
 *   3. Upload metadata folder → get base URL
 *   4. Call setBaseURI on NFT contract → point to Irys gateway
 */

import Irys from "@irys/sdk";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import "dotenv/config";

// ============ Startup Data (mirrors backend/server.js) ============

const STARTUPS: Record<number, { name: string; description: string }> = {
  1:  { name: "Openclaw",      description: "AI-powered autonomous coding agent" },
  2:  { name: "Lovable",       description: "AI software engineer" },
  3:  { name: "Cursor",        description: "AI-first code editor" },
  4:  { name: "OpenAI",        description: "Leading AI research lab - GPT" },
  5:  { name: "Anthropic",     description: "AI safety company - Claude" },
  6:  { name: "Browser Use",   description: "AI browser automation toolkit" },
  7:  { name: "Freeport",      description: "Digital asset infrastructure" },
  8:  { name: "Ruvo",          description: "AI-driven health platform" },
  9:  { name: "Pocket",        description: "Decentralized infrastructure" },
  10: { name: "Axiom",         description: "ZK coprocessor for Ethereum" },
  11: { name: "Daedalus Labs", description: "Blockchain research lab" },
  12: { name: "Caretta",       description: "AI logistics optimization" },
  13: { name: "Midday",        description: "Open-source invoicing for freelancers" },
  14: { name: "Grok",          description: "xAI conversational AI" },
  15: { name: "Perplexity",    description: "AI-powered search engine" },
  16: { name: "Windsurf",      description: "AI code editor by Codeium" },
  17: { name: "Vercel",        description: "Frontend deployment platform" },
  18: { name: "Stripe",        description: "Internet payments infrastructure" },
  19: { name: "Scale AI",      description: "AI data labeling platform" },
};

const RARITY_NAMES: Record<number, string> = {
  0: "Common", 1: "Common", 2: "Rare", 3: "Epic", 4: "Legendary",
};

const RARITY_MULTIPLIERS: Record<number, number> = {
  0: 1, 1: 1, 2: 3, 3: 5, 4: 10,
};

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("Set PRIVATE_KEY in .env");

  console.log("═══════════════════════════════════════════");
  console.log("  AttentionX → Irys Permanent Storage");
  console.log("═══════════════════════════════════════════\n");

  // ── Connect to Irys devnet (uses Sepolia ETH) ──
  console.log("Connecting to Irys devnet...");
  const irys = new Irys({
    network: "devnet",
    token: "ethereum",
    key: privateKey,
    config: {
      providerUrl: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    },
  });

  await irys.ready();
  const balance = await irys.getLoadedBalance();
  console.log(`Irys balance: ${irys.utils.fromAtomic(balance)} ETH`);

  // Fund if needed (~0.001 ETH for all uploads)
  if (balance.lt(irys.utils.toAtomic(0.0005))) {
    console.log("Funding Irys with 0.001 ETH...");
    await irys.fund(irys.utils.toAtomic(0.001));
    console.log("Funded ✓");
  }

  // ── Step 1: Upload images ──
  console.log("\nStep 1: Uploading images...");
  const imageDir = path.join(__dirname, "..", "backend", "public", "images");
  const imageUrls: Record<number, string> = {};

  for (let i = 1; i <= 19; i++) {
    const imagePath = path.join(imageDir, `${i}.png`);
    if (!fs.existsSync(imagePath)) {
      console.log(`  ⚠ Image ${i}.png not found, skipping`);
      continue;
    }

    const data = fs.readFileSync(imagePath);
    const tags = [
      { name: "Content-Type", value: "image/png" },
      { name: "App-Name", value: "AttentionX" },
      { name: "Startup-Id", value: String(i) },
    ];

    const receipt = await irys.upload(data, { tags });
    imageUrls[i] = `https://gateway.irys.xyz/${receipt.id}`;
    console.log(`  ✓ ${STARTUPS[i]?.name || i}: ${imageUrls[i]}`);
  }

  // ── Step 2: Generate & upload metadata JSONs ──
  console.log("\nStep 2: Generating metadata...");
  const metadataDir = path.join(__dirname, "..", "irys-metadata");
  if (!fs.existsSync(metadataDir)) fs.mkdirSync(metadataDir, { recursive: true });

  // We'll create metadata for token IDs 1-100 (covers initial mints)
  // Each token's metadata depends on startupId and rarity from contract
  // Since we can't read contract state in a static upload, we create
  // a generic template per startupId that the frontend can enhance

  // Upload a folder with individual JSON files: /1, /2, /3, etc.
  const metadataFiles: { path: string; data: Buffer; tags: { name: string; value: string }[] }[] = [];

  // For now, create metadata for all 19 startups × 4 rarity tiers = 76 combos
  // Token IDs are sequential, so we'll create a lookup-friendly format
  // But actually, the simplest approach: upload per-token metadata after minting

  // Simpler approach: upload startup images and a manifest, then
  // keep the metadata server but with Irys image URLs
  // This is the "hybrid" approach — images on Irys, metadata dynamic

  // Save image URLs for the metadata server to use
  const manifestPath = path.join(__dirname, "..", "irys-manifest.json");
  const manifest = {
    timestamp: new Date().toISOString(),
    network: "irys-devnet",
    images: imageUrls,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest saved: irys-manifest.json`);

  // ── Step 3: Update NFT contract baseURI ──
  // For the hybrid approach, we keep the metadata server but update
  // image URLs in it to point to Irys permanent storage
  console.log("\n═══════════════════════════════════════════");
  console.log("  UPLOAD COMPLETE");
  console.log("═══════════════════════════════════════════\n");

  console.log("Image URLs (permanent on Arweave):");
  for (const [id, url] of Object.entries(imageUrls)) {
    console.log(`  Startup #${id}: ${url}`);
  }

  console.log("\nNext steps:");
  console.log("  1. Update backend/server.js to use Irys image URLs");
  console.log("  2. Or call setBaseURI on NFT contract to point to Irys");
  console.log("  3. Images are now permanent — even if server goes down");
}

main().catch(console.error);
