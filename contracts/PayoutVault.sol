// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * PayoutVault (Arbitrum)
 *
 * - CCIP receiver for payout instructions from Hedera ClaimManager
 * - Verifies source chain selector + sender (bytes allowlists)
 * - On valid message, transfers PYUSD to claimant
 * - Tracks a basic reserve via onPremiumReserve() hook (called by PremiumVault)
 *
 * Notes:
 * - This contract does NOT pay CCIP fees; receivers don't pay. Hedera sender (ClaimManager) covers fees.
 * - Keep enough PYUSD funded here to satisfy approved claims.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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

contract PayoutVault is CCIPReceiver, Ownable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  // ───────────────────────── Errors ─────────────────────────
  error NotAllowlistedChain(uint64 selector);
  error NotAllowlistedSender(bytes sender);
  error BadTag();
  error ZeroAddress();
  error InsufficientReserve(uint256 have, uint256 need);
  error MessageAlreadyProcessed(bytes32 messageId);
  error InvalidGasLimit();

  // ───────────────────────── Immutable ─────────────────────────
  IERC20 public immutable PYUSD;

  // ───────────────────────── CCIP allowlists/config ─────────────────────────
  mapping(uint64 => bool) public allowlistedSourceChains; // chain selector → allowed
  mapping(bytes => bool)  public allowlistedSenders;      // abi-encoded sender on Hedera → allowed
  mapping(uint64 => uint256) public gasLimitByChain;    // per-dest gas limit for execution

  // ───────────────────────── Reserve accounting ─────────────────────────
  // Optional: track how much of the PYUSD balance is earmarked for claims
  uint256 public reserveBalance;

  // ───────────────────────── Message tracking ─────────────────────────
  // Track processed message IDs to prevent duplicate processing
  mapping(bytes32 => bool) public processedMessages;

  // ───────────────────────── Events ─────────────────────────
  event SourceChainAllowlisted(uint64 selector, bool allowed);
  event SenderAllowlisted(bytes sender, bool allowed);
  event GasLimitSet(uint64 selector, uint256 gasLimit);

  event PremiumReserved(uint256 amount, uint256 newReserve);
  event PayoutExecuted(bytes32 indexed messageId, uint256 indexed claimId, address indexed to, uint256 amount);
  event Funded(address indexed from, uint256 amount);
  event Rescued(address token, address to, uint256 amount);

  // constant TAG to authenticate payload type
  bytes32 internal constant TAG_PAYOUT_V1 = keccak256("DG_PAYOUT_V1");

  constructor(
    address ccipRouter,   // Arbitrum CCIP Router
    address pyusdToken,
    address owner_
  ) CCIPReceiver(ccipRouter) Ownable(owner_) {
    if (pyusdToken == address(0)) revert ZeroAddress();
    PYUSD = IERC20(pyusdToken);
  }

  // ───────────────────────── Admin wiring ─────────────────────────
  function allowlistSourceChain(uint64 selector, bool allowed) external onlyOwner {
    allowlistedSourceChains[selector] = allowed;
    emit SourceChainAllowlisted(selector, allowed);
  }

  function allowlistSender(bytes calldata sender, bool allowed) external onlyOwner {
    allowlistedSenders[sender] = allowed;
    emit SenderAllowlisted(sender, allowed);
  }

  function setGasLimit(uint64 sourceChainSelector, uint256 gasLimit) external onlyOwner {
    if (gasLimit == 0) revert InvalidGasLimit();
    gasLimitByChain[sourceChainSelector] = gasLimit;
    emit GasLimitSet(sourceChainSelector, gasLimit);
  }

  // ───────────────────────── Hooks (called by PremiumVault) ─────────────────────────
  /**
   * @dev Optional accounting hook: PremiumVault calls this AFTER transferring PYUSD here.
   *      We simply increase the reserve counter. (You can skip this if you don’t use reserve tracking.)
   */
  function onPremiumReserve(uint256 amount) external {
    // In a real setup, you'd restrict the caller. For hackathon, stay simple or gate if you want:
    // require(msg.sender == premiumVault, "only PremiumVault");
    reserveBalance += amount;
    emit PremiumReserved(amount, reserveBalance);
  }

  // ───────────────────────── Funding helpers ─────────────────────────
  /**
   * @notice Pull PYUSD from caller to fund the vault (approve first).
   */
  function depositPYUSD(uint256 amount) external {
    PYUSD.safeTransferFrom(msg.sender, address(this), amount);
    // Not automatically counted as reserve; treat as free balance
    emit Funded(msg.sender, amount);
  }

  /**
   * @notice Owner rescue (for stuck tokens or rebalancing). Use with care in demos.
   */
  function rescueToken(address token, address to, uint256 amount) external onlyOwner {
    if (to == address(0)) revert ZeroAddress();
    IERC20(token).safeTransfer(to, amount);
    emit Rescued(token, to, amount);
  }

  // ───────────────────────── CCIP receive ─────────────────────────
  /**
   * Expected payload from Hedera ClaimManager:
   *   abi.encode(TAG_PAYOUT_V1, claimId, claimant, amount)
   */
  function _ccipReceive(Client.Any2EVMMessage memory m) internal override nonReentrant {
    // Check for duplicate message processing
    if (processedMessages[m.messageId]) revert MessageAlreadyProcessed(m.messageId);
    
    // Defensive checks
    if (!allowlistedSourceChains[m.sourceChainSelector]) revert NotAllowlistedChain(m.sourceChainSelector);
    if (!allowlistedSenders[m.sender]) revert NotAllowlistedSender(m.sender);

    // Mark message as processed to prevent reentrancy and duplicate processing
    processedMessages[m.messageId] = true;

    // Decode and validate
    (bytes32 tag, uint256 claimId, address claimant, uint256 amount) =
      abi.decode(m.data, (bytes32, uint256, address, uint256));

    if (tag != TAG_PAYOUT_V1) revert BadTag();

    // Optional: enforce reserve discipline
    if (reserveBalance < amount) revert InsufficientReserve(reserveBalance, amount);
    reserveBalance -= amount;

    // Transfer PYUSD to claimant
    PYUSD.safeTransfer(claimant, amount);

    emit PayoutExecuted(m.messageId, claimId, claimant, amount);
  }

  receive() external payable {}
}
