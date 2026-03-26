/**
 * Commit-Reveal Lineup Tests
 *
 * Tests the new privacy-preserving lineup submission flow:
 *   1. commitLineup(hash) — during Registration phase
 *   2. revealLineup(cardIds, salt) — during Reveal phase
 *   3. Scoring only counts revealed lineups
 */

import { expect } from "chai";
import hre, { ethers } from "hardhat";
import type { Signer } from "ethers";
import { Encryptable } from "@cofhe/sdk";

let cofheClient: any;

async function encryptPoints(points: number[]): Promise<any[]> {
  const encryptables = points.map(p => Encryptable.uint32(BigInt(p)));
  return cofheClient.encryptInputs(encryptables).execute();
}

async function getPlaintext(handle: any): Promise<bigint> {
  return (hre as any).cofhe.mocks.getPlaintext(handle);
}

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

const SAMPLE_POINTS: number[] = [
  100, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 200, 50, 50, 50, 50, 50,
];

describe("Commit-Reveal Lineups", function () {
  this.timeout(120_000);

  let admin: Signer;
  let playerA: Signer;
  let playerB: Signer;
  let playerAAddr: string;
  let playerBAddr: string;

  let mockNFT: Awaited<ReturnType<typeof deployMockNFT>>;
  let tournament: Awaited<ReturnType<typeof deployHelper>>;

  let playerACards: number[];
  let playerBCards: number[];

  const TOURNAMENT_ID = 1;
  const SALT_A = ethers.id("secret-salt-player-a");
  const SALT_B = ethers.id("secret-salt-player-b");

  before(async function () {
    [admin, playerA, playerB] = await ethers.getSigners();
    playerAAddr = await playerA.getAddress();
    playerBAddr = await playerB.getAddress();

    cofheClient = await (hre as any).cofhe.createClientWithBatteries(admin);

    mockNFT = await deployMockNFT();
    tournament = await deployHelper(await mockNFT.getAddress());
    // MockNFT has no access control on lock/unlock — open for all

    // Mint cards: Player A gets 5 cards (startupId=1, multiplier=10)
    // mintCard(to, startupId, multiplier, name) — returns auto-incremented tokenId
    playerACards = [];
    for (let i = 0; i < 5; i++) {
      const tx = await mockNFT.mintCard(playerAAddr, 1, 10, `Startup-A-${i}`);
      const receipt = await tx.wait();
      // tokenId starts from 1 and auto-increments
      playerACards.push(i + 1);
    }

    // Player B gets 5 cards (startupId=14, multiplier=1)
    playerBCards = [];
    for (let i = 0; i < 5; i++) {
      await mockNFT.mintCard(playerBAddr, 14, 1, `Startup-B-${i}`);
      playerBCards.push(i + 6);
    }
  });

  // Helper: compute commit hash
  function computeCommitHash(cardIds: number[], salt: string): string {
    return ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "uint256", "uint256", "uint256", "bytes32"],
      [cardIds[0], cardIds[1], cardIds[2], cardIds[3], cardIds[4], salt]
    );
  }

  describe("commitLineup", function () {
    before(async function () {
      // Create tournament: registration now, starts in 1h, ends in 5h
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await tournament.createTournament(now, now + 3600, now + 18000);
    });

    it("should accept a commit hash during registration", async function () {
      const hash = computeCommitHash(playerACards, SALT_A);
      const tx = await tournament.connect(playerA).commitLineup(TOURNAMENT_ID, hash);
      await expect(tx)
        .to.emit(tournament, "LineupCommitted")
        .withArgs(TOURNAMENT_ID, playerAAddr, hash);
    });

    it("should store commitment and mark player as entered", async function () {
      const entered = await tournament.hasEntered(TOURNAMENT_ID, playerAAddr);
      expect(entered).to.be.true;

      const commitment = await tournament.lineupCommitments(TOURNAMENT_ID, playerAAddr);
      expect(commitment).to.equal(computeCommitHash(playerACards, SALT_A));
    });

    it("should reject duplicate commit", async function () {
      const hash = computeCommitHash(playerACards, SALT_A);
      await expect(
        tournament.connect(playerA).commitLineup(TOURNAMENT_ID, hash)
      ).to.be.revertedWithCustomError(tournament, "AlreadyEntered");
    });

    it("Player B can also commit", async function () {
      const hash = computeCommitHash(playerBCards, SALT_B);
      await tournament.connect(playerB).commitLineup(TOURNAMENT_ID, hash);
      expect(await tournament.hasEntered(TOURNAMENT_ID, playerBAddr)).to.be.true;
    });

    it("lineup is NOT revealed yet — cards are NOT locked", async function () {
      const revealed = await tournament.lineupRevealed(TOURNAMENT_ID, playerAAddr);
      expect(revealed).to.be.false;

      // Cards should NOT be locked
      for (const id of playerACards) {
        expect(await mockNFT.isLocked(id)).to.be.false;
      }
    });
  });

  describe("revealLineup", function () {
    it("should reject reveal before tournament starts", async function () {
      await expect(
        tournament.connect(playerA).revealLineup(TOURNAMENT_ID, playerACards, SALT_A)
      ).to.be.revertedWithCustomError(tournament, "RevealPeriodNotActive");
    });

    it("should accept valid reveal after tournament starts", async function () {
      // Advance time past startTime
      const t = await tournament.getTournament(TOURNAMENT_ID);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(t.startTime) + 1]);
      await ethers.provider.send("evm_mine", []);

      const tx = await tournament.connect(playerA).revealLineup(TOURNAMENT_ID, playerACards, SALT_A);
      await expect(tx)
        .to.emit(tournament, "LineupRevealed")
        .withArgs(TOURNAMENT_ID, playerAAddr);
    });

    it("cards are now locked after reveal", async function () {
      for (const id of playerACards) {
        expect(await mockNFT.isLocked(id)).to.be.true;
      }
    });

    it("lineup is marked as revealed", async function () {
      expect(await tournament.lineupRevealed(TOURNAMENT_ID, playerAAddr)).to.be.true;
    });

    it("should reject reveal with wrong salt", async function () {
      const wrongSalt = ethers.id("wrong-salt");
      await expect(
        tournament.connect(playerB).revealLineup(TOURNAMENT_ID, playerBCards, wrongSalt)
      ).to.be.revertedWithCustomError(tournament, "InvalidReveal");
    });

    it("should reject reveal with wrong cards", async function () {
      const wrongCards = [11, 12, 13, 14, 15]; // not the committed cards
      await expect(
        tournament.connect(playerB).revealLineup(TOURNAMENT_ID, wrongCards, SALT_B)
      ).to.be.revertedWithCustomError(tournament, "InvalidReveal");
    });

    it("Player B reveals successfully", async function () {
      await tournament.connect(playerB).revealLineup(TOURNAMENT_ID, playerBCards, SALT_B);
      expect(await tournament.lineupRevealed(TOURNAMENT_ID, playerBAddr)).to.be.true;
    });

    it("should reject double reveal", async function () {
      await expect(
        tournament.connect(playerA).revealLineup(TOURNAMENT_ID, playerACards, SALT_A)
      ).to.be.revertedWithCustomError(tournament, "AlreadyCommitted");
    });
  });

  describe("scoring only counts revealed lineups", function () {
    it("should compute correct scores for revealed players", async function () {
      const encrypted = await encryptPoints(SAMPLE_POINTS);
      await tournament.setEncryptedPoints(TOURNAMENT_ID, encrypted);
      await tournament.computeEncryptedScores(TOURNAMENT_ID);

      // Player A: 5 cards × (startupId=1, points=100) × multiplier=10 = 5000
      const scoreA = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerAAddr);
      expect(await getPlaintext(scoreA)).to.equal(5000n);

      // Player B: 5 cards × (startupId=14, points=200) × multiplier=1 = 1000
      const scoreB = await tournament.getEncryptedUserScore(TOURNAMENT_ID, playerBAddr);
      expect(await getPlaintext(scoreB)).to.equal(1000n);
    });
  });

  describe("commit-reveal with unrevealed player", function () {
    let t2: Awaited<ReturnType<typeof deployHelper>>;
    let playerC: Signer;
    let playerCAddr: string;
    const T2_ID = 1;

    before(async function () {
      [, , , playerC] = await ethers.getSigners();
      playerCAddr = await playerC.getAddress();

      // Deploy fresh instance
      const nft2 = await deployMockNFT();
      t2 = await deployHelper(await nft2.getAddress());
      // MockNFT has no access control on lock/unlock — open for all

      // Mint cards for playerA (tokenIds 1-5) and playerC (tokenIds 6-10) on nft2
      for (let i = 0; i < 5; i++) {
        await nft2.mintCard(playerAAddr, 1, 10, `CardA-${i}`);
      }
      for (let i = 0; i < 5; i++) {
        await nft2.mintCard(playerCAddr, 1, 10, `CardC-${i}`);
      }

      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await t2.createTournament(now, now + 3600, now + 18000);

      // Player A: commit + reveal (full flow) — tokenIds 1-5
      const cardsA: [number, number, number, number, number] = [1, 2, 3, 4, 5];
      const hashA = computeCommitHash(cardsA, SALT_A);
      await t2.connect(playerA).commitLineup(T2_ID, hashA);

      // Player C: commit only (does NOT reveal) — tokenIds 6-10
      const cardsC: [number, number, number, number, number] = [6, 7, 8, 9, 10];
      const hashC = computeCommitHash(cardsC, ethers.id("salt-c"));
      await t2.connect(playerC).commitLineup(T2_ID, hashC);

      // Advance to reveal phase
      const tourney = await t2.getTournament(T2_ID);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(tourney.startTime) + 1]);
      await ethers.provider.send("evm_mine", []);

      // Only Player A reveals
      await t2.connect(playerA).revealLineup(T2_ID, cardsA, SALT_A);

      // Set points and compute
      const encrypted = await encryptPoints(SAMPLE_POINTS);
      await t2.setEncryptedPoints(T2_ID, encrypted);
      await t2.computeEncryptedScores(T2_ID);
    });

    it("revealed player A has a score", async function () {
      const scoreA = await t2.getEncryptedUserScore(T2_ID, playerAAddr);
      expect(await getPlaintext(scoreA)).to.equal(5000n);
    });

    it("unrevealed player C has zero score (skipped)", async function () {
      const scoreC = await t2.getEncryptedUserScore(T2_ID, playerCAddr);
      // Score handle should be zero/unset — getPlaintext returns 0
      expect(await getPlaintext(scoreC)).to.equal(0n);
    });
  });

  describe("LineupRevealed event does NOT leak card IDs", function () {
    it("event only contains tournamentId and user address", async function () {
      const iface = tournament.interface;
      const event = iface.getEvent("LineupRevealed");
      expect(event).to.not.be.null;
      // Only 2 indexed params: tournamentId, user — no cardIds
      expect(event!.inputs.length).to.equal(2);
      expect(event!.inputs[0].name).to.equal("tournamentId");
      expect(event!.inputs[1].name).to.equal("user");
    });
  });
});
