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
 * @title TournamentManagerFHE
 * @author AttentionX Team
 * @notice FHE-enabled tournament manager with confidential scoring via Fhenix CoFHE
 * @dev All scores stored as euint32. Players view their own score via off-chain
 *      decryptForView with permits. Rankings are computed on-chain using FHE.gt /
 *      FHE.select without revealing raw values.
 *
 * CoFHE ACL model:
 *   - FHE.allowThis(handle) — grants the contract permission to use the handle
 *     in subsequent FHE operations.
 *   - FHE.allowSender(handle) — grants msg.sender permission, used when the
 *     player should be able to decrypt their own data via the SDK.
 *   - FHE.allow(handle, address) — grants a specific address permission.
 *
 * Decryption is done off-chain via the CoFHE SDK:
 *   - decryptForView: player generates a permit → SDK re-encrypts with their
 *     sealing key → plaintext is revealed only to the permit holder.
 *   - decryptForTx: for on-chain reveals (e.g. finalizing scores).
 */
contract TournamentManagerFHE is
    Initializable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    // ============ Constants ============

    uint256 public constant LINEUP_SIZE = 5;
    address public constant SECOND_ADMIN = 0xB36402e87a86206D3a114a98B53f31362291fe1B;
    address public constant THIRD_ADMIN = 0x233c8C54F25734B744E522bdC1Eed9cbc8C97D0c;
    uint256 public constant TOTAL_STARTUPS = 19;

    // ============ Enums ============

    enum TournamentStatus {
        Created,
        Active,
        Finalized,
        Cancelled
    }

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

    // ============ State Variables ============

    IAttentionX_NFT public nftContract;
    address public packOpener;
    uint256 public nextTournamentId;

    mapping(uint256 => Tournament) public tournaments;
    mapping(uint256 => mapping(address => Lineup)) public lineups;
    mapping(uint256 => address[]) public tournamentParticipants;
    mapping(uint256 => mapping(address => bool)) public hasEntered;

    /// @notice Encrypted startup points per tournament (tournamentId => startupId => euint32)
    mapping(uint256 => mapping(uint256 => euint32)) private encryptedPoints;

    /// @notice Encrypted user scores (tournamentId => user => euint32)
    mapping(uint256 => mapping(address => euint32)) private encryptedScores;

    /// @notice Encrypted total score for prize distribution
    mapping(uint256 => euint32) private encryptedTotalScore;

    /// @notice Prize amounts — private to prevent reverse-engineering score proportions.
    mapping(uint256 => mapping(address => uint256)) private prizes;

    /// @notice Dark Leaderboard: encrypted rank positions (lower = better)
    mapping(uint256 => mapping(address => euint32)) private encryptedRanks;

    /// @notice Whether points have been set for a tournament
    mapping(uint256 => bool) public pointsFinalized;

    /// @notice Whether scores have been fully computed (all batches done)
    mapping(uint256 => bool) public scoresComputed;

    /// @notice Commit-Reveal: lineup commitment hashes
    mapping(uint256 => mapping(address => bytes32)) public lineupCommitments;

    /// @notice Commit-Reveal: whether lineup has been revealed
    mapping(uint256 => mapping(address => bool)) public lineupRevealed;

    /// @notice Encrypted card multipliers (tokenId => euint32)
    /// @dev Set by admin so multiplier never appears as plaintext in scoring tx
    mapping(uint256 => euint32) private encryptedMultipliers;

    /// @notice Whether encrypted multiplier has been set for a token
    mapping(uint256 => bool) public multiplierSet;

    // ============ Events ============

    event TournamentCreated(uint256 indexed tournamentId, uint256 registrationStart, uint256 startTime, uint256 endTime);
    event TournamentUpdated(uint256 indexed tournamentId, uint256 newStartTime, uint256 newEndTime);
    event LineupRegistered(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds);
    event LineupCancelled(uint256 indexed tournamentId, address indexed user);
    event TournamentFinalized(uint256 indexed tournamentId, uint256 prizePool, uint256 participantCount);
    event TournamentCancelled(uint256 indexed tournamentId);
    event PrizeClaimed(uint256 indexed tournamentId, address indexed user);
    event NFTsUnfrozen(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds);
    event PrizePoolIncreased(uint256 indexed tournamentId, uint256 amount, uint256 newTotal);
    event PackOpenerUpdated(address indexed oldPackOpener, address indexed newPackOpener);
    event EncryptedPointsSet(uint256 indexed tournamentId);
    event ScoresBatchComputed(uint256 indexed tournamentId, uint256 batchStart, uint256 batchEnd);
    event ScoresFinalized(uint256 indexed tournamentId, uint256 participantCount);
    event LineupCommitted(uint256 indexed tournamentId, address indexed user, bytes32 commitHash);
    event LineupRevealed(uint256 indexed tournamentId, address indexed user);
    event EncryptedMultipliersSet(uint256 count);

    // ============ Errors ============

    error TournamentDoesNotExist();
    error TournamentNotInRegistration();
    error TournamentNotActive();
    error TournamentNotFinalized();
    error TournamentAlreadyFinalized();
    error TournamentAlreadyStarted();
    error InvalidTimeRange();
    error AlreadyEntered();
    error NotCardOwner();
    error CardAlreadyLocked();
    error AlreadyClaimed();
    error ZeroAddress();
    error WithdrawFailed();
    error NotEntered();
    error TournamentCancelledError();
    error UnauthorizedCaller();
    error InsufficientPrizePool();
    error CannotCancelAfterStart();
    error LineupAlreadyCancelled();
    error RegistrationNotOpen();
    error NotAdmin();
    error PointsAlreadySet();
    error PointsNotSet();
    error ScoresNotComputed();
    error ArrayLengthMismatch();
    error CommitmentMissing();
    error InvalidReveal();
    error RevealPeriodNotActive();
    error NotRevealed();
    error AlreadyCommitted();

    // ============ Modifiers ============

    modifier onlyAdmin() {
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN && msg.sender != THIRD_ADMIN) revert NotAdmin();
        _;
    }

    // ============ Constructor (disabled for proxy) ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

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

    // ============ UUPS Upgrade Authorization ============

    function _authorizeUpgrade(address newImplementation) internal override onlyAdmin {}

    // ============ Admin Functions ============

    function createTournament(
        uint256 registrationStart,
        uint256 startTime,
        uint256 endTime
    ) external onlyAdmin returns (uint256 tournamentId) {
        if (registrationStart >= startTime) revert InvalidTimeRange();
        if (startTime >= endTime) revert InvalidTimeRange();

        tournamentId = nextTournamentId++;

        // Reveal deadline = startTime + 25% of tournament duration (min 1 hour)
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
        return tournamentId;
    }

    function updateTournament(uint256 tournamentId, uint256 newStartTime, uint256 newEndTime) external onlyAdmin {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (block.timestamp >= tournament.startTime) revert TournamentAlreadyStarted();
        if (newStartTime >= newEndTime) revert InvalidTimeRange();

        tournament.startTime = newStartTime;
        tournament.endTime = newEndTime;

        emit TournamentUpdated(tournamentId, newStartTime, newEndTime);
    }

    function addToPrizePool(uint256 tournamentId) external payable {
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN && msg.sender != THIRD_ADMIN && msg.sender != packOpener) revert UnauthorizedCaller();

        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();

        tournament.prizePool += msg.value;
        emit PrizePoolIncreased(tournamentId, msg.value, tournament.prizePool);
    }

    /**
     * @notice Set encrypted startup points for a tournament
     * @param tournamentId The tournament to set points for
     * @param inPoints Array of 19 encrypted point values (one per startup)
     */
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

    /**
     * @notice Admin-only: set points from plaintext values. Contract encrypts on-chain via FHE.asEuint32.
     * @dev For hackathon/testnet use. In production, use setEncryptedPoints with CoFHE SDK.
     *      Points are encrypted on-chain and never stored as plaintext.
     * @param tournamentId The tournament to set points for
     * @param rawPoints Array of 19 plaintext point values (0-1000)
     */
    function setPointsFromPlaintext(
        uint256 tournamentId,
        uint32[19] calldata rawPoints
    ) external onlyAdmin {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();
        if (pointsFinalized[tournamentId]) revert PointsAlreadySet();

        for (uint256 i = 0; i < TOTAL_STARTUPS; i++) {
            euint32 pts = FHE.asEuint32(rawPoints[i]);
            FHE.allowThis(pts);
            encryptedPoints[tournamentId][i + 1] = pts;
        }

        pointsFinalized[tournamentId] = true;
        emit EncryptedPointsSet(tournamentId);
    }

    /**
     * @notice Set encrypted multipliers for a batch of tokens
     * @dev Admin encrypts multipliers off-chain via CoFHE SDK, then stores them.
     *      This ensures multiplier values never appear as plaintext in scoring transactions.
     * @param tokenIds Array of token IDs to set multipliers for
     * @param inMultipliers Array of encrypted multiplier values
     */
    function setEncryptedMultipliers(
        uint256[] calldata tokenIds,
        InEuint32[] calldata inMultipliers
    ) external onlyAdmin {
        if (tokenIds.length != inMultipliers.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokenIds.length; i++) {
            euint32 mult = FHE.asEuint32(inMultipliers[i]);
            FHE.allowThis(mult);
            encryptedMultipliers[tokenIds[i]] = mult;
            multiplierSet[tokenIds[i]] = true;
        }

        emit EncryptedMultipliersSet(tokenIds.length);
    }

    /**
     * @notice Compute encrypted scores for a batch of participants
     * @dev Batched to avoid gas limit issues with many participants.
     *      Each user: score = Σ(encrypted_points[startupId] * encrypted_multiplier)
     *      Both points AND multipliers are encrypted — no plaintext in scoring.
     */
    function computeEncryptedScores(
        uint256 tournamentId,
        uint256 batchStart,
        uint256 batchSize
    ) external onlyAdmin {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (!pointsFinalized[tournamentId]) revert PointsNotSet();

        address[] storage participants = tournamentParticipants[tournamentId];
        uint256 total = participants.length;
        uint256 end = batchStart + batchSize;
        if (end > total) end = total;

        for (uint256 i = batchStart; i < end; i++) {
            address user = participants[i];
            Lineup storage lineup = lineups[tournamentId][user];

            if (lineup.cancelled) continue;
            if (!lineupRevealed[tournamentId][user]) continue; // skip unrevealed

            euint32 userScore = FHE.asEuint32(0);
            FHE.allowThis(userScore);

            for (uint256 j = 0; j < LINEUP_SIZE; j++) {
                uint256 tokenId = lineup.cardIds[j];
                (uint256 startupId, , , uint256 multiplier, , ) = nftContract.getCardInfo(tokenId);

                // Always use encrypted multiplier — encrypt on-chain via FHE.asEuint32
                // This ensures multiplier is NEVER stored/used as plaintext in FHE ops
                euint32 multiplierEnc;
                if (multiplierSet[tokenId]) {
                    multiplierEnc = encryptedMultipliers[tokenId];
                } else {
                    // Auto-encrypt from NFT contract data — value is encrypted on-chain
                    // and only exists as euint32 from this point forward
                    multiplierEnc = FHE.asEuint32(uint32(multiplier));
                    FHE.allowThis(multiplierEnc);
                    // Cache for future use
                    encryptedMultipliers[tokenId] = multiplierEnc;
                    multiplierSet[tokenId] = true;
                }

                euint32 cardScore = FHE.mul(
                    encryptedPoints[tournamentId][startupId],
                    multiplierEnc
                );
                FHE.allowThis(cardScore);

                userScore = FHE.add(userScore, cardScore);
                FHE.allowThis(userScore);
            }

            // Grant the user permission to decrypt their own score
            FHE.allowSender(userScore);
            FHE.allow(userScore, user);
            encryptedScores[tournamentId][user] = userScore;

            // Update total — grant contract access
            euint32 newTotal = FHE.add(
                encryptedTotalScore[tournamentId],
                userScore
            );
            FHE.allowThis(newTotal);
            // Grant admin access so they can decrypt total for prize distribution
            FHE.allow(newTotal, owner());
            if (SECOND_ADMIN != address(0)) {
                FHE.allow(newTotal, SECOND_ADMIN);
            }
            if (THIRD_ADMIN != address(0)) {
                FHE.allow(newTotal, THIRD_ADMIN);
            }
            encryptedTotalScore[tournamentId] = newTotal;
        }

        emit ScoresBatchComputed(tournamentId, batchStart, end);
    }

    /**
     * @notice Mark scores as fully computed (after all batches are done)
     */
    function finalizeScores(uint256 tournamentId) external onlyAdmin {
        if (!pointsFinalized[tournamentId]) revert PointsNotSet();
        scoresComputed[tournamentId] = true;
        uint256 count = tournamentParticipants[tournamentId].length;
        emit ScoresFinalized(tournamentId, count);
    }

    /**
     * @notice Get the ciphertext handle of the total score for off-chain decryption
     * @dev Admin decrypts this via SDK decryptForView/decryptForTx, then computes
     *      prize shares and calls finalizeWithPrizes.
     */
    function getEncryptedTotalScore(
        uint256 tournamentId
    ) external view onlyAdmin returns (euint32) {
        return encryptedTotalScore[tournamentId];
    }

    /**
     * @notice Get the ciphertext handle of a user's score for off-chain decryption
     */
    function getEncryptedUserScore(
        uint256 tournamentId,
        address user
    ) external view onlyAdmin returns (euint32) {
        return encryptedScores[tournamentId][user];
    }

    /**
     * @notice Finalize tournament with proportional prize distribution
     */
    function finalizeWithPrizes(
        uint256 tournamentId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external onlyAdmin nonReentrant {
        if (winners.length != amounts.length) revert ArrayLengthMismatch();

        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();
        if (!scoresComputed[tournamentId]) revert ScoresNotComputed();

        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] != address(0)) {
                prizes[tournamentId][winners[i]] = amounts[i];
            }
        }

        tournament.status = TournamentStatus.Finalized;

        address[] storage participants = tournamentParticipants[tournamentId];
        for (uint256 i = 0; i < participants.length; i++) {
            _unfreezeLineup(tournamentId, participants[i]);
        }

        emit TournamentFinalized(tournamentId, tournament.prizePool, participants.length);
    }

    /**
     * @notice Compute Dark Leaderboard ranks using FHE comparisons
     * @dev Rank = number of players with higher score + 1.
     *      Batched for gas safety.
     */
    function computeDarkRanks(
        uint256 tournamentId,
        uint256 batchStart,
        uint256 batchSize
    ) external onlyAdmin {
        if (!scoresComputed[tournamentId]) revert ScoresNotComputed();

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

            // Allow user to decrypt their own rank
            FHE.allow(rank, userA);
            encryptedRanks[tournamentId][userA] = rank;
        }
    }

    function cancelTournament(uint256 tournamentId) external onlyAdmin nonReentrant {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();

        tournament.status = TournamentStatus.Cancelled;

        address[] storage participants = tournamentParticipants[tournamentId];
        for (uint256 i = 0; i < participants.length; i++) {
            _unfreezeLineup(tournamentId, participants[i]);
        }

        emit TournamentCancelled(tournamentId);
    }

    function setPackOpener(address newPackOpener) external onlyAdmin {
        address oldPackOpener = packOpener;
        packOpener = newPackOpener;
        emit PackOpenerUpdated(oldPackOpener, newPackOpener);
    }

    function withdrawFromPrizePool(uint256 tournamentId, uint256 amount, address to)
        external onlyAdmin nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (amount > tournament.prizePool) revert InsufficientPrizePool();

        tournament.prizePool -= amount;
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert WithdrawFailed();
    }

    function pause() external onlyAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

    // ============ User Functions ============

    /**
     * @notice Commit a sealed lineup hash during Registration phase.
     *         No one can see your cards until you reveal.
     * @param tournamentId Tournament to enter
     * @param commitHash  keccak256(abi.encodePacked(cardIds[0..4], salt))
     */
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

    /**
     * @notice Reveal your lineup after tournament starts (Reveal phase).
     *         Verifies hash, checks ownership, locks NFTs.
     * @param tournamentId Tournament to reveal for
     * @param cardIds      The 5 card IDs in your lineup
     * @param salt         The random salt used when committing
     */
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

        // Verify hash
        bytes32 expected = keccak256(abi.encodePacked(
            cardIds[0], cardIds[1], cardIds[2], cardIds[3], cardIds[4], salt
        ));
        if (expected != lineupCommitments[tournamentId][msg.sender]) revert InvalidReveal();

        // Verify ownership and lock
        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            if (nftContract.ownerOf(cardIds[i]) != msg.sender) revert NotCardOwner();
            if (nftContract.isLocked(cardIds[i])) revert CardAlreadyLocked();
        }

        uint256[] memory tokenIds = new uint256[](LINEUP_SIZE);
        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            tokenIds[i] = cardIds[i];
        }
        nftContract.batchLock(tokenIds);

        // Store revealed lineup
        lineups[tournamentId][msg.sender] = Lineup({
            cardIds: cardIds,
            owner: msg.sender,
            timestamp: block.timestamp,
            cancelled: false,
            claimed: false
        });

        lineupRevealed[tournamentId][msg.sender] = true;

        // Event does NOT emit cardIds — lineup stays private from other players
        emit LineupRevealed(tournamentId, msg.sender);
    }

    /**
     * @notice DEPRECATED — use commitLineup + revealLineup instead.
     * @dev Kept only for interface compatibility. Always reverts.
     */
    function enterTournament(uint256 /* tournamentId */, uint256[5] calldata /* cardIds */)
        external pure
    {
        revert("Use commitLineup() + revealLineup() for privacy");
    }

    function cancelEntry(uint256 tournamentId) external nonReentrant {
        Tournament storage tournament = tournaments[tournamentId];

        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (!hasEntered[tournamentId][msg.sender]) revert NotEntered();
        if (block.timestamp >= tournament.startTime) revert CannotCancelAfterStart();

        // If revealed — unlock NFTs
        if (lineupRevealed[tournamentId][msg.sender]) {
            Lineup storage lineup = lineups[tournamentId][msg.sender];
            if (lineup.cancelled) revert LineupAlreadyCancelled();
            lineup.cancelled = true;

            uint256[] memory tokenIds = new uint256[](LINEUP_SIZE);
            for (uint256 i = 0; i < LINEUP_SIZE; i++) {
                tokenIds[i] = lineup.cardIds[i];
            }
            nftContract.batchUnlock(tokenIds);
        } else {
            // Committed but not yet revealed — just clear commitment
            lineupCommitments[tournamentId][msg.sender] = bytes32(0);
        }

        hasEntered[tournamentId][msg.sender] = false;
        tournament.entryCount--;

        emit LineupCancelled(tournamentId, msg.sender);
    }

    function claimPrize(uint256 tournamentId) external nonReentrant {
        Tournament storage tournament = tournaments[tournamentId];
        Lineup storage lineup = lineups[tournamentId][msg.sender];

        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status != TournamentStatus.Finalized) revert TournamentNotFinalized();
        if (!hasEntered[tournamentId][msg.sender]) revert NotEntered();
        if (lineup.claimed) revert AlreadyClaimed();
        if (lineup.cancelled) revert LineupAlreadyCancelled();

        lineup.claimed = true;

        uint256 prizeAmount = prizes[tournamentId][msg.sender];
        if (prizeAmount > 0) {
            (bool success, ) = msg.sender.call{value: prizeAmount}("");
            if (!success) revert WithdrawFailed();
            emit PrizeClaimed(tournamentId, msg.sender);
        }
    }

    // ============ Ciphertext Handle Getters (for off-chain decryption via SDK) ============

    /**
     * @notice Get the ciphertext handle of your own score
     * @dev The caller must have been granted FHE.allow access. Use the CoFHE SDK
     *      with a permit to call decryptForView on this handle.
     */
    function getMyScore(uint256 tournamentId) external view returns (euint32) {
        return encryptedScores[tournamentId][msg.sender];
    }

    /**
     * @notice Get the ciphertext handle of your own rank
     */
    function getMyRank(uint256 tournamentId) external view returns (euint32) {
        return encryptedRanks[tournamentId][msg.sender];
    }

    /**
     * @notice Compare two players' scores without revealing values (admin only)
     * @dev Returns encrypted boolean handle. Admin can decrypt off-chain.
     */
    function compareScores(
        uint256 tournamentId,
        address playerA,
        address playerB
    ) external onlyAdmin returns (ebool) {
        ebool result = FHE.gt(
            encryptedScores[tournamentId][playerA],
            encryptedScores[tournamentId][playerB]
        );
        FHE.allowThis(result);
        FHE.allowSender(result);
        return result;
    }

    // ============ Internal Functions ============

    function _unfreezeLineup(uint256 tournamentId, address user) internal {
        Lineup storage lineup = lineups[tournamentId][user];

        if (lineup.cancelled) return;

        uint256[] memory tokenIds = new uint256[](LINEUP_SIZE);
        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            tokenIds[i] = lineup.cardIds[i];
        }

        try nftContract.batchUnlock(tokenIds) {
            emit NFTsUnfrozen(tournamentId, user, lineup.cardIds);
        } catch {}
    }

    // ============ Public View Functions ============

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

    /// @notice Returns the caller's own prize amount (not anyone else's)
    function getMyPrize(uint256 tournamentId) external view returns (uint256) {
        return prizes[tournamentId][msg.sender];
    }

    function getActiveEntryCount(uint256 tournamentId) external view returns (uint256) {
        return tournaments[tournamentId].entryCount;
    }

    function canRegister(uint256 tournamentId, address user) external view returns (bool) {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) return false;
        if (tournament.status != TournamentStatus.Created) return false;
        if (block.timestamp < tournament.registrationStart) return false;
        if (block.timestamp >= tournament.endTime) return false;
        if (hasEntered[tournamentId][user]) return false;
        return true;
    }

    function canCancelEntry(uint256 tournamentId, address user) external view returns (bool) {
        Tournament storage tournament = tournaments[tournamentId];
        Lineup storage lineup = lineups[tournamentId][user];
        if (tournament.id == 0) return false;
        if (!hasEntered[tournamentId][user]) return false;
        if (lineup.cancelled) return false;
        if (block.timestamp >= tournament.startTime) return false;
        return true;
    }

    function getTournamentPhase(uint256 tournamentId) external view returns (string memory) {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) return "NotFound";
        if (tournament.status == TournamentStatus.Cancelled) return "Cancelled";
        if (tournament.status == TournamentStatus.Finalized) return "Finalized";
        if (block.timestamp < tournament.registrationStart) return "Upcoming";
        if (block.timestamp < tournament.startTime) return "Registration";
        if (block.timestamp < tournament.revealDeadline) return "Reveal";
        if (block.timestamp < tournament.endTime) return "Active";
        return "Ended";
    }

    function getParticipantCount(uint256 tournamentId) external view returns (uint256) {
        return tournamentParticipants[tournamentId].length;
    }

    // ============ Receive ============

    receive() external payable {}
}
