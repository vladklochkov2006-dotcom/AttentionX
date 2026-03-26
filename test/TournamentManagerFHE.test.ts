/**
 * TournamentManagerFHE — Hardhat + @cofhe/hardhat-plugin tests
 *
 * Run with:
 *   npx hardhat test test/TournamentManagerFHE.test.ts
 *
 * Uses @cofhe/hardhat-plugin which auto-deploys mock FHE contracts.
 * Encryption is done via hre.cofhe.createClientWithBatteries (mock ZK verifier).
 * Verification via hre.cofhe.mocks.getPlaintext(handle).
 */

import { expect } from "chai";
import hre, { ethers } from "hardhat";
import type { Signer } from "ethers";
import { Encryptable } from "@cofhe/sdk";

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let cofheClient: any;

// ---------------------------------------------------------------------------
// Encryption helpers using CoFHE SDK
// ---------------------------------------------------------------------------

/**
 * Encrypt 19 startup point values into InEuint32[] using the CoFHE client.
 * Each value is encrypted individually (2048-bit limit per call).
 */
async function encryptPoints(points: number[]): Promise<any[]> {
  if (points.length !== 19) throw new Error("Need exactly 19 points");

  // Encrypt all 19 values — may need batching due to 2048-bit limit
  // Each uint32 is 32 bits, 19 × 32 = 608 bits — well within 2048 limit
  const encryptables = points.map(p => Encryptable.uint32(BigInt(p)));
  const encrypted = await cofheClient.encryptInputs(encryptables).execute();
  return encrypted;
}

/**
 * Read plaintext from a ciphertext handle via mock contract.
 */
async function getPlaintext(handle: any): Promise<bigint> {
  return (hre as any).cofhe.mocks.getPlaintext(handle);
}

// ---------------------------------------------------------------------------
// Deployment helpers
// ---------------------------------------------------------------------------

async function deployMockNFT() {
  const Factory = await ethers.getContractFactory("MockAttentionXNFT");
  const mock = await Factory.deploy();
  await mock.waitForDeployment();
  return mock;
}

