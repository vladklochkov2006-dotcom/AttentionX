// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

interface IAttentionX_NFT {
    function batchMint(address to, uint256[5] calldata startupIds) external returns (uint256[5] memory);
    function totalSupply() external view returns (uint256);
}

interface IPackNFT {
    function mint(address to) external returns (uint256);
    function burn(uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function totalSupply() external view returns (uint256);
}

interface ITournamentManager {
    function addToPrizePool(uint256 tournamentId) external payable;
}

/**
 * @title PackOpener
 * @author AttentionX Team
 * @notice Two-step pack system: buy → receive Pack NFT, open → burn Pack NFT + mint 5 cards (UUPS upgradeable)
 */
contract PackOpener is Initializable, Ownable2StepUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, UUPSUpgradeable {

    // ============ Constants ============

    uint256 public constant PACK_PRICE = 5 ether;
    uint256 public constant MAX_PACKS = 10000;
    uint256 public constant CARDS_PER_PACK = 5;
    uint256 public constant MAX_MULTI_PACKS = 10;

    uint256 public constant REFERRAL_PERCENT = 10;
    uint256 public constant PLATFORM_PERCENT = 10;

    address public constant SECOND_ADMIN = 0xB36402e87a86206D3a114a98B53f31362291fe1B;

    uint256 private constant COMMON_THRESHOLD = 70;
    uint256 private constant RARE_THRESHOLD = 95;

    uint256 private constant LEGENDARY_START = 1;
    uint256 private constant LEGENDARY_COUNT = 5;   // IDs 1-5
    uint256 private constant EPIC_START = 6;
    uint256 private constant EPIC_COUNT = 3;         // IDs 6-8
    uint256 private constant RARE_START = 9;
    uint256 private constant RARE_COUNT = 5;         // IDs 9-13
    uint256 private constant COMMON_START = 14;
    uint256 private constant COMMON_COUNT = 6;       // IDs 14-19

    // ============ State Variables ============

    IAttentionX_NFT public nftContract;
    IPackNFT public packNftContract;
    uint256 public packsSold;
    address public treasury;
    ITournamentManager public tournamentManager;
    uint256 public activeTournamentId;
    uint256 public currentPackPrice;
    uint256 public pendingPrizePool;

    mapping(address => address) public referrers;
    mapping(address => uint256) public referralEarnings;
    mapping(address => uint256) public referralCount;

    // Unique buyer tracking (added in upgrade v2)
    mapping(address => bool) public hasBought;
    uint256 public uniqueBuyerCount;

    // ============ Events ============

    event PackPurchased(address indexed buyer, uint256 indexed packTokenId, uint256 price, uint256 timestamp);
    event PackOpened(address indexed owner, uint256 indexed packTokenId, uint256[5] cardIds, uint256[5] startupIds);
    event ReferralRegistered(address indexed user, address indexed referrer);
    event ReferralRewardPaid(address indexed referrer, address indexed buyer, uint256 amount);
    event FundsDistributed(uint256 prizePoolAmount, uint256 platformAmount, uint256 referralAmount);
    event PendingFundsForwarded(uint256 tournamentId, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event PackPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event FundsWithdrawn(address indexed to, uint256 amount);
    event TournamentManagerUpdated(address indexed oldTM, address indexed newTM);
    event ActiveTournamentUpdated(uint256 oldId, uint256 newId);
    event MultiplePacksPurchased(address indexed buyer, uint256 packCount, uint256[] packTokenIds);
    event BatchPacksOpened(address indexed owner, uint256[] packTokenIds, uint256[] allCardIds);
    event PackNftContractUpdated(address indexed oldContract, address indexed newContract);

    // ============ Errors ============

    error InsufficientPayment();
    error MaxPacksReached();
    error NotPackOwner();
    error ZeroAddress();
    error WithdrawFailed();
    error InvalidPrice();
    error CannotReferSelf();
    error NotAdmin();
    error InvalidPackCount();
    error PackNftNotSet();
    error BatchTooLarge();

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

    function initialize(address _nftContract, address _treasury, address initialOwner) public initializer {
        if (_nftContract == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (initialOwner == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        nftContract = IAttentionX_NFT(_nftContract);
        treasury = _treasury;
        currentPackPrice = PACK_PRICE;
    }

    // ============ UUPS Upgrade Authorization ============

    function _authorizeUpgrade(address newImplementation) internal override onlyAdmin {}

    // ============ Referral Functions ============

    function getReferrer(address user) external view returns (address) {
        return referrers[user];
    }

    function getReferralStats(address referrer) external view returns (uint256 count, uint256 totalEarned) {
        return (referralCount[referrer], referralEarnings[referrer]);
    }

    function _trySetReferrer(address buyer, address referrer) internal {
        if (referrer == address(0)) return;
        if (referrer == buyer) return;
        if (referrers[buyer] != address(0)) return;

        referrers[buyer] = referrer;
        referralCount[referrer]++;
        emit ReferralRegistered(buyer, referrer);
    }

    // ============ Pack Purchase Functions ============

    /**
     * @notice Buy a single pack — mints a Pack NFT to the buyer
     * @param referrer Address of the referrer (or zero address)
     * @return packTokenId The token ID of the minted Pack NFT
     */
    function buyPack(address referrer) external payable whenNotPaused nonReentrant returns (uint256 packTokenId) {
        if (address(packNftContract) == address(0)) revert PackNftNotSet();
        if (msg.value < currentPackPrice) revert InsufficientPayment();
        if (packsSold >= MAX_PACKS) revert MaxPacksReached();

        _trySetReferrer(msg.sender, referrer);
        _trackBuyer(msg.sender);

        packsSold++;

        // Mint Pack NFT to buyer
        packTokenId = packNftContract.mint(msg.sender);

        _distributeFunds(currentPackPrice, msg.sender);

        if (msg.value > currentPackPrice) {
            (bool refundSuccess, ) = msg.sender.call{value: msg.value - currentPackPrice}("");
            if (!refundSuccess) revert WithdrawFailed();
        }

        emit PackPurchased(msg.sender, packTokenId, currentPackPrice, block.timestamp);
        return packTokenId;
    }

    /**
     * @notice Buy multiple packs in one transaction — mints Pack NFTs
     * @param referrer Address of the referrer (or zero address)
     * @param count Number of packs to buy (1-10)
     * @return packTokenIds Array of minted Pack NFT token IDs
     */
    function buyMultiplePacks(address referrer, uint256 count) external payable whenNotPaused nonReentrant returns (
        uint256[] memory packTokenIds
    ) {
        if (address(packNftContract) == address(0)) revert PackNftNotSet();
        if (count == 0 || count > MAX_MULTI_PACKS) revert InvalidPackCount();
        uint256 totalCost = currentPackPrice * count;
        if (msg.value < totalCost) revert InsufficientPayment();
        if (packsSold + count > MAX_PACKS) revert MaxPacksReached();

        _trySetReferrer(msg.sender, referrer);
        _trackBuyer(msg.sender);

        packTokenIds = new uint256[](count);

        for (uint256 p = 0; p < count; p++) {
            packsSold++;
            packTokenIds[p] = packNftContract.mint(msg.sender);
            emit PackPurchased(msg.sender, packTokenIds[p], currentPackPrice, block.timestamp);
        }

        _distributeFunds(totalCost, msg.sender);

        if (msg.value > totalCost) {
            (bool refundSuccess, ) = msg.sender.call{value: msg.value - totalCost}("");
            if (!refundSuccess) revert WithdrawFailed();
        }

        emit MultiplePacksPurchased(msg.sender, count, packTokenIds);
        return packTokenIds;
    }

    /**
     * @notice Open a Pack NFT — burns the pack and mints 5 card NFTs
     * @param packTokenId The token ID of the Pack NFT to open
     * @return cardIds The token IDs of the 5 minted card NFTs
     * @return startupIds The startup IDs assigned to each card
     */
    function openPack(uint256 packTokenId) external whenNotPaused nonReentrant returns (
        uint256[5] memory cardIds,
        uint256[5] memory startupIds
    ) {
        if (address(packNftContract) == address(0)) revert PackNftNotSet();
        if (packNftContract.ownerOf(packTokenId) != msg.sender) revert NotPackOwner();

        // Burn the Pack NFT
        packNftContract.burn(packTokenId);

        // Generate random cards and mint them
        startupIds = _generateRandomCards(packTokenId);
        cardIds = nftContract.batchMint(msg.sender, startupIds);

        emit PackOpened(msg.sender, packTokenId, cardIds, startupIds);
        return (cardIds, startupIds);
    }

    /**
     * @notice Open multiple Pack NFTs in one transaction — burns packs and mints cards
     * @param packTokenIds Array of Pack NFT token IDs to open (max 5)
     * @return allCardIds All minted card token IDs (5 per pack)
     * @return allStartupIds All startup IDs assigned to each card
     */
    function batchOpenPacks(uint256[] calldata packTokenIds) external whenNotPaused nonReentrant returns (
        uint256[] memory allCardIds,
        uint256[] memory allStartupIds
    ) {
        if (address(packNftContract) == address(0)) revert PackNftNotSet();
        if (packTokenIds.length == 0 || packTokenIds.length > MAX_MULTI_PACKS) revert BatchTooLarge();

        uint256 totalCards = packTokenIds.length * CARDS_PER_PACK;
        allCardIds = new uint256[](totalCards);
        allStartupIds = new uint256[](totalCards);

        for (uint256 p = 0; p < packTokenIds.length; p++) {
            if (packNftContract.ownerOf(packTokenIds[p]) != msg.sender) revert NotPackOwner();

            packNftContract.burn(packTokenIds[p]);

            uint256[5] memory startupIds = _generateRandomCards(packTokenIds[p]);
            uint256[5] memory cardIds = nftContract.batchMint(msg.sender, startupIds);

            for (uint256 i = 0; i < CARDS_PER_PACK; i++) {
                allCardIds[p * CARDS_PER_PACK + i] = cardIds[i];
                allStartupIds[p * CARDS_PER_PACK + i] = startupIds[i];
            }

            emit PackOpened(msg.sender, packTokenIds[p], cardIds, startupIds);
        }

        emit BatchPacksOpened(msg.sender, packTokenIds, allCardIds);
        return (allCardIds, allStartupIds);
    }

    // ============ Internal Functions ============

    function _trackBuyer(address buyer) internal {
        if (!hasBought[buyer]) {
            hasBought[buyer] = true;
            uniqueBuyerCount++;
        }
    }

    function _generateRandomCards(uint256 seed) internal view returns (uint256[5] memory startupIds) {
        for (uint256 i = 0; i < CARDS_PER_PACK; i++) {
            uint256 s = uint256(keccak256(abi.encodePacked(
                block.prevrandao,
                block.timestamp,
                msg.sender,
                seed,
                i
            )));

            uint256 rarityRoll = s % 100;
            startupIds[i] = _pickStartupByRarity(rarityRoll, s);
        }
        return startupIds;
    }

    function _pickStartupByRarity(uint256 rarityRoll, uint256 seed) internal pure returns (uint256 startupId) {
        if (rarityRoll < COMMON_THRESHOLD) {
            // 70% Common
            startupId = COMMON_START + (seed / 100 % COMMON_COUNT);
        } else if (rarityRoll < RARE_THRESHOLD) {
            // 25% Rare
            startupId = RARE_START + (seed / 100 % RARE_COUNT);
        } else {
            // 5% Epic (Legendary only from merging)
            startupId = EPIC_START + (seed / 1000000 % EPIC_COUNT);
        }
        return startupId;
    }

    function _distributeFunds(uint256 amount, address buyer) internal {
        address referrer = referrers[buyer];
        uint256 referralShare = 0;
        uint256 platformShare = (amount * PLATFORM_PERCENT) / 100;
        uint256 tournamentShare;

        if (referrer != address(0)) {
            referralShare = (amount * REFERRAL_PERCENT) / 100;
            tournamentShare = amount - platformShare - referralShare;

            (bool refSuccess, ) = referrer.call{value: referralShare}("");
            if (refSuccess) {
                referralEarnings[referrer] += referralShare;
                emit ReferralRewardPaid(referrer, buyer, referralShare);
            } else {
                tournamentShare += referralShare;
                referralShare = 0;
            }
        } else {
            tournamentShare = amount - platformShare;
        }

        if (address(tournamentManager) != address(0) && activeTournamentId > 0) {
            try tournamentManager.addToPrizePool{value: tournamentShare}(activeTournamentId) {
            } catch {
                pendingPrizePool += tournamentShare;
            }
        } else {
            pendingPrizePool += tournamentShare;
        }

        emit FundsDistributed(tournamentShare, platformShare, referralShare);
    }

    // ============ View Functions ============

    function getPacksRemaining() external view returns (uint256) {
        return MAX_PACKS - packsSold;
    }

    // ============ Admin Functions ============

    function setPackNftContract(address _packNftContract) external onlyAdmin {
        if (_packNftContract == address(0)) revert ZeroAddress();
        address oldContract = address(packNftContract);
        packNftContract = IPackNFT(_packNftContract);
        emit PackNftContractUpdated(oldContract, _packNftContract);
    }

    function forwardPendingFunds() external onlyAdmin nonReentrant {
        require(address(tournamentManager) != address(0), "No tournament manager");
        require(activeTournamentId > 0, "No active tournament");
        require(pendingPrizePool > 0, "No pending funds");

        uint256 amount = pendingPrizePool;
        pendingPrizePool = 0;

        tournamentManager.addToPrizePool{value: amount}(activeTournamentId);
        emit PendingFundsForwarded(activeTournamentId, amount);
    }

    function withdraw() external onlyAdmin nonReentrant {
        uint256 platformBalance = address(this).balance - pendingPrizePool;
        if (platformBalance == 0) revert WithdrawFailed();

        (bool success, ) = treasury.call{value: platformBalance}("");
        if (!success) revert WithdrawFailed();

        emit FundsWithdrawn(treasury, platformBalance);
    }

    function setPackPrice(uint256 newPrice) external onlyAdmin {
        if (newPrice == 0) revert InvalidPrice();
        uint256 oldPrice = currentPackPrice;
        currentPackPrice = newPrice;
        emit PackPriceUpdated(oldPrice, newPrice);
    }

    function setTreasury(address newTreasury) external onlyAdmin {
        if (newTreasury == address(0)) revert ZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    function setNftContract(address newNftContract) external onlyAdmin {
        if (newNftContract == address(0)) revert ZeroAddress();
        nftContract = IAttentionX_NFT(newNftContract);
    }

    function setTournamentManager(address newTournamentManager) external onlyAdmin {
        address oldTM = address(tournamentManager);
        tournamentManager = ITournamentManager(newTournamentManager);
        emit TournamentManagerUpdated(oldTM, newTournamentManager);
    }

    function setActiveTournament(uint256 tournamentId) external onlyAdmin {
        uint256 oldId = activeTournamentId;
        activeTournamentId = tournamentId;
        emit ActiveTournamentUpdated(oldId, tournamentId);

        if (tournamentId > 0 && pendingPrizePool > 0 && address(tournamentManager) != address(0)) {
            uint256 amount = pendingPrizePool;
            pendingPrizePool = 0;
            try tournamentManager.addToPrizePool{value: amount}(tournamentId) {
                emit PendingFundsForwarded(tournamentId, amount);
            } catch {
                pendingPrizePool = amount;
            }
        }
    }

    /// @notice Backfill unique buyer data after upgrade (call once per existing buyer)
    function backfillBuyers(address[] calldata buyers) external onlyAdmin {
        for (uint256 i = 0; i < buyers.length; i++) {
            if (!hasBought[buyers[i]]) {
                hasBought[buyers[i]] = true;
                uniqueBuyerCount++;
            }
        }
    }

    function pause() external onlyAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

    receive() external payable {}
}
