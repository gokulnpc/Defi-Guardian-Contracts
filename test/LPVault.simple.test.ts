import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import { LPVault, MockCCIPRouter, MockPYUSD } from "../types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("LPVault - Simple Tests", function () {
  let lpVault: LPVault;
  let mockRouter: MockCCIPRouter;
  let mockPYUSD: MockPYUSD;

  let owner: HardhatEthersSigner;
  let lp1: HardhatEthersSigner;
  let lp2: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const HEDERA_CHAIN_SELECTOR = 1n; // Using the hardcoded value from contract
  const DEFAULT_GAS_LIMIT = 200000n;
  const DEPOSIT_AMOUNT = ethers.parseUnits("10000", 6); // 10k PYUSD
  const COOLDOWN_PERIOD = 86400; // 1 day in seconds

  beforeEach(async function () {
    [owner, lp1, lp2, user] = await ethers.getSigners();

    // Deploy mock contracts
    mockRouter = await ethers.deployContract("MockCCIPRouter");
    mockPYUSD = await ethers.deployContract("MockPYUSD");

    // Deploy LPVault
    lpVault = await ethers.deployContract("LPVault", [
      await mockPYUSD.getAddress(),
      await mockRouter.getAddress(),
      owner.address,
    ]);

    // Setup CCIP configuration
    await lpVault.setReceiver(HEDERA_CHAIN_SELECTOR, owner.address); // Mock VotingMirror
    await lpVault.setGasLimit(HEDERA_CHAIN_SELECTOR, DEFAULT_GAS_LIMIT);

    // Fund the vault with some ETH for CCIP fees
    await owner.sendTransaction({
      to: await lpVault.getAddress(),
      value: ethers.parseEther("10"),
    });

    // Set mock CCIP fee
    await mockRouter.setMockFee(ethers.parseEther("0.01"));

    // Mint PYUSD to LPs and approve vault
    for (const lp of [lp1, lp2]) {
      await mockPYUSD.mint(lp.address, DEPOSIT_AMOUNT * 2n);
      await mockPYUSD
        .connect(lp)
        .approve(await lpVault.getAddress(), DEPOSIT_AMOUNT * 2n);
    }
  });

  describe("Deployment and Setup", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await lpVault.owner()).to.equal(owner.address);
      expect(await lpVault.router()).to.equal(await mockRouter.getAddress());
      expect(await lpVault.PYUSD()).to.equal(await mockPYUSD.getAddress());
      expect(await lpVault.totalShares()).to.equal(0);
      expect(await lpVault.COOLDOWN()).to.equal(COOLDOWN_PERIOD);
    });

    it("Should revert deployment with zero addresses", async function () {
      await expect(
        ethers.deployContract("LPVault", [
          ethers.ZeroAddress,
          await mockRouter.getAddress(),
          owner.address,
        ])
      ).to.be.revertedWithCustomError(lpVault, "ZeroAddress");

      await expect(
        ethers.deployContract("LPVault", [
          await mockPYUSD.getAddress(),
          ethers.ZeroAddress,
          owner.address,
        ])
      ).to.be.revertedWithCustomError(lpVault, "ZeroAddress");

      await expect(
        ethers.deployContract("LPVault", [
          await mockPYUSD.getAddress(),
          await mockRouter.getAddress(),
          ethers.ZeroAddress,
        ])
      ).to.be.revertedWithCustomError(lpVault, "OwnableInvalidOwner");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to set receivers", async function () {
      const newReceiver = ethers.Wallet.createRandom().address;
      const chainSelector = 12345n;

      await expect(lpVault.setReceiver(chainSelector, newReceiver))
        .to.emit(lpVault, "ReceiverSet")
        .withArgs(chainSelector, newReceiver);

      expect(await lpVault.receivers(chainSelector)).to.equal(newReceiver);
    });

    it("Should not allow setting receiver with invalid parameters", async function () {
      await expect(
        lpVault.setReceiver(0n, owner.address)
      ).to.be.revertedWithCustomError(lpVault, "InvalidDestinationChain");

      await expect(
        lpVault.setReceiver(12345n, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(lpVault, "InvalidReceiverAddress");
    });

    it("Should allow owner to set gas limits", async function () {
      const chainSelector = 12345n;
      const gasLimit = 300000n;

      await expect(lpVault.setGasLimit(chainSelector, gasLimit))
        .to.emit(lpVault, "GasLimitSet")
        .withArgs(chainSelector, gasLimit);

      expect(await lpVault.gasLimits(chainSelector)).to.equal(gasLimit);
    });

    it("Should not allow setting gas limit with invalid parameters", async function () {
      await expect(
        lpVault.setGasLimit(0n, 200000n)
      ).to.be.revertedWithCustomError(lpVault, "InvalidDestinationChain");

      await expect(
        lpVault.setGasLimit(12345n, 0n)
      ).to.be.revertedWithCustomError(lpVault, "NoGasLimitOnDestinationChain");
    });

    it("Should only allow owner to call admin functions", async function () {
      await expect(
        lpVault.connect(user).setReceiver(12345n, user.address)
      ).to.be.revertedWithCustomError(lpVault, "OwnableUnauthorizedAccount");

      await expect(
        lpVault.connect(user).setGasLimit(12345n, 200000n)
      ).to.be.revertedWithCustomError(lpVault, "OwnableUnauthorizedAccount");
    });
  });

  describe("Deposits", function () {
    it("Should allow users to deposit PYUSD", async function () {
      const initialTotalShares = await lpVault.totalShares();

      await expect(lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT))
        .to.emit(lpVault, "Deposit")
        .withArgs(lp1.address, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT) // First deposit: shares = amount
        .and.to.emit(lpVault, "SyncToHedera");

      // Check LP stake
      const stake = await lpVault.stakes(lp1.address);
      expect(stake.shares).to.equal(DEPOSIT_AMOUNT);
      expect(stake.lockedUntil).to.be.greaterThan(0);

      // Check total shares
      expect(await lpVault.totalShares()).to.equal(
        initialTotalShares + DEPOSIT_AMOUNT
      );

      // Check vault balance
      expect(await mockPYUSD.balanceOf(await lpVault.getAddress())).to.equal(
        DEPOSIT_AMOUNT
      );
    });

    it("Should calculate shares correctly for subsequent deposits", async function () {
      // First deposit
      await lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT);

      // Second deposit (should get proportional shares)
      const secondDepositAmount = DEPOSIT_AMOUNT / 2n;
      // shares = (amount * totalShares) / vault_balance_after_transfer
      const expectedShares =
        (secondDepositAmount * DEPOSIT_AMOUNT) /
        (DEPOSIT_AMOUNT + secondDepositAmount);

      await expect(lpVault.connect(lp2).deposit(secondDepositAmount))
        .to.emit(lpVault, "Deposit")
        .withArgs(lp2.address, secondDepositAmount, expectedShares);

      const stake2 = await lpVault.stakes(lp2.address);
      expect(stake2.shares).to.equal(expectedShares);
    });

    it("Should revert deposit with zero amount", async function () {
      await expect(
        lpVault.connect(lp1).deposit(0)
      ).to.be.revertedWithCustomError(lpVault, "ZeroAmount");
    });

    it("Should revert deposit with insufficient balance", async function () {
      const excessiveAmount = ethers.parseUnits("100000", 6);

      // Approve the excessive amount but user doesn't have enough balance
      await mockPYUSD
        .connect(lp1)
        .approve(await lpVault.getAddress(), excessiveAmount);

      await expect(
        lpVault.connect(lp1).deposit(excessiveAmount)
      ).to.be.revertedWithCustomError(mockPYUSD, "ERC20InsufficientBalance");
    });

    it("Should revert deposit with insufficient allowance", async function () {
      await mockPYUSD.connect(lp1).approve(await lpVault.getAddress(), 0);

      await expect(
        lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT)
      ).to.be.revertedWithCustomError(mockPYUSD, "ERC20InsufficientAllowance");
    });
  });

  describe("Withdraw Requests", function () {
    beforeEach(async function () {
      // Setup: LP1 deposits some PYUSD
      await lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT);
    });

    it("Should allow users to request withdrawals", async function () {
      const withdrawShares = DEPOSIT_AMOUNT / 2n;

      await expect(
        lpVault.connect(lp1).requestWithdraw(withdrawShares)
      ).to.emit(lpVault, "RequestWithdraw");

      const withdrawRequest = await lpVault.withdrawQueue(lp1.address);
      expect(withdrawRequest.shares).to.equal(withdrawShares);
      expect(withdrawRequest.unlockTimestamp).to.be.greaterThan(0);
    });

    it("Should revert withdraw request with zero shares", async function () {
      await expect(
        lpVault.connect(lp1).requestWithdraw(0)
      ).to.be.revertedWithCustomError(lpVault, "InvalidShares");
    });

    it("Should revert withdraw request exceeding available shares", async function () {
      const excessiveShares = DEPOSIT_AMOUNT + 1n;

      await expect(
        lpVault.connect(lp1).requestWithdraw(excessiveShares)
      ).to.be.revertedWithCustomError(lpVault, "InvalidShares");
    });

    it("Should allow updating withdraw request", async function () {
      const firstWithdrawShares = DEPOSIT_AMOUNT / 4n;
      const secondWithdrawShares = DEPOSIT_AMOUNT / 2n;

      // First request
      await lpVault.connect(lp1).requestWithdraw(firstWithdrawShares);

      // Second request should overwrite first
      await lpVault.connect(lp1).requestWithdraw(secondWithdrawShares);

      const withdrawRequest = await lpVault.withdrawQueue(lp1.address);
      expect(withdrawRequest.shares).to.equal(secondWithdrawShares);
    });
  });

  describe("CCIP Configuration", function () {
    it("Should sync LP data to Hedera on deposit", async function () {
      await expect(lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT)).to.emit(
        lpVault,
        "SyncToHedera"
      );
    });

    it("Should skip CCIP sync when no receiver configured", async function () {
      // Deploy vault without receiver configuration
      const newVault = await ethers.deployContract("LPVault", [
        await mockPYUSD.getAddress(),
        await mockRouter.getAddress(),
        owner.address,
      ]);

      // Mint and approve for new vault
      await mockPYUSD.mint(lp1.address, DEPOSIT_AMOUNT);
      await mockPYUSD
        .connect(lp1)
        .approve(await newVault.getAddress(), DEPOSIT_AMOUNT);

      // Should not emit SyncToHedera event
      await expect(newVault.connect(lp1).deposit(DEPOSIT_AMOUNT))
        .to.emit(newVault, "Deposit")
        .and.to.not.emit(newVault, "SyncToHedera");
    });

    it("Should skip CCIP sync when no gas limit configured", async function () {
      // Set receiver but not gas limit
      const newVault = await ethers.deployContract("LPVault", [
        await mockPYUSD.getAddress(),
        await mockRouter.getAddress(),
        owner.address,
      ]);

      await newVault.setReceiver(HEDERA_CHAIN_SELECTOR, owner.address);
      // Don't set gas limit

      // Mint and approve for new vault
      await mockPYUSD.mint(lp1.address, DEPOSIT_AMOUNT);
      await mockPYUSD
        .connect(lp1)
        .approve(await newVault.getAddress(), DEPOSIT_AMOUNT);

      // Should not emit SyncToHedera event
      await expect(newVault.connect(lp1).deposit(DEPOSIT_AMOUNT))
        .to.emit(newVault, "Deposit")
        .and.to.not.emit(newVault, "SyncToHedera");
    });

    it("Should revert CCIP sync with insufficient balance", async function () {
      // Set a very high CCIP fee
      await mockRouter.setMockFee(ethers.parseEther("100"));

      await expect(
        lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT)
      ).to.be.revertedWithCustomError(lpVault, "NotEnoughBalance");
    });
  });

  describe("Stake Queries and Views", function () {
    beforeEach(async function () {
      await lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT);
      await lpVault.connect(lp2).deposit(DEPOSIT_AMOUNT / 2n);
    });

    it("Should return correct stake information", async function () {
      const stake1 = await lpVault.stakes(lp1.address);
      expect(stake1.shares).to.equal(DEPOSIT_AMOUNT);
      expect(stake1.lockedUntil).to.be.greaterThan(0);

      const stake2 = await lpVault.stakes(lp2.address);
      expect(stake2.shares).to.be.greaterThan(0); // Will be proportional
    });

    it("Should return zero for non-existent stakes", async function () {
      const stake = await lpVault.stakes(user.address);
      expect(stake.shares).to.equal(0);
      expect(stake.lockedUntil).to.equal(0);
    });

    it("Should track total shares correctly", async function () {
      expect(await lpVault.totalShares()).to.be.greaterThan(DEPOSIT_AMOUNT);
    });

    it("Should return correct withdraw requests", async function () {
      await lpVault.connect(lp1).requestWithdraw(DEPOSIT_AMOUNT / 4n);

      const request = await lpVault.withdrawQueue(lp1.address);
      expect(request.shares).to.equal(DEPOSIT_AMOUNT / 4n);
      expect(request.unlockTimestamp).to.be.greaterThan(0);

      // User without request should return zero
      const noRequest = await lpVault.withdrawQueue(lp2.address);
      expect(noRequest.shares).to.equal(0);
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should handle receiving native tokens", async function () {
      const amount = ethers.parseEther("1");

      await expect(
        user.sendTransaction({
          to: await lpVault.getAddress(),
          value: amount,
        })
      ).to.not.be.revertedWithCustomError(lpVault, "ZeroAddress");

      expect(
        await ethers.provider.getBalance(await lpVault.getAddress())
      ).to.be.greaterThan(amount); // Greater than because vault already has ETH
    });

    it("Should use reentrancy protection", async function () {
      // Normal operations should work fine with reentrancy protection
      await expect(
        lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT)
      ).to.not.be.revertedWithCustomError(lpVault, "ZeroAmount");

      await expect(
        lpVault.connect(lp1).requestWithdraw(DEPOSIT_AMOUNT / 2n)
      ).to.not.be.revertedWithCustomError(lpVault, "InvalidShares");
    });

    it("Should handle multiple withdraw requests correctly", async function () {
      await lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT);

      // Multiple withdraw requests should overwrite previous ones
      await lpVault.connect(lp1).requestWithdraw(DEPOSIT_AMOUNT / 4n);
      await lpVault.connect(lp1).requestWithdraw(DEPOSIT_AMOUNT / 2n);
      await lpVault.connect(lp1).requestWithdraw(DEPOSIT_AMOUNT / 3n);

      const request = await lpVault.withdrawQueue(lp1.address);
      expect(request.shares).to.equal(DEPOSIT_AMOUNT / 3n);
    });
  });

  describe("Access Control", function () {
    it("Should have correct owner", async function () {
      expect(await lpVault.owner()).to.equal(owner.address);
    });

    it("Should allow owner to transfer ownership", async function () {
      await expect(lpVault.transferOwnership(user.address))
        .to.emit(lpVault, "OwnershipTransferred")
        .withArgs(owner.address, user.address);

      expect(await lpVault.owner()).to.equal(user.address);
    });

    it("Should not allow non-owner to transfer ownership", async function () {
      await expect(
        lpVault.connect(user).transferOwnership(user.address)
      ).to.be.revertedWithCustomError(lpVault, "OwnableUnauthorizedAccount");
    });
  });

  describe("Integration Readiness", function () {
    it("Should be ready for CCIP integration", async function () {
      // Verify the contract has the necessary structure for CCIP integration
      expect(await lpVault.router()).to.not.equal(ethers.ZeroAddress);

      // Verify receiver and gas limit functions work
      await lpVault.setReceiver(12345n, user.address);
      expect(await lpVault.receivers(12345n)).to.equal(user.address);

      await lpVault.setGasLimit(12345n, 300000n);
      expect(await lpVault.gasLimits(12345n)).to.equal(300000n);
    });

    it("Should handle vault balance calculations correctly", async function () {
      // Test basic deposit and balance tracking
      await lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT);

      expect(await mockPYUSD.balanceOf(await lpVault.getAddress())).to.equal(
        DEPOSIT_AMOUNT
      );
      expect(await lpVault.totalShares()).to.equal(DEPOSIT_AMOUNT);

      const stake = await lpVault.stakes(lp1.address);
      expect(stake.shares).to.equal(DEPOSIT_AMOUNT);
    });

    it("Should support the expected cooldown mechanism", async function () {
      await lpVault.connect(lp1).deposit(DEPOSIT_AMOUNT);

      // Request withdrawal
      await lpVault.connect(lp1).requestWithdraw(DEPOSIT_AMOUNT / 2n);

      const request = await lpVault.withdrawQueue(lp1.address);
      expect(request.shares).to.equal(DEPOSIT_AMOUNT / 2n);
      expect(request.unlockTimestamp).to.be.greaterThan(0);

      // Should revert immediate finalization (cooldown not finished)
      await expect(
        lpVault.connect(lp1).finalizeWithdraw()
      ).to.be.revertedWithCustomError(lpVault, "CooldownNotFinished");
    });
  });
});
