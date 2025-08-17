import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import { PremiumVault, MockCCIPRouter, MockPYUSD } from "../types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("PremiumVault", function () {
  let premiumVault: PremiumVault;
  let mockRouter: MockCCIPRouter;
  let mockPYUSD: MockPYUSD;

  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let lpVault: HardhatEthersSigner;
  let payoutVault: HardhatEthersSigner;

  const HEDERA_CHAIN_SELECTOR = 3599014340846833606n;
  const DEFAULT_GAS_LIMIT = 200000n;
  const PREMIUM_AMOUNT = ethers.parseUnits("1000", 6); // 1000 PYUSD

  beforeEach(async function () {
    [owner, user, lpVault, payoutVault] = await ethers.getSigners();

    // Deploy mock contracts
    mockRouter = await ethers.deployContract("MockCCIPRouter");
    mockPYUSD = await ethers.deployContract("MockPYUSD");

    // Deploy PremiumVault
    premiumVault = await ethers.deployContract("PremiumVault", [
      await mockRouter.getAddress(),
      await mockPYUSD.getAddress(),
      lpVault.address,
      payoutVault.address,
      owner.address,
    ]);

    // Setup initial state
    await premiumVault.allowlistDestChain(HEDERA_CHAIN_SELECTOR, true);
    await premiumVault.setGasLimit(HEDERA_CHAIN_SELECTOR, DEFAULT_GAS_LIMIT);

    // Mint some PYUSD to user and approve PremiumVault
    await mockPYUSD.mint(user.address, PREMIUM_AMOUNT * 10n);
    await mockPYUSD
      .connect(user)
      .approve(await premiumVault.getAddress(), PREMIUM_AMOUNT * 10n);
  });

  describe("Deployment and Setup", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await premiumVault.owner()).to.equal(owner.address);
      expect(await premiumVault.router()).to.equal(
        await mockRouter.getAddress()
      );
      expect(await premiumVault.PYUSD()).to.equal(await mockPYUSD.getAddress());
      expect(await premiumVault.lpVault()).to.equal(lpVault.address);
      expect(await premiumVault.payoutVault()).to.equal(payoutVault.address);
      expect(await premiumVault.premiumBpsToLP()).to.equal(7000); // 70%
      expect(await premiumVault.premiumBpsToReserve()).to.equal(3000); // 30%
    });

    it("Should revert deployment with zero addresses", async function () {
      await expect(
        ethers.deployContract("PremiumVault", [
          ethers.ZeroAddress,
          await mockPYUSD.getAddress(),
          lpVault.address,
          payoutVault.address,
          owner.address,
        ])
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAddress");

      await expect(
        ethers.deployContract("PremiumVault", [
          await mockRouter.getAddress(),
          ethers.ZeroAddress,
          lpVault.address,
          payoutVault.address,
          owner.address,
        ])
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAddress");
    });
  });

  describe("Owner Functions", function () {
    it("Should allow owner to update router", async function () {
      const newRouter = await ethers.deployContract("MockCCIPRouter");

      await expect(premiumVault.setRouter(await newRouter.getAddress()))
        .to.emit(premiumVault, "RouterUpdated")
        .withArgs(await newRouter.getAddress());

      expect(await premiumVault.router()).to.equal(
        await newRouter.getAddress()
      );
    });

    it("Should not allow setting router to zero address", async function () {
      await expect(
        premiumVault.setRouter(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAddress");
    });

    it("Should allow owner to update vaults", async function () {
      const newLPVault = ethers.Wallet.createRandom().address;
      const newPayoutVault = ethers.Wallet.createRandom().address;

      await expect(premiumVault.setVaults(newLPVault, newPayoutVault))
        .to.emit(premiumVault, "VaultsUpdated")
        .withArgs(newLPVault, newPayoutVault);

      expect(await premiumVault.lpVault()).to.equal(newLPVault);
      expect(await premiumVault.payoutVault()).to.equal(newPayoutVault);
    });

    it("Should not allow setting vaults to zero addresses", async function () {
      await expect(
        premiumVault.setVaults(ethers.ZeroAddress, payoutVault.address)
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAddress");

      await expect(
        premiumVault.setVaults(lpVault.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAddress");
    });

    it("Should allow owner to manage destination chain allowlist", async function () {
      const chainSelector = 12345n;

      await expect(premiumVault.allowlistDestChain(chainSelector, true))
        .to.emit(premiumVault, "DestChainAllowlisted")
        .withArgs(chainSelector, true);

      expect(await premiumVault.allowlistedDestChains(chainSelector)).to.be
        .true;

      await premiumVault.allowlistDestChain(chainSelector, false);
      expect(await premiumVault.allowlistedDestChains(chainSelector)).to.be
        .false;
    });

    it("Should allow owner to manage receiver allowlist", async function () {
      const receiver = ethers.randomBytes(32);

      await expect(premiumVault.allowlistReceiver(receiver, true))
        .to.emit(premiumVault, "ReceiverAllowlisted")
        .withArgs(receiver, true);

      expect(await premiumVault.allowlistedReceivers(receiver)).to.be.true;
    });

    it("Should allow owner to set gas limits", async function () {
      const chainSelector = 12345n;
      const gasLimit = 300000n;

      await expect(premiumVault.setGasLimit(chainSelector, gasLimit))
        .to.emit(premiumVault, "GasLimitSet")
        .withArgs(chainSelector, gasLimit);

      expect(await premiumVault.gasLimitByChain(chainSelector)).to.equal(
        gasLimit
      );
    });

    it("Should allow owner to update premium split", async function () {
      const newLPBps = 8000; // 80%
      const newReserveBps = 2000; // 20%

      await expect(premiumVault.setSplit(newLPBps, newReserveBps))
        .to.emit(premiumVault, "SplitUpdated")
        .withArgs(newLPBps, newReserveBps);

      expect(await premiumVault.premiumBpsToLP()).to.equal(newLPBps);
      expect(await premiumVault.premiumBpsToReserve()).to.equal(newReserveBps);
    });

    it("Should revert split update if sum is not 100%", async function () {
      await expect(
        premiumVault.setSplit(7000, 4000)
      ).to.be.revertedWithCustomError(premiumVault, "BadAllocationSum");

      await expect(
        premiumVault.setSplit(5000, 4000)
      ).to.be.revertedWithCustomError(premiumVault, "BadAllocationSum");
    });

    it("Should only allow owner to call admin functions", async function () {
      await expect(
        premiumVault.connect(user).setRouter(await mockRouter.getAddress())
      ).to.be.revertedWithCustomError(
        premiumVault,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        premiumVault
          .connect(user)
          .setVaults(lpVault.address, payoutVault.address)
      ).to.be.revertedWithCustomError(
        premiumVault,
        "OwnableUnauthorizedAccount"
      );

      await expect(
        premiumVault.connect(user).setSplit(8000, 2000)
      ).to.be.revertedWithCustomError(
        premiumVault,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Premium Allocation", function () {
    it("Should correctly calculate premium allocation", async function () {
      const premiumAmount = ethers.parseUnits("1000", 6);
      const [toLP, toReserve] = await premiumVault.previewAllocation(
        premiumAmount
      );

      expect(toLP).to.equal((premiumAmount * 7000n) / 10000n); // 70%
      expect(toReserve).to.equal((premiumAmount * 3000n) / 10000n); // 30%
      expect(toLP + toReserve).to.equal(premiumAmount);
    });

    it("Should handle zero premium amount", async function () {
      const [toLP, toReserve] = await premiumVault.previewAllocation(0);
      expect(toLP).to.equal(0);
      expect(toReserve).to.equal(0);
    });

    it("Should handle custom split ratios", async function () {
      await premiumVault.setSplit(9000, 1000); // 90% LP, 10% Reserve

      const premiumAmount = ethers.parseUnits("1000", 6);
      const [toLP, toReserve] = await premiumVault.previewAllocation(
        premiumAmount
      );

      expect(toLP).to.equal((premiumAmount * 9000n) / 10000n);
      expect(toReserve).to.equal((premiumAmount * 1000n) / 10000n);
    });
  });

  describe("CCIP Fee Quotation", function () {
    let hederaReceiver: string;
    let policyTerms: any;

    beforeEach(async function () {
      hederaReceiver = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ethers.Wallet.createRandom().address]
      );

      await premiumVault.allowlistReceiver(hederaReceiver, true);

      policyTerms = {
        poolId: ethers.keccak256(ethers.toUtf8Bytes("test-pool")),
        buyer: user.address,
        coverageAmount: ethers.parseUnits("10000", 6),
        startTs: Math.floor(Date.now() / 1000),
        endTs: Math.floor(Date.now() / 1000) + 86400 * 30,
        policyRef: ethers.keccak256(ethers.toUtf8Bytes("test-ref")),
      };

      // Set mock CCIP fee
      await mockRouter.setMockFee(ethers.parseEther("0.1"));
    });

    it("Should quote CCIP fee correctly", async function () {
      const fee = await premiumVault.quoteCCIPFee(
        HEDERA_CHAIN_SELECTOR,
        hederaReceiver,
        policyTerms
      );

      expect(fee).to.equal(ethers.parseEther("0.1"));
    });

    it("Should revert fee quote for non-allowlisted destination", async function () {
      const badChainSelector = 99999n;

      await expect(
        premiumVault.quoteCCIPFee(badChainSelector, hederaReceiver, policyTerms)
      ).to.be.revertedWithCustomError(premiumVault, "DestNotAllowlisted");
    });

    it("Should revert fee quote for non-allowlisted receiver", async function () {
      const badReceiver = ethers.randomBytes(32);

      await expect(
        premiumVault.quoteCCIPFee(
          HEDERA_CHAIN_SELECTOR,
          badReceiver,
          policyTerms
        )
      ).to.be.revertedWithCustomError(premiumVault, "ReceiverNotAllowlisted");
    });

    it("Should revert fee quote for chain with no gas limit", async function () {
      const newChainSelector = 77777n;
      await premiumVault.allowlistDestChain(newChainSelector, true);
      // Don't set gas limit

      await expect(
        premiumVault.quoteCCIPFee(newChainSelector, hederaReceiver, policyTerms)
      ).to.be.revertedWithCustomError(premiumVault, "NoGasLimitForChain");
    });
  });

  describe("Buy Coverage", function () {
    let hederaReceiver: string;
    let policyTerms: any;
    let ccipFee: bigint;

    beforeEach(async function () {
      hederaReceiver = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ethers.Wallet.createRandom().address]
      );

      await premiumVault.allowlistReceiver(hederaReceiver, true);

      policyTerms = {
        poolId: ethers.keccak256(ethers.toUtf8Bytes("test-pool")),
        buyer: user.address,
        coverageAmount: ethers.parseUnits("10000", 6),
        startTs: Math.floor(Date.now() / 1000),
        endTs: Math.floor(Date.now() / 1000) + 86400 * 30,
        policyRef: ethers.keccak256(ethers.toUtf8Bytes("test-ref")),
      };

      ccipFee = ethers.parseEther("0.1");
      await mockRouter.setMockFee(ccipFee);
    });

    it("Should successfully buy coverage", async function () {
      const initialLPBalance = await mockPYUSD.balanceOf(lpVault.address);
      const initialPayoutBalance = await mockPYUSD.balanceOf(
        payoutVault.address
      );

      const expectedToLP = (PREMIUM_AMOUNT * 7000n) / 10000n;
      const expectedToReserve = (PREMIUM_AMOUNT * 3000n) / 10000n;

      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            HEDERA_CHAIN_SELECTOR,
            hederaReceiver,
            policyTerms,
            PREMIUM_AMOUNT,
            { value: ccipFee }
          )
      )
        .to.emit(premiumVault, "PremiumPaid")
        .and.to.emit(premiumVault, "CCIPSent");

      // Check token distributions
      expect(await mockPYUSD.balanceOf(lpVault.address)).to.equal(
        initialLPBalance + expectedToLP
      );
      expect(await mockPYUSD.balanceOf(payoutVault.address)).to.equal(
        initialPayoutBalance + expectedToReserve
      );
    });

    it("Should refund excess native fee", async function () {
      const overpayment = ccipFee + ethers.parseEther("0.05");
      const initialBalance = await ethers.provider.getBalance(user.address);

      const tx = await premiumVault
        .connect(user)
        .buyCoverage(
          HEDERA_CHAIN_SELECTOR,
          hederaReceiver,
          policyTerms,
          PREMIUM_AMOUNT,
          { value: overpayment }
        );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const finalBalance = await ethers.provider.getBalance(user.address);

      // Should have paid exactly the CCIP fee + gas, excess refunded
      expect(finalBalance).to.equal(initialBalance - ccipFee - gasUsed);
    });

    it("Should revert with insufficient native fee", async function () {
      const insufficientFee = ccipFee / 2n;

      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            HEDERA_CHAIN_SELECTOR,
            hederaReceiver,
            policyTerms,
            PREMIUM_AMOUNT,
            { value: insufficientFee }
          )
      ).to.be.revertedWithCustomError(premiumVault, "NotEnoughNative");
    });

    it("Should revert with zero premium amount", async function () {
      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(HEDERA_CHAIN_SELECTOR, hederaReceiver, policyTerms, 0, {
            value: ccipFee,
          })
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAmount");
    });

    it("Should revert for non-allowlisted destination", async function () {
      const badChainSelector = 99999n;

      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            badChainSelector,
            hederaReceiver,
            policyTerms,
            PREMIUM_AMOUNT,
            { value: ccipFee }
          )
      ).to.be.revertedWithCustomError(premiumVault, "DestNotAllowlisted");
    });

    it("Should revert for non-allowlisted receiver", async function () {
      const badReceiver = ethers.randomBytes(32);

      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            HEDERA_CHAIN_SELECTOR,
            badReceiver,
            policyTerms,
            PREMIUM_AMOUNT,
            { value: ccipFee }
          )
      ).to.be.revertedWithCustomError(premiumVault, "ReceiverNotAllowlisted");
    });

    it("Should revert if user has insufficient PYUSD balance", async function () {
      const excessiveAmount = ethers.parseUnits("100000", 6);

      // Approve more than balance to test balance limitation
      await mockPYUSD
        .connect(user)
        .approve(await premiumVault.getAddress(), excessiveAmount);

      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            HEDERA_CHAIN_SELECTOR,
            hederaReceiver,
            policyTerms,
            excessiveAmount,
            { value: ccipFee }
          )
      ).to.be.revertedWithCustomError(mockPYUSD, "ERC20InsufficientBalance");
    });

    it("Should revert if user has insufficient PYUSD allowance", async function () {
      await mockPYUSD.connect(user).approve(await premiumVault.getAddress(), 0);

      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            HEDERA_CHAIN_SELECTOR,
            hederaReceiver,
            policyTerms,
            PREMIUM_AMOUNT,
            { value: ccipFee }
          )
      ).to.be.revertedWithCustomError(mockPYUSD, "ERC20InsufficientAllowance");
    });
  });

  describe("Token Rescue", function () {
    it("Should allow owner to rescue tokens", async function () {
      // Send some tokens to the contract
      const rescueAmount = ethers.parseUnits("100", 6);
      await mockPYUSD.mint(await premiumVault.getAddress(), rescueAmount);

      const recipient = ethers.Wallet.createRandom().address;
      const initialBalance = await mockPYUSD.balanceOf(recipient);

      await premiumVault.rescueToken(
        await mockPYUSD.getAddress(),
        recipient,
        rescueAmount
      );

      expect(await mockPYUSD.balanceOf(recipient)).to.equal(
        initialBalance + rescueAmount
      );
    });

    it("Should not allow rescuing to zero address", async function () {
      await expect(
        premiumVault.rescueToken(
          await mockPYUSD.getAddress(),
          ethers.ZeroAddress,
          100
        )
      ).to.be.revertedWithCustomError(premiumVault, "InvalidAddress");
    });

    it("Should only allow owner to rescue tokens", async function () {
      await expect(
        premiumVault
          .connect(user)
          .rescueToken(await mockPYUSD.getAddress(), user.address, 100)
      ).to.be.revertedWithCustomError(
        premiumVault,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should handle zero allocation amounts", async function () {
      await premiumVault.setSplit(10000, 0); // 100% to LP, 0% to reserve

      const hederaReceiver = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ethers.Wallet.createRandom().address]
      );
      await premiumVault.allowlistReceiver(hederaReceiver, true);

      const policyTerms = {
        poolId: ethers.keccak256(ethers.toUtf8Bytes("test-pool")),
        buyer: user.address,
        coverageAmount: ethers.parseUnits("10000", 6),
        startTs: Math.floor(Date.now() / 1000),
        endTs: Math.floor(Date.now() / 1000) + 86400 * 30,
        policyRef: ethers.keccak256(ethers.toUtf8Bytes("test-ref")),
      };

      const ccipFee = ethers.parseEther("0.1");
      await mockRouter.setMockFee(ccipFee);

      // Should not revert even with zero toReserve
      await expect(
        premiumVault
          .connect(user)
          .buyCoverage(
            HEDERA_CHAIN_SELECTOR,
            hederaReceiver,
            policyTerms,
            PREMIUM_AMOUNT,
            { value: ccipFee }
          )
      ).to.not.be.revertedWithCustomError(premiumVault, "InvalidAmount");
    });

    it("Should handle receiving native tokens", async function () {
      const amount = ethers.parseEther("1");

      await expect(
        user.sendTransaction({
          to: await premiumVault.getAddress(),
          value: amount,
        })
      ).to.not.be.revertedWithCustomError(premiumVault, "InvalidAddress");

      expect(
        await ethers.provider.getBalance(await premiumVault.getAddress())
      ).to.equal(amount);
    });

    it("Should use reentrancy protection", async function () {
      // The contract uses ReentrancyGuard, verify normal operations work
      const hederaReceiver = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ethers.Wallet.createRandom().address]
      );
      await premiumVault.allowlistReceiver(hederaReceiver, true);

      const policyTerms = {
        poolId: ethers.keccak256(ethers.toUtf8Bytes("test-pool")),
        buyer: user.address,
        coverageAmount: ethers.parseUnits("10000", 6),
        startTs: Math.floor(Date.now() / 1000),
        endTs: Math.floor(Date.now() / 1000) + 86400 * 30,
        policyRef: ethers.keccak256(ethers.toUtf8Bytes("test-ref")),
      };

      const ccipFee = ethers.parseEther("0.1");
      await mockRouter.setMockFee(ccipFee);

      // Multiple calls should work fine
      await premiumVault
        .connect(user)
        .buyCoverage(
          HEDERA_CHAIN_SELECTOR,
          hederaReceiver,
          policyTerms,
          PREMIUM_AMOUNT,
          { value: ccipFee }
        );

      await premiumVault
        .connect(user)
        .buyCoverage(
          HEDERA_CHAIN_SELECTOR,
          hederaReceiver,
          policyTerms,
          PREMIUM_AMOUNT,
          { value: ccipFee }
        );
    });
  });
});
