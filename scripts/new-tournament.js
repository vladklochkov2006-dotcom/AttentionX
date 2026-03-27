const hre = require("hardhat");
async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Signer:", deployer.address);

    const ABI = [
        'function cancelTournament(uint256 tournamentId)',
        'function createTournament(uint256 registrationStart, uint256 startTime, uint256 endTime) returns (uint256)',
        'function nextTournamentId() view returns (uint256)',
        'function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    ];
    const PACK_ABI = ['function setActiveTournament(uint256)', 'function activeTournamentId() view returns (uint256)'];

    const tournament = await hre.ethers.getContractAt(ABI, '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81', deployer);
    const packOpener = await hre.ethers.getContractAt(PACK_ABI, '0xB6F73D5172425B734E020073A80A44d8B22FfA39', deployer);

    // Cancel current active tournament
    const currentId = Number(await packOpener.activeTournamentId());
    if (currentId > 0) {
        const t = await tournament.getTournament(currentId);
        if (Number(t.status) === 0) {
            console.log(`Cancelling tournament #${currentId}...`);
            const tx0 = await tournament.cancelTournament(currentId);
            await tx0.wait();
            console.log(`✓ #${currentId} cancelled`);
        }
    }

    // Create new: registration now → +2 days, active 7 days
    const now = Math.floor(Date.now() / 1000);
    const regStart = now + 60;
    const startTime = now + (2 * 24 * 3600);
    const endTime = now + (9 * 24 * 3600);

    console.log("\nCreating tournament...");
    console.log("  Registration:", new Date(regStart * 1000).toISOString());
    console.log("  Start:", new Date(startTime * 1000).toISOString());
    console.log("  End:", new Date(endTime * 1000).toISOString());

    const tx1 = await tournament.createTournament(regStart, startTime, endTime);
    await tx1.wait();

    const newId = Number(await tournament.nextTournamentId()) - 1;
    console.log(`✓ Tournament #${newId} created`);

    // Set active
    const tx2 = await packOpener.setActiveTournament(newId);
    await tx2.wait();
    console.log(`✓ Active tournament set to #${newId}`);

    // Verify
    const info = await tournament.getTournament(newId);
    console.log(`\n=== Tournament #${newId} ===`);
    console.log("Registration:", new Date(Number(info.registrationStart) * 1000).toISOString());
    console.log("Start:", new Date(Number(info.startTime) * 1000).toISOString());
    console.log("Reveal deadline:", new Date(Number(info.revealDeadline) * 1000).toISOString());
    console.log("End:", new Date(Number(info.endTime) * 1000).toISOString());
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
