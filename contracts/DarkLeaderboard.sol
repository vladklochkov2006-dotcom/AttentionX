// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITournamentManagerFHE {
    function getTournamentParticipants(uint256 tournamentId) external view returns (address[] memory);
    function hasEntered(uint256 tournamentId, address user) external view returns (bool);
}

/**
 * @title DarkLeaderboard
 * @author AttentionX Team
 * @notice A "Dark Leaderboard" where rankings are visible but scores are hidden.
 *         Players can see their own score and rank, but cannot see others' scores.
 *
 * @dev This is a read-only companion to TournamentManagerFHE.
 *      It stores only ranks (uint256) — no FHE types needed here.
 *      All FHE computation happens in TournamentManagerFHE; this contract
 *      only receives the final rank ordering from the admin.
 */
contract DarkLeaderboard {

    ITournamentManagerFHE public tournamentManager;
    address public admin;

    /// @notice Public rank for each player (set by admin after FHE comparison)
    /// Players can see everyone's rank but not the underlying score
    mapping(uint256 => mapping(address => uint256)) public publicRanks;

    /// @notice Whether ranks have been published for a tournament
    mapping(uint256 => bool) public ranksPublished;

    /// @notice Total ranked participants per tournament
    mapping(uint256 => uint256) public rankedCount;

    /// @notice Reverse lookup: rank => address (for displaying leaderboard)
    mapping(uint256 => mapping(uint256 => address)) public rankToPlayer;

    event RanksPublished(uint256 indexed tournamentId, uint256 participantCount);
    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);

    error NotAdmin();
    error RanksAlreadyPublished();
    error InvalidRankData();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _tournamentManager, address _admin) {
        if (_tournamentManager == address(0) || _admin == address(0)) revert ZeroAddress();
        tournamentManager = ITournamentManagerFHE(_tournamentManager);
        admin = _admin;
    }

    /**
     * @notice Publish final ranks after off-chain FHE-based sorting
     * @dev Admin decrypts comparison results off-chain, sorts players,
     *      and submits the final ordering. Ranks are public but scores remain encrypted.
     * @param tournamentId The tournament ID
     * @param rankedPlayers Ordered array of player addresses (index 0 = rank 1)
     */
    function publishRanks(
        uint256 tournamentId,
        address[] calldata rankedPlayers
    ) external onlyAdmin {
        if (ranksPublished[tournamentId]) revert RanksAlreadyPublished();
        if (rankedPlayers.length == 0) revert InvalidRankData();

        for (uint256 i = 0; i < rankedPlayers.length; i++) {
            uint256 rank = i + 1;
            address player = rankedPlayers[i];
            publicRanks[tournamentId][player] = rank;
            rankToPlayer[tournamentId][rank] = player;
        }

        rankedCount[tournamentId] = rankedPlayers.length;
        ranksPublished[tournamentId] = true;

        emit RanksPublished(tournamentId, rankedPlayers.length);
    }

    /**
     * @notice Get the full leaderboard (addresses + ranks, no scores)
     * @param tournamentId The tournament ID
     * @return players Array of player addresses in rank order
     * @return ranks Array of rank numbers (1, 2, 3, ...)
     */
    function getLeaderboard(uint256 tournamentId)
        external view
        returns (address[] memory players, uint256[] memory ranks)
    {
        uint256 count = rankedCount[tournamentId];
        players = new address[](count);
        ranks = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            uint256 rank = i + 1;
            players[i] = rankToPlayer[tournamentId][rank];
            ranks[i] = rank;
        }
    }

    /**
     * @notice Get a page of the leaderboard
     * @param tournamentId The tournament ID
     * @param offset Start rank (0-indexed)
     * @param limit Max results to return
     */
    function getLeaderboardPage(
        uint256 tournamentId,
        uint256 offset,
        uint256 limit
    )
        external view
        returns (address[] memory players, uint256[] memory ranks)
    {
        uint256 count = rankedCount[tournamentId];
        uint256 start = offset;
        if (start >= count) {
            return (new address[](0), new uint256[](0));
        }

        uint256 end = start + limit;
        if (end > count) end = count;
        uint256 size = end - start;

        players = new address[](size);
        ranks = new uint256[](size);

        for (uint256 i = 0; i < size; i++) {
            uint256 rank = start + i + 1;
            players[i] = rankToPlayer[tournamentId][rank];
            ranks[i] = rank;
        }
    }

    /**
     * @notice Get a player's public rank
     * @param tournamentId The tournament ID
     * @param player The player address
     * @return rank The player's rank (0 if not ranked)
     */
    function getPlayerRank(uint256 tournamentId, address player)
        external view returns (uint256 rank)
    {
        return publicRanks[tournamentId][player];
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address old = admin;
        admin = newAdmin;
        emit AdminUpdated(old, newAdmin);
    }
}