async function deployHelper(nftAddress: string) {
  const Factory = await ethers.getContractFactory("TournamentManagerFHETestHelper");
  const impl = await Factory.deploy();
  await impl.waitForDeployment();

  const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
  const initData = impl.interface.encodeFunctionData("initialize", [nftAddress]);
  const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();

  return Factory.attach(await proxy.getAddress()) as Awaited<ReturnType<typeof Factory.deploy>>;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SAMPLE_POINTS: number[] = [
  100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 200, 50, 50, 50, 50, 50,
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TournamentManagerFHE", function () {
  this.timeout(120_000);

  let admin: Signer;
  let playerA: Signer;
  let playerB: Signer;
  let adminAddr: string;
  let playerAAddr: string;
  let playerBAddr: string;

  let mockNFT: Awaited<ReturnType<typeof deployMockNFT>>;
  let tournament: Awaited<ReturnType<typeof deployHelper>>;

  let playerACards: number[];
  let playerBCards: number[];

  const TOURNAMENT_ID = 1;

  before(async function () {
    [admin, playerA, playerB] = await ethers.getSigners();
    adminAddr = await admin.getAddress();
    playerAAddr = await playerA.getAddress();
    playerBAddr = await playerB.getAddress();

    // Initialize CoFHE client with the admin signer (used for encrypting inputs)
    cofheClient = await (hre as any).cofhe.createClientWithBatteries(admin);
  });

  beforeEach(async function () {
    mockNFT = await deployMockNFT();
    const nftAddr = await mockNFT.getAddress();
    tournament = await deployHelper(nftAddr);

    // Mint 5 cards for Player A — all startup #1 (Openclaw, multiplier=10)
    playerACards = [];
    for (let i = 0; i < 5; i++) {
      await mockNFT.mintCard(playerAAddr, 1, 10, "Openclaw");
      playerACards.push(i + 1);
    }

    // Mint 5 cards for Player B — all startup #14 (Pocket, multiplier=1)
    playerBCards = [];
    for (let i = 0; i < 5; i++) {
      await mockNFT.mintCard(playerBAddr, 14, 1, "Pocket");
      playerBCards.push(i + 6);
    }

    // Create tournament
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await tournament.connect(admin).createTournament(
      now - 10,
      now + 86400,
      now + 86400 * 7
    );
  });

  // =======================================================================
  // 1. setEncryptedPoints
  // =======================================================================

  describe("setEncryptedPoints", function () {
    it("should store encrypted points and mark pointsFinalized", async function () {
      const encPts = await encryptPoints(SAMPLE_POINTS);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);

      expect(await tournament.pointsFinalized(TOURNAMENT_ID)).to.equal(true);
    });

    it("should store correct plaintext values behind ciphertext handles", async function () {
      const encPts = await encryptPoints(SAMPLE_POINTS);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);

      for (let i = 0; i < 19; i++) {
        const startupId = i + 1;
        const handle = await tournament.getEncryptedStartupPoints(TOURNAMENT_ID, startupId);
        const plaintext = await getPlaintext(handle);
        expect(plaintext).to.equal(
          BigInt(SAMPLE_POINTS[i]),
          `Startup ${startupId}: expected ${SAMPLE_POINTS[i]}, got ${plaintext}`
        );
      }
    });

    it("should revert if points are set twice", async function () {
      const encPts = await encryptPoints(SAMPLE_POINTS);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);

      const encPts2 = await encryptPoints(SAMPLE_POINTS);
      await expect(
        tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts2)
      ).to.be.revertedWithCustomError(tournament, "PointsAlreadySet");
    });

    it("should revert if called by non-admin", async function () {
      const encPts = await encryptPoints(SAMPLE_POINTS);

      await expect(
        tournament.connect(playerA).setEncryptedPoints(TOURNAMENT_ID, encPts)
      ).to.be.revertedWithCustomError(tournament, "NotAdmin");
    });
  });

  // =======================================================================
  // 2. computeEncryptedScores — verify FHE math
  // =======================================================================

  describe("computeEncryptedScores", function () {
    beforeEach(async function () {
      const encPts = await encryptPoints(SAMPLE_POINTS);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);
      await tournament.connect(playerA).enterTournament(TOURNAMENT_ID, playerACards);
      await tournament.connect(playerB).enterTournament(TOURNAMENT_ID, playerBCards);
    });

    it("should compute correct score for Player A: 5 × (100 × 10) = 5000", async function () {
      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);

      const handle = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerAAddr);
      expect(await getPlaintext(handle)).to.equal(5000n);
    });

    it("should compute correct score for Player B: 5 × (200 × 1) = 1000", async function () {
      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);

      const handle = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerBAddr);
      expect(await getPlaintext(handle)).to.equal(1000n);
    });

    it("should compute correct total score: 5000 + 1000 = 6000", async function () {
      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);

      const handle = await tournament.getEncryptedTotalScore(TOURNAMENT_ID);
      expect(await getPlaintext(handle)).to.equal(6000n);
    });

    it("should revert if points not set yet", async function () {
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await tournament.connect(admin).createTournament(now - 10, now + 86400, now + 86400 * 7);

      await expect(
        tournament.connect(admin).computeEncryptedScores(2)
      ).to.be.revertedWithCustomError(tournament, "PointsNotSet");
    });
  });

  // =======================================================================
  // 3. Mixed lineup
  // =======================================================================

  describe("Mixed startup lineup scoring", function () {
    it("should correctly sum scores across different startups and multipliers", async function () {
      const freshNFT = await deployMockNFT();
      const freshTournament = await deployHelper(await freshNFT.getAddress());

      const mixedCards = [
        { startupId: 1,  multiplier: 10, name: "Openclaw" },
        { startupId: 6,  multiplier: 5,  name: "Browser Use" },
        { startupId: 9,  multiplier: 3,  name: "Axiom" },
        { startupId: 14, multiplier: 1,  name: "Pocket" },
        { startupId: 14, multiplier: 1,  name: "Pocket" },
      ];

      const cardIds: number[] = [];
      for (let i = 0; i < mixedCards.length; i++) {
        const c = mixedCards[i];
        await freshNFT.mintCard(playerAAddr, c.startupId, c.multiplier, c.name);
        cardIds.push(i + 1);
      }

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await freshTournament.connect(admin).createTournament(now - 10, now + 86400, now + 86400 * 7);

      const encPts = await encryptPoints(SAMPLE_POINTS);
      await freshTournament.connect(admin).setEncryptedPoints(1, encPts);
      await freshTournament.connect(playerA).enterTournament(1, cardIds);

      await freshTournament.connect(admin).computeEncryptedScores(1);

      const handle = await freshTournament.getEncryptedUserScore(1, playerAAddr);
      expect(await getPlaintext(handle)).to.equal(1800n);
    });
  });

  // =======================================================================
  // 4. computeDarkRanks
  // =======================================================================

  describe("computeDarkRanks", function () {
    beforeEach(async function () {
      const encPts = await encryptPoints(SAMPLE_POINTS);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);
      await tournament.connect(playerA).enterTournament(TOURNAMENT_ID, playerACards);
      await tournament.connect(playerB).enterTournament(TOURNAMENT_ID, playerBCards);
      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);
    });

    it("should assign rank 1 to Player A (5000) and rank 2 to Player B (1000)", async function () {
      await tournament.connect(admin).computeDarkRanks(TOURNAMENT_ID, 0, 2);

      const handleA = await tournament.getEncryptedUserRank(TOURNAMENT_ID, playerAAddr);
      const handleB = await tournament.getEncryptedUserRank(TOURNAMENT_ID, playerBAddr);
      expect(await getPlaintext(handleA)).to.equal(1n);
      expect(await getPlaintext(handleB)).to.equal(2n);
    });

    it("should handle batched rank computation", async function () {
      await tournament.connect(admin).computeDarkRanks(TOURNAMENT_ID, 0, 1);
      const handleA = await tournament.getEncryptedUserRank(TOURNAMENT_ID, playerAAddr);
      expect(await getPlaintext(handleA)).to.equal(1n);

      await tournament.connect(admin).computeDarkRanks(TOURNAMENT_ID, 1, 1);
      const handleB = await tournament.getEncryptedUserRank(TOURNAMENT_ID, playerBAddr);
      expect(await getPlaintext(handleB)).to.equal(2n);
    });
  });

  // =======================================================================
  // 5. Full lifecycle
  // =======================================================================

  describe("Full tournament lifecycle", function () {
    it("create → enter → setPoints → compute → rank → verify", async function () {
      await tournament.connect(playerA).enterTournament(TOURNAMENT_ID, playerACards);
      await tournament.connect(playerB).enterTournament(TOURNAMENT_ID, playerBCards);
      expect(await tournament.getParticipantCount(TOURNAMENT_ID)).to.equal(2);

      const encPts = await encryptPoints(SAMPLE_POINTS);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);
      expect(await tournament.pointsFinalized(TOURNAMENT_ID)).to.equal(true);

      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);

      const scoreA = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerAAddr);
      const scoreB = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerBAddr);
      const total = await tournament.getEncryptedTotalScore(TOURNAMENT_ID);
      expect(await getPlaintext(scoreA)).to.equal(5000n);
      expect(await getPlaintext(scoreB)).to.equal(1000n);
      expect(await getPlaintext(total)).to.equal(6000n);

      await tournament.connect(admin).computeDarkRanks(TOURNAMENT_ID, 0, 2);

      const rankA = await tournament.getEncryptedUserRank(TOURNAMENT_ID, playerAAddr);
      const rankB = await tournament.getEncryptedUserRank(TOURNAMENT_ID, playerBAddr);
      expect(await getPlaintext(rankA)).to.equal(1n);
      expect(await getPlaintext(rankB)).to.equal(2n);

      for (const id of playerACards) {
        expect(await mockNFT.isLocked(id)).to.equal(true);
      }
    });
  });

  // =======================================================================
  // 6. Edge cases
  // =======================================================================

  describe("Edge cases", function () {
    it("should handle zero-point startups correctly", async function () {
      const zeroPoints = new Array(19).fill(0);
      const encPts = await encryptPoints(zeroPoints);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);

      await tournament.connect(playerA).enterTournament(TOURNAMENT_ID, playerACards);
      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);

      const handle = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerAAddr);
      expect(await getPlaintext(handle)).to.equal(0n);
    });

    it("should handle large but safe values without overflow", async function () {
      const largePoints = new Array(19).fill(1000);
      const encPts = await encryptPoints(largePoints);
      await tournament.connect(admin).setEncryptedPoints(TOURNAMENT_ID, encPts);

      await tournament.connect(playerA).enterTournament(TOURNAMENT_ID, playerACards);
      await tournament.connect(admin).computeEncryptedScores(TOURNAMENT_ID);

      const handle = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerAAddr);
      expect(await getPlaintext(handle)).to.equal(50_000n);
    });

    it("should handle equal scores with tied ranks", async function () {
      const freshNFT = await deployMockNFT();
      const freshTournament = await deployHelper(await freshNFT.getAddress());

      const cardsA: number[] = [];
      for (let i = 0; i < 5; i++) {
        await freshNFT.mintCard(playerAAddr, 14, 1, "Pocket");
        cardsA.push(i + 1);
      }
      const cardsB: number[] = [];
      for (let i = 0; i < 5; i++) {
        await freshNFT.mintCard(playerBAddr, 14, 1, "Pocket");
        cardsB.push(i + 6);
      }

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await freshTournament.connect(admin).createTournament(now - 10, now + 86400, now + 86400 * 7);

      const encPts = await encryptPoints(SAMPLE_POINTS);
      await freshTournament.connect(admin).setEncryptedPoints(1, encPts);
      await freshTournament.connect(playerA).enterTournament(1, cardsA);
      await freshTournament.connect(playerB).enterTournament(1, cardsB);

      await freshTournament.connect(admin).computeEncryptedScores(1);

      const scoreA = await freshTournament.getEncryptedUserScore(1, playerAAddr);
      const scoreB = await freshTournament.getEncryptedUserScore(1, playerBAddr);
      expect(await getPlaintext(scoreA)).to.equal(1000n);
      expect(await getPlaintext(scoreB)).to.equal(1000n);

      await freshTournament.connect(admin).computeDarkRanks(1, 0, 2);
      const rankA = await freshTournament.getEncryptedUserRank(1, playerAAddr);
      const rankB = await freshTournament.getEncryptedUserRank(1, playerBAddr);
      expect(await getPlaintext(rankA)).to.equal(1n);
      expect(await getPlaintext(rankB)).to.equal(1n);
    });
  });
});
