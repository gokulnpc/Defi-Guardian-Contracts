import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();
import {
  ClaimManager,
  MockCCIPRouter,
  VotingMirror,
  PolicyManager,
} from "../types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ClaimManager - Simple Tests", function () {
  let claimManager: ClaimManager;
  let mockRouter: MockCCIPRouter;
  let votingMirror: VotingMirror;
  let policyManager: PolicyManager;
  
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    // Deploy mock contracts
    mockRouter = await ethers.deployContract("MockCCIPRouter");
    
    // Deploy VotingMirror
    votingMirror = await ethers.deployContract("VotingMirror", [
      await mockRouter.getAddress(),
      owner.address,
    ]);

    // Deploy PolicyManager
    policyManager = await ethers.deployContract("PolicyManager", [
      await mockRouter.getAddress(),
      owner.address,
    ]);

    // Deploy ClaimManager
    claimManager = await ethers.deployContract("ClaimManager", [
      await mockRouter.getAddress(),
      await votingMirror.getAddress(),
      await policyManager.getAddress(),
      owner.address,
    ]);
  });

  describe("Deployment and Basic Setup", function () {
    it("Should deploy with correct initial parameters", async function () {
      expect(await claimManager.owner()).to.equal(owner.address);
      expect(await claimManager.votingMirror()).to.equal(await votingMirror.getAddress());
      expect(await claimManager.policyManager()).to.equal(await policyManager.getAddress());
      expect(await claimManager.router()).to.equal(await mockRouter.getAddress());
      expect(await claimManager.votingPeriodSeconds()).to.equal(300); // 5 minutes
      expect(await claimManager.quorumBps()).to.equal(2000); // 20%
      expect(await claimManager.nextClaimId()).to.equal(0);
    });

    it("Should allow owner to update voting parameters", async function () {
      const newVotingPeriod = 600; // 10 minutes
      const newQuorum = 3000; // 30%

      await expect(claimManager.setParams(newVotingPeriod, newQuorum))
        .to.emit(claimManager, "ParamsUpdated")
        .withArgs(newVotingPeriod, newQuorum);

      expect(await claimManager.votingPeriodSeconds()).to.equal(newVotingPeriod);
      expect(await claimManager.quorumBps()).to.equal(newQuorum);
    });

    it("Should reject invalid parameters", async function () {
      // Zero voting period
      await expect(claimManager.setParams(0, 2000))
        .to.be.revertedWithCustomError(claimManager, "BadParams");
      
      // Quorum > 100%
      await expect(claimManager.setParams(300, 10001))
        .to.be.revertedWithCustomError(claimManager, "BadParams");
    });

    it("Should only allow owner to update parameters", async function () {
      await expect(claimManager.connect(user).setParams(600, 3000))
        .to.be.revertedWithCustomError(claimManager, "OwnableUnauthorizedAccount");
    });
  });

  describe("Allowlist Management", function () {
    it("Should manage destination chain allowlist", async function () {
      const chainSelector = 12345n;
      
      expect(await claimManager.allowlistedDestChains(chainSelector)).to.be.false;
      
      await expect(claimManager.allowlistDestChain(chainSelector, true))
        .to.emit(claimManager, "DestAllowlisted")
        .withArgs(chainSelector, true);
      
      expect(await claimManager.allowlistedDestChains(chainSelector)).to.be.true;
      
      await claimManager.allowlistDestChain(chainSelector, false);
      expect(await claimManager.allowlistedDestChains(chainSelector)).to.be.false;
    });

    it("Should manage receiver allowlist", async function () {
      const receiver = ethers.randomBytes(32);
      
      expect(await claimManager.allowlistedReceivers(receiver)).to.be.false;
      
      await expect(claimManager.allowlistReceiver(receiver, true))
        .to.emit(claimManager, "ReceiverAllowlisted")
        .withArgs(receiver, true);
      
      expect(await claimManager.allowlistedReceivers(receiver)).to.be.true;
    });

    it("Should manage gas limits by chain", async function () {
      const chainSelector = 12345n;
      const gasLimit = 200000n;
      
      expect(await claimManager.gasLimitByChain(chainSelector)).to.equal(0);
      
      await expect(claimManager.setGasLimit(chainSelector, gasLimit))
        .to.emit(claimManager, "GasLimitSet")
        .withArgs(chainSelector, gasLimit);
      
      expect(await claimManager.gasLimitByChain(chainSelector)).to.equal(gasLimit);
    });

    it("Should only allow owner to manage allowlists", async function () {
      await expect(claimManager.connect(user).allowlistDestChain(12345n, true))
        .to.be.revertedWithCustomError(claimManager, "OwnableUnauthorizedAccount");
        
      await expect(claimManager.connect(user).allowlistReceiver(ethers.randomBytes(32), true))
        .to.be.revertedWithCustomError(claimManager, "OwnableUnauthorizedAccount");
        
      await expect(claimManager.connect(user).setGasLimit(12345n, 200000n))
        .to.be.revertedWithCustomError(claimManager, "OwnableUnauthorizedAccount");
    });
  });

  describe("Contract Updates", function () {
    it("Should allow owner to update router", async function () {
      const newRouter = await ethers.deployContract("MockCCIPRouter");
      
      await expect(claimManager.setRouter(await newRouter.getAddress()))
        .to.emit(claimManager, "RouterUpdated")
        .withArgs(await newRouter.getAddress());
      
      expect(await claimManager.router()).to.equal(await newRouter.getAddress());
    });

    it("Should allow owner to update voting mirror", async function () {
      const newVotingMirror = await ethers.deployContract("VotingMirror", [
        await mockRouter.getAddress(),
        owner.address,
      ]);
      
      await expect(claimManager.setVotingMirror(await newVotingMirror.getAddress()))
        .to.emit(claimManager, "VotingMirrorUpdated")
        .withArgs(await newVotingMirror.getAddress());
      
      expect(await claimManager.votingMirror()).to.equal(await newVotingMirror.getAddress());
    });

    it("Should allow owner to update policy manager", async function () {
      const newPolicyManager = await ethers.deployContract("PolicyManager", [
        await mockRouter.getAddress(),
        owner.address,
      ]);
      
      await expect(claimManager.setPolicyManager(await newPolicyManager.getAddress()))
        .to.emit(claimManager, "PolicyManagerUpdated")
        .withArgs(await newPolicyManager.getAddress());
      
      expect(await claimManager.policyManager()).to.equal(await newPolicyManager.getAddress());
    });

    it("Should only allow owner to update contracts", async function () {
      const newRouter = await ethers.deployContract("MockCCIPRouter");
      
      await expect(claimManager.connect(user).setRouter(await newRouter.getAddress()))
        .to.be.revertedWithCustomError(claimManager, "OwnableUnauthorizedAccount");
    });
  });

  describe("MockCCIPRouter", function () {
    it("Should set and return fees correctly", async function () {
      const fee = ethers.parseEther("0.1");
      await mockRouter.setMockFee(fee);
      
      const mockMessage = {
        receiver: ethers.randomBytes(32),
        data: ethers.randomBytes(64),
        tokenAmounts: [],
        feeToken: ethers.ZeroAddress,
        extraArgs: "0x"
      };
      
      expect(await mockRouter.getFee(12345n, mockMessage)).to.equal(fee);
    });

    it("Should handle CCIP send with correct fee", async function () {
      const fee = ethers.parseEther("0.1");
      await mockRouter.setMockFee(fee);
      
      const mockMessage = {
        receiver: ethers.randomBytes(32),
        data: ethers.randomBytes(64),
        tokenAmounts: [],
        feeToken: ethers.ZeroAddress,
        extraArgs: "0x"
      };
      
      await expect(mockRouter.ccipSend(12345n, mockMessage, { value: fee }))
        .to.not.be.revertedWith("Insufficient fee");
        
      expect(await mockRouter.lastMessageId()).to.not.equal(ethers.ZeroHash);
    });

    it("Should revert CCIP send with insufficient fee", async function () {
      const fee = ethers.parseEther("0.1");
      await mockRouter.setMockFee(fee);
      
      const mockMessage = {
        receiver: ethers.randomBytes(32),
        data: ethers.randomBytes(64),
        tokenAmounts: [],
        feeToken: ethers.ZeroAddress,
        extraArgs: "0x"
      };
      
      await expect(mockRouter.ccipSend(12345n, mockMessage, { value: fee / 2n }))
        .to.be.revertedWith("Insufficient fee");
    });
  });
});
