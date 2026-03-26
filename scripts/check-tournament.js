const hre = require("hardhat");
async function main() {
    const contract = await hre.ethers.getContractAt(
        ['function getTournament(uint256) view returns (tuple(uint256 id, uint256 registrationStart, uint256 startTime, uint256 revealDeadline, uint256 endTime, uint256 prizePool, uint256 entryCount, uint8 status))'],
        '0x1B0e40BbB6b436866cf64882DBcECb01F5207f81'
    );
    const t = await contract.getTournament(10);
    const now = Math.floor(Date.now()/1000);
    console.log('Now:', now, new Date(now*1000).toISOString());
    console.log('registrationStart:', Number(t.registrationStart), new Date(Number(t.registrationStart)*1000).toISOString());
    console.log('startTime:', Number(t.startTime), new Date(Number(t.startTime)*1000).toISOString());
    console.log('revealDeadline:', Number(t.revealDeadline), new Date(Number(t.revealDeadline)*1000).toISOString());
    console.log('endTime:', Number(t.endTime), new Date(Number(t.endTime)*1000).toISOString());
    console.log('status:', Number(t.status));
    console.log('prizePool:', hre.ethers.formatEther(t.prizePool), 'ETH');
    console.log('entryCount:', Number(t.entryCount));
    if (now < Number(t.registrationStart)) console.log('Phase: UPCOMING');
    else if (now < Number(t.startTime)) console.log('Phase: REGISTRATION');
    else if (now < Number(t.revealDeadline)) console.log('Phase: REVEAL');
    else if (now < Number(t.endTime)) console.log('Phase: ACTIVE');
    else console.log('Phase: ENDED');
}
main().catch(console.error);
