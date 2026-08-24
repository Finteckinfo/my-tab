// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MyTabAccountFactory} from "../src/MyTabAccountFactory.sol";
import {LightAccountFactory} from "light-account/src/LightAccountFactory.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MyTabAccountFactoryTest is Test {
    MyTabAccountFactory public factory;
    LightAccountFactory public innerFactory;
    EntryPoint public entryPoint;
    MockUSDC public usdc;

    function setUp() public {
        entryPoint = new EntryPoint();
        innerFactory = new LightAccountFactory(address(this), entryPoint);
        factory = new MyTabAccountFactory(innerFactory);
        usdc = new MockUSDC();
    }

    function testFuzz_GetAddressMatchesCreate(address owner, uint256 salt) public {
        vm.assume(owner != address(0));
        
        address predicted = factory.getAddress(owner, salt);
        address deployed = factory.createAccount(owner, salt);
        
        assertEq(predicted, deployed, "getAddress should exactly match createAccount");
    }
    
    function testFuzz_CreateAccountIsIdempotent(address owner, uint256 salt) public {
        vm.assume(owner != address(0));
        
        address first = factory.createAccount(owner, salt);
        address second = factory.createAccount(owner, salt);
        
        assertEq(first, second, "Subsequent calls should return the same address");
        
        // Assert it is actually deployed
        uint256 size;
        assembly { size := extcodesize(first) }
        assertTrue(size > 0, "Account was not deployed");
    }

    function test_CounterfactualDeposits(address owner, uint256 salt) public {
        vm.assume(owner != address(0));
        
        address predicted = factory.getAddress(owner, salt);
        
        // Assert it doesn't exist yet
        uint256 size;
        assembly { size := extcodesize(predicted) }
        assertEq(size, 0, "Account should not exist yet");
        
        // 1. Receive ETH
        vm.deal(predicted, 1 ether);
        assertEq(predicted.balance, 1 ether, "Counterfactual account should hold ETH");
        
        // 2. Receive USDC
        usdc.mint(predicted, 5000e6);
        assertEq(usdc.balanceOf(predicted), 5000e6, "Counterfactual account should hold USDC");
        
        // Deploy and assert balances remain
        address deployed = factory.createAccount(owner, salt);
        assertEq(deployed, predicted);
        
        assertEq(deployed.balance, 1 ether, "Deployed account retains ETH");
        assertEq(usdc.balanceOf(deployed), 5000e6, "Deployed account retains USDC");
    }

    function test_GetAddressIsPureView() public {
        // We ensure it deploys nothing by checking codesize before and after
        address owner = address(0xABCD);
        uint256 salt = 42;
        
        address predicted = factory.getAddress(owner, salt);
        
        uint256 size;
        assembly { size := extcodesize(predicted) }
        assertEq(size, 0, "Should deploy nothing");
        
        // Check gas or state
        uint256 snapshotId = vm.snapshot();
        address predicted2 = factory.getAddress(owner, salt);
        assertEq(predicted, predicted2);
        assertTrue(vm.revertTo(snapshotId), "Reverting should work, proving no state changes required");
    }
}
