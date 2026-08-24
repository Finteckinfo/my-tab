// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PledgeLedger} from "../src/PledgeLedger.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract MockIdentityRegistry {
    mapping(address => bool) public blacklisted;
    function setBlacklisted(address w, bool b) external { blacklisted[w] = b; }
    function isBlacklisted(address wallet) external view returns (bool) { return blacklisted[wallet]; }
}

contract MockReputationEngine {
    mapping(address => bool) public enforced;
    function setEnforced(address w, bool b) external { enforced[w] = b; }
    function requiresEnforcedTrack(address user) external view returns (bool) { return enforced[user]; }
}

contract PledgeLedgerTest is Test {
    PledgeLedger ledger;
    MockIdentityRegistry identityRegistry;
    MockReputationEngine reputationEngine;

    address admin = address(1);
    address settlementRouter = address(2);
    address lender = address(3);
    address debtor = address(4);
    address token = address(5);

    bytes32 constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    function setUp() public {
        identityRegistry = new MockIdentityRegistry();
        reputationEngine = new MockReputationEngine();

        vm.startPrank(admin);
        PledgeLedger impl = new PledgeLedger();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeWithSelector(PledgeLedger.initialize.selector, address(identityRegistry), address(reputationEngine), admin)
        );
        ledger = PledgeLedger(address(proxy));

        ledger.grantRole(SETTLEMENT_ROLE, settlementRouter);
        vm.stopPrank();

        vm.warp(100 days); // Ensure block.timestamp > 0
    }

    // ================= LEGAL TRANSITIONS =================

    function test_legal_createPledge() public returns (uint256) {
        uint64 due = uint64(block.timestamp + 10 days);
        vm.prank(lender);
        uint256 pId = ledger.createPledge(debtor, 100, token, due, PledgeLedger.Track.Voluntary);
        
        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint(p.status), uint(PledgeLedger.Status.Pending));
        return pId;
    }

    function test_legal_confirmPledge() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(debtor);
        ledger.confirmPledge(pId);
        
        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint(p.status), uint(PledgeLedger.Status.Active));
    }

    function test_legal_cancelPledge() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(lender);
        ledger.cancelPledge(pId);
        
        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint(p.status), uint(PledgeLedger.Status.Cancelled));
    }

    function test_legal_markPaidOffChain() public {
        uint256 pId = test_legal_createPledge();
        
        vm.prank(debtor);
        ledger.confirmPledge(pId);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);
        
        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint(p.status), uint(PledgeLedger.Status.SettlementClaimed));
        assertEq(p.claimedAt, block.timestamp);
    }

    function test_legal_setDisapproved() public {
        uint256 pId = test_legal_createPledge();
        
        vm.prank(debtor);
        ledger.confirmPledge(pId);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        vm.prank(settlementRouter);
        ledger.setDisapproved(pId);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint(p.status), uint(PledgeLedger.Status.Active));
    }

    function test_legal_setSettled() public {
        uint256 pId = test_legal_createPledge();
        vm.prank(settlementRouter);
        ledger.setSettled(pId);
        assertEq(uint(ledger.getPledge(pId).status), uint(PledgeLedger.Status.Settled));
    }

    function test_legal_setDefaulted() public {
        uint256 pId = test_legal_createPledge();
        vm.prank(settlementRouter);
        ledger.setDefaulted(pId);
        assertEq(uint(ledger.getPledge(pId).status), uint(PledgeLedger.Status.Defaulted));
    }

    function test_isOverdue() public {
        uint256 pId = test_legal_createPledge();
        
        // Initially not active
        assertFalse(ledger.isOverdue(pId));

        vm.prank(debtor);
        ledger.confirmPledge(pId);
        
        // Active but not due
        assertFalse(ledger.isOverdue(pId));

        vm.warp(block.timestamp + 11 days);
        // Active and due
        assertTrue(ledger.isOverdue(pId));
    }


    // ================= ILLEGAL TRANSITIONS =================

    function test_revert_createAgainstBlacklistedParty() public {
        uint64 due = uint64(block.timestamp + 10 days);
        
        // Blacklist debtor
        identityRegistry.setBlacklisted(debtor, true);
        vm.prank(lender);
        vm.expectRevert(PledgeLedger.PartyBlacklisted.selector);
        ledger.createPledge(debtor, 100, token, due, PledgeLedger.Track.Voluntary);

        identityRegistry.setBlacklisted(debtor, false);

        // Blacklist lender
        identityRegistry.setBlacklisted(lender, true);
        vm.prank(lender);
        vm.expectRevert(PledgeLedger.PartyBlacklisted.selector);
        ledger.createPledge(debtor, 100, token, due, PledgeLedger.Track.Voluntary);
    }

    function test_revert_createSelfPledge() public {
        uint64 due = uint64(block.timestamp + 10 days);
        vm.prank(lender);
        vm.expectRevert(PledgeLedger.SelfPledgeNotAllowed.selector);
        ledger.createPledge(lender, 100, token, due, PledgeLedger.Track.Voluntary);
    }

    function test_revert_createPastDue() public {
        uint64 due = uint64(block.timestamp - 1);
        vm.prank(lender);
        vm.expectRevert(PledgeLedger.InvalidDueTimestamp.selector);
        ledger.createPledge(debtor, 100, token, due, PledgeLedger.Track.Voluntary);
    }

    function test_revert_createVoluntaryForTier3() public {
        uint64 due = uint64(block.timestamp + 10 days);
        reputationEngine.setEnforced(debtor, true);
        
        vm.prank(lender);
        vm.expectRevert(PledgeLedger.EnforcedTrackRequired.selector);
        ledger.createPledge(debtor, 100, token, due, PledgeLedger.Track.Voluntary);

        // Should work with Enforced
        vm.prank(lender);
        ledger.createPledge(debtor, 100, token, due, PledgeLedger.Track.Enforced);
    }

    function test_revert_confirmByNonDebtor() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(lender);
        vm.expectRevert(PledgeLedger.Unauthorized.selector);
        ledger.confirmPledge(pId);
    }

    function test_revert_confirmTwice() public {
        uint256 pId = test_legal_createPledge();

        vm.startPrank(debtor);
        ledger.confirmPledge(pId);
        
        vm.expectRevert(PledgeLedger.InvalidStatus.selector);
        ledger.confirmPledge(pId);
        vm.stopPrank();
    }

    function test_revert_confirmAfter7DayWindow() public {
        uint256 pId = test_legal_createPledge();

        vm.warp(block.timestamp + 7 days + 1 seconds);
        
        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.ConfirmationWindowExpired.selector);
        ledger.confirmPledge(pId);
    }

    function test_revert_cancelAfterConfirmation() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(debtor);
        ledger.confirmPledge(pId);
        
        vm.prank(lender);
        vm.expectRevert(PledgeLedger.InvalidStatus.selector);
        ledger.cancelPledge(pId);
    }

    function test_revert_cancelByNonLender() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.Unauthorized.selector);
        ledger.cancelPledge(pId);
    }

    function test_revert_markPaidUnconfirmed() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.InvalidStatus.selector);
        ledger.markPaidOffChain(pId);
    }

    function test_revert_claimSpamCooldown() public {
        uint256 pId = test_legal_createPledge();

        vm.startPrank(debtor);
        ledger.confirmPledge(pId);
        ledger.markPaidOffChain(pId);
        vm.stopPrank();

        // Router disapproves (e.g. lender said it wasn't paid)
        vm.prank(settlementRouter);
        ledger.setDisapproved(pId);

        // Debtor tries to claim again immediately
        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.ClaimCooldownNotElapsed.selector);
        ledger.markPaidOffChain(pId);

        // Warp 15 days (cooldown is 30)
        vm.warp(block.timestamp + 15 days);
        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.ClaimCooldownNotElapsed.selector);
        ledger.markPaidOffChain(pId);

        // Warp another 16 days (total 31)
        vm.warp(block.timestamp + 16 days);
        vm.prank(debtor);
        ledger.markPaidOffChain(pId); // Should succeed

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint(p.status), uint(PledgeLedger.Status.SettlementClaimed));
    }

    function test_revert_routerDisapproveNonClaimed() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(settlementRouter);
        vm.expectRevert(PledgeLedger.InvalidStatus.selector);
        ledger.setDisapproved(pId);
    }

    function test_revert_routerUnauthorized() public {
        uint256 pId = test_legal_createPledge();

        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", lender, SETTLEMENT_ROLE));
        ledger.setSettled(pId);
    }
}
