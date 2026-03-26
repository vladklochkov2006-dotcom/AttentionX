// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title PackNFT
 * @author AttentionX Team
 * @notice ERC-721 NFT contract for tradeable card packs (UUPS upgradeable)
 * @dev Each token represents an unopened pack. PackOpener mints on purchase and burns on open.
 */
contract PackNFT is
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC2981Upgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{

    // ============ Constants ============

    uint96 public constant ROYALTY_FEE = 200; // 2%
    address public constant ROYALTY_RECEIVER = 0x233c8C54F25734B744E522bdC1Eed9cbc8C97D0c;
    address public constant SECOND_ADMIN = 0xB36402e87a86206D3a114a98B53f31362291fe1B;

    // ============ State Variables ============

    uint256 public maxSupply;
    uint256 private _nextTokenId;
    string public baseURI;

    mapping(address => bool) public authorizedMinters;
    mapping(address => bool) public authorizedBurners;

    // ============ Events ============

    event PackMinted(address indexed to, uint256 indexed tokenId);
    event PackBurned(address indexed from, uint256 indexed tokenId);
    event AuthorizedMinterSet(address indexed minter, bool authorized);
    event AuthorizedBurnerSet(address indexed burner, bool authorized);
    event MaxSupplyUpdated(uint256 oldMax, uint256 newMax);
    event BaseURIUpdated(string newBaseURI);

    // ============ Errors ============

    error MaxSupplyReached();
    error NotAuthorizedMinter();
    error NotAuthorizedBurner();
    error ZeroAddress();
    error NotAdmin();
    error MaxSupplyTooLow();

    // ============ Modifiers ============

    modifier onlyAdmin() {
        if (msg.sender != owner() && msg.sender != SECOND_ADMIN) revert NotAdmin();
        _;
    }

    modifier onlyAuthorizedMinter() {
        if (!authorizedMinters[msg.sender]) revert NotAuthorizedMinter();
        _;
    }

    modifier onlyAuthorizedBurner() {
        if (!authorizedBurners[msg.sender]) revert NotAuthorizedBurner();
        _;
    }

    // ============ Constructor (disabled for proxy) ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    function initialize(address initialOwner) public initializer {
        if (initialOwner == address(0)) revert ZeroAddress();

        __ERC721_init("AttentionX Packs", "AXPACK");
        __ERC721Enumerable_init();
        __ERC2981_init();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        maxSupply = 10000;
        _nextTokenId = 1;

        _setDefaultRoyalty(ROYALTY_RECEIVER, ROYALTY_FEE);
    }

    // ============ UUPS Upgrade Authorization ============

    function _authorizeUpgrade(address newImplementation) internal override onlyAdmin {}

    // ============ Mint & Burn ============

    function mint(address to) external onlyAuthorizedMinter whenNotPaused returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply() >= maxSupply) revert MaxSupplyReached();

        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);

        emit PackMinted(to, tokenId);
        return tokenId;
    }

    function burn(uint256 tokenId) external onlyAuthorizedBurner {
        address tokenOwner = ownerOf(tokenId);
        _burn(tokenId);

        emit PackBurned(tokenOwner, tokenId);
    }

    // ============ View Functions ============

    function getOwnedTokens(address tokenOwner) external view returns (uint256[] memory) {
        uint256 bal = balanceOf(tokenOwner);
        uint256[] memory tokenIds = new uint256[](bal);

        for (uint256 i = 0; i < bal; i++) {
            tokenIds[i] = tokenOfOwnerByIndex(tokenOwner, i);
        }

        return tokenIds;
    }

    // ============ Admin Functions ============

    function setMaxSupply(uint256 newMax) external onlyAdmin {
        if (newMax < totalSupply()) revert MaxSupplyTooLow();
        uint256 oldMax = maxSupply;
        maxSupply = newMax;
        emit MaxSupplyUpdated(oldMax, newMax);
    }

    function setAuthorizedMinter(address minter, bool authorized) external onlyAdmin {
        if (minter == address(0)) revert ZeroAddress();
        authorizedMinters[minter] = authorized;
        emit AuthorizedMinterSet(minter, authorized);
    }

    function setAuthorizedBurner(address burner, bool authorized) external onlyAdmin {
        if (burner == address(0)) revert ZeroAddress();
        authorizedBurners[burner] = authorized;
        emit AuthorizedBurnerSet(burner, authorized);
    }

    function setBaseURI(string calldata newBaseURI) external onlyAdmin {
        baseURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    function setRoyaltyReceiver(address receiver) external onlyAdmin {
        if (receiver == address(0)) revert ZeroAddress();
        _setDefaultRoyalty(receiver, ROYALTY_FEE);
    }

    function pause() external onlyAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

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
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
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
