/**
 * Admin Setup Script — sets encrypted card stats + encrypted multipliers
 * using CoFHE SDK encryption via hre.cofhe
 *
 * Usage: npx hardhat run scripts/admin-setup.ts --network eth-sepolia
 */

import hre, { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const [admin] = await ethers.getSigners();
  const deployment = JSON.parse(fs.readFileSync("deployment-cofhe.json", "utf8"));

  console.log("═══════════════════════════════════════");
  console.log("  Admin Setup — Encrypted Card Stats");
  console.log("═══════════════════════════════════════\n");

  // Create CoFHE client for encryption
  const cofheClient = await (hre as any).cofhe.createClientWithBatteries(admin);

  const nft = await ethers.getContractAt("AttentionX_NFT", deployment.contracts.AttentionX_NFT);
  const cardStats = await ethers.getContractAt("EncryptedCardStats", deployment.contracts.EncryptedCardStats);
  const tournament = await ethers.getContractAt(
    "TournamentManagerFHE",
    deployment.contracts.TournamentManagerFHE.proxy
  );

  const totalSupply = await nft.totalSupply();
  console.log(`Total NFTs: ${totalSupply}\n`);

  // Helper: encrypt a uint32
  async function encryptUint32(value: number) {
    const encryptables = [cofheClient.encryptable.uint32(value)];
    const encrypted = await cofheClient.encryptInputs(encryptables).execute();
    return encrypted[0];
  }

  // 1. Set encrypted power for each card
  console.log("Step 1: Setting encrypted card power levels...");
  for (let i = 1; i <= Number(totalSupply); i++) {
    const info = await nft.getCardInfo(i);
    const rarityPower: Record<number, number> = { 0: 100, 1: 100, 2: 300, 3: 500, 4: 1000 };
    const power = rarityPower[Number(info.rarity)] || 100;

    try {
      const hasStats = await cardStats.statsSet(i);
      if (hasStats) {
        console.log(`  ⏭ Token #${i}: already set, skipping`);
        continue;
      }

      const encPower = await encryptUint32(power);
      const tx = await cardStats.setEncryptedStat(i, encPower);
      await tx.wait();
      console.log(`  ✅ Token #${i}: ${info[5] || 'Unknown'} (rarity ${info.rarity}) → power ${power}`);
    } catch (e: any) {
      console.log(`  ❌ Token #${i}: ${e.message?.slice(0, 80)}`);
    }
  }

  // 2. Set encrypted multipliers
  console.log("\nStep 2: Setting encrypted multipliers...");
  const tokenIds: number[] = [];
  const encMults: any[] = [];

  for (let i = 1; i <= Number(totalSupply); i++) {
    const info = await nft.getCardInfo(i);
    const mult = Number(info.multiplier) || 1;

    const hasMultiplier = await tournament.multiplierSet(i);
    if (hasMultiplier) {
      console.log(`  ⏭ Token #${i}: multiplier already set`);
      continue;
    }

    tokenIds.push(i);
    const encMult = await encryptUint32(mult);
    encMults.push(encMult);
    console.log(`  🔐 Token #${i}: multiplier ${mult} → encrypted`);
  }

  if (tokenIds.length > 0) {
    try {
      const tx = await tournament.setEncryptedMultipliers(tokenIds, encMults);
      await tx.wait();
      console.log(`  ✅ Set encrypted multipliers for ${tokenIds.length} cards\n`);
    } catch (e: any) {
      console.log(`  ⚠️ Batch failed, trying one by one...`);
      for (let i = 0; i < tokenIds.length; i++) {
        try {
          const tx = await tournament.setEncryptedMultipliers([tokenIds[i]], [encMults[i]]);
          await tx.wait();
          console.log(`  ✅ Token #${tokenIds[i]}`);
        } catch (e2: any) {
          console.log(`  ❌ Token #${tokenIds[i]}: ${e2.message?.slice(0, 60)}`);
        }
      }
    }
  }

  console.log("\n═══════════════════════════════════════");
  console.log("  Setup Complete ✅");
  console.log("═══════════════════════════════════════");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
