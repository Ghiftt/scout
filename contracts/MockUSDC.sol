// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    string public name = "Mock USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}