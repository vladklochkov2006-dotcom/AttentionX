// Upgrade all UUPS contracts to add THIRD_ADMIN
// Usage: npx hardhat run scripts/upgrade-all.ts --network eth-sepolia

import { ethers } from "hardhat";
import * as fs from "fs";

async function upgradeContract(name: string, proxyAddress: string) {
    console.log(`\n── Upgrading ${name} ──`);
    console.log(`  Proxy: ${proxyAddress}`);

    const Factory = await ethers.getContractFactory(name);

    // Get current gas price and add 50% buffer to avoid "underpriced"
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = (feeData.gasPrice || 0n) * 150n / 100n;
    console.log(`  Gas price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);

    const newImpl = await Factory.deploy({ gasPrice });
    await newImpl.waitForDeployment();
    const newImplAddress = await newImpl.getAddress();
    console.log(`  New implementation: ${newImplAddress}`);

    const proxy = Factory.attach(proxyAddress);
    const tx = await proxy.upgradeToAndCall(newImplAddress, "0x", { gasPrice });
    await tx.wait();
    console.log(`  ✓ ${name} upgraded`);

    return newImplAddress;
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "ETH");

    const deployment = JSON.parse(fs.readFileSync("deployment-cofhe.json", "utf8"));

    // 1. PackOpener (UUPS)
    await upgradeContract("PackOpener", deployment.contracts.PackOpener);

    // 2. AttentionX_NFT (UUPS)
    await upgradeContract("AttentionX_NFT", deployment.contracts.AttentionX_NFT);

    // 3. PackNFT (UUPS)
    await upgradeContract("PackNFT", deployment.contracts.PackNFT);

    // 4. MarketplaceV2 (UUPS)
    await upgradeContract("MarketplaceV2", deployment.contracts.MarketplaceV2);

    // 5. TournamentManagerFHE (UUPS proxy)
    const fheProxy = typeof deployment.contracts.TournamentManagerFHE === 'string'
        ? deployment.contracts.TournamentManagerFHE
        : deployment.contracts.TournamentManagerFHE.proxy;
    const newFheImpl = await upgradeContract("TournamentManagerFHE", fheProxy);

    // Update deployment file with new FHE implementation
    if (typeof deployment.contracts.TournamentManagerFHE === 'object') {
        deployment.contracts.TournamentManagerFHE.implementation = newFheImpl;
    }
    fs.writeFileSync("deployment-cofhe.json", JSON.stringify(deployment, null, 2));

    // Also set pack price to 0.01 ETH
    console.log("\n── Setting pack price to 0.01 ETH ──");
    const PackOpener = await ethers.getContractFactory("PackOpener");
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = (feeData.gasPrice || 0n) * 150n / 100n;
    const packOpener = PackOpener.attach(deployment.contracts.PackOpener);
    const priceTx = await packOpener.setPackPrice(ethers.parseEther("0.01"), { gasPrice });
    await priceTx.wait();
    console.log("  ✓ Pack price set to 0.01 ETH");

    console.log("\n✓ All contracts upgraded with THIRD_ADMIN support!");
    console.log("  THIRD_ADMIN: 0x233c8C54F25734B744E522bdC1Eed9cbc8C97D0c");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
