// Cancel tournament #10 and create new one with proper registration window
// Usage: npx hardhat run scripts/reset-tournament.js --network eth-sepolia

const hre = require("hardhat");

async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Signer:", deployer.address);

    const ABI = [
        'function cancelTournament(uint256 tournamentId)',
        'function createTournament(uint256 registrationStart, uint256 startTime, uint256 endTime) returns (uint256)',
        'function setActiveTournament(uint256 tournamentId)',
        'function getTournament(uint256 tournamentId) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
    ];

    const tournament = await hre.ethers.getContractAt(ABI, '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81', deployer);
    const packOpener = await hre.ethers.getContractAt(
        ['function setActiveTournament(uint256 tournamentId)'],
        '0xB6F73D5172425B734E020073A80A44d8B22FfA39',
        deployer
    );

    // 1. Cancel tournament #10
    console.log("\n1. Cancelling tournament #10...");
    const tx1 = await tournament.cancelTournament(10);
    await tx1.wait();
    console.log("   ✓ Tournament #10 cancelled");

    // 2. Create new tournament
    //    Registration: now → +2 days
    //    Start (reveal begins): now + 2 days
    //    End: now + 9 days
    const now = Math.floor(Date.now() / 1000);
    const regStart = now + 60;                    // 1 min from now
    const startTime = now + (2 * 24 * 60 * 60);  // +2 days
    const endTime = now + (9 * 24 * 60 * 60);    // +9 days

    console.log("\n2. Creating new tournament...");
    console.log("   Registration:", new Date(regStart * 1000).toISOString());
    console.log("   Start (reveal):", new Date(startTime * 1000).toISOString());
    console.log("   End:", new Date(endTime * 1000).toISOString());

    const tx2 = await tournament.createTournament(regStart, startTime, endTime);
    const receipt = await tx2.wait();

    // Get new tournament ID from event
    const event = receipt.logs.find(l => {
        try { return tournament.interface.parseLog(l)?.name === 'TournamentCreated'; } catch { return false; }
    });
    const newId = event ? tournament.interface.parseLog(event).args[0] : 'unknown';
    console.log("   ✓ Tournament #" + newId + " created");

    // 3. Set as active on PackOpener
    console.log("\n3. Setting active tournament on PackOpener...");
    const tx3 = await packOpener.setActiveTournament(newId);
    await tx3.wait();
    console.log("   ✓ Active tournament set to #" + newId);

    // 4. Verify
    const t = await tournament.getTournament(newId);
    console.log("\n=== Tournament #" + newId + " ===");
    console.log("Registration:", new Date(Number(t.registrationStart) * 1000).toISOString());
    console.log("Start:", new Date(Number(t.startTime) * 1000).toISOString());
    console.log("Reveal deadline:", new Date(Number(t.revealDeadline) * 1000).toISOString());
    console.log("End:", new Date(Number(t.endTime) * 1000).toISOString());
    console.log("Status:", Number(t.status));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
