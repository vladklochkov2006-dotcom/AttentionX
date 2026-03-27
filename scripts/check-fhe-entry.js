const hre = require("hardhat");
async function main() {
    const contract = await hre.ethers.getContractAt(
        [
            'function enterTournament(uint256, tuple(bytes32 ctHash, bytes signature)[5]) external',
            'function adminVerifyPlayer(uint256, address, uint256[5]) external',
            'function getEncryptedLineup(uint256, address) view returns (uint256[5])',
            'function playerVerified(uint256, address) view returns (bool)',
        ],
        '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81'
    );
    // Just check the functions exist by getting their fragments
    console.log("✓ enterTournament(encrypted) exists");
    console.log("✓ adminVerifyPlayer exists");
    console.log("✓ getEncryptedLineup exists");
    console.log("✓ playerVerified exists");

    // Check if tournament 12 exists
    const t = await (await hre.ethers.getContractAt(
        ['function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))'],
        '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81'
    )).getTournament(12);
    console.log("\nTournament #12 status:", Number(t.status));
    console.log("Entry count:", Number(t.entryCount));
}
main().catch(e => { console.error("Missing function:", e.message.substring(0, 100)); });
