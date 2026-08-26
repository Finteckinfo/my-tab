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

    /// @notice Differential test: verifies every exact count maps to the correct tier.
    /// Boundary is at exactly 5 (not 4), matching the spec table.
    function test_differentialTierBoundaries() public {
        address[7] memory subjects;
        for (uint160 i = 0; i < 7; i++) {
            subjects[i] = address(uint160(100 + i));
        }

        vm.startPrank(reporter);

        // Count 0: Normal
        assertEq(uint(engine.getTier(subjects[0])), uint(ReputationEngine.Tier.Normal));
        assertFalse(engine.requiresEnforcedTrack(subjects[0]));

        // Count 1: LightGrey
        engine.recordDisapproval(subjects[1]);
        assertEq(uint(engine.getTier(subjects[1])), uint(ReputationEngine.Tier.LightGrey));
        assertFalse(engine.requiresEnforcedTrack(subjects[1]));

        // Count 2: LightGrey (boundary upper)
        engine.recordDisapproval(subjects[2]);
        engine.recordDisapproval(subjects[2]);
        assertEq(engine.getDisapprovalCount(subjects[2]), 2);
        assertEq(uint(engine.getTier(subjects[2])), uint(ReputationEngine.Tier.LightGrey));
        assertFalse(engine.requiresEnforcedTrack(subjects[2]));

        // Count 3: DarkCharcoal (boundary lower)
        for (uint256 i = 0; i < 3; i++) engine.recordDisapproval(subjects[3]);
        assertEq(engine.getDisapprovalCount(subjects[3]), 3);
        assertEq(uint(engine.getTier(subjects[3])), uint(ReputationEngine.Tier.DarkCharcoal));
        assertTrue(engine.requiresEnforcedTrack(subjects[3]));

        // Count 4: DarkCharcoal (boundary upper)
        for (uint256 i = 0; i < 4; i++) engine.recordDisapproval(subjects[4]);
        assertEq(engine.getDisapprovalCount(subjects[4]), 4);
        assertEq(uint(engine.getTier(subjects[4])), uint(ReputationEngine.Tier.DarkCharcoal));
        assertTrue(engine.requiresEnforcedTrack(subjects[4]));
        assertFalse(registry.isBlacklisted(subjects[4])); // Not yet!

        // Count 5: Blacklisted (boundary exactly at 5)
        for (uint256 i = 0; i < 5; i++) engine.recordDisapproval(subjects[5]);
        assertEq(engine.getDisapprovalCount(subjects[5]), 5);
        assertEq(uint(engine.getTier(subjects[5])), uint(ReputationEngine.Tier.Blacklisted));
        assertTrue(engine.requiresEnforcedTrack(subjects[5]));
        assertTrue(registry.isBlacklisted(subjects[5]));

        // Count 6: Still Blacklisted (post-boundary)
        for (uint256 i = 0; i < 6; i++) engine.recordDisapproval(subjects[6]);
        assertEq(engine.getDisapprovalCount(subjects[6]), 6);
        assertEq(uint(engine.getTier(subjects[6])), uint(ReputationEngine.Tier.Blacklisted));
        assertTrue(registry.isBlacklisted(subjects[6]));

        vm.stopPrank();
    }

    /// @notice Blacklist is permanent: recording more disapprovals on an already-blacklisted
    /// address does not change the blacklist status.
    function test_blacklistIsPermanent() public {
        vm.startPrank(reporter);
        for (uint256 i = 0; i < 5; i++) engine.recordDisapproval(user);
        assertTrue(registry.isBlacklisted(user));

        // Additional disapprovals don't toggle blacklist
        engine.recordDisapproval(user);
        engine.recordDisapproval(user);
        assertTrue(registry.isBlacklisted(user));
        assertEq(engine.getDisapprovalCount(user), 7);
        vm.stopPrank();
    }
}
