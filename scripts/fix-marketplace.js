const hre = require("hardhat");
async function main() {
    const [d] = await hre.ethers.getSigners();
    const m = await hre.ethers.getContractAt(
        ['function setPackNftContract(address)', 'function allowedNFTs(address) view returns (bool)'],
        '0x8C64e6380561496B278AC7Ab6f35AFf9aB88160C', d
    );
    const packNFT = '0xe8BBC11b3CEFdC64D79af217f79497B7EAf34fa5';
    console.log('PackNFT allowed before:', await m.allowedNFTs(packNFT));
    const tx = await m.setPackNftContract(packNFT);
    await tx.wait();
    console.log('PackNFT allowed after:', await m.allowedNFTs(packNFT));
    console.log('✓ PackNFT now allowed on marketplace');
}
main().catch(console.error);
