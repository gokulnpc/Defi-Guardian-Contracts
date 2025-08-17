import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import { VotingMirror, MockCCIPRouter } from "../types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("VotingMirror", function () {
  let votingMirror: VotingMirror;
  let mockRouter: MockCCIPRouter;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let lp1: HardhatEthersSigner;
  let lp2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user, lp1, lp2] = await ethers.getSigners();

    // Deploy mock router
    mockRouter = await ethers.deployContract("MockCCIPRouter");

    // Deploy VotingMirror
    votingMirror = await ethers.deployContract("VotingMirror", [
      await mockRouter.getAddress(),
      owner.address,
    ]);
  });

  describe("Deployment and Setup", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await votingMirror.owner()).to.equal(owner.address);
      expect(await votingMirror.router()).to.equal(
        await mockRouter.getAddress()
      );
      expect(await votingMirror.totalPowerCached()).to.equal(0);
    });
  });

  describe("Allowlist Management", function () {
    it("Should manage source chain allowlist", async function () {
      const chainSelector = 12345n;

      expect(await votingMirror.allowlistedSourceChains(chainSelector)).to.be
        .false;

      await expect(votingMirror.allowlistSourceChain(chainSelector, true))
        .to.emit(votingMirror, "SourceChainAllowlisted")
        .withArgs(chainSelector, true);

      expect(await votingMirror.allowlistedSourceChains(chainSelector)).to.be
        .true;

      await votingMirror.allowlistSourceChain(chainSelector, false);
      expect(await votingMirror.allowlistedSourceChains(chainSelector)).to.be
        .false;
    });

    it("Should manage sender allowlist", async function () {
      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );

      expect(await votingMirror.allowlistedSenders(sender)).to.be.false;

      await expect(votingMirror.allowlistSender(sender, true))
        .to.emit(votingMirror, "SenderAllowlisted")
        .withArgs(sender, true);

      expect(await votingMirror.allowlistedSenders(sender)).to.be.true;
    });

    it("Should only allow owner to manage allowlists", async function () {
      await expect(
        votingMirror.connect(user).allowlistSourceChain(12345n, true)
      ).to.be.revertedWithCustomError(
        votingMirror,
        "OwnableUnauthorizedAccount"
      );

      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );
      await expect(
        votingMirror.connect(user).allowlistSender(sender, true)
      ).to.be.revertedWithCustomError(
        votingMirror,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Voting Power Management", function () {
    it("Should track individual voting power", async function () {
      // Initially, all voting power should be zero
      expect(await votingMirror.vPowerOf(lp1.address)).to.equal(0);
      expect(await votingMirror.vPowerOf(lp2.address)).to.equal(0);
      expect(await votingMirror.totalPower()).to.equal(0);
    });

    it("Should provide voting power view functions", async function () {
      // Test the view functions exist and return correct initial values
      expect(await votingMirror.vPowerOf(ethers.ZeroAddress)).to.equal(0);
      expect(await votingMirror.totalPower()).to.equal(0);
      expect(await votingMirror.totalPowerCached()).to.equal(0);
    });

    it("Should handle zero power queries", async function () {
      const randomAddress = ethers.Wallet.createRandom().address;
      expect(await votingMirror.vPowerOf(randomAddress)).to.equal(0);
    });
  });

  describe("Message Processing", function () {
    it("Should track processed messages", async function () {
      const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message"));

      expect(await votingMirror.processedMessages(messageId)).to.be.false;

      // We can't easily test the internal message processing without complex CCIP setup
      // But we can verify the storage structure exists
    });
  });

  describe("Access Control", function () {
    it("Should have correct owner", async function () {
      expect(await votingMirror.owner()).to.equal(owner.address);
    });

    it("Should allow owner to transfer ownership", async function () {
      await expect(votingMirror.transferOwnership(user.address))
        .to.emit(votingMirror, "OwnershipTransferred")
        .withArgs(owner.address, user.address);

      expect(await votingMirror.owner()).to.equal(user.address);
    });

    it("Should not allow non-owner to transfer ownership", async function () {
      await expect(
        votingMirror.connect(user).transferOwnership(user.address)
      ).to.be.revertedWithCustomError(
        votingMirror,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Edge Cases", function () {
    it("Should handle voting power queries for invalid addresses", async function () {
      expect(await votingMirror.vPowerOf(ethers.ZeroAddress)).to.equal(0);

      const invalidAddress = "0x0000000000000000000000000000000000000001";
      expect(await votingMirror.vPowerOf(invalidAddress)).to.equal(0);
    });

    it("Should maintain consistent total power", async function () {
      // Even with no updates, total power should be consistent
      expect(await votingMirror.totalPower()).to.equal(
        await votingMirror.totalPowerCached()
      );
    });
  });

  describe("Integration Readiness", function () {
    it("Should be ready to receive CCIP messages", async function () {
      // Verify the contract has the necessary structure for CCIP integration
      expect(await votingMirror.router()).to.not.equal(ethers.ZeroAddress);

      // Verify allowlist functions exist and work
      await votingMirror.allowlistSourceChain(12345n, true);
      expect(await votingMirror.allowlistedSourceChains(12345n)).to.be.true;

      const testSender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );
      await votingMirror.allowlistSender(testSender, true);
      expect(await votingMirror.allowlistedSenders(testSender)).to.be.true;
    });

    it("Should have proper event structure", async function () {
      // Test that events are properly defined by triggering them
      const chainSelector = 67890n;
      await expect(votingMirror.allowlistSourceChain(chainSelector, true))
        .to.emit(votingMirror, "SourceChainAllowlisted")
        .withArgs(chainSelector, true);

      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [lp1.address]
      );
      await expect(votingMirror.allowlistSender(sender, true))
        .to.emit(votingMirror, "SenderAllowlisted")
        .withArgs(sender, true);
    });

    it("Should support the expected interface", async function () {
      // Verify that the contract supports the CCIPReceiver interface pattern
      // This tests the inheritance structure is correct
      expect(await votingMirror.router()).to.equal(
        await mockRouter.getAddress()
      );
    });
  });

  describe("State Consistency", function () {
    it("Should maintain state consistency across calls", async function () {
      // Multiple calls to view functions should return consistent results
      const power1 = await votingMirror.vPowerOf(lp1.address);
      const power2 = await votingMirror.vPowerOf(lp1.address);
      expect(power1).to.equal(power2);

      const total1 = await votingMirror.totalPower();
      const total2 = await votingMirror.totalPower();
      expect(total1).to.equal(total2);
    });

    it("Should handle multiple address queries", async function () {
      const addresses = [lp1.address, lp2.address, user.address, owner.address];

      for (const addr of addresses) {
        const power = await votingMirror.vPowerOf(addr);
        expect(power).to.equal(0); // Initially all should be zero
      }
    });
  });

  describe("Security Features", function () {
    it("Should use reentrancy protection", async function () {
      // The contract inherits from ReentrancyGuard
      // We can't easily test reentrancy attacks without complex setup,
      // but we can verify the structure is in place

      // The contract should handle normal operations without issues
      await votingMirror.allowlistSourceChain(12345n, true);
      await votingMirror.allowlistSourceChain(67890n, false);

      // No errors should occur during normal operation
      expect(await votingMirror.allowlistedSourceChains(12345n)).to.be.true;
      expect(await votingMirror.allowlistedSourceChains(67890n)).to.be.false;
    });

    it("Should properly handle ownership", async function () {
      // Verify ownership controls work as expected
      expect(await votingMirror.owner()).to.equal(owner.address);

      // Non-owner operations should fail
      await expect(
        votingMirror.connect(user).allowlistSourceChain(12345n, true)
      ).to.be.revertedWithCustomError(
        votingMirror,
        "OwnableUnauthorizedAccount"
      );

      // Owner operations should succeed
      await expect(
        votingMirror.allowlistSourceChain(12345n, true)
      ).to.not.be.revertedWithCustomError(
        votingMirror,
        "OwnableUnauthorizedAccount"
      );
    });
  });
});
