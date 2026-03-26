// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockAttentionXNFT
 * @notice Minimal mock of AttentionX_NFT for testing TournamentManagerFHE.
 *         Implements only the IAttentionX_NFT interface methods needed by the tournament.
 */
contract MockAttentionXNFT {

    struct CardData {
        uint256 startupId;
        uint256 edition;
        uint8 rarity;
        uint256 multiplier;
        string name;
    }

    mapping(uint256 => address) public owners;
    mapping(uint256 => bool) public locked;
    mapping(uint256 => CardData) public cards;

    uint256 public nextTokenId = 1;

    // ============ Setup helpers (called from tests) ============

    /**
     * @notice Mint a card with specific startup data to a given owner.
     * @param to         Card owner
     * @param startupId  Startup ID (1-19)
     * @param multiplier Card multiplier (1, 3, 5, 10)
     * @param name       Startup name
     * @return tokenId   The minted token ID
     */
    function mintCard(
        address to,
        uint256 startupId,
        uint256 multiplier,
        string calldata name
    ) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        owners[tokenId] = to;
        cards[tokenId] = CardData({
            startupId: startupId,
            edition: 1,
            rarity: 0,
            multiplier: multiplier,
            name: name
        });
    }

    // ============ IAttentionX_NFT interface ============

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }

    function isLocked(uint256 tokenId) external view returns (bool) {
        return locked[tokenId];
    }

    function batchLock(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            locked[tokenIds[i]] = true;
        }
    }

    function batchUnlock(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            locked[tokenIds[i]] = false;
        }
    }

    function getCardInfo(uint256 tokenId) external view returns (
        uint256 startupId,
        uint256 edition,
        uint8 rarity,
        uint256 multiplier,
        bool isLocked_,
        string memory name
    ) {
        CardData storage c = cards[tokenId];
        return (c.startupId, c.edition, c.rarity, c.multiplier, locked[tokenId], c.name);
    }
}
