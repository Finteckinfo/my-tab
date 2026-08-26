// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SettlementRouter} from "../src/SettlementRouter.sol";
import {PledgeLedger} from "../src/PledgeLedger.sol";
import {ReputationEngine} from "../src/ReputationEngine.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MyTabAccountFactory} from "../src/MyTabAccountFactory.sol";
import {LightAccountFactory} from "light-account/src/LightAccountFactory.sol";
import {LightAccount} from "light-account/src/LightAccount.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SettlementRouterTest is Test {
    SettlementRouter public router;
    PledgeLedger public ledger;
    ReputationEngine public reputationEngine;
    IdentityRegistry public identityRegistry;
    MockERC20 public token;

    address public admin = address(0xAD);
    address public lender = address(0x10);
    address public debtor = address(0x20);
    address public stranger = address(0x30);
    address public keeper = address(0x40);
    address public relayer = address(0x50);

    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    bytes32 public constant DISAPPROVAL_REPORTER_ROLE = keccak256("DISAPPROVAL_REPORTER_ROLE");
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant REPUTATION_ROLE = keccak256("REPUTATION_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    event PledgeSettled(
        uint256 indexed pledgeId,
        address indexed debtor,
        address indexed lender,
        uint256 amount,
        address token,
        SettlementRouter.SettlementMethod method
    );

    event OffChainClaimDisputed(
        uint256 indexed pledgeId,
        address indexed debtor,
        address indexed lender
    );

    event DirectDebitFailed(
        uint256 indexed pledgeId,
        address indexed debtor,
        string reason
    );

    function setUp() public {
        vm.startPrank(admin);

        // 1. IdentityRegistry
        identityRegistry = new IdentityRegistry(admin);

        // 2. ReputationEngine (UUPS Proxy)
        ReputationEngine repImpl = new ReputationEngine();
        ERC1967Proxy repProxy = new ERC1967Proxy(
            address(repImpl),
            abi.encodeWithSelector(
                ReputationEngine.initialize.selector,
                address(identityRegistry),
                admin
            )
        );
        reputationEngine = ReputationEngine(address(repProxy));

        // 3. PledgeLedger (UUPS Proxy)
        PledgeLedger ledgerImpl = new PledgeLedger();
        ERC1967Proxy ledgerProxy = new ERC1967Proxy(
            address(ledgerImpl),
            abi.encodeWithSelector(
                PledgeLedger.initialize.selector,
                address(identityRegistry),
                address(reputationEngine),
                admin
            )
        );
        ledger = PledgeLedger(address(ledgerProxy));

        // 4. SettlementRouter (UUPS Proxy)
        SettlementRouter routerImpl = new SettlementRouter();
        ERC1967Proxy routerProxy = new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSelector(
                SettlementRouter.initialize.selector,
                address(ledger),
                address(reputationEngine),
                admin
            )
        );
        router = SettlementRouter(address(routerProxy));

        // Grant roles:
        identityRegistry.grantRole(REPUTATION_ROLE, address(reputationEngine));
        ledger.grantRole(SETTLEMENT_ROLE, address(router));
        reputationEngine.grantRole(DISAPPROVAL_REPORTER_ROLE, address(router));
        router.grantRole(KEEPER_ROLE, keeper);
        router.grantRole(RELAYER_ROLE, relayer);

        vm.stopPrank();

        // 5. Mock Token
        token = new MockERC20("USD Coin", "USDC");

        // Fund debtor
        token.mint(debtor, 10_000e6);

        vm.warp(100 days);
    }

    function _createAndConfirmPledge(uint128 amount) internal returns (uint256) {
        uint64 due = uint64(block.timestamp + 7 days);

        vm.prank(lender);
        uint256 pId = ledger.createPledge(
            debtor,
            amount,
            address(token),
            due,
            PledgeLedger.Track.Voluntary
        );

        vm.prank(debtor);
        ledger.confirmPledge(pId);

        return pId;
    }

    function _createAndConfirmEnforcedPledge(uint128 amount, uint64 duration) internal returns (uint256) {
        uint64 due = uint64(block.timestamp + duration);

        vm.prank(lender);
        uint256 pId = ledger.createPledge(
            debtor,
            amount,
            address(token),
            due,
            PledgeLedger.Track.Enforced
        );

        vm.prank(debtor);
        ledger.confirmPledge(pId);

        return pId;
    }

    // ================= settleOnChain TESTS =================

    function test_settleOnChain_happyPath_fromActive() public {
        uint128 amount = 500e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        token.approve(address(router), amount);

        uint256 lenderBalBefore = token.balanceOf(lender);
        uint256 debtorBalBefore = token.balanceOf(debtor);

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            debtor,
            lender,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.OnChain
        );

        vm.prank(debtor);
        router.settleOnChain(pId);

        assertEq(token.balanceOf(lender), lenderBalBefore + amount);
        assertEq(token.balanceOf(debtor), debtorBalBefore - amount);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Settled));
    }

    function test_settleOnChain_happyPath_fromSettlementClaimed() public {
        uint128 amount = 300e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        PledgeLedger.Pledge memory pBefore = ledger.getPledge(pId);
        assertEq(
            uint256(pBefore.status),
            uint256(PledgeLedger.Status.SettlementClaimed)
        );

        vm.prank(debtor);
        token.approve(address(router), amount);

        uint256 lenderBalBefore = token.balanceOf(lender);
        uint256 debtorBalBefore = token.balanceOf(debtor);

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            debtor,
            lender,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.OnChain
        );

        vm.prank(debtor);
        router.settleOnChain(pId);

        assertEq(token.balanceOf(lender), lenderBalBefore + amount);
        assertEq(token.balanceOf(debtor), debtorBalBefore - amount);

        PledgeLedger.Pledge memory pAfter = ledger.getPledge(pId);
        assertEq(uint256(pAfter.status), uint256(PledgeLedger.Status.Settled));
    }

    function test_revert_settleOnChain_nonDebtor() public {
        uint256 pId = _createAndConfirmPledge(100e6);

        vm.prank(debtor);
        token.approve(address(router), 100e6);

        vm.prank(lender);
        vm.expectRevert(SettlementRouter.Unauthorized.selector);
        router.settleOnChain(pId);

        vm.prank(stranger);
        vm.expectRevert(SettlementRouter.Unauthorized.selector);
        router.settleOnChain(pId);
    }

    function test_revert_settleOnChain_insufficientBalance_noPartialState() public {
        uint128 amount = 500e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        token.approve(address(router), amount);

        uint256 debtorBal = token.balanceOf(debtor);
        vm.prank(debtor);
        token.transfer(stranger, debtorBal);
        assertEq(token.balanceOf(debtor), 0);

        vm.prank(debtor);
        vm.expectRevert();
        router.settleOnChain(pId);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Active));
        assertEq(token.balanceOf(lender), 0);
    }

    function test_revert_settleOnChain_insufficientAllowance() public {
        uint128 amount = 500e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        token.approve(address(router), amount - 1);

        vm.prank(debtor);
        vm.expectRevert();
        router.settleOnChain(pId);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Active));
    }

    function test_revert_settleOnChain_invalidStatus() public {
        uint64 due = uint64(block.timestamp + 7 days);

        vm.prank(lender);
        uint256 pId = ledger.createPledge(
            debtor,
            100e6,
            address(token),
            due,
            PledgeLedger.Track.Voluntary
        );

        vm.prank(debtor);
        token.approve(address(router), 100e6);

        vm.prank(debtor);
        vm.expectRevert(SettlementRouter.InvalidStatus.selector);
        router.settleOnChain(pId);

        vm.prank(lender);
        ledger.cancelPledge(pId);

        vm.prank(debtor);
        vm.expectRevert(SettlementRouter.InvalidStatus.selector);
        router.settleOnChain(pId);
    }

    function test_revert_settleOnChain_nonExistentPledge() public {
        vm.prank(debtor);
        vm.expectRevert(SettlementRouter.InvalidPledge.selector);
        router.settleOnChain(9999);
    }

    // ================= lenderRespond TESTS =================

    function test_lenderRespond_approved_settles() public {
        uint128 amount = 200e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            debtor,
            lender,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.OffChain
        );

        vm.prank(lender);
        router.lenderRespond(pId, true);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Settled));
        assertEq(reputationEngine.getDisapprovalCount(debtor), 0);
    }

    function test_lenderRespond_disapproved_returnsToActive_incrementsReputation_startsCooldown() public {
        uint128 amount = 200e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        assertEq(reputationEngine.getDisapprovalCount(debtor), 0);
        assertEq(
            uint256(reputationEngine.getTier(debtor)),
            uint256(ReputationEngine.Tier.Normal)
        );

        vm.expectEmit(true, true, true, true);
        emit OffChainClaimDisputed(pId, debtor, lender);

        vm.prank(lender);
        router.lenderRespond(pId, false);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Active));

        assertEq(reputationEngine.getDisapprovalCount(debtor), 1);
        assertEq(
            uint256(reputationEngine.getTier(debtor)),
            uint256(ReputationEngine.Tier.LightGrey)
        );

        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.ClaimCooldownNotElapsed.selector);
        ledger.markPaidOffChain(pId);

        vm.warp(block.timestamp + 29 days);
        vm.prank(debtor);
        vm.expectRevert(PledgeLedger.ClaimCooldownNotElapsed.selector);
        ledger.markPaidOffChain(pId);

        vm.warp(block.timestamp + 2 days);
        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        PledgeLedger.Pledge memory pReclaimed = ledger.getPledge(pId);
        assertEq(
            uint256(pReclaimed.status),
            uint256(PledgeLedger.Status.SettlementClaimed)
        );
    }

    function test_revert_lenderRespond_nonLender() public {
        uint256 pId = _createAndConfirmPledge(200e6);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        vm.prank(debtor);
        vm.expectRevert(SettlementRouter.Unauthorized.selector);
        router.lenderRespond(pId, true);

        vm.prank(stranger);
        vm.expectRevert(SettlementRouter.Unauthorized.selector);
        router.lenderRespond(pId, false);
    }

    function test_revert_lenderRespond_invalidStatus() public {
        uint256 pId = _createAndConfirmPledge(200e6);

        vm.prank(lender);
        vm.expectRevert(SettlementRouter.InvalidStatus.selector);
        router.lenderRespond(pId, true);

        vm.prank(lender);
        vm.expectRevert(SettlementRouter.InvalidStatus.selector);
        router.lenderRespond(pId, false);
    }

    function test_revert_lenderRespond_nonExistentPledge() public {
        vm.prank(lender);
        vm.expectRevert(SettlementRouter.InvalidPledge.selector);
        router.lenderRespond(9999, true);
    }

    // ================= DIRECT DEBIT TESTS =================

    function test_executeDirectDebit_success() public {
        uint128 amount = 400e6;
        uint256 pId = _createAndConfirmEnforcedPledge(amount, 5 days);

        // Debtor approves router (scoped to pledge amount)
        vm.prank(debtor);
        token.approve(address(router), amount);

        // Warp past due date
        vm.warp(block.timestamp + 6 days);

        uint256 lenderBalBefore = token.balanceOf(lender);
        uint256 debtorBalBefore = token.balanceOf(debtor);

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            debtor,
            lender,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.DirectDebit
        );

        vm.prank(keeper);
        router.executeDirectDebit(pId);

        assertEq(token.balanceOf(lender), lenderBalBefore + amount);
        assertEq(token.balanceOf(debtor), debtorBalBefore - amount);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Settled));
    }

    function test_executeDirectDebit_insufficientBalance_setsDefaultedAndEmits() public {
        uint128 amount = 400e6;
        uint256 pId = _createAndConfirmEnforcedPledge(amount, 5 days);

        vm.prank(debtor);
        token.approve(address(router), amount);

        // Debtor drains balance
        uint256 debtorBal = token.balanceOf(debtor);
        vm.prank(debtor);
        token.transfer(stranger, debtorBal);

        vm.warp(block.timestamp + 6 days);

        // Must NOT revert, must emit DirectDebitFailed and set Defaulted
        vm.expectEmit(true, true, false, true);
        emit DirectDebitFailed(pId, debtor, "TransferFailed");

        vm.prank(keeper);
        router.executeDirectDebit(pId);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Defaulted));
        assertEq(token.balanceOf(lender), 0);
    }

    function test_executeDirectDebit_insufficientAllowance_setsDefaultedAndEmits() public {
        uint128 amount = 400e6;
        uint256 pId = _createAndConfirmEnforcedPledge(amount, 5 days);

        // Debtor approves 0 or partial
        vm.prank(debtor);
        token.approve(address(router), amount - 1);

        vm.warp(block.timestamp + 6 days);

        vm.expectEmit(true, true, false, true);
        emit DirectDebitFailed(pId, debtor, "TransferFailed");

        vm.prank(keeper);
        router.executeDirectDebit(pId);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Defaulted));
    }

    function test_revert_executeDirectDebit_beforeDueDate() public {
        uint128 amount = 400e6;
        uint256 pId = _createAndConfirmEnforcedPledge(amount, 5 days);

        vm.prank(debtor);
        token.approve(address(router), amount);

        // Try to execute at day 4 (not yet due)
        vm.warp(block.timestamp + 4 days);

        vm.prank(keeper);
        vm.expectRevert(SettlementRouter.NotDue.selector);
        router.executeDirectDebit(pId);
    }

    function test_revert_executeDirectDebit_voluntaryTrack() public {
        uint128 amount = 400e6;
        // Voluntary track pledge
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        token.approve(address(router), amount);

        vm.warp(block.timestamp + 10 days);

        vm.prank(keeper);
        vm.expectRevert(SettlementRouter.InvalidTrack.selector);
        router.executeDirectDebit(pId);
    }

    function test_revert_executeDirectDebit_nonKeeper() public {
        uint128 amount = 400e6;
        uint256 pId = _createAndConfirmEnforcedPledge(amount, 5 days);

        vm.warp(block.timestamp + 6 days);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)",
                stranger,
                KEEPER_ROLE
            )
        );
        router.executeDirectDebit(pId);
    }

    // ================= AUTO CLEAR TESTS =================

    function test_revert_autoApprove_before14Days() public {
        uint128 amount = 200e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        // 13 days 23 hours later: should revert
        vm.warp(block.timestamp + 14 days - 1 hours);

        vm.prank(relayer);
        vm.expectRevert(SettlementRouter.WindowNotElapsed.selector);
        router.autoApproveOffChainSettlement(pId);
    }

    function test_autoApprove_atExactly14Days_succeeds() public {
        uint128 amount = 200e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        uint64 claimTimestamp = uint64(block.timestamp);

        // Warp exactly 14 days
        vm.warp(claimTimestamp + 14 days);

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            debtor,
            lender,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.AutoCleared
        );

        vm.prank(relayer);
        router.autoApproveOffChainSettlement(pId);

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Settled));
    }

    function test_autoApprove_afterDisputeAndReclaim_usesCorrectTimestamp() public {
        uint128 amount = 200e6;
        uint256 pId = _createAndConfirmPledge(amount);

        // 1. Initial claim at T0
        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        // 2. Lender disputes at T0 + 1 day
        vm.warp(block.timestamp + 1 days);
        vm.prank(lender);
        router.lenderRespond(pId, false);

        PledgeLedger.Pledge memory pDisputed = ledger.getPledge(pId);
        assertEq(uint256(pDisputed.status), uint256(PledgeLedger.Status.Active));

        // 3. Debtor waits out the 30-day cooldown
        vm.warp(block.timestamp + 30 days);

        // 4. Debtor re-claims at T1 (T0 + 31 days)
        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        uint64 reclaimTimestamp = uint64(block.timestamp);

        // 5. At T1 + 2 days (which is T0 + 33 days > 14 days since initial claim, but only 2 days since reclaim)
        // autoApprove must REVERT because the 14-day window restarts from the new claim!
        vm.warp(reclaimTimestamp + 2 days);
        vm.prank(relayer);
        vm.expectRevert(SettlementRouter.WindowNotElapsed.selector);
        router.autoApproveOffChainSettlement(pId);

        // 6. Warp to exactly T1 + 14 days
        vm.warp(reclaimTimestamp + 14 days);

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            debtor,
            lender,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.AutoCleared
        );

        vm.prank(relayer);
        router.autoApproveOffChainSettlement(pId);

        PledgeLedger.Pledge memory pSettled = ledger.getPledge(pId);
        assertEq(uint256(pSettled.status), uint256(PledgeLedger.Status.Settled));
    }

    function test_revert_autoApprove_nonRelayer() public {
        uint128 amount = 200e6;
        uint256 pId = _createAndConfirmPledge(amount);

        vm.prank(debtor);
        ledger.markPaidOffChain(pId);

        vm.warp(block.timestamp + 14 days);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)",
                stranger,
                RELAYER_ROLE
            )
        );
        router.autoApproveOffChainSettlement(pId);
    }

    // ================= DISAPPROVAL ROLE WIRING TEST =================

    function test_revert_directCall_recordDisapproval_unauthorized() public {
        vm.prank(lender);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)",
                lender,
                DISAPPROVAL_REPORTER_ROLE
            )
        );
        reputationEngine.recordDisapproval(debtor);

        vm.prank(debtor);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)",
                debtor,
                DISAPPROVAL_REPORTER_ROLE
            )
        );
        reputationEngine.recordDisapproval(lender);
    }

    // ================= SMART ACCOUNT BATCH CONFIRMATION TEST =================

    function test_smartAccount_batchConfirmationAndDirectDebit() public {
        EntryPoint entryPoint = new EntryPoint();
        LightAccountFactory innerFactory = new LightAccountFactory(address(this), entryPoint);
        MyTabAccountFactory factory = new MyTabAccountFactory(innerFactory);

        address debtorOwner = address(0xAA11);
        address debtorAccount = factory.createAccount(debtorOwner, 1);

        uint128 amount = 500e6;
        token.mint(debtorAccount, amount);

        // Lender creates Enforced pledge for debtorAccount
        uint64 due = uint64(block.timestamp + 7 days);
        vm.prank(lender);
        uint256 pId = ledger.createPledge(
            debtorAccount,
            amount,
            address(token),
            due,
            PledgeLedger.Track.Enforced
        );

        // Debtor account executes batch: approve(router, amount) and confirmPledge(pId)
        address[] memory targets = new address[](2);
        targets[0] = address(token);
        targets[1] = address(ledger);

        bytes[] memory callDatas = new bytes[](2);
        callDatas[0] = abi.encodeWithSelector(ERC20.approve.selector, address(router), amount);
        callDatas[1] = abi.encodeWithSelector(PledgeLedger.confirmPledge.selector, pId);

        vm.prank(debtorOwner);
        LightAccount(payable(debtorAccount)).executeBatch(targets, callDatas);

        // Assert allowance is exactly amount
        assertEq(token.allowance(debtorAccount, address(router)), amount);

        // Assert pledge is Active
        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        assertEq(uint256(p.status), uint256(PledgeLedger.Status.Active));

        // Warp to due date
        vm.warp(due + 1);

        // Keeper executes direct debit
        vm.prank(keeper);
        router.executeDirectDebit(pId);

        // Assert settled and funds transferred
        PledgeLedger.Pledge memory pSettled = ledger.getPledge(pId);
        assertEq(uint256(pSettled.status), uint256(PledgeLedger.Status.Settled));
        assertEq(token.balanceOf(lender), amount);
        assertEq(token.balanceOf(debtorAccount), 0);
        assertEq(token.allowance(debtorAccount, address(router)), 0);
    }
}
