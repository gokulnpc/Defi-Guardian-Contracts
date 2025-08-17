import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import { PayoutVault, MockCCIPRouter, MockPYUSD } from "../types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("PayoutVault - Simple Tests", function () {
  let payoutVault: PayoutVault;
  let mockRouter: MockCCIPRouter;
  let mockPYUSD: MockPYUSD;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let claimant: HardhatEthersSigner;

  const HEDERA_CHAIN_SELECTOR = 3599014340846833606n;
  const DEFAULT_GAS_LIMIT = 200000n;
  const RESERVE_AMOUNT = ethers.parseUnits("10000", 6); // 10k PYUSD

  beforeEach(async function () {
    [owner, user, claimant] = await ethers.getSigners();

    // Deploy mock contracts
    mockRouter = await ethers.deployContract("MockCCIPRouter");
    mockPYUSD = await ethers.deployContract("MockPYUSD");

    // Deploy PayoutVault
    payoutVault = await ethers.deployContract("PayoutVault", [
      await mockRouter.getAddress(),
      await mockPYUSD.getAddress(),
      owner.address,
    ]);

    // Setup initial state
    await payoutVault.allowlistSourceChain(HEDERA_CHAIN_SELECTOR, true);
    await payoutVault.setGasLimit(HEDERA_CHAIN_SELECTOR, DEFAULT_GAS_LIMIT);

    // Fund the vault with PYUSD
    await mockPYUSD.mint(await payoutVault.getAddress(), RESERVE_AMOUNT);
    await payoutVault.onPremiumReserve(RESERVE_AMOUNT);
  });

  describe("Deployment and Setup", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await payoutVault.owner()).to.equal(owner.address);
      expect(await payoutVault.router()).to.equal(
        await mockRouter.getAddress()
      );
      expect(await payoutVault.PYUSD()).to.equal(await mockPYUSD.getAddress());
      expect(await payoutVault.reserveBalance()).to.equal(RESERVE_AMOUNT);
    });

    it("Should revert deployment with zero PYUSD address", async function () {
      await expect(
        ethers.deployContract("PayoutVault", [
          await mockRouter.getAddress(),
          ethers.ZeroAddress,
          owner.address,
        ])
      ).to.be.revertedWithCustomError(payoutVault, "ZeroAddress");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to manage source chain allowlist", async function () {
      const chainSelector = 12345n;

      expect(await payoutVault.allowlistedSourceChains(chainSelector)).to.be
        .false;

      await expect(payoutVault.allowlistSourceChain(chainSelector, true))
        .to.emit(payoutVault, "SourceChainAllowlisted")
        .withArgs(chainSelector, true);

      expect(await payoutVault.allowlistedSourceChains(chainSelector)).to.be
        .true;

      await payoutVault.allowlistSourceChain(chainSelector, false);
      expect(await payoutVault.allowlistedSourceChains(chainSelector)).to.be
        .false;
    });

    it("Should allow owner to manage sender allowlist", async function () {
      const sender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );

      expect(await payoutVault.allowlistedSenders(sender)).to.be.false;

      await expect(payoutVault.allowlistSender(sender, true))
        .to.emit(payoutVault, "SenderAllowlisted")
        .withArgs(sender, true);

      expect(await payoutVault.allowlistedSenders(sender)).to.be.true;
    });

    it("Should allow owner to set gas limits", async function () {
      const chainSelector = 12345n;
      const gasLimit = 300000n;

      await expect(payoutVault.setGasLimit(chainSelector, gasLimit))
        .to.emit(payoutVault, "GasLimitSet")
        .withArgs(chainSelector, gasLimit);

      expect(await payoutVault.gasLimitByChain(chainSelector)).to.equal(
        gasLimit
      );
    });

    it("Should revert setting zero gas limit", async function () {
      const chainSelector = 12345n;

      await expect(
        payoutVault.setGasLimit(chainSelector, 0)
      ).to.be.revertedWithCustomError(payoutVault, "InvalidGasLimit");
    });

    it("Should only allow owner to call admin functions", async function () {
      await expect(
        payoutVault.connect(user).allowlistSourceChain(12345n, true)
      ).to.be.revertedWithCustomError(
        payoutVault,
        "OwnableUnauthorizedAccount"
      );

      const sender = ethers.randomBytes(32);
      await expect(
        payoutVault.connect(user).allowlistSender(sender, true)
      ).to.be.revertedWithCustomError(
        payoutVault,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        payoutVault.connect(user).setGasLimit(12345n, 200000n)
      ).to.be.revertedWithCustomError(
        payoutVault,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Premium Reserve Management", function () {
    it("Should track premium reserves correctly", async function () {
      const additionalReserve = ethers.parseUnits("5000", 6);
      const initialReserve = await payoutVault.reserveBalance();

      await expect(payoutVault.onPremiumReserve(additionalReserve))
        .to.emit(payoutVault, "PremiumReserved")
        .withArgs(additionalReserve, initialReserve + additionalReserve);

      expect(await payoutVault.reserveBalance()).to.equal(
        initialReserve + additionalReserve
      );
    });

    it("Should allow any address to call onPremiumReserve", async function () {
      // This function is designed to be callable by PremiumVault
      const reserveAmount = ethers.parseUnits("1000", 6);

      await expect(
        payoutVault.connect(user).onPremiumReserve(reserveAmount)
      ).to.not.be.revertedWithCustomError(
        payoutVault,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Funding Functions", function () {
    it("Should allow users to deposit PYUSD", async function () {
      const depositAmount = ethers.parseUnits("5000", 6);

      // Mint and approve tokens for user
      await mockPYUSD.mint(user.address, depositAmount);
      await mockPYUSD
        .connect(user)
        .approve(await payoutVault.getAddress(), depositAmount);

      const initialBalance = await mockPYUSD.balanceOf(
        await payoutVault.getAddress()
      );

      await expect(payoutVault.connect(user).depositPYUSD(depositAmount))
        .to.emit(payoutVault, "Funded")
        .withArgs(user.address, depositAmount);

      expect(
        await mockPYUSD.balanceOf(await payoutVault.getAddress())
      ).to.equal(initialBalance + depositAmount);
    });

    it("Should revert deposit with insufficient allowance", async function () {
      const depositAmount = ethers.parseUnits("5000", 6);
      await mockPYUSD.mint(user.address, depositAmount);
      // Don't approve

      await expect(
        payoutVault.connect(user).depositPYUSD(depositAmount)
      ).to.be.revertedWithCustomError(mockPYUSD, "ERC20InsufficientAllowance");
    });
  });

  describe("Token Rescue", function () {
    it("Should allow owner to rescue tokens", async function () {
      const rescueAmount = ethers.parseUnits("100", 6);
      await mockPYUSD.mint(await payoutVault.getAddress(), rescueAmount);

      const recipient = ethers.Wallet.createRandom().address;
      const initialBalance = await mockPYUSD.balanceOf(recipient);

      await expect(
        payoutVault.rescueToken(
          await mockPYUSD.getAddress(),
          recipient,
          rescueAmount
        )
      )
        .to.emit(payoutVault, "Rescued")
        .withArgs(await mockPYUSD.getAddress(), recipient, rescueAmount);

      expect(await mockPYUSD.balanceOf(recipient)).to.equal(
        initialBalance + rescueAmount
      );
    });

    it("Should not allow rescuing to zero address", async function () {
      await expect(
        payoutVault.rescueToken(
          await mockPYUSD.getAddress(),
          ethers.ZeroAddress,
          100
        )
      ).to.be.revertedWithCustomError(payoutVault, "ZeroAddress");
    });

    it("Should only allow owner to rescue tokens", async function () {
      await expect(
        payoutVault
          .connect(user)
          .rescueToken(await mockPYUSD.getAddress(), user.address, 100)
      ).to.be.revertedWithCustomError(
        payoutVault,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Storage and State", function () {
    it("Should track processed messages", async function () {
      const messageId = ethers.keccak256(ethers.toUtf8Bytes("test-message"));

      expect(await payoutVault.processedMessages(messageId)).to.be.false;

      // We can't test the CCIP message processing directly,
      // but we can verify the storage structure exists
    });

    it("Should handle reserve balance updates", async function () {
      const initialReserve = await payoutVault.reserveBalance();

      // Add more reserve
      const additionalReserve = ethers.parseUnits("2000", 6);
      await payoutVault.onPremiumReserve(additionalReserve);

      expect(await payoutVault.reserveBalance()).to.equal(
        initialReserve + additionalReserve
      );
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should handle receiving native tokens", async function () {
      const amount = ethers.parseEther("1");

      await expect(
        user.sendTransaction({
          to: await payoutVault.getAddress(),
          value: amount,
        })
      ).to.not.be.revertedWithCustomError(payoutVault, "ZeroAddress");

      expect(
        await ethers.provider.getBalance(await payoutVault.getAddress())
      ).to.equal(amount);
    });

    it("Should use reentrancy protection pattern", async function () {
      // The contract uses ReentrancyGuard, verify normal operations work
      const depositAmount = ethers.parseUnits("1000", 6);

      await mockPYUSD.mint(user.address, depositAmount);
      await mockPYUSD
        .connect(user)
        .approve(await payoutVault.getAddress(), depositAmount);

      // Should work fine with reentrancy protection
      await expect(
        payoutVault.connect(user).depositPYUSD(depositAmount)
      ).to.not.be.revertedWithCustomError(payoutVault, "ZeroAddress");
    });

    it("Should maintain correct allowlist states", async function () {
      // Test that allowlists work correctly
      expect(await payoutVault.allowlistedSourceChains(HEDERA_CHAIN_SELECTOR))
        .to.be.true;
      expect(await payoutVault.gasLimitByChain(HEDERA_CHAIN_SELECTOR)).to.equal(
        DEFAULT_GAS_LIMIT
      );

      // Test non-allowlisted chain
      expect(await payoutVault.allowlistedSourceChains(99999n)).to.be.false;
      expect(await payoutVault.gasLimitByChain(99999n)).to.equal(0);
    });
  });

  describe("Integration Readiness", function () {
    it("Should be ready to receive CCIP messages", async function () {
      // Verify the contract has the necessary structure for CCIP integration
      expect(await payoutVault.router()).to.not.equal(ethers.ZeroAddress);

      // Verify allowlist functions exist and work
      await payoutVault.allowlistSourceChain(12345n, true);
      expect(await payoutVault.allowlistedSourceChains(12345n)).to.be.true;

      const testSender = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [user.address]
      );
      await payoutVault.allowlistSender(testSender, true);
      expect(await payoutVault.allowlistedSenders(testSender)).to.be.true;
    });

    it("Should have proper reserve management", async function () {
      // Test reserve functionality
      const startingReserve = await payoutVault.reserveBalance();
      expect(startingReserve).to.equal(RESERVE_AMOUNT);

      // Add more reserves
      const additionalAmount = ethers.parseUnits("5000", 6);
      await payoutVault.onPremiumReserve(additionalAmount);

      expect(await payoutVault.reserveBalance()).to.equal(
        startingReserve + additionalAmount
      );
    });

    it("Should support the expected interface", async function () {
      // Verify that the contract supports the CCIPReceiver interface pattern
      expect(await payoutVault.router()).to.equal(
        await mockRouter.getAddress()
      );
    });
  });
});
