// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FHE, euint32, ebool, InEuint32} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

interface IAttentionX_NFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function batchLock(uint256[] calldata tokenIds) external;
    function batchUnlock(uint256[] calldata tokenIds) external;
    function isLocked(uint256 tokenId) external view returns (bool);
    function getCardInfo(uint256 tokenId) external view returns (
        uint256 startupId,
        uint256 edition,
        uint8 rarity,
        uint256 multiplier,
        bool locked,
        string memory name
    );
}

/**
 * @title TournamentManagerFHETestHelper
 * @notice Test-only version with decrypt accessors via hre.cofhe.mocks.
 * @dev In the CoFHE Hardhat plugin, FHE.decrypt is available in mock mode.
 *      This contract MUST NEVER be deployed to production.
 */
contract TournamentManagerFHETestHelper is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    // ============ Constants ============

    uint256 public constant LINEUP_SIZE = 5;
    address public constant SECOND_ADMIN = 0xB36402e87a86206D3a114a98B53f31362291fe1B;
    uint256 public constant TOTAL_STARTUPS = 19;

    // ============ Enums ============

    enum TournamentStatus { Created, Active, Finalized, Cancelled }

    // ============ Structs ============

    struct Tournament {
        uint256 id;
        uint256 registrationStart;
        uint256 startTime;
        uint256 revealDeadline;
        uint256 endTime;
        uint256 prizePool;
        uint256 entryCount;
        TournamentStatus status;
    }

    struct Lineup {
        uint256[5] cardIds;
        address owner;
        uint256 timestamp;
        bool cancelled;
        bool claimed;
    }

    // ============ State ============

    IAttentionX_NFT public nftContract;
    address public packOpener;
    uint256 public nextTournamentId;

    mapping(uint256 => Tournament) public tournaments;
    mapping(uint256 => mapping(address => Lineup)) public lineups;
    mapping(uint256 => address[]) public tournamentParticipants;
    mapping(uint256 => mapping(address => bool)) public hasEntered;

    mapping(uint256 => mapping(uint256 => euint32)) private encryptedPoints;
    mapping(uint256 => mapping(address => euint32)) private encryptedScores;
    mapping(uint256 => euint32) private encryptedTotalScore;
    mapping(uint256 => mapping(address => uint256)) private prizes;
    mapping(uint256 => mapping(address => euint32)) private encryptedRanks;
    mapping(uint256 => bool) public pointsFinalized;
    mapping(uint256 => bool) public scoresComputed;
    mapping(uint256 => mapping(address => bytes32)) public lineupCommitments;
    mapping(uint256 => mapping(address => bool)) public lineupRevealed;
    mapping(uint256 => euint32) private encryptedMultipliers;
    mapping(uint256 => bool) public multiplierSet;

    // ============ Events ============

    event TournamentCreated(uint256 indexed tournamentId, uint256 registrationStart, uint256 startTime, uint256 endTime);
    event LineupRegistered(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds);
    event LineupCommitted(uint256 indexed tournamentId, address indexed user, bytes32 commitHash);
    event LineupRevealed(uint256 indexed tournamentId, address indexed user);
    event LineupCancelled(uint256 indexed tournamentId, address indexed user);
    event EncryptedPointsSet(uint256 indexed tournamentId);
    event ScoresComputed(uint256 indexed tournamentId, uint256 participantCount);
    event TournamentFinalized(uint256 indexed tournamentId, uint256 prizePool, uint256 participantCount);
    event TournamentCancelled(uint256 indexed tournamentId);
    event NFTsUnfrozen(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds);

    // ============ Errors ============

    error TournamentDoesNotExist();
    error TournamentAlreadyFinalized();
    error TournamentCancelledError();
    error InvalidTimeRange();
    error AlreadyEntered();
    error NotCardOwner();
    error CardAlreadyLocked();
    error RegistrationNotOpen();
    error TournamentAlreadyStarted();
    error NotAdmin();
    error PointsAlreadySet();
    error PointsNotSet();
    error ZeroAddress();
    error NotEntered();
    error TournamentNotFinalized();
    error AlreadyClaimed();
    error LineupAlreadyCancelled();
    error WithdrawFailed();
    error CannotCancelAfterStart();
    error CommitmentMissing();
    error InvalidReveal();
    error RevealPeriodNotActive();
    error AlreadyCommitted();

    // ============ Modifiers ============

    modifier onlyAdmin() {
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN) revert NotAdmin();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _nftContract) public initializer {
        if (_nftContract == address(0)) revert ZeroAddress();
        __Ownable_init(msg.sender);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        nftContract = IAttentionX_NFT(_nftContract);
        nextTournamentId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyAdmin {}

    // ============ Core Functions (mirrors TournamentManagerFHE) ============

    function createTournament(
        uint256 registrationStart,
        uint256 startTime,
        uint256 endTime
    ) external onlyAdmin returns (uint256 tournamentId) {
        if (registrationStart >= startTime) revert InvalidTimeRange();
        if (startTime >= endTime) revert InvalidTimeRange();

        tournamentId = nextTournamentId++;
        uint256 revealWindow = (endTime - startTime) / 4;
        if (revealWindow < 1 hours) revealWindow = 1 hours;
        uint256 revealDeadline = startTime + revealWindow;
        if (revealDeadline >= endTime) revealDeadline = endTime;

        tournaments[tournamentId] = Tournament({
            id: tournamentId,
            registrationStart: registrationStart,
            startTime: startTime,
            revealDeadline: revealDeadline,
            endTime: endTime,
            prizePool: 0,
            entryCount: 0,
            status: TournamentStatus.Created
        });
        emit TournamentCreated(tournamentId, registrationStart, startTime, endTime);
    }

    function setEncryptedPoints(
        uint256 tournamentId,
        InEuint32[19] calldata inPoints
    ) external onlyAdmin {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();
        if (pointsFinalized[tournamentId]) revert PointsAlreadySet();

        for (uint256 i = 0; i < TOTAL_STARTUPS; i++) {
            euint32 pts = FHE.asEuint32(inPoints[i]);
            FHE.allowThis(pts);
            encryptedPoints[tournamentId][i + 1] = pts;
        }

        pointsFinalized[tournamentId] = true;
        emit EncryptedPointsSet(tournamentId);
    }

    function commitLineup(uint256 tournamentId, bytes32 commitHash)
        external whenNotPaused
    {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();
        if (block.timestamp < tournament.registrationStart) revert RegistrationNotOpen();
        if (block.timestamp >= tournament.startTime) revert TournamentAlreadyStarted();
        if (hasEntered[tournamentId][msg.sender]) revert AlreadyEntered();

        lineupCommitments[tournamentId][msg.sender] = commitHash;
        hasEntered[tournamentId][msg.sender] = true;
        tournamentParticipants[tournamentId].push(msg.sender);
        tournament.entryCount++;

        emit LineupCommitted(tournamentId, msg.sender, commitHash);
    }

    function revealLineup(
        uint256 tournamentId,
        uint256[5] calldata cardIds,
        bytes32 salt
    ) external whenNotPaused nonReentrant {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (block.timestamp < tournament.startTime) revert RevealPeriodNotActive();
        if (block.timestamp >= tournament.revealDeadline) revert RevealPeriodNotActive();
        if (lineupCommitments[tournamentId][msg.sender] == bytes32(0)) revert CommitmentMissing();
        if (lineupRevealed[tournamentId][msg.sender]) revert AlreadyCommitted();

        bytes32 expected = keccak256(abi.encodePacked(
            cardIds[0], cardIds[1], cardIds[2], cardIds[3], cardIds[4], salt
        ));
        if (expected != lineupCommitments[tournamentId][msg.sender]) revert InvalidReveal();

        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            if (nftContract.ownerOf(cardIds[i]) != msg.sender) revert NotCardOwner();
            if (nftContract.isLocked(cardIds[i])) revert CardAlreadyLocked();
        }

        uint256[] memory tokenIds = new uint256[](LINEUP_SIZE);
        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            tokenIds[i] = cardIds[i];
        }
        nftContract.batchLock(tokenIds);

        lineups[tournamentId][msg.sender] = Lineup({
            cardIds: cardIds,
            owner: msg.sender,
            timestamp: block.timestamp,
            cancelled: false,
            claimed: false
        });

        lineupRevealed[tournamentId][msg.sender] = true;
        emit LineupRevealed(tournamentId, msg.sender);
    }

    function enterTournament(uint256 tournamentId, uint256[5] calldata cardIds)
        external whenNotPaused nonReentrant
    {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();
        if (block.timestamp < tournament.registrationStart) revert RegistrationNotOpen();
        if (block.timestamp >= tournament.endTime) revert TournamentAlreadyStarted();
        if (hasEntered[tournamentId][msg.sender]) revert AlreadyEntered();

        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            if (nftContract.ownerOf(cardIds[i]) != msg.sender) revert NotCardOwner();
            if (nftContract.isLocked(cardIds[i])) revert CardAlreadyLocked();
        }

        uint256[] memory tokenIds = new uint256[](LINEUP_SIZE);
        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            tokenIds[i] = cardIds[i];
        }
        nftContract.batchLock(tokenIds);

        lineups[tournamentId][msg.sender] = Lineup({
            cardIds: cardIds,
            owner: msg.sender,
            timestamp: block.timestamp,
            cancelled: false,
            claimed: false
        });

        hasEntered[tournamentId][msg.sender] = true;
        lineupRevealed[tournamentId][msg.sender] = true;
        tournamentParticipants[tournamentId].push(msg.sender);
        tournament.entryCount++;

        emit LineupRegistered(tournamentId, msg.sender, cardIds);
    }

    function setEncryptedMultipliers(
        uint256[] calldata tokenIds,
        InEuint32[] calldata inMultipliers
    ) external onlyAdmin {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            euint32 mult = FHE.asEuint32(inMultipliers[i]);
            FHE.allowThis(mult);
            encryptedMultipliers[tokenIds[i]] = mult;
            multiplierSet[tokenIds[i]] = true;
        }
    }

    function computeEncryptedScores(uint256 tournamentId) external onlyAdmin {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (!pointsFinalized[tournamentId]) revert PointsNotSet();

        address[] storage participants = tournamentParticipants[tournamentId];
        uint256 participantCount = participants.length;

        euint32 totalScore = FHE.asEuint32(0);
        FHE.allowThis(totalScore);

        for (uint256 i = 0; i < participantCount; i++) {
            address user = participants[i];
            Lineup storage lineup = lineups[tournamentId][user];
            if (lineup.cancelled) continue;

            euint32 userScore = FHE.asEuint32(0);
            FHE.allowThis(userScore);

            for (uint256 j = 0; j < LINEUP_SIZE; j++) {
                uint256 tokenId = lineup.cardIds[j];
                (uint256 startupId, , , uint256 multiplier, , ) = nftContract.getCardInfo(tokenId);

                euint32 multiplierEnc;
                if (multiplierSet[tokenId]) {
                    multiplierEnc = encryptedMultipliers[tokenId];
                } else {
                    multiplierEnc = FHE.asEuint32(uint32(multiplier));
                    FHE.allowThis(multiplierEnc);
                }

                euint32 cardScore = FHE.mul(
                    encryptedPoints[tournamentId][startupId],
                    multiplierEnc
                );
                FHE.allowThis(cardScore);

                userScore = FHE.add(userScore, cardScore);
                FHE.allowThis(userScore);
            }

            FHE.allow(userScore, user);
            encryptedScores[tournamentId][user] = userScore;

            totalScore = FHE.add(totalScore, userScore);
            FHE.allowThis(totalScore);
        }

        encryptedTotalScore[tournamentId] = totalScore;
        emit ScoresComputed(tournamentId, participantCount);
    }

    function computeDarkRanks(
        uint256 tournamentId,
        uint256 batchStart,
        uint256 batchSize
    ) external onlyAdmin {
        if (!pointsFinalized[tournamentId]) revert PointsNotSet();

        address[] storage participants = tournamentParticipants[tournamentId];
        uint256 total = participants.length;
        uint256 end = batchStart + batchSize;
        if (end > total) end = total;

        for (uint256 i = batchStart; i < end; i++) {
            address userA = participants[i];
            Lineup storage lineupA = lineups[tournamentId][userA];
            if (lineupA.cancelled) continue;

            euint32 rank = FHE.asEuint32(1);
            FHE.allowThis(rank);

            for (uint256 j = 0; j < total; j++) {
                if (i == j) continue;
                address userB = participants[j];
                Lineup storage lineupB = lineups[tournamentId][userB];
                if (lineupB.cancelled) continue;

                ebool bIsHigher = FHE.gt(
                    encryptedScores[tournamentId][userB],
                    encryptedScores[tournamentId][userA]
                );
                FHE.allowThis(bIsHigher);

                euint32 one = FHE.asEuint32(1);
                FHE.allowThis(one);
                euint32 zero = FHE.asEuint32(0);
                FHE.allowThis(zero);

                euint32 increment = FHE.select(bIsHigher, one, zero);
                FHE.allowThis(increment);

                rank = FHE.add(rank, increment);
                FHE.allowThis(rank);
            }

            FHE.allow(rank, userA);
            encryptedRanks[tournamentId][userA] = rank;
        }
    }

    // ============ TEST-ONLY: Expose ciphertext handles for mock decryption ============
    // In tests, use hre.cofhe.mocks.expectPlaintext(handle, expectedValue)
    // or hre.cofhe.mocks.getPlaintext(handle) to verify encrypted values.

    function getEncryptedStartupPoints(
        uint256 tournamentId,
        uint256 startupId
    ) external view returns (euint32) {
        return encryptedPoints[tournamentId][startupId];
    }

    function getEncryptedUserScore(
        uint256 tournamentId,
        address user
    ) external view returns (euint32) {
        return encryptedScores[tournamentId][user];
    }

    function getEncryptedTotalScore(
        uint256 tournamentId
    ) external view returns (euint32) {
        return encryptedTotalScore[tournamentId];
    }

    function getEncryptedUserRank(
        uint256 tournamentId,
        address user
    ) external view returns (euint32) {
        return encryptedRanks[tournamentId][user];
    }

    // ============ View helpers ============

    function getTournament(uint256 tournamentId) external view returns (Tournament memory) {
        return tournaments[tournamentId];
    }

    function getUserLineup(uint256 tournamentId, address user) external view returns (
        uint256[5] memory cardIds, address lineupOwner, uint256 timestamp, bool cancelled, bool claimed
    ) {
        Lineup storage lineup = lineups[tournamentId][user];
        return (lineup.cardIds, lineup.owner, lineup.timestamp, lineup.cancelled, lineup.claimed);
    }

    function getTournamentParticipants(uint256 tournamentId) external view returns (address[] memory) {
        return tournamentParticipants[tournamentId];
    }

    function getParticipantCount(uint256 tournamentId) external view returns (uint256) {
        return tournamentParticipants[tournamentId].length;
    }

    receive() external payable {}
}
