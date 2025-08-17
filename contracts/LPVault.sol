// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * LPVault (Arbitrum / Ethereum)
 *
 * - Accepts PYUSD deposits from LPs
 * - Mints gPYUSD-LP tokens representing share + governance weight
 * - Tracks reserve for claims
 * - Supports withdraw requests with cooldown
 * - Syncs LP stake to Hedera via CCIP
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

    function _argsToBytes(GenericExtraArgsV2 memory _args) internal pure returns (bytes memory) {
        return abi.encode(_args);
    }

    struct GenericExtraArgsV2 {
        uint256 gasLimit;
        bool allowOutOfOrderExecution;
    }
}

contract LPVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────────────────────── Errors ─────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error InvalidShares();
    error CooldownNotFinished();
    error NoPendingWithdraw();
    error NotEnoughBalance(uint256 currentBalance, uint256 calculatedFees);
    error InvalidDestinationChain();
    error InvalidReceiverAddress();
    error NoReceiverOnDestinationChain(uint64 destinationChainSelector);
    error NoGasLimitOnDestinationChain(uint64 destinationChainSelector);

    // ───────────────────────── Immutable ─────────────────────────
    IERC20 public immutable PYUSD;
    IRouterClient public immutable router;

    // ───────────────────────── LP accounting ─────────────────────────
    struct Stake {
        uint256 shares;
        uint256 lockedUntil;
    }
    mapping(address => Stake) public stakes;
    uint256 public totalShares;

    // ───────────────────────── Withdraw queue ─────────────────────────
    struct WithdrawRequest {
        uint256 shares;
        uint256 unlockTimestamp;
    }
    mapping(address => WithdrawRequest) public withdrawQueue;
    uint256 public constant COOLDOWN = 1 days; // hackathon quick demo

    // ───────────────────────── CCIP configuration ─────────────────────────
    mapping(uint64 => address) public receivers;
    mapping(uint64 => uint256) public gasLimits;

    // ───────────────────────── Events ─────────────────────────
    event Deposit(address indexed lp, uint256 amount, uint256 shares);
    event RequestWithdraw(address indexed lp, uint256 shares, uint256 unlockTime);
    event FinalizeWithdraw(address indexed lp, uint256 shares, uint256 amount);
    event SyncToHedera(address indexed lp, uint256 shares, uint256 lockedUntil);
    event ReceiverSet(uint64 destinationChainSelector, address receiver);
    event GasLimitSet(uint64 destinationChainSelector, uint256 gasLimit);

    constructor(address _pyusd, address _ccipRouter, address _owner) Ownable(_owner) {
        if (_pyusd == address(0)) revert ZeroAddress();
        if (_ccipRouter == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();
        PYUSD = IERC20(_pyusd);
        router = IRouterClient(_ccipRouter);
    }

    // ───────────────────────── Admin functions ─────────────────────────
    function setReceiver(uint64 destinationChainSelector, address receiver) external onlyOwner {
        if (destinationChainSelector == 0) revert InvalidDestinationChain();
        if (receiver == address(0)) revert InvalidReceiverAddress();
        receivers[destinationChainSelector] = receiver;
        emit ReceiverSet(destinationChainSelector, receiver);
    }

    function setGasLimit(uint64 destinationChainSelector, uint256 gasLimit) external onlyOwner {
        if (destinationChainSelector == 0) revert InvalidDestinationChain();
        if (gasLimit == 0) revert NoGasLimitOnDestinationChain(destinationChainSelector);
        gasLimits[destinationChainSelector] = gasLimit;
        emit GasLimitSet(destinationChainSelector, gasLimit);
    }

    // ───────────────────────── Deposit ─────────────────────────
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        PYUSD.safeTransferFrom(msg.sender, address(this), amount);

        uint256 shares;
        if (totalShares == 0) {
            shares = amount;
        } else {
            shares = (amount * totalShares) / PYUSD.balanceOf(address(this));
        }

        Stake storage s = stakes[msg.sender];
        s.shares += shares;
        s.lockedUntil = block.timestamp + COOLDOWN;

        totalShares += shares;

        emit Deposit(msg.sender, amount, shares);

        // Sync LP stake to Hedera via CCIP (for governance)
        _syncLP(msg.sender, s.shares, s.lockedUntil);
    }

    // ───────────────────────── Request Withdraw ─────────────────────────
    function requestWithdraw(uint256 shares) external nonReentrant {
        Stake storage s = stakes[msg.sender];
        if (shares == 0 || shares > s.shares) revert InvalidShares();

        withdrawQueue[msg.sender] = WithdrawRequest({
            shares: shares,
            unlockTimestamp: block.timestamp + COOLDOWN
        });

        emit RequestWithdraw(msg.sender, shares, block.timestamp + COOLDOWN);
    }

    // ───────────────────────── Finalize Withdraw ─────────────────────────
    function finalizeWithdraw() external nonReentrant {
        WithdrawRequest storage req = withdrawQueue[msg.sender];
        if (block.timestamp < req.unlockTimestamp) revert CooldownNotFinished();
        if (req.shares == 0) revert NoPendingWithdraw();

        Stake storage s = stakes[msg.sender];
        uint256 amount = (req.shares * PYUSD.balanceOf(address(this))) / totalShares;

        s.shares -= req.shares;
        totalShares -= req.shares;

        delete withdrawQueue[msg.sender];

        PYUSD.safeTransfer(msg.sender, amount);

        emit FinalizeWithdraw(msg.sender, req.shares, amount);

        // Sync LP stake to Hedera after withdrawal
        _syncLP(msg.sender, s.shares, s.lockedUntil);
    }

    // ───────────────────────── Sync LP to Hedera ─────────────────────────
    function _syncLP(address lp, uint256 shares, uint256 lockedUntil) internal {
        // For demo purposes, use a hardcoded destination chain selector
        // In production, this would be configurable
        uint64 destinationChainSelector = 0x0000000000000000000000000000000000000000000000000000000000000001; // Example
        
        address receiver = receivers[destinationChainSelector];
        if (receiver == address(0)) {
            // Skip CCIP sync if no receiver configured
            return;
        }

        uint256 gasLimit = gasLimits[destinationChainSelector];
        if (gasLimit == 0) {
            // Skip CCIP sync if no gas limit configured
            return;
        }

        // Encode payload for Hedera VotingMirror
        bytes memory payload = abi.encode(lp, shares, lockedUntil);
        
        // Create CCIP message
        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: payload,
            tokenAmounts: new Client.EVMTokenAmount[](0), // no tokens sent, only data
            extraArgs: Client._argsToBytes(
                Client.GenericExtraArgsV2({
                    gasLimit: gasLimit,
                    allowOutOfOrderExecution: true
                })
            ),
            feeToken: address(0) // pay with native token
        });

        // Get fee and send message
        uint256 fee = router.getFee(destinationChainSelector, message);
        if (address(this).balance < fee) revert NotEnoughBalance(address(this).balance, fee);
        
        router.ccipSend{value: fee}(destinationChainSelector, message);

        emit SyncToHedera(lp, shares, lockedUntil);
    }

    // ───────────────────────── Receive function ─────────────────────────
    receive() external payable {}
}
