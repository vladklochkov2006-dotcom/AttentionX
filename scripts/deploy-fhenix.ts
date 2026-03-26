/**
 * Deploy TournamentManagerFHE + DarkLeaderboard to Ethereum Sepolia (CoFHE)
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx hardhat run scripts/deploy-fhenix.ts --network eth-sepolia
 *
 * Prerequisites:
 *   1. Get Sepolia ETH from https://sepoliafaucet.com
 *   2. Set PRIVATE_KEY in .env
 *
 * This script deploys:
 *   1. TournamentManagerFHE (UUPS proxy)
 *   2. DarkLeaderboard
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddr);
  const network = await ethers.provider.getNetwork();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  AttentionX FHE Deployment — CoFHE on Sepolia");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Network:  ${network.name} (chainId: ${network.chainId})`);
  console.log(`  Deployer: ${deployerAddr}`);
  console.log(`  Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log("");

  if (balance === 0n) {
    console.error("  ERROR: Deployer has 0 balance. Get Sepolia ETH from a faucet.");
    process.exit(1);
  }

  // ============================================================
  // Config — set your existing NFT contract address here
  // ============================================================
  const EXISTING_NFT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || "";

  let nftAddress: string;

  if (EXISTING_NFT_ADDRESS) {
    nftAddress = EXISTING_NFT_ADDRESS;
    console.log(`  Using existing NFT contract: ${nftAddress}`);
  } else {
    console.log("  No NFT_CONTRACT_ADDRESS set — deploying MockAttentionXNFT...");
    const MockNFT = await ethers.getContractFactory("MockAttentionXNFT");
    const mockNft = await MockNFT.deploy();
    await mockNft.waitForDeployment();
    nftAddress = await mockNft.getAddress();
    console.log(`  MockAttentionXNFT deployed: ${nftAddress}`);
  }
  console.log("");

  // ============================================================
  // Step 1: Deploy TournamentManagerFHE (UUPS Proxy)
  // ============================================================
  console.log("Step 1: Deploying TournamentManagerFHE...");

  const TournamentFHE = await ethers.getContractFactory("TournamentManagerFHE");
  const impl = await TournamentFHE.deploy();
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log(`  Implementation: ${implAddress}`);

  // Deploy ERC1967Proxy with initialize(nftAddress)
  const initData = TournamentFHE.interface.encodeFunctionData("initialize", [nftAddress]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(implAddress, initData);
  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log(`  Proxy:          ${proxyAddress}`);

  const tournament = TournamentFHE.attach(proxyAddress) as Awaited<ReturnType<typeof TournamentFHE.deploy>>;
  const owner = await tournament.owner();
  console.log(`  Owner:          ${owner}`);
  console.log("");

  // ============================================================
  // Step 2: Deploy DarkLeaderboard
  // ============================================================
  console.log("Step 2: Deploying DarkLeaderboard...");

  const DarkLeaderboard = await ethers.getContractFactory("DarkLeaderboard");
  const leaderboard = await DarkLeaderboard.deploy(proxyAddress, deployerAddr);
  await leaderboard.waitForDeployment();
  const leaderboardAddress = await leaderboard.getAddress();
  console.log(`  DarkLeaderboard: ${leaderboardAddress}`);
  console.log("");

  // ============================================================
  // Step 2b: Deploy EncryptedCardStats
  // ============================================================
  console.log("Step 2b: Deploying EncryptedCardStats...");

  const EncryptedCardStats = await ethers.getContractFactory("EncryptedCardStats");
  const cardStats = await EncryptedCardStats.deploy(nftAddress, deployerAddr);
  await cardStats.waitForDeployment();
  const cardStatsAddress = await cardStats.getAddress();
  console.log(`  EncryptedCardStats: ${cardStatsAddress}`);
  console.log("");

  // ============================================================
  // Step 3: Configuration
  // ============================================================
  console.log("Step 3: Post-deploy configuration...");

  if (EXISTING_NFT_ADDRESS) {
    console.log("  Setting TournamentManagerFHE as authorized locker on NFT...");
    const nftContract = await ethers.getContractAt(
      ["function setAuthorizedLocker(address locker, bool authorized) external"],
      nftAddress,
      deployer
    );
    const tx = await nftContract.setAuthorizedLocker(proxyAddress, true);
    await tx.wait();
    console.log("  Done.");
  } else {
    console.log("  Skipped NFT locker config (using mock).");
  }
  console.log("");

  // ============================================================
  // Summary
  // ============================================================
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Contracts:");
  console.log(`    TournamentManagerFHE (proxy):  ${proxyAddress}`);
  console.log(`    TournamentManagerFHE (impl):   ${implAddress}`);
  console.log(`    DarkLeaderboard:               ${leaderboardAddress}`);
  console.log(`    EncryptedCardStats:            ${cardStatsAddress}`);
  console.log(`    NFT Contract:                  ${nftAddress}`);
  console.log("");

  const deploymentInfo = {
    network: network.name,
    chainId: Number(network.chainId),
    timestamp: new Date().toISOString(),
    deployer: deployerAddr,
    contracts: {
      TournamentManagerFHE: {
        proxy: proxyAddress,
        implementation: implAddress,
      },
      DarkLeaderboard: leaderboardAddress,
      EncryptedCardStats: cardStatsAddress,
      AttentionX_NFT: nftAddress,
    },
  };

  const outPath = path.join(__dirname, "..", "deployment-cofhe.json");
  fs.writeFileSync(outPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`  Saved to: deployment-cofhe.json`);
  console.log("");

  console.log("  Next steps:");
  console.log("    1. Update front/lib/networks.ts with addresses above");
  console.log("    2. Fund the TournamentManagerFHE proxy with ETH for prize pool");
  console.log("    3. Create a tournament: createTournament(regStart, startTime, endTime)");
  console.log("    4. Set encrypted points: setEncryptedPoints(tournamentId, encryptedPoints)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
