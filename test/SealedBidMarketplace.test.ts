import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";

const cofheClients: Record<string, any> = {};

async function getCofheClient(signer: any): Promise<any> {
  const addr = await signer.getAddress();
  if (!cofheClients[addr]) {
    cofheClients[addr] = await (hre as any).cofhe.createClientWithBatteries(signer);
  }
  return cofheClients[addr];
}

async function encryptUint32For(signer: any, value: number) {
  const client = await getCofheClient(signer);
  const encrypted = await client.encryptInputs([Encryptable.uint32(BigInt(value))]).execute();
  return encrypted[0];
}

async function getPlaintext(handle: any): Promise<bigint> {
  return (hre as any).cofhe.mocks.getPlaintext(handle);
}

describe("SealedBidMarketplace", function () {
  let marketplace: any;
  let nft: any;
  let admin: any, seller: any, bidder1: any, bidder2: any;

  beforeEach(async function () {
    [admin, seller, bidder1, bidder2] = await ethers.getSigners();

    // Deploy mock ERC721
    const MockNFT = await ethers.getContractFactory("MockERC721");
    nft = await MockNFT.deploy();
    await nft.waitForDeployment();

    // Deploy SealedBidMarketplace
    const Marketplace = await ethers.getContractFactory("SealedBidMarketplace");
    marketplace = await Marketplace.deploy(await nft.getAddress(), admin.address);
    await marketplace.waitForDeployment();

    // Mint NFTs
    await nft.mint(seller.address);   // tokenId 1
    await nft.mint(seller.address);   // tokenId 2
    await nft.mint(bidder1.address);  // tokenId 3

    // Approve marketplace for all
    await nft.connect(seller).setApprovalForAll(await marketplace.getAddress(), true);
    await nft.connect(bidder1).setApprovalForAll(await marketplace.getAddress(), true);
  });

  describe("listSealed", function () {
    it("should list an NFT with encrypted min price", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      const tx = await marketplace.connect(seller).listSealed(1, encMinPrice);
      const receipt = await tx.wait();

      // Check listing
      const [listSeller, tokenId, active, createdAt] = await marketplace.getListing(1);
      expect(listSeller).to.equal(seller.address);
      expect(tokenId).to.equal(1);
      expect(active).to.equal(true);

      // NFT transferred to marketplace
      expect(await nft.ownerOf(1)).to.equal(await marketplace.getAddress());
    });

    it("should emit SealedListed event without price", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await expect(marketplace.connect(seller).listSealed(1, encMinPrice))
        .to.emit(marketplace, "SealedListed")
        .withArgs(1, seller.address, 1);
    });

    it("should revert if not token owner", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await expect(
        marketplace.connect(bidder1).listSealed(1, encMinPrice)
      ).to.be.revertedWithCustomError(marketplace, "NotTokenOwner");
    });

    it("should revert if token already listed", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      // After listing, NFT is in contract, so seller is no longer owner
      // This correctly prevents double-listing
      await expect(
        marketplace.connect(seller).listSealed(1, encMinPrice)
      ).to.be.reverted;
    });

    it("should store correct encrypted min price", async function () {
      const encMinPrice = await encryptUint32For(seller, 750);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      const handle = await marketplace.getEncryptedMinPrice(1);
      const plaintext = await getPlaintext(handle);
      expect(plaintext).to.equal(750n);
    });
  });

  describe("placeSealedBid", function () {
    beforeEach(async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);
    });

    it("should accept a bid with ETH deposit", async function () {
      const encBid = await encryptUint32For(bidder1, 600);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid, {
        value: ethers.parseEther("0.001"),
      });

      const [bidder, listingId, deposit, active] = await marketplace.getBid(1);
      expect(bidder).to.equal(bidder1.address);
      expect(listingId).to.equal(1);
      expect(deposit).to.equal(ethers.parseEther("0.001"));
      expect(active).to.equal(true);
    });

    it("should emit SealedBidPlaced without amount", async function () {
      const encBid = await encryptUint32For(bidder1, 600);
      await expect(
        marketplace.connect(bidder1).placeSealedBid(1, encBid, {
          value: ethers.parseEther("0.001"),
        })
      )
        .to.emit(marketplace, "SealedBidPlaced")
        .withArgs(1, 1, bidder1.address);
    });

    it("should store correct encrypted bid amount", async function () {
      const encBid = await encryptUint32For(bidder1, 800);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid, {
        value: ethers.parseEther("0.001"),
      });

      const handle = await marketplace.getEncryptedBidAmount(1);
      const plaintext = await getPlaintext(handle);
      expect(plaintext).to.equal(800n);
    });

    it("should allow multiple bids on same listing", async function () {
      const encBid1 = await encryptUint32For(bidder1, 600);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid1, {
        value: ethers.parseEther("0.001"),
      });

      const encBid2 = await encryptUint32For(bidder2, 700);
      await marketplace.connect(bidder2).placeSealedBid(1, encBid2, {
        value: ethers.parseEther("0.002"),
      });

      const bidIds = await marketplace.getBidsForListing(1);
      expect(bidIds.length).to.equal(2);
    });

    it("should revert on inactive listing", async function () {
      await marketplace.connect(seller).cancelSealedListing(1);

      const encBid = await encryptUint32For(bidder1, 600);
      await expect(
        marketplace.connect(bidder1).placeSealedBid(1, encBid, {
          value: ethers.parseEther("0.001"),
        })
      ).to.be.revertedWithCustomError(marketplace, "ListingNotActive");
    });

    it("should revert with zero deposit", async function () {
      const encBid = await encryptUint32For(bidder1, 600);
      await expect(
        marketplace.connect(bidder1).placeSealedBid(1, encBid, { value: 0 })
      ).to.be.revertedWithCustomError(marketplace, "ZeroDeposit");
    });
  });

  describe("acceptSealedBid", function () {
    beforeEach(async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      const encBid1 = await encryptUint32For(bidder1, 600);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid1, {
        value: ethers.parseEther("0.005"),
      });

      const encBid2 = await encryptUint32For(bidder2, 800);
      await marketplace.connect(bidder2).placeSealedBid(1, encBid2, {
        value: ethers.parseEther("0.008"),
      });
    });

    it("should transfer NFT to accepted bidder", async function () {
      await marketplace.connect(seller).acceptSealedBid(2); // accept bidder2
      expect(await nft.ownerOf(1)).to.equal(bidder2.address);
    });

    it("should transfer ETH deposit to seller", async function () {
      const sellerBefore = await ethers.provider.getBalance(seller.address);
      const tx = await marketplace.connect(seller).acceptSealedBid(2);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const sellerAfter = await ethers.provider.getBalance(seller.address);

      // Seller received 0.008 ETH minus gas
      expect(sellerAfter - sellerBefore + gasCost).to.equal(ethers.parseEther("0.008"));
    });

    it("should refund other bidders", async function () {
      const bidder1Before = await ethers.provider.getBalance(bidder1.address);
      await marketplace.connect(seller).acceptSealedBid(2);
      const bidder1After = await ethers.provider.getBalance(bidder1.address);

      // Bidder1 gets 0.005 ETH refund
      expect(bidder1After - bidder1Before).to.equal(ethers.parseEther("0.005"));
    });

    it("should deactivate listing and bid", async function () {
      await marketplace.connect(seller).acceptSealedBid(2);

      const [, , listingActive] = await marketplace.getListing(1);
      expect(listingActive).to.equal(false);

      const [, , , bidActive] = await marketplace.getBid(2);
      expect(bidActive).to.equal(false);
    });

    it("should emit SealedBidAccepted without amounts", async function () {
      await expect(marketplace.connect(seller).acceptSealedBid(2))
        .to.emit(marketplace, "SealedBidAccepted")
        .withArgs(2, 1, bidder2.address);
    });

    it("should revert if not seller", async function () {
      await expect(
        marketplace.connect(bidder1).acceptSealedBid(2)
      ).to.be.revertedWithCustomError(marketplace, "NotSeller");
    });
  });

  describe("cancelSealedListing", function () {
    it("should return NFT and refund all bids", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      const encBid = await encryptUint32For(bidder1, 600);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid, {
        value: ethers.parseEther("0.003"),
      });

      const bidder1Before = await ethers.provider.getBalance(bidder1.address);
      await marketplace.connect(seller).cancelSealedListing(1);
      const bidder1After = await ethers.provider.getBalance(bidder1.address);

      // NFT returned
      expect(await nft.ownerOf(1)).to.equal(seller.address);

      // Bid refunded
      expect(bidder1After - bidder1Before).to.equal(ethers.parseEther("0.003"));
    });
  });

  describe("cancelSealedBid", function () {
    it("should refund ETH to bidder", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      const encBid = await encryptUint32For(bidder1, 600);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid, {
        value: ethers.parseEther("0.004"),
      });

      const before = await ethers.provider.getBalance(bidder1.address);
      const tx = await marketplace.connect(bidder1).cancelSealedBid(1);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(bidder1.address);

      expect(after - before + gasCost).to.equal(ethers.parseEther("0.004"));
    });

    it("should revert if not bidder", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      const encBid = await encryptUint32For(bidder1, 600);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid, {
        value: ethers.parseEther("0.001"),
      });

      await expect(
        marketplace.connect(bidder2).cancelSealedBid(1)
      ).to.be.revertedWithCustomError(marketplace, "NotBidder");
    });
  });

  describe("Privacy: events don't leak amounts", function () {
    it("SealedListed has no price field", async function () {
      const abi = marketplace.interface;
      const event = abi.getEvent("SealedListed");
      // Should only have: listingId, seller, tokenId — NO price
      expect(event!.inputs.length).to.equal(3);
      const names = event!.inputs.map((i: any) => i.name);
      expect(names).to.not.include("price");
      expect(names).to.not.include("minPrice");
      expect(names).to.not.include("amount");
    });

    it("SealedBidPlaced has no amount field", async function () {
      const abi = marketplace.interface;
      const event = abi.getEvent("SealedBidPlaced");
      expect(event!.inputs.length).to.equal(3);
      const names = event!.inputs.map((i: any) => i.name);
      expect(names).to.not.include("amount");
      expect(names).to.not.include("price");
    });

    it("SealedBidAccepted has no amount field", async function () {
      const abi = marketplace.interface;
      const event = abi.getEvent("SealedBidAccepted");
      expect(event!.inputs.length).to.equal(3);
      const names = event!.inputs.map((i: any) => i.name);
      expect(names).to.not.include("amount");
      expect(names).to.not.include("price");
    });
  });

  describe("FHE comparison: bid vs minPrice", function () {
    it("encrypted bid amount is stored correctly", async function () {
      const encMinPrice = await encryptUint32For(seller, 500);
      await marketplace.connect(seller).listSealed(1, encMinPrice);

      const encBid = await encryptUint32For(bidder1, 999);
      await marketplace.connect(bidder1).placeSealedBid(1, encBid, {
        value: ethers.parseEther("0.001"),
      });

      // Verify encrypted values via mock decrypt
      const minHandle = await marketplace.getEncryptedMinPrice(1);
      const bidHandle = await marketplace.getEncryptedBidAmount(1);

      const minPlain = await getPlaintext(minHandle);
      const bidPlain = await getPlaintext(bidHandle);

      expect(minPlain).to.equal(500n);
      expect(bidPlain).to.equal(999n);
    });
  });
});
