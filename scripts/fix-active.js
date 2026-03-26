const hre = require("hardhat");
async function main() {
    const [deployer] = await hre.ethers.getSigners();
    const ABI = [
        'function nextTournamentId() view returns (uint256)',
        'function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    ];
    const t = await hre.ethers.getContractAt(ABI, '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81');
    const nextId = Number(await t.nextTournamentId());
    const newId = nextId - 1;
    console.log("Latest tournament ID:", newId);

    const info = await t.getTournament(newId);
    console.log("Registration:", new Date(Number(info.registrationStart)*1000).toISOString());
    console.log("Start:", new Date(Number(info.startTime)*1000).toISOString());
    console.log("Reveal deadline:", new Date(Number(info.revealDeadline)*1000).toISOString());
    console.log("End:", new Date(Number(info.endTime)*1000).toISOString());
    console.log("Status:", Number(info.status));

    // Set as active on PackOpener
    const packOpener = await hre.ethers.getContractAt(
        ['function setActiveTournament(uint256)', 'function activeTournamentId() view returns (uint256)'],
        '0xB6F73D5172425B734E020073A80A44d8B22FfA39', deployer
    );
    const tx = await packOpener.setActiveTournament(newId);
    await tx.wait();
    console.log("✓ Active tournament set to #" + newId);
    console.log("Verify:", Number(await packOpener.activeTournamentId()));
}
main().catch(console.error);
