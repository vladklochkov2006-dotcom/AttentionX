const hre = require("hardhat");
async function main() {
    const packOpener = await hre.ethers.getContractAt(
        ['function currentPackPrice() view returns (uint256)', 'function activeTournamentId() view returns (uint256)'],
        '0xB6F73D5172425B734E020073A80A44d8B22FfA39'
    );
    const tournament = await hre.ethers.getContractAt(
        ['function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))'],
        '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81'
    );

    const price = await packOpener.currentPackPrice();
    const activeId = Number(await packOpener.activeTournamentId());
    console.log('Pack price on contract:', hre.ethers.formatEther(price), 'ETH');
    console.log('Active tournament:', activeId);

    if (activeId > 0) {
        const t = await tournament.getTournament(activeId);
        console.log('Prize pool on contract:', hre.ethers.formatEther(t.prizePool), 'ETH');
        console.log('Entry count:', Number(t.entryCount));
    }
}
main().catch(console.error);
