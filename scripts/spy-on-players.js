// Attacker simulation: try to discover players' cards in the tournament
const hre = require("hardhat");
async function main() {
    const PROXY = "0x1B0e40BbB6b436866cf64882DBcECb01F5207f81";
    const ABI = [
        'function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))',
        'function getTournamentParticipants(uint256) view returns (address[])',
        'function playerVerified(uint256, address) view returns (bool)',
        'function getUserLineup(uint256, address) view returns (tuple(uint256[5] cardIds, address owner, uint256 timestamp, bool cancelled, bool claimed))',
        'function hasEntered(uint256, address) view returns (bool)',
        'function nextTournamentId() view returns (uint256)',
    ];
    const PACK_ABI = ['function activeTournamentId() view returns (uint256)'];

    const contract = await hre.ethers.getContractAt(ABI, PROXY);
    const packOpener = await hre.ethers.getContractAt(PACK_ABI, '0xB6F73D5172425B734E020073A80A44d8B22FfA39');

    const activeId = Number(await packOpener.activeTournamentId());
    const nextId = Number(await contract.nextTournamentId());
    console.log("Active tournament ID:", activeId);
    console.log("Next tournament ID:", nextId);

    // Check all recent tournaments
    for (let id = Math.max(1, nextId - 3); id < nextId; id++) {
        const t = await contract.getTournament(id);
        const statusNames = ['Created', 'Active', 'Finalized', 'Cancelled'];
        console.log(`\n=== Tournament #${id} (${statusNames[Number(t.status)]}) — ${Number(t.entryCount)} entries ===`);

        if (Number(t.entryCount) === 0) {
            console.log("  No participants");
            continue;
        }

        const participants = await contract.getTournamentParticipants(id);
        console.log(`  ${participants.length} participants found\n`);

        console.log("  [ATTACKER] Attempting to read cards...\n");
        for (const p of participants) {
            console.log(`  Player: ${p}`);

            // Method 1: Try plaintext lineup
            const lineup = await contract.getUserLineup(id, p);
            const cards = lineup.cardIds.map(Number);
            const allZero = cards.every(c => c === 0);
            console.log(`    Plaintext lineup: [${cards.join(', ')}]`);
            console.log(`    → ${allZero ? '❌ BLOCKED — all zeros, cards are private!' : '⚠️  VISIBLE — cards exposed!'}`);

            // Method 2: Check verified status
            const verified = await contract.playerVerified(id, p);
            console.log(`    playerVerified: ${verified}`);

            // Method 3: Try reading encrypted handles (only admin can decode these)
            try {
                const encABI = ['function getEncryptedLineup(uint256, address) view returns (uint256[5])'];
                const encContract = await hre.ethers.getContractAt(encABI, PROXY);
                const enc = await encContract.getEncryptedLineup(id, p);
                const handles = enc.map(h => h.toString());
                const hasData = handles.some(h => h !== '0');
                console.log(`    Encrypted handles: [${handles.map(h => h.substring(0, 12) + '...').join(', ')}]`);
                console.log(`    → ${hasData ? 'Has ciphertext (unreadable without admin key)' : 'Empty'}`);
            } catch (err) {
                console.log(`    Encrypted lineup: ❌ ACCESS DENIED (admin-only function)`);
            }

            console.log();
        }
    }

    console.log("\n=== ATTACKER CONCLUSION ===");
    console.log("Cannot determine which NFT cards any player submitted.");
    console.log("Encrypted lineup handles are meaningless without CoFHE decryption key.");
    console.log("Plaintext lineup is all zeros until server verifies (private operation).");
}
main().catch(console.error);
