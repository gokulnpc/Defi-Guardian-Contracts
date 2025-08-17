// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * PremiumVault (Arbitrum) — Native-fee CCIP
 *
 * - Users pay premiums in PYUSD (ERC20)
 * - Premium is split between LPVault (yield) and PayoutVault (reserve)
 * - Sends a CCIP message (data-only) to Hedera PolicyManager using NATIVE gas (no LINK)
 *
 * Notes:
 * - CCIP: This contract builds Client.EVM2AnyMessage with feeToken=address(0)
 *         and pays the CCIP fee via msg.value.
 * - A simple allowlist is used for destination chain selectors and receiver addresses.
 * - Minimal storage; events are emitted for indexers/frontends.
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";

contract PremiumVault is Ownable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  // ─────────────────────────── Errors ───────────────────────────
  error InvalidAddress();
  error InvalidAmount();
  error DestNotAllowlisted(uint64 selector);
  error ReceiverNotAllowlisted(bytes receiver);
  error NoGasLimitForChain(uint64 selector);
  error NotEnoughNative(uint256 have, uint256 need);
  error ZeroAllocation();
  error BadAllocationSum();

  // ──────────────────────── External contracts ────────────────────────
  IERC20 public immutable PYUSD;           // PYUSD on Arbitrum
  address public lpVault;                  // receives yield portion
  address public payoutVault;              // receives reserve portion
  IRouterClient public router;             // Chainlink CCIP Router (Arbitrum)

  // ──────────────────────── CCIP allowlists/config ────────────────────────
  mapping(uint64 => bool) public allowlistedDestChains; // chain selector → allowed
  mapping(bytes => bool)  public allowlistedReceivers;  // abi-encoded address on dest → allowed
  mapping(uint64 => uint256) public gasLimitByChain;    // per-dest gas limit for execution

  // ─────────────────────────── Split config ───────────────────────────
  uint256 public premiumBpsToLP      = 7000; // 70%
  uint256 public premiumBpsToReserve = 3000; // 30%
  uint256 internal constant BPS = 10_000;

  // ─────────────────────────── Types ───────────────────────────
  struct PolicyTerms {
    bytes32 poolId;           // target coverage pool (protocol)
    address buyer;            // buyer on Arbitrum (msg.sender suggested)
    uint256 coverageAmount;   // insured amount in PYUSD
    uint64  startTs;          // coverage start
    uint64  endTs;            // coverage end
    bytes32 policyRef;        // off-chain/IPFS ref or terms hash
  }

  // ─────────────────────────── Events ───────────────────────────
  event RouterUpdated(address router);
  event VaultsUpdated(address lpVault, address payoutVault);
  event DestChainAllowlisted(uint64 selector, bool allowed);
  event ReceiverAllowlisted(bytes receiver, bool allowed);
  event GasLimitSet(uint64 selector, uint256 gasLimit);
  event SplitUpdated(uint256 bpsToLP, uint256 bpsToReserve);

  event PremiumPaid(
    address indexed user,
    uint256 premiumPYUSD,
    uint256 toLP,
    uint256 toReserve,
    bytes32 ccipMessageId
  );

  event CCIPSent(
    bytes32 indexed messageId,
    uint64 indexed dstSelector,
    bytes indexed receiver,
    uint256 feePaidNative
  );

  // ─────────────────────────── Constructor ───────────────────────────
  constructor(
    address _router,
    address _pyusd,
    address _lpVault,
    address _payoutVault,
    address _owner
  ) Ownable(_owner) {
    if (_router == address(0) || _pyusd == address(0) || _lpVault == address(0) || _payoutVault == address(0)) {
      revert InvalidAddress();
    }
    router = IRouterClient(_router);
    PYUSD = IERC20(_pyusd);
    lpVault = _lpVault;
    payoutVault = _payoutVault;
  }

  // ─────────────────────────── Owner functions ───────────────────────────
  function setRouter(address _router) external onlyOwner {
    if (_router == address(0)) revert InvalidAddress();
    router = IRouterClient(_router);
    emit RouterUpdated(_router);
  }

  function setVaults(address _lpVault, address _payoutVault) external onlyOwner {
    if (_lpVault == address(0) || _payoutVault == address(0)) revert InvalidAddress();
    lpVault = _lpVault;
    payoutVault = _payoutVault;
    emit VaultsUpdated(_lpVault, _payoutVault);
  }

  function allowlistDestChain(uint64 selector, bool allowed) external onlyOwner {
    allowlistedDestChains[selector] = allowed;
    emit DestChainAllowlisted(selector, allowed);
  }

  function allowlistReceiver(bytes calldata receiver, bool allowed) external onlyOwner {
    allowlistedReceivers[receiver] = allowed;
    emit ReceiverAllowlisted(receiver, allowed);
  }

  function setGasLimit(uint64 selector, uint256 gasLimit) external onlyOwner {
    gasLimitByChain[selector] = gasLimit;
    emit GasLimitSet(selector, gasLimit);
  }

  function setSplit(uint256 bpsToLP_, uint256 bpsToReserve_) external onlyOwner {
    if (bpsToLP_ + bpsToReserve_ != BPS) revert BadAllocationSum();
    premiumBpsToLP = bpsToLP_;
    premiumBpsToReserve = bpsToReserve_;
    emit SplitUpdated(bpsToLP_, bpsToReserve_);
  }

  // ─────────────────────────── External functions ───────────────────────────
  /**
   * @notice Pay premium in PYUSD, split locally, then CCIP-send policy terms to Hedera PolicyManager.
   * @param dstChainSelector   Hedera chain selector (must be allowlisted)
   * @param hederaReceiver     abi.encodePacked(PolicyManager address on Hedera) (must be allowlisted)
   * @param terms              Policy terms (decoded by Hedera receiver)
   * @param premiumPYUSD       Amount of PYUSD premium to transfer from user
   * @return messageId         CCIP message id
   */
  function buyCoverage(
    uint64 dstChainSelector,
    bytes calldata hederaReceiver,
    PolicyTerms calldata terms,
    uint256 premiumPYUSD
  ) external payable nonReentrant returns (bytes32 messageId) {
    if (!allowlistedDestChains[dstChainSelector]) revert DestNotAllowlisted(dstChainSelector);
    if (!allowlistedReceivers[hederaReceiver])  revert ReceiverNotAllowlisted(hederaReceiver);
    if (premiumPYUSD == 0)                      revert InvalidAmount();

    // 1) Pull premium
    PYUSD.safeTransferFrom(msg.sender, address(this), premiumPYUSD);

    // 2) Split to LP + Reserve
    (uint256 toLP, uint256 toReserve) = _calcAlloc(premiumPYUSD);
    if (toLP > 0)      PYUSD.safeTransfer(lpVault, toLP);
    if (toReserve > 0) PYUSD.safeTransfer(payoutVault, toReserve);

    // 3) CCIP: build message (data-only) with native fee
    uint256 gasLimit = gasLimitByChain[dstChainSelector];
    if (gasLimit == 0) revert NoGasLimitForChain(dstChainSelector);

    Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
      receiver: hederaReceiver,
      data: abi.encode(terms),                               // Hedera receiver decodes PolicyTerms
      tokenAmounts: new Client.EVMTokenAmount[](0),          // no token bridging, only data
      extraArgs: Client._argsToBytes(
        Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true})
      ),
      feeToken: address(0)                                   // ← pay CCIP fee in native gas
    });

    // 4) Quote fee and ensure msg.value covers it
    uint256 fee = router.getFee(dstChainSelector, m);
    if (msg.value < fee) revert NotEnoughNative(msg.value, fee);

    // 5) Send
    messageId = router.ccipSend{value: fee}(dstChainSelector, m);

    // 6) Refund any overpayment
    if (msg.value > fee) {
      (bool ok, ) = msg.sender.call{value: (msg.value - fee)}("");
      require(ok, "Refund failed");
    }

    emit CCIPSent(messageId, dstChainSelector, hederaReceiver, fee);
    emit PremiumPaid(msg.sender, premiumPYUSD, toLP, toReserve, messageId);
  }

  // ─────────────────────────── Views / helpers ───────────────────────────
  function previewAllocation(uint256 premiumPYUSD) external view returns (uint256 toLP, uint256 toReserve) {
    return _calcAlloc(premiumPYUSD);
  }

  function quoteCCIPFee(
    uint64 dstChainSelector,
    bytes calldata hederaReceiver,
    PolicyTerms calldata terms
  ) external view returns (uint256) {
    if (!allowlistedDestChains[dstChainSelector]) revert DestNotAllowlisted(dstChainSelector);
    if (!allowlistedReceivers[hederaReceiver])    revert ReceiverNotAllowlisted(hederaReceiver);

    uint256 gasLimit = gasLimitByChain[dstChainSelector];
    if (gasLimit == 0) revert NoGasLimitForChain(dstChainSelector);

    Client.EVM2AnyMessage memory m = Client.EVM2AnyMessage({
      receiver: hederaReceiver,
      data: abi.encode(terms),
      tokenAmounts: new Client.EVMTokenAmount[](0),
      extraArgs: Client._argsToBytes(
        Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true})
      ),
      feeToken: address(0) // native
    });

    return router.getFee(dstChainSelector, m);
  }

  // ─────────────────────────── Internal ───────────────────────────
  function _calcAlloc(uint256 amount) internal view returns (uint256 toLP, uint256 toReserve) {
    toLP = (amount * premiumBpsToLP) / BPS;
    toReserve = (amount * premiumBpsToReserve) / BPS;
  }

  // ─────────────────────────── Rescue ───────────────────────────
  function rescueToken(address token, address to, uint256 amt) external onlyOwner {
    if (to == address(0)) revert InvalidAddress();
    IERC20(token).safeTransfer(to, amt);
  }

  receive() external payable {}
}
