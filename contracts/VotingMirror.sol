// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * VotingMirror (Hedera EVM)
 * - CCIP receiver of LP voting power from Arbitrum
 * - Exposes vPowerOf() and totalPower() for ClaimManager quorum/weights
 */

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

contract VotingMirror is CCIPReceiver, Ownable, ReentrancyGuard {
  // ───────────────────────── Errors ─────────────────────────
  error NotAllowlistedChain(uint64 sel);
  error NotAllowlistedSender(bytes sender);
  error MessageAlreadyProcessed(bytes32 messageId);

  // ───────────────────────── CCIP allowlists ─────────────────────────
  mapping(uint64 => bool) public allowlistedSourceChains;
  mapping(bytes => bool)  public allowlistedSenders;

  // ───────────────────────── Message tracking ─────────────────────────
  mapping(bytes32 => bool) public processedMessages;

  // ───────────────────────── Voting power tracking ─────────────────────────
  mapping(address => uint256) public vPower;
  uint256 public totalPowerCached;

  // ───────────────────────── Events ─────────────────────────
  event SourceChainAllowlisted(uint64 selector, bool allowed);
  event SenderAllowlisted(bytes sender, bool allowed);
  event PowerSet(address indexed lp, uint256 power, uint256 totalPower);

  constructor(address router, address _owner) CCIPReceiver(router) Ownable(_owner) {}

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
  struct Update {
    address lp;
    uint256 power;
    bool    isDelta; // if true: add/sub; if false: absolute set
  }

  function _ccipReceive(Client.Any2EVMMessage memory m) internal override nonReentrant {
    // Check for duplicate message processing
    if (processedMessages[m.messageId]) revert MessageAlreadyProcessed(m.messageId);
    
    if (!allowlistedSourceChains[m.sourceChainSelector]) revert NotAllowlistedChain(m.sourceChainSelector);
    if (!allowlistedSenders[m.sender]) revert NotAllowlistedSender(m.sender);

    // Mark message as processed to prevent reentrancy and duplicate processing
    processedMessages[m.messageId] = true;

    Update[] memory ups = abi.decode(m.data, (Update[]));
    uint256 newTotal = totalPowerCached;

    for (uint256 i = 0; i < ups.length; i++) {
      Update memory u = ups[i];
      uint256 old = vPower[u.lp];
      uint256 fresh;

      if (u.isDelta) {
        // delta update (can be add or subtract)
        if (u.power > 0) {
          // interpret sign by convention: use two messages for add/sub, or encode negative via separate flag in a real build
          // For hackathon, assume this is "add"
          fresh = old + u.power;
          newTotal += u.power;
        } else {
          // no-op for simplicity
          fresh = old;
        }
      } else {
        // absolute set
        fresh = u.power;
        if (fresh >= old) {
          newTotal += (fresh - old);
        } else {
          newTotal -= (old - fresh);
        }
      }

      vPower[u.lp] = fresh;
      emit PowerSet(u.lp, fresh, newTotal);
    }

    totalPowerCached = newTotal;
  }

  // ───────────────────────── View functions ─────────────────────────
  function vPowerOf(address lp) external view returns (uint256) {
    return vPower[lp];
  }

  function totalPower() external view returns (uint256) {
    return totalPowerCached;
  }
}
