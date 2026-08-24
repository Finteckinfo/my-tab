// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReputationEngine} from "../src/ReputationEngine.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract ReputationEngineTest is Test {
    ReputationEngine engine;
    IdentityRegistry registry;
    
    address admin = address(1);
    address reporter = address(2);
    address user = address(3);

    bytes32 constant DISAPPROVAL_REPORTER_ROLE = keccak256("DISAPPROVAL_REPORTER_ROLE");
    bytes32 constant REPUTATION_ROLE = keccak256("REPUTATION_ROLE");

    event ReputationTierChanged(address indexed user, ReputationEngine.Tier oldTier, ReputationEngine.Tier newTier, uint256 disapprovalCount);

    function setUp() public {
        vm.startPrank(admin);
        
        registry = new IdentityRegistry(admin);
        
        ReputationEngine implementation = new ReputationEngine();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeWithSelector(ReputationEngine.initialize.selector, address(registry), admin)
        );
        engine = ReputationEngine(address(proxy));

        registry.grantRole(REPUTATION_ROLE, address(engine));
        engine.grantRole(DISAPPROVAL_REPORTER_ROLE, reporter);
        
        vm.stopPrank();
    }

    function test_revert_UnauthorisedCallerCannotIncrement() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", user, DISAPPROVAL_REPORTER_ROLE));
        engine.recordDisapproval(user);
    }

    function test_tierBoundary_0_to_1() public {
        assertEq(uint(engine.getTier(user)), uint(ReputationEngine.Tier.Normal));
        
        vm.prank(reporter);
        vm.expectEmit(true, true, true, true);
        emit ReputationTierChanged(user, ReputationEngine.Tier.Normal, ReputationEngine.Tier.LightGrey, 1);
        engine.recordDisapproval(user);
        
        assertEq(uint(engine.getTier(user)), uint(ReputationEngine.Tier.LightGrey));
    }

    function test_tierBoundary_2_to_3() public {
        vm.startPrank(reporter);
        engine.recordDisapproval(user); // 1 (LightGrey)
        engine.recordDisapproval(user); // 2 (LightGrey)
        
        vm.expectEmit(true, true, true, true);
        emit ReputationTierChanged(user, ReputationEngine.Tier.LightGrey, ReputationEngine.Tier.DarkCharcoal, 3);
        engine.recordDisapproval(user); // 3 (DarkCharcoal)
        vm.stopPrank();
        
        assertEq(uint(engine.getTier(user)), uint(ReputationEngine.Tier.DarkCharcoal));
    }

    function test_tierBoundary_4_to_5() public {
        vm.startPrank(reporter);
        engine.recordDisapproval(user); // 1 (LightGrey)
        engine.recordDisapproval(user); // 2 (LightGrey)
        engine.recordDisapproval(user); // 3 (DarkCharcoal)
        engine.recordDisapproval(user); // 4 (DarkCharcoal)
        
        assertFalse(registry.isBlacklisted(user));

        vm.expectEmit(true, true, true, true);
        emit ReputationTierChanged(user, ReputationEngine.Tier.DarkCharcoal, ReputationEngine.Tier.Blacklisted, 5);
        engine.recordDisapproval(user); // 5 (Blacklisted)
        vm.stopPrank();
        
        assertEq(uint(engine.getTier(user)), uint(ReputationEngine.Tier.Blacklisted));
        assertTrue(registry.isBlacklisted(user));
    }

    function test_eventFiresOnlyOnRealTransitions() public {
        vm.startPrank(reporter);
        
        // 0 -> 1: emits
        vm.expectEmit(true, true, true, true);
        emit ReputationTierChanged(user, ReputationEngine.Tier.Normal, ReputationEngine.Tier.LightGrey, 1);
        engine.recordDisapproval(user);
        
        // 1 -> 2: does not emit
        vm.recordLogs();
        engine.recordDisapproval(user);
        assertEq(vm.getRecordedLogs().length, 0);

        vm.stopPrank();
    }

    function testFuzz_tierIsAlwaysCorrect(uint256 count) public {
        count = bound(count, 0, 20);
        
        vm.startPrank(reporter);
        for(uint256 i = 0; i < count; i++) {
            engine.recordDisapproval(user);
        }
        vm.stopPrank();

        ReputationEngine.Tier expectedTier;
        if (count == 0) {
            expectedTier = ReputationEngine.Tier.Normal;
        } else if (count <= 2) {
            expectedTier = ReputationEngine.Tier.LightGrey;
        } else if (count <= 4) {
            expectedTier = ReputationEngine.Tier.DarkCharcoal;
        } else {
            expectedTier = ReputationEngine.Tier.Blacklisted;
        }

        assertEq(uint(engine.getTier(user)), uint(expectedTier));
    }
}
