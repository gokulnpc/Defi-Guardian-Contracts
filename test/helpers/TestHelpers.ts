import { network } from "hardhat";
import * as helpers from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = await network.connect();

export class TestHelpers {
  // Time utilities
  static async getCurrentTime(): Promise<number> {
    const blockNum = await ethers.provider.getBlockNumber();
    const block = await ethers.provider.getBlock(blockNum);
    return block?.timestamp || 0;
  }

  static async increaseTime(seconds: number): Promise<void> {
    await helpers.time.increase(seconds);
  }

  static async setNextBlockTimestamp(timestamp: number): Promise<void> {
    await helpers.time.setNextBlockTimestamp(timestamp);
  }

  // Address utilities
  static generateRandomAddress(): string {
    return ethers.Wallet.createRandom().address;
  }

  static generateRandomBytes32(): string {
    return ethers.keccak256(ethers.randomBytes(32));
  }

  // CCIP message utilities
  static encodeCCIPMessage(data: any): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [data]);
  }

  static createMockCCIPMessage(
    messageId: string,
    sourceChainSelector: bigint,
    sender: string,
    data: string
  ) {
    return {
      messageId,
      sourceChainSelector,
      sender: ethers.AbiCoder.defaultAbiCoder().encode(["address"], [sender]),
      data,
      destTokenAmounts: [],
    };
  }

  // Policy utilities
  static createPolicyTerms(
    poolId: string,
    buyer: string,
    coverageAmount: bigint,
    startTs: bigint,
    endTs: bigint,
    policyRef: string
  ) {
    return {
      poolId,
      buyer,
      coverageAmount,
      startTs,
      endTs,
      policyRef,
    };
  }

  static encodePolicyTerms(terms: any): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(bytes32,address,uint256,uint64,uint64,bytes32)"],
      [
        [
          terms.poolId,
          terms.buyer,
          terms.coverageAmount,
          terms.startTs,
          terms.endTs,
          terms.policyRef,
        ],
      ]
    );
  }

  // Voting power update utilities
  static createVotingUpdate(lp: string, power: bigint, isDelta: boolean) {
    return {
      lp,
      power,
      isDelta,
    };
  }

  static encodeVotingUpdates(updates: any[]): string {
    const encodedUpdates = updates.map((u) => [u.lp, u.power, u.isDelta]);
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address,uint256,bool)[]"],
      [encodedUpdates]
    );
  }

  // Payout instruction utilities
  static createPayoutInstruction(
    claimId: bigint,
    claimant: string,
    amount: bigint
  ): string {
    const TAG = ethers.keccak256(ethers.toUtf8Bytes("DG_PAYOUT_V1"));
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "uint256"],
      [TAG, claimId, claimant, amount]
    );
  }

  // BPS calculations
  static calculateBPS(amount: bigint, bps: number): bigint {
    return (amount * BigInt(bps)) / 10000n;
  }

  // Error message helpers
  static expectRevert(
    promise: Promise<any>,
    expectedError?: string
  ): Promise<any> {
    return promise.then(
      () => {
        throw new Error("Expected transaction to revert");
      },
      (error) => {
        if (expectedError && !error.message.includes(expectedError)) {
          throw new Error(
            `Expected error "${expectedError}" but got "${error.message}"`
          );
        }
        return error;
      }
    );
  }
}

export const CHAIN_SELECTORS = {
  ARBITRUM: 4949039107694359620n,
  HEDERA: 3599014340846833606n,
  ETHEREUM: 5009297550715157269n,
};

export const DEFAULT_GAS_LIMITS = {
  STANDARD: 200000n,
  COMPLEX: 500000n,
};

export const DEFAULT_BPS = {
  PREMIUM_TO_LP: 7000, // 70%
  PREMIUM_TO_PAYOUT: 3000, // 30%
  QUORUM: 2000, // 20%
};

export const TIME_CONSTANTS = {
  ONE_DAY: 86400,
  ONE_WEEK: 604800,
  VOTING_PERIOD: 300, // 5 minutes
};
