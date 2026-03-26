/**
 * AttentionX FHE Demo — Run as: npx hardhat test test/demo.test.ts
 *
 * Full encrypted tournament lifecycle with colored terminal output.
 */

import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { expect } from "chai";

const G = "\x1b[32m", Y = "\x1b[33m", C = "\x1b[36m", M = "\x1b[35m";
const R = "\x1b[31m", B = "\x1b[1m", X = "\x1b[0m";

function log(icon: string, msg: string) { console.log(`    ${icon}  ${msg}`); }
function header(t: string) {
  console.log(`\n  ${B}${C}${"═".repeat(60)}${X}`);
  console.log(`  ${B}${C}  ${t}${X}`);
  console.log(`  ${B}${C}${"═".repeat(60)}${X}\n`);
}
function step(n: number, t: string) {
  console.log(`\n  ${B}${Y}  Step ${n}: ${t}${X}`);
  console.log(`  ${Y}  ${"─".repeat(48)}${X}`);
}

describe("AttentionX FHE Demo", function () {
  this.timeout(120_000);

  it("Full encrypted tournament lifecycle", async function () {
    const [admin, playerA, playerB] = await ethers.getSigners();
    const playerAAddr = await playerA.getAddress();
    const playerBAddr = await playerB.getAddress();

    const cofheClient = await (hre as any).cofhe.createClientWithBatteries(admin);

    header("AttentionX FHE Demo — Encrypted Fantasy League");
    log("🎮", `Network: hardhat (mock FHE)`);
    log("🅰️", `Player A: ${playerAAddr.slice(0, 10)}... (Privacy — commit-reveal)`);
    log("🅱️", `Player B: ${playerBAddr.slice(0, 10)}... (Legacy — public entry)`);

    // ── Step 1: Deploy ──
    step(1, "Deploy Contracts");
    const nft = await (await ethers.getContractFactory("MockAttentionXNFT")).deploy();
    await nft.waitForDeployment();

    const Helper = await ethers.getContractFactory("TournamentManagerFHETestHelper");
    const impl = await Helper.deploy();
    await impl.waitForDeployment();
    const initData = Helper.interface.encodeFunctionData("initialize", [await nft.getAddress()]);
    const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();
    const tournament = Helper.attach(await proxy.getAddress()) as any;
    log("✅", `TournamentManagerFHE deployed`);

    // ── Step 2: Mint Cards ──
    step(2, "Mint NFT Cards");
    const playerACards: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      await nft.mintCard(playerAAddr, 1, 10, `YC-Alpha-${i}`);
      playerACards.push(BigInt(i + 1));
    }
    log("🃏", `Player A: 5 Legendary cards (Startup #1, ${G}10x${X} mult)`);

    const playerBCards: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      await nft.mintCard(playerBAddr, 14, 1, `YC-Beta-${i}`);
      playerBCards.push(BigInt(i + 6));
    }
    log("🃏", `Player B: 5 Common cards (Startup #14, ${Y}1x${X} mult)`);

    // ── Step 3: Create Tournament ──
    step(3, "Create Tournament");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await tournament.createTournament(now + 1, now + 100, now + 18000);
    await ethers.provider.send("evm_setNextBlockTimestamp", [now + 2]);
    await ethers.provider.send("evm_mine", []);
    log("🏆", "Tournament #1 — Registration open");

    // ── Step 4: Player A commits hidden lineup ──
    step(4, "Player A: Commit Hidden Lineup");
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commitHash = ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
      [...playerACards, salt]
    );
    await tournament.connect(playerA).commitLineup(1, commitHash);
    log("🔐", `Commit hash: ${commitHash.slice(0, 22)}...`);
    log("🔒", `${G}Cards HIDDEN — no one sees Player A's strategy!${X}`);
    expect(await nft.isLocked(1)).to.be.false;
    log("🔓", `Cards locked? ${G}NO${X} — free until reveal`);

    // ── Step 5: Player B enters publicly ──
    step(5, "Player B: Enter Publicly");
    await tournament.connect(playerB).enterTournament(1, playerBCards);
    log("👀", `Cards: [${playerBCards.join(", ")}] — ${R}visible in event!${X}`);

    // ── Step 6: Reveal ──
    step(6, "Player A Reveals Lineup");
    await ethers.provider.send("evm_setNextBlockTimestamp", [now + 101]);
    await ethers.provider.send("evm_mine", []);

    const revealTx = await tournament.connect(playerA).revealLineup(1, playerACards, salt);
    const receipt = await revealTx.wait();
    const revealLog = receipt!.logs.find((l: any) => {
      try { return tournament.interface.parseLog(l)?.name === "LineupRevealed"; } catch { return false; }
    });
    if (revealLog) {
      const parsed = tournament.interface.parseLog(revealLog);
      log("🔒", `Event: LineupRevealed(id=1, user=${String(parsed!.args[1]).slice(0, 10)}...)`);
      log("✅", `${G}No card IDs in event — strategy private!${X}`);
    }
    expect(await nft.isLocked(1)).to.be.true;
    log("🔐", `Cards now locked? ${G}YES${X}`);

    // ── Step 7: Encrypted points ──
    step(7, "Set Encrypted Points (FHE)");
    const points = [100,50,50,50,50,50,50,50,50,50,50,50,50,200,50,50,50,50,50];
    const enc = await cofheClient.encryptInputs(points.map(p => Encryptable.uint32(BigInt(p)))).execute();
    await tournament.setEncryptedPoints(1, enc);
    log("🔐", `19 startup points → ${C}euint32${X} ciphertext`);
    log("✅", `${G}No plaintext on-chain!${X}`);

    // ── Step 8: Compute scores ──
    step(8, "Compute Encrypted Scores (FHE.mul + FHE.add)");
    await tournament.computeEncryptedScores(1);

    const scoreA = await tournament.getEncryptedUserScore(1, playerAAddr);
    const scoreB = await tournament.getEncryptedUserScore(1, playerBAddr);
    const plainA = await (hre as any).cofhe.mocks.getPlaintext(scoreA);
    const plainB = await (hre as any).cofhe.mocks.getPlaintext(scoreB);

    log("🧮", `Player A: 5 × (100 × 10) = ${G}${plainA}${X} ${M}[decrypted for demo]${X}`);
    log("🧮", `Player B: 5 × (200 × 1)  = ${Y}${plainB}${X} ${M}[decrypted for demo]${X}`);
    log("🔒", `In production: scores are ${R}NEVER${X} visible`);

    expect(plainA).to.equal(5000n);
    expect(plainB).to.equal(1000n);

    // ── Step 9: Dark ranks ──
    step(9, "Dark Leaderboard (FHE.gt + FHE.select)");
    await tournament.computeDarkRanks(1, 0, 10);

    const rankA = await (hre as any).cofhe.mocks.getPlaintext(await tournament.getEncryptedUserRank(1, playerAAddr));
    const rankB = await (hre as any).cofhe.mocks.getPlaintext(await tournament.getEncryptedUserRank(1, playerBAddr));

    log("🏅", `Player A: Rank ${G}#${rankA}${X}`);
    log("🏅", `Player B: Rank ${Y}#${rankB}${X}`);

    expect(rankA).to.equal(1n);
    expect(rankB).to.equal(2n);

    // ── Summary ──
    header("DEMO COMPLETE");
    console.log(`    ${B}Visible on-chain:${X}`);
    console.log(`      ✅ Tournament exists, 2 participants`);
    console.log(`      ✅ Ranks: A=#1, B=#2`);
    console.log(`      ✅ Commit hash + reveal verified`);
    console.log("");
    console.log(`    ${B}${R}HIDDEN${X}${B} on-chain:${X}`);
    console.log(`      ❌ Player A's cards (commit-reveal)`);
    console.log(`      ❌ All scores (euint32 ciphertext)`);
    console.log(`      ❌ Startup points (euint32 ciphertext)`);
    console.log(`      ❌ Score comparisons (FHE.gt)`);
    console.log("");
    console.log(`    ${B}${G}✨ Privacy preserved. Fair competition. Provably correct. ✨${X}`);
    console.log("");
  });
});
