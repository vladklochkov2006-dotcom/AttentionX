// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
 * @title TournamentManager
 * @author AttentionX Team
 * @notice Manage weekly tournaments with registration period, NFT freeze, and prize distribution (UUPS upgradeable)
 */
contract TournamentManager is Initializable, Ownable2StepUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {

    // ============ Constants ============

    uint256 public constant LINEUP_SIZE = 5;
    address public constant SECOND_ADMIN = 0xB36402e87a86206D3a114a98B53f31362291fe1B;
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
    mapping(uint256 => mapping(address => uint256)) public prizes;
    mapping(uint256 => address[]) public tournamentParticipants;
    mapping(uint256 => mapping(address => bool)) public hasEntered;
    mapping(uint256 => mapping(uint256 => uint256)) public tournamentPoints;
    mapping(uint256 => mapping(address => uint256)) public userScores;
    mapping(uint256 => uint256) public totalTournamentScore;

    // ============ Events ============

    event TournamentCreated(uint256 indexed tournamentId, uint256 registrationStart, uint256 startTime, uint256 endTime);
    event TournamentUpdated(uint256 indexed tournamentId, uint256 newStartTime, uint256 newEndTime);
    event LineupRegistered(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds);
    event LineupCancelled(uint256 indexed tournamentId, address indexed user);
    event TournamentStarted(uint256 indexed tournamentId);
    event TournamentFinalized(uint256 indexed tournamentId, uint256 prizePool, uint256 winnersCount);
    event TournamentCancelled(uint256 indexed tournamentId);
    event PrizeClaimed(uint256 indexed tournamentId, address indexed user, uint256 prizeAmount);
    event NFTsUnfrozen(uint256 indexed tournamentId, address indexed user, uint256[5] cardIds);
    event PrizePoolIncreased(uint256 indexed tournamentId, uint256 amount, uint256 newTotal);
    event PackOpenerUpdated(address indexed oldPackOpener, address indexed newPackOpener);

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
    error ArrayLengthMismatch();
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

    // ============ Modifiers ============

    modifier onlyAdmin() {
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN) revert NotAdmin();
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

        tournaments[tournamentId] = Tournament({
            id: tournamentId,
            registrationStart: registrationStart,
            startTime: startTime,
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
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN && msg.sender != packOpener) revert UnauthorizedCaller();

        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();

        tournament.prizePool += msg.value;
        emit PrizePoolIncreased(tournamentId, msg.value, tournament.prizePool);
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

    function finalizeTournament(
        uint256 tournamentId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external onlyAdmin nonReentrant {
        if (winners.length != amounts.length) revert ArrayLengthMismatch();

        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();

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

        emit TournamentFinalized(tournamentId, tournament.prizePool, winners.length);
    }

    function finalizeWithPoints(
        uint256 tournamentId,
        uint256[19] calldata points
    ) external onlyAdmin nonReentrant {
        Tournament storage tournament = tournaments[tournamentId];
        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (tournament.status == TournamentStatus.Finalized) revert TournamentAlreadyFinalized();
        if (tournament.status == TournamentStatus.Cancelled) revert TournamentCancelledError();

        for (uint256 i = 0; i < TOTAL_STARTUPS; i++) {
            tournamentPoints[tournamentId][i + 1] = points[i];
        }

        address[] storage participants = tournamentParticipants[tournamentId];
        uint256 participantCount = participants.length;
        uint256 totalScore = 0;

        for (uint256 i = 0; i < participantCount; i++) {
            address user = participants[i];
            Lineup storage lineup = lineups[tournamentId][user];

            if (lineup.cancelled) continue;

            uint256 userScore = 0;

            for (uint256 j = 0; j < LINEUP_SIZE; j++) {
                uint256 tokenId = lineup.cardIds[j];
                (uint256 startupId, , , uint256 multiplier, , ) = nftContract.getCardInfo(tokenId);

                uint256 cardPoints = tournamentPoints[tournamentId][startupId];
                unchecked {
                    userScore += cardPoints * multiplier;
                }
            }

            userScores[tournamentId][user] = userScore;
            unchecked {
                totalScore += userScore;
            }
        }

        totalTournamentScore[tournamentId] = totalScore;

        if (totalScore > 0) {
            uint256 prizePool = tournament.prizePool;

            for (uint256 i = 0; i < participantCount; i++) {
                address user = participants[i];
                uint256 score = userScores[tournamentId][user];

                if (score > 0) {
                    uint256 prize = (score * prizePool) / totalScore;
                    prizes[tournamentId][user] = prize;
                }
            }
        }

        tournament.status = TournamentStatus.Finalized;

        for (uint256 i = 0; i < participantCount; i++) {
            _unfreezeLineup(tournamentId, participants[i]);
        }

        emit TournamentFinalized(tournamentId, tournament.prizePool, participantCount);
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

    function emergencyWithdraw(uint256 amount, address to) external onlyAdmin nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        // Zero out prizePool for all tournaments to keep state consistent
        for (uint256 i = 0; i < nextTournamentId; i++) {
            if (tournaments[i].prizePool > 0) {
                tournaments[i].prizePool = 0;
            }
        }
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert WithdrawFailed();
    }

    function pause() external onlyAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

    // ============ User Functions ============

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
        tournamentParticipants[tournamentId].push(msg.sender);
        tournament.entryCount++;

        emit LineupRegistered(tournamentId, msg.sender, cardIds);
    }

    function cancelEntry(uint256 tournamentId) external nonReentrant {
        Tournament storage tournament = tournaments[tournamentId];
        Lineup storage lineup = lineups[tournamentId][msg.sender];

        if (tournament.id == 0) revert TournamentDoesNotExist();
        if (!hasEntered[tournamentId][msg.sender]) revert NotEntered();
        if (lineup.cancelled) revert LineupAlreadyCancelled();
        if (block.timestamp >= tournament.startTime) revert CannotCancelAfterStart();

        lineup.cancelled = true;
        tournament.entryCount--;

        uint256[] memory tokenIds = new uint256[](LINEUP_SIZE);
        for (uint256 i = 0; i < LINEUP_SIZE; i++) {
            tokenIds[i] = lineup.cardIds[i];
        }
        nftContract.batchUnlock(tokenIds);

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
            emit PrizeClaimed(tournamentId, msg.sender, prizeAmount);
        }
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

    // ============ View Functions ============

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

    function getUserPrize(uint256 tournamentId, address user) external view returns (uint256) {
        return prizes[tournamentId][user];
    }

    function getUserScoreInfo(uint256 tournamentId, address user) external view returns (
        uint256 score, uint256 prize, uint256 totalScore
    ) {
        return (
            userScores[tournamentId][user],
            prizes[tournamentId][user],
            totalTournamentScore[tournamentId]
        );
    }

    function getTournamentPoints(uint256 tournamentId) external view returns (uint256[19] memory points) {
        for (uint256 i = 0; i < TOTAL_STARTUPS; i++) {
            points[i] = tournamentPoints[tournamentId][i + 1];
        }
        return points;
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
        if (block.timestamp < tournament.endTime) return "Active";
        return "Ended";
    }

    // ============ Batch View Functions (added in upgrade v2) ============

    /// @notice Returns summary of all tournaments the user participated in
    struct UserTournamentInfo {
        uint256 tournamentId;
        uint256 startTime;
        uint256 endTime;
        uint256 prizePool;
        uint256 entryCount;
        TournamentStatus status;
        uint256 userScore;
        uint256 userPrize;
        bool claimed;
    }

    function getUserTournamentHistory(address user) external view returns (UserTournamentInfo[] memory) {
        // Count how many tournaments user entered
        uint256 count = 0;
        for (uint256 i = 1; i < nextTournamentId; i++) {
            if (hasEntered[i][user] && !lineups[i][user].cancelled) {
                count++;
            }
        }

        UserTournamentInfo[] memory result = new UserTournamentInfo[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i < nextTournamentId; i++) {
            if (hasEntered[i][user] && !lineups[i][user].cancelled) {
                Tournament storage t = tournaments[i];
                result[idx] = UserTournamentInfo({
                    tournamentId: i,
                    startTime: t.startTime,
                    endTime: t.endTime,
                    prizePool: t.prizePool,
                    entryCount: t.entryCount,
                    status: t.status,
                    userScore: userScores[i][user],
                    userPrize: prizes[i][user],
                    claimed: lineups[i][user].claimed
                });
                idx++;
            }
        }
        return result;
    }

    /// @notice Returns summary of all tournaments (for history page)
    struct TournamentSummary {
        uint256 id;
        uint256 registrationStart;
        uint256 startTime;
        uint256 endTime;
        uint256 prizePool;
        uint256 entryCount;
        TournamentStatus status;
    }

    function getAllTournamentsSummary() external view returns (TournamentSummary[] memory) {
        uint256 count = nextTournamentId > 1 ? nextTournamentId - 1 : 0;
        TournamentSummary[] memory result = new TournamentSummary[](count);
        for (uint256 i = 1; i <= count; i++) {
            Tournament storage t = tournaments[i];
            result[i - 1] = TournamentSummary({
                id: t.id,
                registrationStart: t.registrationStart,
                startTime: t.startTime,
                endTime: t.endTime,
                prizePool: t.prizePool,
                entryCount: t.entryCount,
                status: t.status
            });
        }
        return result;
    }

    // ============ Receive ============

    receive() external payable {}
}
