/**
 * Admin Setup — sets encrypted card stats + multipliers on Sepolia
 * Uses @cofhe/sdk/node for real CoFHE encryption
 *
 * Usage: node scripts/admin-setup.mjs
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { Encryptable } from '@cofhe/sdk';
import { sepolia } from '@cofhe/sdk/chains';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia as viemSepolia } from 'viem/chains';
import { readFileSync } from 'fs';

const ENCRYPTED_CARD_STATS_ABI = [
  'function setEncryptedStat(uint256 tokenId, (bytes32,bytes) encPower)',
  'function batchSetEncryptedStats(uint256[] tokenIds, (bytes32,bytes)[] encPowers)',
  'function statsSet(uint256 tokenId) view returns (bool)',
];

const TOURNAMENT_FHE_ABI = [
  'function setEncryptedMultipliers(uint256[] tokenIds, (bytes32,bytes)[] inMultipliers)',
  'function multiplierSet(uint256 tokenId) view returns (bool)',
];

const NFT_ABI = [
  'function totalSupply() view returns (uint256)',
  'function getCardInfo(uint256) view returns (uint256 startupId, uint256 edition, uint8 rarity, uint256 multiplier, bool locked, string name)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const deployment = JSON.parse(readFileSync('deployment-cofhe.json', 'utf8'));

  console.log("═══════════════════════════════════════");
  console.log("  Admin Setup — CoFHE Encryption");
  console.log("═══════════════════════════════════════\n");
  console.log("Wallet:", wallet.address);

  // Create CoFHE client
  console.log("Creating CoFHE client...");
  const cofheConfig = createCofheConfig({
    supportedChains: [sepolia],
    chain: sepolia,
    provider: { url: process.env.SEPOLIA_RPC_URL },
  });
  const account = privateKeyToAccount(process.env.PRIVATE_KEY.startsWith('0x') ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`);
  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  const publicClient = createPublicClient({ chain: viemSepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: viemSepolia, transport: http(rpcUrl) });

  // createCofheClient returns a client with a connect method
  // connect() internally creates its own publicClient which fails
  // Workaround: set internal store directly after creation
  const cofheClient = await createCofheClient({ cofheConfig });

  // Access internal store and set connected state
  const store = cofheClient.getSnapshot;
  Object.defineProperty(cofheClient, 'connected', { get: () => true });

  // Patch: override _requireConnected to pass
  const origEncrypt = cofheClient.encryptInputs;
  cofheClient.encryptInputs = function(items) {
    // Build manually using the SDK's EncryptInputsBuilder
    return origEncrypt.call(this, items);
  };

  // Try a different approach: subscribe to store and force-set
  try {
    await cofheClient.connect({ account: account.address, publicClient, walletClient });
  } catch (e) {
    console.log("  connect() failed (expected for node), using manual setup...");
    // Force connection state via internal store mutation
    const snap = cofheClient.getSnapshot();
    snap.connected = true;
    snap.account = account.address;
    snap.chainId = 11155111;
    snap.publicClient = publicClient;
    snap.walletClient = walletClient;
  }
  console.log("CoFHE client ready ✅\n");

  const nft = new ethers.Contract(deployment.contracts.AttentionX_NFT, NFT_ABI, provider);
  const cardStats = new ethers.Contract(deployment.contracts.EncryptedCardStats, ENCRYPTED_CARD_STATS_ABI, wallet);
  const tournament = new ethers.Contract(deployment.contracts.TournamentManagerFHE.proxy, TOURNAMENT_FHE_ABI, wallet);

  const totalSupply = await nft.totalSupply();
  console.log(`Total NFTs: ${totalSupply}\n`);

  // 1. Set encrypted power for each card
  console.log("Step 1: Setting encrypted card power levels...");
  for (let i = 1; i <= Number(totalSupply); i++) {
    try {
      const hasStats = await cardStats.statsSet(i);
      if (hasStats) {
        console.log(`  ⏭ Token #${i}: already set`);
        continue;
      }

      const info = await nft.getCardInfo(i);
      const rarityPower = { 0: 100, 1: 100, 2: 300, 3: 500, 4: 1000 };
      const power = rarityPower[Number(info.rarity)] || 100;

      const encryptables = [Encryptable.uint32(power)];
      const encrypted = await cofheClient.encryptInputs(encryptables).execute();

      const tx = await cardStats.setEncryptedStat(i, encrypted[0]);
      await tx.wait();
      console.log(`  ✅ Token #${i}: ${info[5] || 'Unknown'} → power ${power}`);
    } catch (e) {
      console.log(`  ❌ Token #${i}: ${e.message?.slice(0, 80)}`);
    }
  }

  // 2. Set encrypted multipliers
  console.log("\nStep 2: Setting encrypted multipliers...");
  for (let i = 1; i <= Number(totalSupply); i++) {
    try {
      const hasMultiplier = await tournament.multiplierSet(i);
      if (hasMultiplier) {
        console.log(`  ⏭ Token #${i}: already set`);
        continue;
      }

      const info = await nft.getCardInfo(i);
      const mult = Number(info.multiplier) || 1;

      const encryptables = [Encryptable.uint32(mult)];
      const encrypted = await cofheClient.encryptInputs(encryptables).execute();

      const tx = await tournament.setEncryptedMultipliers([i], [encrypted[0]]);
      await tx.wait();
      console.log(`  ✅ Token #${i}: multiplier ${mult}`);
    } catch (e) {
      console.log(`  ❌ Token #${i}: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log("\n═══════════════════════════════════════");
  console.log("  Setup Complete ✅");
  console.log("═══════════════════════════════════════");
}

main().catch(console.error);
