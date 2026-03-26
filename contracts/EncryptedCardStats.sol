// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FHE, euint32, ebool, InEuint32} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @title EncryptedCardStats
 * @notice Stores per-NFT encrypted power levels using FHE.
 *         Only the card owner can decrypt their own stats via CoFHE SDK.
 *         Oracle can set/update stats and compare cards without revealing values.
 *
 * Privacy guarantees:
 *   - encryptedPower mapping is private — no public getter
 *   - getMyCardPower() returns euint32 handle, decryptable only by owner
 *   - compareCardPowers() returns ebool — encrypted comparison result
 *   - Events emit only tokenId, never power values
 */

interface IAttentionX_NFT_Minimal {
    function ownerOf(uint256 tokenId) external view returns (address);
}

contract EncryptedCardStats {
    // ── Errors ──
    error NotOracle();
    error NotCardOwner();
    error StatsNotSet();
    error ArrayLengthMismatch();
    error ZeroAddress();

    // ── Events ──
    event EncryptedStatSet(uint256 indexed tokenId);
    event EncryptedStatsBatchSet(uint256 count);
    event OwnerPermissionUpdated(uint256 indexed tokenId, address indexed newOwner);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ── State ──
    IAttentionX_NFT_Minimal public immutable nftContract;
    address public oracle;
    address public admin;

    mapping(uint256 => euint32) private encryptedPower;
    mapping(uint256 => bool) public hasEncryptedStats;

    // ── Modifiers ──
    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotOracle(); // reuse error for simplicity
        _;
    }

    // ── Constructor ──
    constructor(address _nftContract, address _oracle) {
        if (_nftContract == address(0) || _oracle == address(0)) revert ZeroAddress();
        nftContract = IAttentionX_NFT_Minimal(_nftContract);
        oracle = _oracle;
        admin = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════
    // Oracle functions — set/update encrypted stats
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Set encrypted power level for a single card.
     * @param tokenId  NFT token ID
     * @param encPower Encrypted power value (InEuint32 from CoFHE SDK)
     */
    function setEncryptedStat(
        uint256 tokenId,
        InEuint32 calldata encPower
    ) external onlyOracle {
        euint32 power = FHE.asEuint32(encPower);
        encryptedPower[tokenId] = power;
        hasEncryptedStats[tokenId] = true;

        // Grant contract access for comparisons
        FHE.allowThis(power);

        // Grant current owner access for decryption
        address owner = nftContract.ownerOf(tokenId);
        if (owner != address(0)) {
            FHE.allow(power, owner);
        }

        emit EncryptedStatSet(tokenId);
    }

    /**
     * @notice Batch set encrypted stats for multiple cards.
     * @param tokenIds Array of token IDs
     * @param powers   Array of encrypted power values (must match tokenIds length)
     */
    function batchSetEncryptedStats(
        uint256[] calldata tokenIds,
        InEuint32[] calldata powers
    ) external onlyOracle {
        if (tokenIds.length != powers.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokenIds.length; i++) {
            euint32 power = FHE.asEuint32(powers[i]);
            encryptedPower[tokenIds[i]] = power;
            hasEncryptedStats[tokenIds[i]] = true;

            FHE.allowThis(power);

            address owner = nftContract.ownerOf(tokenIds[i]);
            if (owner != address(0)) {
                FHE.allow(power, owner);
            }
        }

        emit EncryptedStatsBatchSet(tokenIds.length);
    }

    // ═══════════════════════════════════════════════════════════════
    // Owner functions — read own stats
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Get your card's encrypted power level.
     *         Returns a euint32 handle — use CoFHE SDK decryptForView() to see plaintext.
     * @param tokenId NFT token ID (caller must be owner)
     * @return Encrypted power handle (euint32)
     */
    function getMyCardPower(uint256 tokenId) external view returns (euint32) {
        if (nftContract.ownerOf(tokenId) != msg.sender) revert NotCardOwner();
        if (!hasEncryptedStats[tokenId]) revert StatsNotSet();
        return encryptedPower[tokenId];
    }

    /**
     * @notice Update decrypt permission after a card trade/transfer.
     *         New owner calls this to gain access to the encrypted stat.
     * @param tokenId NFT token ID (caller must be current owner)
     */
    function updateOwnerPermission(uint256 tokenId) external {
        if (nftContract.ownerOf(tokenId) != msg.sender) revert NotCardOwner();
        if (!hasEncryptedStats[tokenId]) revert StatsNotSet();

        FHE.allow(encryptedPower[tokenId], msg.sender);
        emit OwnerPermissionUpdated(tokenId, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════
    // Oracle comparison — encrypted result
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Compare power of two cards without revealing either value.
     * @param tokenIdA First card
     * @param tokenIdB Second card
     * @return Encrypted boolean: true if A > B
     */
    function compareCardPowers(
        uint256 tokenIdA,
        uint256 tokenIdB
    ) external onlyOracle returns (ebool) {
        if (!hasEncryptedStats[tokenIdA] || !hasEncryptedStats[tokenIdB]) revert StatsNotSet();

        ebool result = FHE.gt(encryptedPower[tokenIdA], encryptedPower[tokenIdB]);
        FHE.allowThis(result);
        FHE.allowSender(result);
        return result;
    }

    // ═══════════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════════

    /**
     * @notice Update the oracle address.
     */
    function setOracle(address newOracle) external onlyAdmin {
        if (newOracle == address(0)) revert ZeroAddress();
        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }
}
