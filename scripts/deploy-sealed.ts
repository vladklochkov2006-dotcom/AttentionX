import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(await deployer.getAddress());
  console.log(`Deployer: ${await deployer.getAddress()} (${ethers.formatEther(balance)} ETH)`);

  // Read existing deployment
  const deployPath = path.join(__dirname, "..", "deployment-cofhe.json");
  const deployment = JSON.parse(fs.readFileSync(deployPath, "utf8"));
  const nftAddress = deployment.contracts.AttentionX_NFT;
  console.log(`NFT contract: ${nftAddress}`);

  // Deploy SealedBidMarketplace
  console.log("\nDeploying SealedBidMarketplace...");
  const Factory = await ethers.getContractFactory("SealedBidMarketplace");
  const contract = await Factory.deploy(nftAddress, await deployer.getAddress());
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`SealedBidMarketplace: ${address}`);

  // Update deployment file
  deployment.contracts.SealedBidMarketplace = address;
  fs.writeFileSync(deployPath, JSON.stringify(deployment, null, 2));
  console.log("\nSaved to deployment-cofhe.json ✓");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
