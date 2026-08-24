// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";

contract IdentityRegistryTest is Test {
    IdentityRegistry registry;
    address admin = address(1);
    address registrar = address(2);
    address reputationEngine = address(3);
    address userWallet = address(4);

    bytes32 constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 constant REPUTATION_ROLE = keccak256("REPUTATION_ROLE");
    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;

    event IdentityRegistered(bytes32 indexed phoneHash, bytes32 indexed usernameHash, address indexed wallet);
    event BlacklistStatusChanged(address indexed wallet, bool status);

    function setUp() public {
        vm.prank(admin);
        registry = new IdentityRegistry(admin);

        vm.startPrank(admin);
        registry.grantRole(REGISTRAR_ROLE, registrar);
        registry.grantRole(REPUTATION_ROLE, reputationEngine);
        vm.stopPrank();
    }

    function test_happyPathRegistration() public {
        bytes32 phoneHash = keccak256("1234567890");
        bytes32 usernameHash = keccak256("alice");

        vm.prank(registrar);
        vm.expectEmit(true, true, true, true);
        emit IdentityRegistered(phoneHash, usernameHash, userWallet);
        registry.registerIdentity(phoneHash, usernameHash, userWallet);

        assertEq(registry.resolveByPhoneHash(phoneHash), userWallet);
        assertEq(registry.resolveByUsername(usernameHash), userWallet);
    }

    function test_revert_PhoneAlreadyRegistered() public {
        bytes32 phoneHash = keccak256("1234567890");
        bytes32 usernameHash1 = keccak256("alice");
        bytes32 usernameHash2 = keccak256("bob");
        address user2 = address(5);

        vm.prank(registrar);
        registry.registerIdentity(phoneHash, usernameHash1, userWallet);

        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.PhoneAlreadyRegistered.selector, userWallet));
        registry.registerIdentity(phoneHash, usernameHash2, user2);
    }

    function test_revert_UsernameTaken() public {
        bytes32 phoneHash1 = keccak256("1234567890");
        bytes32 phoneHash2 = keccak256("0987654321");
        bytes32 usernameHash = keccak256("alice");
        address user2 = address(5);

        vm.prank(registrar);
        registry.registerIdentity(phoneHash1, usernameHash, userWallet);

        vm.prank(registrar);
        vm.expectRevert(IdentityRegistry.UsernameTaken.selector);
        registry.registerIdentity(phoneHash2, usernameHash, user2);
    }

    function test_revert_WalletAlreadyRegistered() public {
        bytes32 phoneHash1 = keccak256("1234567890");
        bytes32 phoneHash2 = keccak256("0987654321");
        bytes32 usernameHash1 = keccak256("alice");
        bytes32 usernameHash2 = keccak256("bob");

        vm.prank(registrar);
        registry.registerIdentity(phoneHash1, usernameHash1, userWallet);

        vm.prank(registrar);
        vm.expectRevert(IdentityRegistry.WalletAlreadyRegistered.selector);
        registry.registerIdentity(phoneHash2, usernameHash2, userWallet);
    }

    function test_revert_NonRegistrarCannotRegister() public {
        bytes32 phoneHash = keccak256("1234567890");
        bytes32 usernameHash = keccak256("alice");

        vm.prank(userWallet); // Not registrar
        vm.expectRevert(abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", userWallet, REGISTRAR_ROLE));
        registry.registerIdentity(phoneHash, usernameHash, userWallet);
    }

    function test_reputationEngineCanBlacklist() public {
        vm.prank(reputationEngine);
        vm.expectEmit(true, true, true, true);
        emit BlacklistStatusChanged(userWallet, true);
        registry.setBlacklisted(userWallet, true);

        assertTrue(registry.isBlacklisted(userWallet));
    }

    function test_revert_NonReputationRoleCannotBlacklist() public {
        vm.prank(userWallet); // Not reputation engine
        vm.expectRevert(abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", userWallet, REPUTATION_ROLE));
        registry.setBlacklisted(userWallet, true);
    }

    function testFuzz_distinctPhoneHashesDoNotCollide(bytes32 phoneHash1, bytes32 phoneHash2, bytes32 usernameHash1, bytes32 usernameHash2, address wallet1, address wallet2) public {
        vm.assume(phoneHash1 != phoneHash2);
        vm.assume(usernameHash1 != usernameHash2);
        vm.assume(wallet1 != wallet2);
        vm.assume(wallet1 != address(0));
        vm.assume(wallet2 != address(0));

        vm.startPrank(registrar);
        registry.registerIdentity(phoneHash1, usernameHash1, wallet1);
        registry.registerIdentity(phoneHash2, usernameHash2, wallet2);
        vm.stopPrank();

        assertEq(registry.resolveByPhoneHash(phoneHash1), wallet1);
        assertEq(registry.resolveByPhoneHash(phoneHash2), wallet2);
    }
}
