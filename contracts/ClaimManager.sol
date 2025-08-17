// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * ClaimManager (Hedera EVM)
 * - Simple binary voting for claims using vPower from VotingMirror
 * - If approved, CCIP-sends payout instruction to Arbitrum PayoutVault (native fee)
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

interface IVotingMirror {
  function vPowerOf(address) external view returns (uint256);
  function totalPower() external view returns (uint256);
}

interface IPolicyManagerView {
  function policies(bytes32 policyId) external view returns (
    bytes32 poolId,
    address buyer,
    uint256 coverageAmount,
    uint64  startTs,
    uint64  endTs,
    bytes32 policyRef,
    uint256 tokenId,
    bool    active
  );
}

contract ClaimManager is Ownable, ReentrancyGuard {
  error NotPolicyHolder();
  error VoteWindowClosed();
  error AlreadyVoted();
  error NotAllowlistedDest(uint64 sel);
  error NotAllowlistedReceiver(bytes r);
  error NoGasLimitForChain(uint64 sel);
  error NotEnoughNative(uint256 have, uint256 need);
  error AlreadyFinalized();
  error BadParams();

  // external deps
  IVotingMirror public votingMirror;
  IPolicyManagerView public policyManager;
  IRouterClient public router; // CCIP router on Hedera

  // allowlists for outbound CCIP (to Arbitrum)
  mapping(uint64 => bool) public allowlistedDestChains;
  mapping(bytes => bool)  public allowlistedReceivers;
  mapping(uint64 => uint256) public gasLimitByChain;

  // governance knobs
  uint256 public votingPeriodSeconds = 5 minutes;
  uint256 public quorumBps = 2000; // 20%
  uint256 internal constant BPS = 10_000;

  struct Claim {
    bytes32 policyId;
    address claimant;          // EVM address to receive payout on Arbitrum
    uint256 amount;            // PYUSD amount
    uint64  startTs;           // voting start
    uint64  endTs;             // voting end
    uint64  dstChainSelector;  // Arbitrum selector for payout
    bytes   dstPayoutVault;    // abi.encodePacked(PayoutVault address)
    bool    finalized;
    bool    approved;
    uint256 yes;
    uint256 no;
  }

  // claimId => Claim
  mapping(uint256 => Claim) public claims;
  uint256 public nextClaimId;

  // claimId => voter => voted?
  mapping(uint256 => mapping(address => bool)) public hasVoted;

  event RouterUpdated(address router);
  event VotingMirrorUpdated(address mirror);
  event PolicyManagerUpdated(address policyManager);

  event DestAllowlisted(uint64 selector, bool allowed);
  event ReceiverAllowlisted(bytes receiver, bool allowed);
  event GasLimitSet(uint64 selector, uint256 gasLimit);
  event ParamsUpdated(uint256 votingPeriodSeconds, uint256 quorumBps);

  event ClaimOpened(uint256 indexed claimId, bytes32 indexed policyId, address indexed claimant, uint256 amount);
  event Voted(uint256 indexed claimId, address indexed voter, bool support, uint256 weight);
  event ClaimFinalized(uint256 indexed claimId, bool approved);
  event PayoutSent(uint256 indexed claimId, bytes32 messageId, uint256 amount, address claimant);

  constructor(
    address _router,
    address _votingMirror,
    address _policyManager,
    address _owner
  ) Ownable(_owner) {
    router = IRouterClient(_router);
    votingMirror = IVotingMirror(_votingMirror);
    policyManager = IPolicyManagerView(_policyManager);
  }

  // Admin wiring
  function setRouter(address _router) external onlyOwner {
    router = IRouterClient(_router);
    emit RouterUpdated(_router);
  }

  function setVotingMirror(address m) external onlyOwner {
    votingMirror = IVotingMirror(m);
    emit VotingMirrorUpdated(m);
  }

  function setPolicyManager(address p) external onlyOwner {
    policyManager = IPolicyManagerView(p);
    emit PolicyManagerUpdated(p);
  }

  function allowlistDestChain(uint64 sel, bool allowed) external onlyOwner {
    allowlistedDestChains[sel] = allowed;
    emit DestAllowlisted(sel, allowed);
  }

  function allowlistReceiver(bytes calldata r, bool allowed) external onlyOwner {
    allowlistedReceivers[r] = allowed;
    emit ReceiverAllowlisted(r, allowed);
  }

  function setGasLimit(uint64 sel, uint256 gasLimit) external onlyOwner {
    gasLimitByChain[sel] = gasLimit;
    emit GasLimitSet(sel, gasLimit);
  }

  function setParams(uint256 _votingPeriodSeconds, uint256 _quorumBps) external onlyOwner {
    if (_quorumBps > BPS || _votingPeriodSeconds == 0) revert BadParams();
    votingPeriodSeconds = _votingPeriodSeconds;
    quorumBps = _quorumBps;
    emit ParamsUpdated(_votingPeriodSeconds, _quorumBps);
  }

  // Open a claim: either the policy holder or owner (for demo) can open
  function openClaim(
    bytes32 policyId,
    address claimantOnArbitrum,
    uint256 amountPYUSD,
    uint64  dstChainSelector,
    bytes   calldata dstPayoutVault
  ) external returns (uint256 claimId) {
    // Quick policy check
    (, address buyer, uint256 coverageAmount, uint64 startTs, uint64 endTs, , , bool active) =
      policyManager.policies(policyId);

    if (msg.sender != buyer && msg.sender != owner()) revert NotPolicyHolder();
    require(active, "policy inactive");
    require(block.timestamp >= startTs && block.timestamp <= endTs, "outside coverage window");
    require(amountPYUSD > 0 && amountPYUSD <= coverageAmount, "bad amount");

    // Create claim
    claimId = ++nextClaimId;
    claims[claimId] = Claim({
      policyId: policyId,
      claimant: claimantOnArbitrum,
      amount: amountPYUSD,
      startTs: uint64(block.timestamp),
      endTs: uint64(block.timestamp + votingPeriodSeconds),
      dstChainSelector: dstChainSelector,
      dstPayoutVault: dstPayoutVault,
      finalized: false,
      approved: false,
      yes: 0,
      no: 0
    });

    emit ClaimOpened(claimId, policyId, claimantOnArbitrum, amountPYUSD);
  }

  // Binary vote — weight = vPower from VotingMirror
  function voteYes(uint256 claimId) external {
    _vote(claimId, true);
  }

  function voteNo(uint256 claimId) external {
    _vote(claimId, false);
  }

  function _vote(uint256 claimId, bool support) internal {
    Claim storage c = claims[claimId];
    if (block.timestamp > c.endTs) revert VoteWindowClosed();
    if (hasVoted[claimId][msg.sender]) revert AlreadyVoted();

    uint256 weight = votingMirror.vPowerOf(msg.sender);
    hasVoted[claimId][msg.sender] = true;

    if (support) {
      c.yes += weight;
    } else {
      c.no += weight;
    }

    emit Voted(claimId, msg.sender, support, weight);
  }

  // Finalize with quorum+majority. If approved, CCIP-send payout to Arbitrum PayoutVault (native fee).
  function finalizeClaim(uint256 claimId) external payable nonReentrant {
    Claim storage c = claims[claimId];
    if (c.finalized) revert AlreadyFinalized();
    if (block.timestamp <= c.endTs) revert VoteWindowClosed();

    uint256 total = votingMirror.totalPower();
    uint256 participated = c.yes + c.no;
    bool hasQuorum = (participated * BPS) / (total == 0 ? 1 : total) >= quorumBps;
    bool approved = hasQuorum && (c.yes > c.no);

    c.finalized = true;
    c.approved = approved;

    emit ClaimFinalized(claimId, approved);

    if (!approved) return;

    // CCIP outbound to Arbitrum PayoutVault
    if (!allowlistedDestChains[c.dstChainSelector]) revert NotAllowlistedDest(c.dstChainSelector);
    if (!allowlistedReceivers[c.dstPayoutVault])    revert NotAllowlistedReceiver(c.dstPayoutVault);

    uint256 gasLimit = gasLimitByChain[c.dstChainSelector];
    if (gasLimit == 0) revert NoGasLimitForChain(c.dstChainSelector);

    // Payload: (tag, claimId, claimant, amount)
    bytes32 TAG = keccak256("DG_PAYOUT_V1");
    bytes memory payload = abi.encode(TAG, claimId, c.claimant, c.amount);

    Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
      receiver: c.dstPayoutVault,
      data: payload,
      tokenAmounts: new Client.EVMTokenAmount[](0), // no tokens sent, only data
      extraArgs: Client._argsToBytes(
        Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true})
      ),
      feeToken: address(0) // native only
    });

    uint256 fee = router.getFee(c.dstChainSelector, m);
    if (msg.value < fee) revert NotEnoughNative(msg.value, fee);

    bytes32 messageId = router.ccipSend{value: fee}(c.dstChainSelector, m);

    // refund any overpay
    if (msg.value > fee) {
      (bool ok, ) = msg.sender.call{value: (msg.value - fee)}("");
      require(ok, "refund fail");
    }

    emit PayoutSent(claimId, messageId, c.amount, c.claimant);
  }

  receive() external payable {}
}
