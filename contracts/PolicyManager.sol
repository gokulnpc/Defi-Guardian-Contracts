// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * PolicyManager (Hedera EVM)
 * - CCIP receiver for policy premium proofs from Arbitrum PremiumVault
 * - Records policy and mints an ERC721 Policy NFT to the buyer
 * - Simple allowlists for source chain selector and sender (bytes)
 */

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Minimal CCIP interfaces for hackathon
interface IRouterClient {
    function ccipSend(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message) external payable returns (bytes32);
    function getFee(uint64 destinationChainSelector, Client.EVM2AnyMessage calldata message) external view returns (uint256);
}

library Client {
    struct EVMTokenAmount {
        address token;
        uint256 amount;
    }

    struct EVM2AnyMessage {
        bytes receiver;
        bytes data;
        EVMTokenAmount[] tokenAmounts;
        address feeToken;
        bytes extraArgs;
    }

    struct Any2EVMMessage {
        bytes32 messageId;
        uint64 sourceChainSelector;
        bytes sender;
        bytes data;
        EVMTokenAmount[] destTokenAmounts;
    }

    function _argsToBytes(GenericExtraArgsV2 memory _args) internal pure returns (bytes memory) {
        return abi.encode(_args);
    }

    struct GenericExtraArgsV2 {
        uint256 gasLimit;
        bool allowOutOfOrderExecution;
    }
}

// Minimal CCIPReceiver implementation
abstract contract CCIPReceiver {
    IRouterClient public immutable router;

    constructor(address _router) {
        router = IRouterClient(_router);
    }

    function _ccipReceive(Client.Any2EVMMessage memory message) internal virtual;
}

contract PolicyManager is CCIPReceiver, ERC721, Ownable, ReentrancyGuard {
  // ───────────────────────── Errors ─────────────────────────
  error NotAllowlistedChain(uint64 sel);
  error NotAllowlistedSender(bytes sender);
  error ZeroAddress();
  error MessageAlreadyProcessed(bytes32 messageId);

  // ───────────────────────── CCIP allowlists ─────────────────────────
  mapping(uint64 => bool) public allowlistedSourceChains;
  mapping(bytes => bool)  public allowlistedSenders;

  // ───────────────────────── Message tracking ─────────────────────────
  mapping(bytes32 => bool) public processedMessages;

  // ───────────────────────── Policy tracking ─────────────────────────
  uint256 public nextTokenId;

  struct Policy {
    bytes32 poolId;
    address buyer;            // evm address (from Arbitrum)
    uint256 coverageAmount;
    uint64  startTs;
    uint64  endTs;
    bytes32 policyRef;
    uint256 tokenId;
    bool    active;
  }

  // policyId (bytes32) => Policy
  mapping(bytes32 => Policy) public policies;

  // ───────────────────────── Events ─────────────────────────
  event SourceChainAllowlisted(uint64 selector, bool allowed);
  event SenderAllowlisted(bytes sender, bool allowed);
  event PolicyRegistered(bytes32 indexed policyId, address indexed buyer, uint256 tokenId);

  constructor(address _router, address _owner)
    CCIPReceiver(_router)
    ERC721("DeFiGuardians Policy", "DG-POL")
    Ownable(_owner)
  {}

  // ───────────────────────── Admin functions ─────────────────────────
  function allowlistSourceChain(uint64 selector, bool allowed) external onlyOwner {
    allowlistedSourceChains[selector] = allowed;
    emit SourceChainAllowlisted(selector, allowed);
  }

  function allowlistSender(bytes calldata sender, bool allowed) external onlyOwner {
    allowlistedSenders[sender] = allowed;
    emit SenderAllowlisted(sender, allowed);
  }

  // ───────────────────────── CCIP receive ─────────────────────────
  // Incoming CCIP messages from Arbitrum PremiumVault
  // Expects `abi.encode(PolicyTerms)` as payload
  struct PolicyTerms {
    bytes32 poolId;
    address buyer;
    uint256 coverageAmount;
    uint64  startTs;
    uint64  endTs;
    bytes32 policyRef;
  }

  function _ccipReceive(Client.Any2EVMMessage memory m) internal override nonReentrant {
    // Check for duplicate message processing
    if (processedMessages[m.messageId]) revert MessageAlreadyProcessed(m.messageId);
    
    // 1) Defensive checks
    if (!allowlistedSourceChains[m.sourceChainSelector]) revert NotAllowlistedChain(m.sourceChainSelector);
    if (!allowlistedSenders[m.sender]) revert NotAllowlistedSender(m.sender);

    // Mark message as processed to prevent reentrancy and duplicate processing
    processedMessages[m.messageId] = true;

    // 2) Decode terms and derive deterministic policyId
    PolicyTerms memory t = abi.decode(m.data, (PolicyTerms));
    bytes32 policyId = keccak256(abi.encode(t.poolId, t.buyer, t.coverageAmount, t.startTs, t.endTs, t.policyRef));

    // 3) Mint a Policy NFT to the buyer (hackathon-simple)
    uint256 tokenId = ++nextTokenId;
    _safeMint(t.buyer, tokenId);

    // 4) Store
    policies[policyId] = Policy({
      poolId: t.poolId,
      buyer: t.buyer,
      coverageAmount: t.coverageAmount,
      startTs: t.startTs,
      endTs: t.endTs,
      policyRef: t.policyRef,
      tokenId: tokenId,
      active: true
    });

    emit PolicyRegistered(policyId, t.buyer, tokenId);
  }

  // ───────────────────────── Helper functions ─────────────────────────
  function getPolicy(bytes32 policyId) external view returns (Policy memory) {
    return policies[policyId];
  }
}
