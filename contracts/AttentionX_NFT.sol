// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title AttentionX_NFT
 * @author AttentionX Team
 * @notice Main ERC-721 NFT contract for AttentionX startup cards (UUPS upgradeable)
 * @dev Implements 19 startup cards with 5 rarity tiers, lock mechanism for tournaments,
 *      and ERC-2981 royalty standard (2% royalty)
 */
contract AttentionX_NFT is
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC2981Upgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{

    // ============ Constants ============

    /// @notice Maximum supply of NFTs
    uint256 public constant MAX_SUPPLY = 50000;

    /// @notice Total number of startup types
    uint256 public constant TOTAL_STARTUPS = 19;

    /// @notice Royalty fee in basis points (2% = 200)
    uint96 public constant ROYALTY_FEE = 200;

    /// @notice Hardcoded royalty receiver address
    address public constant ROYALTY_RECEIVER = 0x233c8C54F25734B744E522bdC1Eed9cbc8C97D0c;

    /// @notice Hardcoded second admin address
    address public constant SECOND_ADMIN = 0xB36402e87a86206D3a114a98B53f31362291fe1B;

    // ============ Rarity Enums ============

    enum Rarity {
        Common,      // 1x multiplier
        Rare,        // 3x multiplier
        Epic,        // 5x multiplier
        EpicRare,    // 8x multiplier
        Legendary    // 10x multiplier
    }

    // ============ Structs ============

    struct StartupInfo {
        string name;
        Rarity rarity;
        uint256 multiplier;
    }

    struct CardInfo {
        uint256 startupId;
        uint256 edition;
        Rarity rarity;
        uint256 multiplier;
        bool isLocked;
        string name;
    }

    // ============ State Variables ============

    /// @notice Base URI for token metadata
    string public baseURI;

    /// @notice Next token ID to mint
    uint256 private _nextTokenId;

    /// @notice Maps tokenId to startupId (1-20)
    mapping(uint256 => uint256) public tokenToStartup;

    /// @notice Maps tokenId to edition number within that startup
    mapping(uint256 => uint256) public tokenToEdition;

    /// @notice Maps tokenId to lock status (locked in tournament)
    mapping(uint256 => bool) public isLocked;

    /// @notice Tracks mint count per startup type
    mapping(uint256 => uint256) public startupMintCount;

    /// @notice Authorized addresses that can mint (PackOpener)
    mapping(address => bool) public authorizedMinters;

    /// @notice Authorized addresses that can lock/unlock (TournamentManager)
    mapping(address => bool) public authorizedLockers;

    /// @notice Startup information by ID (1-20)
    mapping(uint256 => StartupInfo) public startups;

    // ============ Events ============

    event CardMinted(
        address indexed to,
        uint256 indexed tokenId,
        uint256 indexed startupId,
        uint256 edition
    );

    event CardLocked(uint256 indexed tokenId, address indexed locker);
    event CardUnlocked(uint256 indexed tokenId, address indexed unlocker);
    event CardsLockedBatch(uint256[] tokenIds, address indexed locker);
    event CardsUnlockedBatch(uint256[] tokenIds, address indexed unlocker);
    event AuthorizedMinterSet(address indexed minter, bool authorized);
    event AuthorizedLockerSet(address indexed locker, bool authorized);
    event BaseURIUpdated(string newBaseURI);
    event CardsMerged(
        address indexed owner,
        uint256[3] burnedTokenIds,
        uint256 indexed newTokenId,
        Rarity fromRarity,
        Rarity toRarity
    );

    // ============ Errors ============

    error MaxSupplyReached();
    error InvalidStartupId();
    error NotAuthorizedMinter();
    error NotAuthorizedLocker();
    error CardIsLocked();
    error CardNotLocked();
    error ZeroAddress();
    error ArrayLengthMismatch();
    error NotCardOwner();
    error CannotMergeLegendary();
    error RarityMismatch();
    error NotAdmin();

    // ============ Modifiers ============

    modifier onlyAdmin() {
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN) revert NotAdmin();
        _;
    }

    modifier onlyAuthorizedMinter() {
        if (!authorizedMinters[msg.sender]) revert NotAuthorizedMinter();
        _;
    }

    modifier onlyAuthorizedLocker() {
        if (!authorizedLockers[msg.sender]) revert NotAuthorizedLocker();
        _;
    }

    // ============ Constructor (disabled for proxy) ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    /**
     * @notice Initializes the AttentionX NFT contract (called once via proxy)
     * @param initialOwner The initial owner of the contract
     */
    function initialize(address initialOwner) public initializer {
        if (initialOwner == address(0)) revert ZeroAddress();

        __ERC721_init("AttentionX Cards", "ATTNX");
        __ERC721Enumerable_init();
        __ERC2981_init();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        baseURI = "http://localhost:3001/metadata/";
        _nextTokenId = 1;

        _setDefaultRoyalty(ROYALTY_RECEIVER, ROYALTY_FEE);

        _initializeStartups();
    }

    // ============ UUPS Upgrade Authorization ============

    function _authorizeUpgrade(address newImplementation) internal override onlyAdmin {}

    // ============ Internal Functions ============

    /**
     * @dev Initialize all 19 startup types with their rarity and multipliers
     */
    function _initializeStartups() private {
        // Legendary (10x multiplier) - IDs 1-5
        startups[1] = StartupInfo("Openclaw", Rarity.Legendary, 10);
        startups[2] = StartupInfo("Lovable", Rarity.Legendary, 10);
        startups[3] = StartupInfo("Cursor", Rarity.Legendary, 10);
        startups[4] = StartupInfo("OpenAI", Rarity.Legendary, 10);
        startups[5] = StartupInfo("Anthropic", Rarity.Legendary, 10);

        // Epic (5x multiplier) - IDs 6-8
        startups[6] = StartupInfo("Browser Use", Rarity.Epic, 5);
        startups[7] = StartupInfo("Dedalus Labs", Rarity.Epic, 5);
        startups[8] = StartupInfo("Autumn", Rarity.Epic, 5);

        // Rare (3x multiplier) - IDs 9-13
        startups[9] = StartupInfo("Axiom", Rarity.Rare, 3);
        startups[10] = StartupInfo("Multifactor", Rarity.Rare, 3);
        startups[11] = StartupInfo("Dome", Rarity.Rare, 3);
        startups[12] = StartupInfo("GrazeMate", Rarity.Rare, 3);
        startups[13] = StartupInfo("Tornyol Systems", Rarity.Rare, 3);

        // Common (1x multiplier) - IDs 14-19
        startups[14] = StartupInfo("Pocket", Rarity.Common, 1);
        startups[15] = StartupInfo("Caretta", Rarity.Common, 1);
        startups[16] = StartupInfo("AxionOrbital Space", Rarity.Common, 1);
        startups[17] = StartupInfo("Freeport Markets", Rarity.Common, 1);
        startups[18] = StartupInfo("Ruvo", Rarity.Common, 1);
        startups[19] = StartupInfo("Lightberry", Rarity.Common, 1);
    }

    /**
     * @dev Internal mint function
     */
    function _mintCard(address to, uint256 startupId) private returns (uint256) {
        if (totalSupply() >= MAX_SUPPLY) revert MaxSupplyReached();
        if (startupId < 1 || startupId > TOTAL_STARTUPS) revert InvalidStartupId();

        uint256 tokenId = _nextTokenId++;

        startupMintCount[startupId]++;
        tokenToStartup[tokenId] = startupId;
        tokenToEdition[tokenId] = startupMintCount[startupId];

        _safeMint(to, tokenId);

        emit CardMinted(to, tokenId, startupId, tokenToEdition[tokenId]);

        return tokenId;
    }

    // ============ External Minting Functions ============

    function mint(address to, uint256 startupId)
        external
        onlyAuthorizedMinter
        whenNotPaused
        returns (uint256)
    {
        if (to == address(0)) revert ZeroAddress();
        return _mintCard(to, startupId);
    }

    function batchMint(address to, uint256[5] calldata startupIds)
        external
        onlyAuthorizedMinter
        whenNotPaused
        returns (uint256[5] memory tokenIds)
    {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() + 5 > MAX_SUPPLY) revert MaxSupplyReached();

        for (uint256 i = 0; i < 5; i++) {
            tokenIds[i] = _mintCard(to, startupIds[i]);
        }

        return tokenIds;
    }

    // ============ Lock/Unlock Functions ============

    function lockCard(uint256 tokenId) external onlyAuthorizedLocker {
        if (isLocked[tokenId]) revert CardIsLocked();
        isLocked[tokenId] = true;
        emit CardLocked(tokenId, msg.sender);
    }

    function unlockCard(uint256 tokenId) external onlyAuthorizedLocker {
        if (!isLocked[tokenId]) revert CardNotLocked();
        isLocked[tokenId] = false;
        emit CardUnlocked(tokenId, msg.sender);
    }

    function batchLock(uint256[] calldata tokenIds) external onlyAuthorizedLocker {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (!isLocked[tokenIds[i]]) {
                isLocked[tokenIds[i]] = true;
            }
        }
        emit CardsLockedBatch(tokenIds, msg.sender);
    }

    function batchUnlock(uint256[] calldata tokenIds) external onlyAuthorizedLocker {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            if (isLocked[tokenIds[i]]) {
                isLocked[tokenIds[i]] = false;
            }
        }
        emit CardsUnlockedBatch(tokenIds, msg.sender);
    }

    // ============ Merge Functions ============

    function mergeCards(uint256[3] calldata tokenIds)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newTokenId)
    {
        for (uint256 i = 0; i < 3; i++) {
            if (ownerOf(tokenIds[i]) != msg.sender) revert NotCardOwner();
            if (isLocked[tokenIds[i]]) revert CardIsLocked();
        }

        uint256 startupId0 = tokenToStartup[tokenIds[0]];
        Rarity fromRarity = startups[startupId0].rarity;

        for (uint256 i = 1; i < 3; i++) {
            uint256 sid = tokenToStartup[tokenIds[i]];
            if (startups[sid].rarity != fromRarity) revert RarityMismatch();
        }

        if (fromRarity == Rarity.Legendary || fromRarity == Rarity.EpicRare) revert CannotMergeLegendary();

        // Common→Rare, Rare→Epic, Epic→Legendary (skip EpicRare)
        Rarity toRarity;
        if (fromRarity == Rarity.Epic) {
            toRarity = Rarity.Legendary;
        } else {
            toRarity = Rarity(uint8(fromRarity) + 1);
        }
        uint256 newStartupId = _getRandomStartupByRarity(toRarity, tokenIds[0]);

        for (uint256 i = 0; i < 3; i++) {
            _burn(tokenIds[i]);
        }

        newTokenId = _mintCard(msg.sender, newStartupId);

        emit CardsMerged(msg.sender, tokenIds, newTokenId, fromRarity, toRarity);

        return newTokenId;
    }

    function _getRandomStartupByRarity(Rarity rarity, uint256 seed) internal view returns (uint256) {
        uint256 random = uint256(keccak256(abi.encodePacked(
            block.prevrandao,
            block.timestamp,
            msg.sender,
            seed
        )));

        if (rarity == Rarity.Common) {
            return 14 + (random % 6);   // IDs 14-19 (6 common startups)
        } else if (rarity == Rarity.Rare) {
            return 9 + (random % 5);    // IDs 9-13 (5 rare startups)
        } else if (rarity == Rarity.Epic) {
            return 6 + (random % 3);    // IDs 6-8 (3 epic startups)
        } else {
            // Legendary (includes any EpicRare fallback)
            return 1 + (random % 5);    // IDs 1-5 (5 legendary startups)
        }
    }

    // ============ View Functions ============

    function getCardInfo(uint256 tokenId) external view returns (CardInfo memory info) {
        uint256 startupId = tokenToStartup[tokenId];
        StartupInfo memory startup = startups[startupId];

        info = CardInfo({
            startupId: startupId,
            edition: tokenToEdition[tokenId],
            rarity: startup.rarity,
            multiplier: startup.multiplier,
            isLocked: isLocked[tokenId],
            name: startup.name
        });
    }

    function getStartupInfo(uint256 startupId) external view returns (StartupInfo memory) {
        if (startupId < 1 || startupId > TOTAL_STARTUPS) revert InvalidStartupId();
        return startups[startupId];
    }

    function getOwnedTokens(address tokenOwner) external view returns (uint256[] memory) {
        uint256 bal = balanceOf(tokenOwner);
        uint256[] memory tokenIds = new uint256[](bal);

        for (uint256 i = 0; i < bal; i++) {
            tokenIds[i] = tokenOfOwnerByIndex(tokenOwner, i);
        }

        return tokenIds;
    }

    // ============ Admin Functions ============

    function setAuthorizedMinter(address minter, bool authorized) external onlyAdmin {
        if (minter == address(0)) revert ZeroAddress();
        authorizedMinters[minter] = authorized;
        emit AuthorizedMinterSet(minter, authorized);
    }

    function setAuthorizedLocker(address locker, bool authorized) external onlyAdmin {
        if (locker == address(0)) revert ZeroAddress();
        authorizedLockers[locker] = authorized;
        emit AuthorizedLockerSet(locker, authorized);
    }

    function setBaseURI(string calldata newBaseURI) external onlyAdmin {
        baseURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    function pause() external onlyAdmin {
        _pause();
    }

    function unpause() external onlyAdmin {
        _unpause();
    }

    function setRoyaltyReceiver(address receiver) external onlyAdmin {
        if (receiver == address(0)) revert ZeroAddress();
        _setDefaultRoyalty(receiver, ROYALTY_FEE);
    }

    /// @notice Re-initialize startup data after UUPS upgrade (fixes any stale storage)
    function reinitializeStartups() external onlyAdmin {
        _initializeStartups();
    }

    // ============ Overrides ============

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        string memory base = _baseURI();
        return bytes(base).length > 0
            ? string(abi.encodePacked(base, _toString(tokenId)))
            : "";
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && isLocked[tokenId]) {
            revert CardIsLocked();
        }

        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable, ERC2981Upgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
