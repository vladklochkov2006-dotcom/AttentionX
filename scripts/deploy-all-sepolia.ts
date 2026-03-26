/**
 * Deploy ALL AttentionX contracts to Ethereum Sepolia
 *
 * Usage:
 *   npx hardhat run scripts/deploy-all-sepolia.ts --network eth-sepolia
 *
 * Deploys:
 *   1. AttentionX_NFT (UUPS proxy)
 *   2. PackNFT (UUPS proxy)
 *   3. PackOpener (UUPS proxy)
 *   4. MarketplaceV2 (UUPS proxy)
 *   5. TournamentManagerFHE (UUPS proxy) — with CoFHE
 *   7. DarkLeaderboard
 *   8. EncryptedCardStats
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function deployProxy(name: string, initArgs: any[]): Promise<{ proxy: string; impl: string }> {
  console.log(`  Deploying ${name}...`);
  const Factory = await ethers.getContractFactory(name);
  const impl = await Factory.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();

  const initData = Factory.interface.encodeFunctionData("initialize", initArgs);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();

  console.log(`    impl:  ${implAddress}`);
  console.log(`    proxy: ${proxyAddress}`);
  return { proxy: proxyAddress, impl: implAddress };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddr);
  const network = await ethers.provider.getNetwork();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  AttentionX FULL Deployment — Sepolia");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Network:  ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Deployer: ${deployerAddr}`);
  console.log(`  Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log("");

  if (balance === 0n) {
    console.error("  ERROR: 0 balance. Get Sepolia ETH from a faucet.");
    process.exit(1);
  }

  // ── Step 1: AttentionX_NFT ──
  console.log("Step 1: AttentionX_NFT");
  const nft = await deployProxy("AttentionX_NFT", [deployerAddr]);
  console.log("");

  // ── Step 2: PackNFT ──
  console.log("Step 2: PackNFT");
  const packNft = await deployProxy("PackNFT", [deployerAddr]);
  console.log("");

  // ── Step 3: PackOpener ──
  console.log("Step 3: PackOpener");
  const packOpener = await deployProxy("PackOpener", [nft.proxy, deployerAddr, deployerAddr]);
  console.log("");

  // ── Step 4: MarketplaceV2 ──
  console.log("Step 4: MarketplaceV2");
  const marketplace = await deployProxy("MarketplaceV2", [nft.proxy, deployerAddr]);
  console.log("");

  // ── Step 5: TournamentManagerFHE ──
  console.log("Step 5: TournamentManagerFHE");
  const tournament = await deployProxy("TournamentManagerFHE", [nft.proxy]);
  console.log("");

  // ── Step 6: DarkLeaderboard ──
  console.log("Step 6: DarkLeaderboard");
  const DarkLeaderboard = await ethers.getContractFactory("DarkLeaderboard");
  const leaderboard = await DarkLeaderboard.deploy(tournament.proxy, deployerAddr);
  await leaderboard.waitForDeployment();
  const leaderboardAddr = await leaderboard.getAddress();
  console.log(`    DarkLeaderboard: ${leaderboardAddr}`);
  console.log("");

  // ── Step 7: EncryptedCardStats ──
  console.log("Step 7: EncryptedCardStats");
  const EncryptedCardStats = await ethers.getContractFactory("EncryptedCardStats");
  const cardStats = await EncryptedCardStats.deploy(nft.proxy, deployerAddr);
  await cardStats.waitForDeployment();
  const cardStatsAddr = await cardStats.getAddress();
  console.log(`    EncryptedCardStats: ${cardStatsAddr}`);
  console.log("");

  // ── Step 8: Configure permissions ──
  console.log("Step 8: Configure permissions...");

  // Set PackOpener as authorized minter on NFT
  const nftContract = await ethers.getContractAt("AttentionX_NFT", nft.proxy, deployer);
  const tx1 = await nftContract.setAuthorizedLocker(tournament.proxy, true);
  await tx1.wait();
  console.log("  TournamentManagerFHE → authorized locker on NFT ✓");

  // Set PackOpener as pack opener on TournamentManagerFHE
  const tournamentContract = await ethers.getContractAt("TournamentManagerFHE", tournament.proxy, deployer);
  const tx2 = await tournamentContract.setPackOpener(packOpener.proxy);
  await tx2.wait();
  console.log("  PackOpener → set on TournamentManagerFHE ✓");

  // Approve marketplace on NFT
  const tx3 = await nftContract.setApprovalForAll(marketplace.proxy, true);
  await tx3.wait();
  console.log("  MarketplaceV2 → approved on NFT ✓");
  console.log("");

  // ── Summary ──
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Contracts:");
  console.log(`    AttentionX_NFT:              ${nft.proxy}`);
  console.log(`    PackNFT:                     ${packNft.proxy}`);
  console.log(`    PackOpener:                  ${packOpener.proxy}`);
  console.log(`    MarketplaceV2:               ${marketplace.proxy}`);
  console.log(`    TournamentManagerFHE:        ${tournament.proxy}`);
  console.log(`    DarkLeaderboard:             ${leaderboardAddr}`);
  console.log(`    EncryptedCardStats:          ${cardStatsAddr}`);
  console.log("");

  const deploymentInfo = {
    network: network.name,
    chainId: Number(network.chainId),
    timestamp: new Date().toISOString(),
    deployer: deployerAddr,
    contracts: {
      AttentionX_NFT: nft.proxy,
      PackNFT: packNft.proxy,
      PackOpener: packOpener.proxy,
      MarketplaceV2: marketplace.proxy,
      TournamentManager: tournament.proxy,
      TournamentManagerFHE: {
        proxy: tournament.proxy,
        implementation: tournament.impl,
      },
      DarkLeaderboard: leaderboardAddr,
      EncryptedCardStats: cardStatsAddr,
    },
  };

  const outPath = path.join(__dirname, "..", "deployment-cofhe.json");
  fs.writeFileSync(outPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`  Saved to: deployment-cofhe.json`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
