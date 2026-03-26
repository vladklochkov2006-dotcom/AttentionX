import { ethers } from "hardhat";

async function main() {
  const nft = await ethers.getContractAt("AttentionX_NFT", "0x409384AF735AAe5AD58cE4dc70c9309E9f3E72aF");
  const packOpener = await ethers.getContractAt("PackOpener", "0xB6F73D5172425B734E020073A80A44d8B22FfA39");

  console.log("1. Setting PackOpener as authorized minter on NFT...");
  const tx1 = await nft.setAuthorizedMinter("0xB6F73D5172425B734E020073A80A44d8B22FfA39", true);
  await tx1.wait();
  console.log("   ✓ Done");

  console.log("2. Setting pack price to 0.0009 ETH...");
  const tx2 = await packOpener.setPackPrice(ethers.parseEther("0.0009"));
  await tx2.wait();
  console.log("   ✓ Done");

  console.log("3. Setting PackNFT contract...");
  const tx3 = await packOpener.setPackNftContract("0xe8BBC11b3CEFdC64D79af217f79497B7EAf34fa5");
  await tx3.wait();
  console.log("   ✓ Done");

  console.log("4. Setting TournamentManager...");
  const tx4 = await packOpener.setTournamentManager("0x1B0e40BbB6b436866cf64882DBcECb01F5207f81");
  await tx4.wait();
  console.log("   ✓ Done");

  // Verify
  const price = await packOpener.currentPackPrice();
  console.log(`\nPack price: ${ethers.formatEther(price)} ETH`);
  const isMinter = await nft.authorizedMinters("0xB6F73D5172425B734E020073A80A44d8B22FfA39");
  console.log(`PackOpener is minter: ${isMinter}`);
  console.log("\nAll configured! Try buying a pack now.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
