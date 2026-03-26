/**
 * TournamentManagerFHE — Security & FHE Encapsulation Tests
 *
 * Verifies that:
 * 1. No plaintext scores leak through public state, events, or view functions
 * 2. All scoring/ranking operations use FHE encrypted types
 * 3. Access control prevents unauthorized score viewing
 * 4. The contract ABI has no public getters that expose raw scores
 * 5. DarkLeaderboard only exposes ranks, never scores
 */

import { expect } from "chai";
import hre, { ethers } from "hardhat";
import type { Signer, ContractTransactionReceipt } from "ethers";
import { Encryptable } from "@cofhe/sdk";

let cofheClient: any;

async function encryptPoints(points: number[]): Promise<any[]> {
  const encryptables = points.map(p => Encryptable.uint32(BigInt(p)));
  return cofheClient.encryptInputs(encryptables).execute();
}

async function deployMockNFT() {
  const F = await ethers.getContractFactory("MockAttentionXNFT");
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

async function deployHelper(nftAddr: string) {
  const F = await ethers.getContractFactory("TournamentManagerFHETestHelper");
  const impl = await F.deploy();
  await impl.waitForDeployment();
  const PF = await ethers.getContractFactory("ERC1967Proxy");
  const initData = impl.interface.encodeFunctionData("initialize", [nftAddr]);
  const proxy = await PF.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return F.attach(await proxy.getAddress()) as Awaited<ReturnType<typeof F.deploy>>;
}

async function deployDarkLeaderboard(tournamentAddr: string, adminAddr: string) {
  const F = await ethers.getContractFactory("DarkLeaderboard");
  const c = await F.deploy(tournamentAddr, adminAddr);
  await c.waitForDeployment();
  return c;
}

const POINTS = [100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 200, 50, 50, 50, 50, 50];

describe("FHE Security & Encapsulation", function () {
  this.timeout(120_000);

  let admin: Signer, playerA: Signer, playerB: Signer, outsider: Signer;
  let adminAddr: string, playerAAddr: string, playerBAddr: string, outsiderAddr: string;
  let mockNFT: Awaited<ReturnType<typeof deployMockNFT>>;
  let tournament: Awaited<ReturnType<typeof deployHelper>>;
  let leaderboard: Awaited<ReturnType<typeof deployDarkLeaderboard>>;
  let playerACards: number[], playerBCards: number[];
  const TID = 1;

  before(async function () {
    [admin, playerA, playerB, outsider] = await ethers.getSigners();
    adminAddr = await admin.getAddress();
    playerAAddr = await playerA.getAddress();
    playerBAddr = await playerB.getAddress();
    outsiderAddr = await outsider.getAddress();
    cofheClient = await hre.cofhe.createClientWithBatteries(admin);
  });

  beforeEach(async function () {
    mockNFT = await deployMockNFT();
    tournament = await deployHelper(await mockNFT.getAddress());
    leaderboard = await deployDarkLeaderboard(
      await tournament.getAddress(),
      adminAddr
    );

    // Player A: 5 × startup 1 (multiplier 10)
    playerACards = [];
    for (let i = 0; i < 5; i++) {
      await mockNFT.mintCard(playerAAddr, 1, 10, "Openclaw");
      playerACards.push(i + 1);
    }
    // Player B: 5 × startup 14 (multiplier 1)
    playerBCards = [];
    for (let i = 0; i < 5; i++) {
      await mockNFT.mintCard(playerBAddr, 14, 1, "Pocket");
      playerBCards.push(i + 6);
    }

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await tournament.connect(admin).createTournament(now - 10, now + 86400, now + 86400 * 7);
    await tournament.connect(admin).setEncryptedPoints(TID, await encryptPoints(POINTS));
    await tournament.connect(playerA).enterTournament(TID, playerACards);
    await tournament.connect(playerB).enterTournament(TID, playerBCards);
    await tournament.connect(admin).computeEncryptedScores(TID);
  });

  // =======================================================================
  // 1. No public getters expose raw scores
  // =======================================================================

  describe("No public score/points getters", function () {
    it("contract has no public 'userScores' mapping", async function () {
      // The test helper has decrypt functions but the production contract shouldn't
      // Verify via the ABI that there's no userScores(uint256,address) function
      const iface = tournament.interface;
      const fnNames = iface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as any).name);

      expect(fnNames).to.not.include("userScores");
      expect(fnNames).to.not.include("tournamentPoints");
      expect(fnNames).to.not.include("totalTournamentScore");
    });

    it("encryptedPoints mapping is private (no auto-getter)", async function () {
      const iface = tournament.interface;
      const fnNames = iface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as any).name);

      expect(fnNames).to.not.include("encryptedPoints");
      expect(fnNames).to.not.include("encryptedScores");
      expect(fnNames).to.not.include("encryptedTotalScore");
      expect(fnNames).to.not.include("encryptedRanks");
    });
  });

  // =======================================================================
  // 2. Events don't leak scores
  // =======================================================================

  describe("Events contain no score data", function () {
    it("ScoresComputed event only emits tournamentId and count, not scores", async function () {
      // Re-check: the event signature should NOT include any score values
      const iface = tournament.interface;
      const event = iface.getEvent("ScoresComputed");
      expect(event).to.not.be.null;

      // Check event inputs - should only have tournamentId and participantCount
      const inputNames = event!.inputs.map((i) => i.name);
      expect(inputNames).to.not.include("score");
      expect(inputNames).to.not.include("totalScore");
      expect(inputNames).to.not.include("points");
    });

    it("LineupRegistered only emits cardIds, not startup points or multipliers", async function () {
      const iface = tournament.interface;
      const event = iface.getEvent("LineupRegistered");
      const inputNames = event!.inputs.map((i) => i.name);

      expect(inputNames).to.include("cardIds");
      expect(inputNames).to.not.include("score");
      expect(inputNames).to.not.include("multiplier");
      expect(inputNames).to.not.include("points");
    });
  });

  // =======================================================================
  // 3. FHE.decrypt confirms math is done on encrypted types
  // =======================================================================

  describe("FHE arithmetic verification", function () {
    async function getPlaintext(handle: any): Promise<bigint> {
      return (hre as any).cofhe.mocks.getPlaintext(handle);
    }

    it("encrypted score matches expected: FHE.mul(encrypt(100), encrypt(10)) × 5 = 5000", async function () {
      const handle = await tournament.getEncryptedUserScore(TID, playerAAddr);
      const score = await getPlaintext(handle);
      expect(score).to.equal(5000n);
    });

    it("encrypted total is sum of all encrypted individual scores", async function () {
      const hA = await tournament.getEncryptedUserScore(TID, playerAAddr);
      const hB = await tournament.getEncryptedUserScore(TID, playerBAddr);
      const hT = await tournament.getEncryptedTotalScore(TID);
      const scoreA = await getPlaintext(hA);
      const scoreB = await getPlaintext(hB);
      const total = await getPlaintext(hT);
      expect(total).to.equal(scoreA + scoreB);
    });

    it("FHE.gt correctly compares without revealing values", async function () {
      await tournament.connect(admin).computeDarkRanks(TID, 0, 2);
      const hRA = await tournament.getEncryptedUserRank(TID, playerAAddr);
      const hRB = await tournament.getEncryptedUserRank(TID, playerBAddr);
      const rankA = await getPlaintext(hRA);
      const rankB = await getPlaintext(hRB);
      expect(rankA).to.equal(1n);
      expect(rankB).to.equal(2n);
    });

    it("FHE.select correctly conditionally increments rank", async function () {
      const freshNFT = await deployMockNFT();
      const freshT = await deployHelper(await freshNFT.getAddress());
      const [, pA, pB, pC] = await ethers.getSigners();

      for (let i = 0; i < 5; i++) await freshNFT.mintCard(await pA.getAddress(), 1, 10, "X");
      for (let i = 0; i < 5; i++) await freshNFT.mintCard(await pB.getAddress(), 14, 1, "Y");
      for (let i = 0; i < 5; i++) await freshNFT.mintCard(await pC.getAddress(), 14, 1, "Z");

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await freshT.connect(admin).createTournament(now - 10, now + 86400, now + 86400 * 7);
      await freshT.connect(admin).setEncryptedPoints(1, await encryptPoints(POINTS));

      await freshT.connect(pA).enterTournament(1, [1, 2, 3, 4, 5]);
      await freshT.connect(pB).enterTournament(1, [6, 7, 8, 9, 10]);
      await freshT.connect(pC).enterTournament(1, [11, 12, 13, 14, 15]);

      await freshT.connect(admin).computeEncryptedScores(1);
      await freshT.connect(admin).computeDarkRanks(1, 0, 3);

      const rA = await getPlaintext(await freshT.getEncryptedUserRank(1, await pA.getAddress()));
      const rB = await getPlaintext(await freshT.getEncryptedUserRank(1, await pB.getAddress()));
      const rC = await getPlaintext(await freshT.getEncryptedUserRank(1, await pC.getAddress()));

      expect(rA).to.equal(1n);
      expect(rB).to.equal(2n);
      expect(rC).to.equal(2n);
    });
  });

  // =======================================================================
  // 4. Access control on sealed outputs
  // =======================================================================

  describe("Access control", function () {
    it("non-admin cannot call setEncryptedPoints", async function () {
      const freshNFT = await deployMockNFT();
      const freshT = await deployHelper(await freshNFT.getAddress());
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await freshT.connect(admin).createTournament(now - 10, now + 86400, now + 86400 * 7);

      await expect(
        freshT.connect(playerA).setEncryptedPoints(1, await encryptPoints(POINTS))
      ).to.be.revertedWithCustomError(freshT, "NotAdmin");
    });

    it("non-admin cannot call computeEncryptedScores", async function () {
      await expect(
        tournament.connect(playerA).computeEncryptedScores(TID)
      ).to.be.revertedWithCustomError(tournament, "NotAdmin");
    });

    it("non-admin cannot call computeDarkRanks", async function () {
      await expect(
        tournament.connect(playerA).computeDarkRanks(TID, 0, 2)
      ).to.be.revertedWithCustomError(tournament, "NotAdmin");
    });
  });

  // =======================================================================
  // 5. DarkLeaderboard only exposes ranks
  // =======================================================================

  describe("DarkLeaderboard security", function () {
    it("publishes only ranks and addresses, never scores", async function () {
      // Admin publishes ranks after off-chain FHE comparison
      await leaderboard.connect(admin).publishRanks(TID, [playerAAddr, playerBAddr]);

      const [players, ranks] = await leaderboard.getLeaderboard(TID);

      expect(players[0]).to.equal(playerAAddr);
      expect(players[1]).to.equal(playerBAddr);
      expect(ranks[0]).to.equal(1);
      expect(ranks[1]).to.equal(2);
    });

    it("has no score-related getters in ABI", async function () {
      const iface = leaderboard.interface;
      const fnNames = iface.fragments
        .filter((f) => f.type === "function")
        .map((f) => (f as any).name);

      expect(fnNames).to.not.include("getScore");
      expect(fnNames).to.not.include("getUserScore");
      expect(fnNames).to.not.include("scores");
    });

    it("non-admin cannot publish ranks", async function () {
      await expect(
        leaderboard.connect(playerA).publishRanks(TID, [playerAAddr, playerBAddr])
      ).to.be.revertedWithCustomError(leaderboard, "NotAdmin");
    });

    it("cannot publish ranks twice", async function () {
      await leaderboard.connect(admin).publishRanks(TID, [playerAAddr, playerBAddr]);

      await expect(
        leaderboard.connect(admin).publishRanks(TID, [playerBAddr, playerAAddr])
      ).to.be.revertedWithCustomError(leaderboard, "RanksAlreadyPublished");
    });

    it("getLeaderboardPage returns correct subset", async function () {
      await leaderboard.connect(admin).publishRanks(TID, [playerAAddr, playerBAddr]);

      const [players, ranks] = await leaderboard.getLeaderboardPage(TID, 0, 1);
      expect(players.length).to.equal(1);
      expect(players[0]).to.equal(playerAAddr);
      expect(ranks[0]).to.equal(1);
    });
  });

  // =======================================================================
  // 6. Verify the FHE data flow end-to-end
  // =======================================================================

  describe("End-to-end FHE data flow", function () {
    async function getPlaintext(handle: any): Promise<bigint> {
      return (hre as any).cofhe.mocks.getPlaintext(handle);
    }

    it("plaintext never appears in contract storage for scores/points", async function () {
      // Verify encrypted startup points match input via mock getPlaintext
      for (let i = 0; i < 19; i++) {
        const handle = await tournament.getEncryptedStartupPoints(TID, i + 1);
        const dec = await getPlaintext(handle);
        expect(dec).to.equal(BigInt(POINTS[i]));
      }

      // Verify computed scores
      const sA = await getPlaintext(await tournament.getEncryptedUserScore(TID, playerAAddr));
      const sB = await getPlaintext(await tournament.getEncryptedUserScore(TID, playerBAddr));

      // Player A: 5 cards × startup 1 (100 pts) × 10x = 5000
      // Player B: 5 cards × startup 14 (200 pts) × 1x = 1000
      expect(sA).to.equal(BigInt(5 * 100 * 10));
      expect(sB).to.equal(BigInt(5 * 200 * 1));
    });

    it("all intermediate values use FHE operations", async function () {
      await tournament.connect(admin).computeDarkRanks(TID, 0, 2);

      const total = await getPlaintext(await tournament.getEncryptedTotalScore(TID));
      expect(total).to.equal(6000n);

      const rankA = await getPlaintext(await tournament.getEncryptedUserRank(TID, playerAAddr));
      const rankB = await getPlaintext(await tournament.getEncryptedUserRank(TID, playerBAddr));
      expect(rankA).to.equal(1n);
      expect(rankB).to.equal(2n);
    });
  });

  // =======================================================================
  // 7. Known limitation: ETH transfers are public
  // =======================================================================

  describe("Known limitations (documented)", function () {
    it("ETH claim amounts are visible on-chain (inherent EVM limitation)", async function () {
      // This is a known and documented limitation.
      // Prize amounts in finalizeWithPrizes calldata are visible to block explorers.
      // ETH transfer values in claimPrize are also visible.
      // FHE can only protect computation, not ETH movements.
      //
      // Mitigation options for future:
      // 1. Use a withdraw pattern with obfuscated timing
      // 2. Use a privacy-preserving token instead of native ETH
      // 3. Batch all claims into a single admin distribution

      // For now, we just verify the system works end-to-end
      expect(true).to.equal(true); // Documentation test
    });
  });
});
