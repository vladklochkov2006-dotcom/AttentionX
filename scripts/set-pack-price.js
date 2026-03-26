// Set pack price on PackOpener contract
// Usage: npx hardhat run scripts/set-pack-price.js --network eth-sepolia

const hre = require("hardhat");

async function main() {
    const PACK_OPENER = "0xB6F73D5172425B734E020073A80A44d8B22FfA39";
    const NEW_PRICE = hre.ethers.parseEther("0.01"); // 0.01 ETH

    const [deployer] = await hre.ethers.getSigners();
    console.log("Signer:", deployer.address);

    const packOpener = await hre.ethers.getContractAt(
        ["function setPackPrice(uint256 newPrice) external", "function currentPackPrice() view returns (uint256)"],
        PACK_OPENER,
        deployer
    );

    const oldPrice = await packOpener.currentPackPrice();
    console.log("Current price:", hre.ethers.formatEther(oldPrice), "ETH");
    console.log("Setting to:", hre.ethers.formatEther(NEW_PRICE), "ETH");

    const tx = await packOpener.setPackPrice(NEW_PRICE);
    console.log("Tx sent:", tx.hash);
    await tx.wait();

    const newPrice = await packOpener.currentPackPrice();
    console.log("✓ Pack price updated to", hre.ethers.formatEther(newPrice), "ETH");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
