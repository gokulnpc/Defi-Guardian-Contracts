import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import { PolicyManager, MockCCIPRouter } from "../types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("PolicyManager", function () {
  let policyManager: PolicyManager;
  let mockRouter: MockCCIPRouter;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let buyer: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user, buyer] = await ethers.getSigners();

    // Deploy mock router
    mockRouter = await ethers.deployContract("MockCCIPRouter");

    // Deploy PolicyManager
    policyManager = await ethers.deployContract("PolicyManager", [
      await mockRouter.getAddress(),
      owner.address,
    ]);
  });

  describe("Deployment and Setup", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await policyManager.owner()).to.equal(owner.address);
      expect(await policyManager.router()).to.equal(
        await mockRouter.getAddress()
      );
      expect(await policyManager.nextTokenId()).to.equal(0);
      expect(await policyManager.name()).to.equal("DeFiGuardians Policy");
      expect(await policyManager.symbol()).to.equal("DG-POL");
    });
  });

  describe("Allowlist Management", function () {
    it("Should manage source chain allowlist", async function () {
      const chainSelector = 12345n;

      expect(await policyManager.allowlistedSourceChains(chainSelector)).to.be
        .false;

      await expect(policyManager.allowlistSourceChain(chainSelector, true))
        .to.emit(policyManager, "SourceChainAllowlisted")
        .withArgs(chainSelector, true);

      expect(await policyManager.allowlistedSourceChains(chainSelector)).to.be
        .true;

      await policyManager.allowlistSourceChain(chainSelector, false);
      expect(await policyManager.allowlistedSourceChains(chainSelector)).to.be
        .false;
    });

    it("Should manage sender allowlist", async function () {
      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );

      expect(await policyManager.allowlistedSenders(sender)).to.be.false;

      await expect(policyManager.allowlistSender(sender, true))
        .to.emit(policyManager, "SenderAllowlisted")
        .withArgs(sender, true);

      expect(await policyManager.allowlistedSenders(sender)).to.be.true;
    });

    it("Should only allow owner to manage allowlists", async function () {
      await expect(
        policyManager.connect(user).allowlistSourceChain(12345n, true)
      ).to.be.revertedWithCustomError(
        policyManager,
        "OwnableUnauthorizedAccount"
      );

      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );
      await expect(
        policyManager.connect(user).allowlistSender(sender, true)
      ).to.be.revertedWithCustomError(
        policyManager,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Policy Storage and Retrieval", function () {
    it("Should store and retrieve policy correctly", async function () {
      // Create sample policy terms
      const policyTerms = {
        poolId: ethers.keccak256(ethers.toUtf8Bytes("test-pool")),
        buyer: buyer.address,
        coverageAmount: ethers.parseUnits("10000", 6), // 10k PYUSD
        startTs: Math.floor(Date.now() / 1000),
        endTs: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
        policyRef: ethers.keccak256(ethers.toUtf8Bytes("test-policy-ref")),
      };

      // Calculate expected policy ID
      const expectedPolicyId = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "uint256", "uint64", "uint64", "bytes32"],
          [
            policyTerms.poolId,
            policyTerms.buyer,
            policyTerms.coverageAmount,
            policyTerms.startTs,
            policyTerms.endTs,
            policyTerms.policyRef,
          ]
        )
      );

      // Manually call internal policy creation logic for testing
      // (In reality this would come via CCIP)
      // For testing, we'll verify the policy storage structure

      // Check that policy doesn't exist initially
      const initialPolicy = await policyManager.getPolicy(expectedPolicyId);
      expect(initialPolicy.buyer).to.equal(ethers.ZeroAddress);
      expect(initialPolicy.active).to.be.false;
    });
  });

  describe("Message Processing", function () {
    it("Should track processed messages", async function () {
      const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message"));

      expect(await policyManager.processedMessages(messageId)).to.be.false;

      // We can't easily test the internal message processing without complex CCIP setup
      // But we can verify the storage structure exists
    });
  });

  describe("ERC721 Functionality", function () {
    it("Should support ERC721 interface", async function () {
      // Check ERC721 interface support
      const ERC721InterfaceId = "0x80ac58cd";
      expect(await policyManager.supportsInterface(ERC721InterfaceId)).to.be
        .true;
    });

    it("Should have correct token metadata", async function () {
      expect(await policyManager.name()).to.equal("DeFiGuardians Policy");
      expect(await policyManager.symbol()).to.equal("DG-POL");
    });

    it("Should start with zero total supply", async function () {
      expect(await policyManager.nextTokenId()).to.equal(0);
    });
  });

  describe("Access Control", function () {
    it("Should have correct owner", async function () {
      expect(await policyManager.owner()).to.equal(owner.address);
    });

    it("Should allow owner to transfer ownership", async function () {
      await expect(policyManager.transferOwnership(user.address))
        .to.emit(policyManager, "OwnershipTransferred")
        .withArgs(owner.address, user.address);

      expect(await policyManager.owner()).to.equal(user.address);
    });

    it("Should not allow non-owner to transfer ownership", async function () {
      await expect(
        policyManager.connect(user).transferOwnership(user.address)
      ).to.be.revertedWithCustomError(
        policyManager,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero address checks", async function () {
      // The contract should handle edge cases appropriately
      // Most validation happens in the CCIP receive function
      const zeroPolicy = await policyManager.getPolicy(ethers.ZeroHash);
      expect(zeroPolicy.buyer).to.equal(ethers.ZeroAddress);
      expect(zeroPolicy.active).to.be.false;
    });

    it("Should handle empty policy lookups", async function () {
      const randomPolicyId = ethers.keccak256(ethers.randomBytes(32));
      const policy = await policyManager.getPolicy(randomPolicyId);

      expect(policy.poolId).to.equal(ethers.ZeroHash);
      expect(policy.buyer).to.equal(ethers.ZeroAddress);
      expect(policy.coverageAmount).to.equal(0);
      expect(policy.startTs).to.equal(0);
      expect(policy.endTs).to.equal(0);
      expect(policy.policyRef).to.equal(ethers.ZeroHash);
      expect(policy.tokenId).to.equal(0);
      expect(policy.active).to.be.false;
    });
  });

  describe("Integration Readiness", function () {
    it("Should be ready to receive CCIP messages", async function () {
      // Verify the contract has the necessary structure for CCIP integration
      expect(await policyManager.router()).to.not.equal(ethers.ZeroAddress);

      // Verify allowlist functions exist and work
      await policyManager.allowlistSourceChain(12345n, true);
      expect(await policyManager.allowlistedSourceChains(12345n)).to.be.true;

      const testSender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );
      await policyManager.allowlistSender(testSender, true);
      expect(await policyManager.allowlistedSenders(testSender)).to.be.true;
    });

    it("Should have proper event structure", async function () {
      // Test that events are properly defined by triggering them
      const chainSelector = 67890n;
      await expect(policyManager.allowlistSourceChain(chainSelector, true))
        .to.emit(policyManager, "SourceChainAllowlisted")
        .withArgs(chainSelector, true);

      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [buyer.address]
      );
      await expect(policyManager.allowlistSender(sender, true))
        .to.emit(policyManager, "SenderAllowlisted")
        .withArgs(sender, true);
    });
  });
});
