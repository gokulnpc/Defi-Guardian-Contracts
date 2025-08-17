// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";

// Interface for contracts that can receive CCIP messages
interface ICCIPReceiver {
    function _ccipReceive(Client.Any2EVMMessage memory message) external;
}

contract MockCCIPRouter is IRouterClient {
    uint256 private _fee;
    bytes32 private _lastMessageId;
    uint256 private _messageCounter;

    function setMockFee(uint256 fee) external {
        _fee = fee;
    }

    function getFee(
        uint64, /* destinationChainSelector */
        Client.EVM2AnyMessage memory /* message */
    ) external view override returns (uint256) {
        return _fee;
    }

    function ccipSend(
        uint64, /* destinationChainSelector */
        Client.EVM2AnyMessage memory /* message */
    ) external payable override returns (bytes32) {
        require(msg.value >= _fee, "Insufficient fee");
        
        _messageCounter++;
        _lastMessageId = keccak256(abi.encodePacked(_messageCounter, block.timestamp));
        
        return _lastMessageId;
    }

    function lastMessageId() external view returns (bytes32) {
        return _lastMessageId;
    }

    function isChainSupported(uint64) external pure override returns (bool) {
        return true;
    }

    // Test helper function to simulate receiving CCIP messages
    function simulateMessageReceived(
        address receiver, 
        Client.Any2EVMMessage memory message
    ) external {
        ICCIPReceiver(receiver)._ccipReceive(message);
    }
}
