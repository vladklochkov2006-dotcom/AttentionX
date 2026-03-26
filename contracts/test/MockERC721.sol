// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title MockERC721
 * @notice Simple ERC721 mock for testing SealedBidMarketplace.
 */
contract MockERC721 is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("MockNFT", "MNFT") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }
}
