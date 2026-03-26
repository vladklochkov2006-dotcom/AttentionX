import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const deployment = JSON.parse(fs.readFileSync("deployment-cofhe.json", "utf8"));
  const proxyAddress = deployment.contracts.TournamentManagerFHE.proxy;
  
  console.log("Upgrading TournamentManagerFHE...");
  console.log("Proxy:", proxyAddress);
  
  const TournamentFHE = await ethers.getContractFactory("TournamentManagerFHE");
  const newImpl = await TournamentFHE.deploy();
  await newImpl.waitForDeployment();
  const newImplAddress = await newImpl.getAddress();
  console.log("New implementation:", newImplAddress);
  
  // Call upgradeToAndCall on proxy
  const proxy = TournamentFHE.attach(proxyAddress);
  const tx = await proxy.upgradeToAndCall(newImplAddress, "0x");
  await tx.wait();
  
  console.log("Upgrade complete!");
  
  // Update deployment file
  deployment.contracts.TournamentManagerFHE.implementation = newImplAddress;
  fs.writeFileSync("deployment-cofhe.json", JSON.stringify(deployment, null, 2));
  console.log("deployment-cofhe.json updated");
  
  // Verify enterTournament is disabled
  try {
    await proxy.enterTournament.staticCall(1, [1,2,3,4,5]);
    console.log("ERROR: enterTournament should revert!");
  } catch (e: any) {
    console.log("enterTournament reverts:", e.reason || e.message?.slice(0, 80));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
