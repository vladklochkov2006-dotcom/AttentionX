const hre = require("hardhat");
const fs = require("fs");
async function main() {
    const [deployer] = await hre.ethers.getSigners();
    console.log("Deployer:", deployer.address);
    const deployment = JSON.parse(fs.readFileSync("deployment-cofhe.json", "utf8"));
    const proxyAddress = typeof deployment.contracts.TournamentManagerFHE === 'string'
        ? deployment.contracts.TournamentManagerFHE
        : deployment.contracts.TournamentManagerFHE.proxy;
    console.log("Proxy:", proxyAddress);

    const feeData = await hre.ethers.provider.getFeeData();
    const gasPrice = (feeData.gasPrice || 0n) * 150n / 100n;

    const Factory = await hre.ethers.getContractFactory("TournamentManagerFHE");
    const newImpl = await Factory.deploy({ gasPrice });
    await newImpl.waitForDeployment();
    const newImplAddress = await newImpl.getAddress();
    console.log("New implementation:", newImplAddress);

    const proxy = Factory.attach(proxyAddress);
    const tx = await proxy.upgradeToAndCall(newImplAddress, "0x", { gasPrice });
    await tx.wait();
    console.log("✓ TournamentManagerFHE upgraded");

    if (typeof deployment.contracts.TournamentManagerFHE === 'object') {
        deployment.contracts.TournamentManagerFHE.implementation = newImplAddress;
        fs.writeFileSync("deployment-cofhe.json", JSON.stringify(deployment, null, 2));
        console.log("✓ deployment-cofhe.json updated");
    }

    // Test enterTournament exists
    const abi = ['function enterTournament(uint256, uint256[5]) external'];
    const test = await hre.ethers.getContractAt(abi, proxyAddress);
    console.log("✓ enterTournament function exists on proxy");
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
