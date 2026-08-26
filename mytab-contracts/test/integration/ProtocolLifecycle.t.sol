// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {ReputationEngine} from "../../src/ReputationEngine.sol";
import {PledgeLedger} from "../../src/PledgeLedger.sol";
import {SettlementRouter} from "../../src/SettlementRouter.sol";
import {MyTabAccountFactory} from "../../src/MyTabAccountFactory.sol";
import {LightAccountFactory} from "light-account/src/LightAccountFactory.sol";
import {LightAccount} from "light-account/src/LightAccount.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockLifecycleERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ProtocolLifecycleTest is Test {
    IdentityRegistry public identityRegistry;
    ReputationEngine public reputationEngine;
    PledgeLedger public pledgeLedger;
    SettlementRouter public settlementRouter;

    MockLifecycleERC20 public token;
    EntryPoint public entryPoint;
    LightAccountFactory public lightAccountFactory;
    MyTabAccountFactory public accountFactory;

    address public admin = address(0xAD);
    address public relayer = address(0x101);
    address public keeper = address(0x102);

    address public userAOwner = address(0xAA01);
    address public userBOwner = address(0xBB01);

    address public userAAccount;
    address public userBAccount;

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
        // 1. Core Contracts
        identityRegistry = new IdentityRegistry(address(this));

        ReputationEngine repImpl = new ReputationEngine();
        ERC1967Proxy repProxy = new ERC1967Proxy(
            address(repImpl),
            abi.encodeWithSelector(
                ReputationEngine.initialize.selector,
                address(identityRegistry),
                address(this)
            )
        );
        reputationEngine = ReputationEngine(address(repProxy));

        PledgeLedger ledgerImpl = new PledgeLedger();
        ERC1967Proxy ledgerProxy = new ERC1967Proxy(
            address(ledgerImpl),
            abi.encodeWithSelector(
                PledgeLedger.initialize.selector,
                address(identityRegistry),
                address(reputationEngine),
                address(this)
            )
        );
        pledgeLedger = PledgeLedger(address(ledgerProxy));

        SettlementRouter routerImpl = new SettlementRouter();
        ERC1967Proxy routerProxy = new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSelector(
                SettlementRouter.initialize.selector,
                address(pledgeLedger),
                address(reputationEngine),
                address(this)
            )
        );
        settlementRouter = SettlementRouter(address(routerProxy));

        // 2. Wire roles
        identityRegistry.grantRole(identityRegistry.REPUTATION_ROLE(), address(reputationEngine));
        identityRegistry.grantRole(identityRegistry.REGISTRAR_ROLE(), relayer);
        identityRegistry.grantRole(identityRegistry.DEFAULT_ADMIN_ROLE(), admin);

        reputationEngine.grantRole(reputationEngine.DISAPPROVAL_REPORTER_ROLE(), address(settlementRouter));
        reputationEngine.grantRole(reputationEngine.DEFAULT_ADMIN_ROLE(), admin);

        pledgeLedger.grantRole(pledgeLedger.SETTLEMENT_ROLE(), address(settlementRouter));
        pledgeLedger.grantRole(pledgeLedger.DEFAULT_ADMIN_ROLE(), admin);

        settlementRouter.grantRole(settlementRouter.RELAYER_ROLE(), relayer);
        settlementRouter.grantRole(settlementRouter.KEEPER_ROLE(), keeper);
        settlementRouter.grantRole(settlementRouter.DEFAULT_ADMIN_ROLE(), admin);

        // 3. Smart Account Infrastructure
        entryPoint = new EntryPoint();
        lightAccountFactory = new LightAccountFactory(address(this), entryPoint);
        accountFactory = new MyTabAccountFactory(lightAccountFactory);

        userAAccount = accountFactory.createAccount(userAOwner, 1);
        userBAccount = accountFactory.createAccount(userBOwner, 1);

        // Register in IdentityRegistry
        vm.startPrank(relayer);
        identityRegistry.registerIdentity(keccak256("+1111111111"), "usera", userAAccount);
        identityRegistry.registerIdentity(keccak256("+2222222222"), "userb", userBAccount);
        vm.stopPrank();

        // 4. Deploy Mock Token
        token = new MockLifecycleERC20("USDC Mock", "USDC");
    }

    // ── Scenario 1: Voluntary On-Chain Settlement ─────────────────────────────
    function test_lifecycle_1_voluntary_onChainSettlement() public {
        uint128 amount = 1000e6;
        token.mint(userBAccount, amount);

        // A creates Voluntary pledge for B
        uint64 due = uint64(block.timestamp + 7 days);
        vm.prank(userAAccount);
        uint256 pId = pledgeLedger.createPledge(
            userBAccount,
            amount,
            address(token),
            due,
            PledgeLedger.Track.Voluntary
        );

        // B confirms pledge
        vm.prank(userBAccount);
        pledgeLedger.confirmPledge(pId);

        PledgeLedger.Pledge memory pActive = pledgeLedger.getPledge(pId);
        assertEq(uint256(pActive.status), uint256(PledgeLedger.Status.Active));

        // B approves SettlementRouter and settles on-chain
        vm.prank(userBOwner);
        LightAccount(payable(userBAccount)).execute(
            address(token),
            0,
            abi.encodeWithSelector(ERC20.approve.selector, address(settlementRouter), amount)
        );

        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            userBAccount,
            userAAccount,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.OnChain
        );

        vm.prank(userBAccount);
        settlementRouter.settleOnChain(pId);

        // Assert Settled and funds moved
        PledgeLedger.Pledge memory pSettled = pledgeLedger.getPledge(pId);
        assertEq(uint256(pSettled.status), uint256(PledgeLedger.Status.Settled));
        assertEq(token.balanceOf(userAAccount), amount);
        assertEq(token.balanceOf(userBAccount), 0);
    }

    // ── Scenario 2: Off-Chain Approved Settlement ─────────────────────────────
    function test_lifecycle_2_offChain_approvedSettlement() public {
        uint128 amount = 500e6;

        vm.prank(userAAccount);
        uint256 pId = pledgeLedger.createPledge(
            userBAccount,
            amount,
            address(token),
            uint64(block.timestamp + 5 days),
            PledgeLedger.Track.Voluntary
        );

        vm.prank(userBAccount);
        pledgeLedger.confirmPledge(pId);

        // Debtor B marks paid off-chain
        vm.prank(userBAccount);
        pledgeLedger.markPaidOffChain(pId);

        PledgeLedger.Pledge memory pClaimed = pledgeLedger.getPledge(pId);
        assertEq(uint256(pClaimed.status), uint256(PledgeLedger.Status.SettlementClaimed));

        // Lender A approves claim
        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            userBAccount,
            userAAccount,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.OffChain
        );

        vm.prank(userAAccount);
        settlementRouter.lenderRespond(pId, true);

        PledgeLedger.Pledge memory pSettled = pledgeLedger.getPledge(pId);
        assertEq(uint256(pSettled.status), uint256(PledgeLedger.Status.Settled));
    }

    // ── Scenario 3: Off-Chain Disputed Settlement ─────────────────────────────
    function test_lifecycle_3_offChain_disputedSettlement() public {
        uint128 amount = 300e6;

        vm.prank(userAAccount);
        uint256 pId = pledgeLedger.createPledge(
            userBAccount,
            amount,
            address(token),
            uint64(block.timestamp + 5 days),
            PledgeLedger.Track.Voluntary
        );

        vm.prank(userBAccount);
        pledgeLedger.confirmPledge(pId);

        vm.prank(userBAccount);
        pledgeLedger.markPaidOffChain(pId);

        // Lender A disapproves claim
        vm.expectEmit(true, true, true, true);
        emit OffChainClaimDisputed(pId, userBAccount, userAAccount);

        vm.prank(userAAccount);
        settlementRouter.lenderRespond(pId, false);

        // Assert back to Active, reputation incremented, and cooldown active
        PledgeLedger.Pledge memory pReverted = pledgeLedger.getPledge(pId);
        assertEq(uint256(pReverted.status), uint256(PledgeLedger.Status.Active));
        assertEq(reputationEngine.getDisapprovalCount(userBAccount), 1);
        assertGt(pReverted.lastClaimAt, 0);

        // Debtor cannot immediately re-claim within 30 days
        vm.prank(userBAccount);
        vm.expectRevert(PledgeLedger.ClaimCooldownNotElapsed.selector);
        pledgeLedger.markPaidOffChain(pId);

        // After 30 days, re-claim succeeds
        vm.warp(pReverted.lastClaimAt + 30 days + 1);
        vm.prank(userBAccount);
        pledgeLedger.markPaidOffChain(pId);

        PledgeLedger.Pledge memory pReclaimed = pledgeLedger.getPledge(pId);
        assertEq(uint256(pReclaimed.status), uint256(PledgeLedger.Status.SettlementClaimed));
    }

    // ── Scenario 4: Auto-Clear Settlement (14-day rule) ───────────────────────
    function test_lifecycle_4_autoClear() public {
        uint128 amount = 400e6;

        vm.prank(userAAccount);
        uint256 pId = pledgeLedger.createPledge(
            userBAccount,
            amount,
            address(token),
            uint64(block.timestamp + 10 days),
            PledgeLedger.Track.Voluntary
        );

        vm.prank(userBAccount);
        pledgeLedger.confirmPledge(pId);

        vm.prank(userBAccount);
        pledgeLedger.markPaidOffChain(pId);

        // Lender does nothing; advance time 14 days
        vm.warp(block.timestamp + 14 days);

        // Relayer runs auto-clear sweep
        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            userBAccount,
            userAAccount,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.AutoCleared
        );

        vm.prank(relayer);
        settlementRouter.autoApproveOffChainSettlement(pId);

        PledgeLedger.Pledge memory pSettled = pledgeLedger.getPledge(pId);
        assertEq(uint256(pSettled.status), uint256(PledgeLedger.Status.Settled));
    }

    // ── Scenario 5: Enforced Track Success (Direct Debit) ─────────────────────
    function test_lifecycle_5_enforced_success_directDebit() public {
        uint128 amount = 750e6;
        token.mint(userBAccount, amount);

        uint64 due = uint64(block.timestamp + 3 days);
        vm.prank(userAAccount);
        uint256 pId = pledgeLedger.createPledge(
            userBAccount,
            amount,
            address(token),
            due,
            PledgeLedger.Track.Enforced
        );

        // Debtor executes batched approve and confirm
        address[] memory targets = new address[](2);
        targets[0] = address(token);
        targets[1] = address(pledgeLedger);

        bytes[] memory callDatas = new bytes[](2);
        callDatas[0] = abi.encodeWithSelector(ERC20.approve.selector, address(settlementRouter), amount);
        callDatas[1] = abi.encodeWithSelector(PledgeLedger.confirmPledge.selector, pId);

        vm.prank(userBOwner);
        LightAccount(payable(userBAccount)).executeBatch(targets, callDatas);

        assertEq(token.allowance(userBAccount, address(settlementRouter)), amount);

        // Advance to due date
        vm.warp(due + 1);

        // Keeper runs direct debit
        vm.expectEmit(true, true, true, true);
        emit PledgeSettled(
            pId,
            userBAccount,
            userAAccount,
            amount,
            address(token),
            SettlementRouter.SettlementMethod.DirectDebit
        );

        vm.prank(keeper);
        settlementRouter.executeDirectDebit(pId);

        // Assert Settled, funds pulled, allowance cleared
        PledgeLedger.Pledge memory pSettled = pledgeLedger.getPledge(pId);
        assertEq(uint256(pSettled.status), uint256(PledgeLedger.Status.Settled));
        assertEq(token.balanceOf(userAAccount), amount);
        assertEq(token.balanceOf(userBAccount), 0);
        assertEq(token.allowance(userBAccount, address(settlementRouter)), 0);
    }

    // ── Scenario 6: Enforced Track Default (Drained Balance) ───────────────────
    function test_lifecycle_6_enforced_default_drainedBalance() public {
        uint128 amount = 600e6;
        token.mint(userBAccount, amount);

        uint64 due = uint64(block.timestamp + 3 days);
        vm.prank(userAAccount);
        uint256 pId = pledgeLedger.createPledge(
            userBAccount,
            amount,
            address(token),
            due,
            PledgeLedger.Track.Enforced
        );

        // Debtor confirms with batched approve
        address[] memory targets = new address[](2);
        targets[0] = address(token);
        targets[1] = address(pledgeLedger);

        bytes[] memory callDatas = new bytes[](2);
        callDatas[0] = abi.encodeWithSelector(ERC20.approve.selector, address(settlementRouter), amount);
        callDatas[1] = abi.encodeWithSelector(PledgeLedger.confirmPledge.selector, pId);

        vm.prank(userBOwner);
        LightAccount(payable(userBAccount)).executeBatch(targets, callDatas);

        // Debtor drains balance before due
        vm.prank(userBOwner);
        LightAccount(payable(userBAccount)).execute(
            address(token),
            0,
            abi.encodeWithSelector(ERC20.transfer.selector, address(0xDEAD), amount)
        );
        assertEq(token.balanceOf(userBAccount), 0);

        // Advance to due date
        vm.warp(due + 1);

        // Keeper runs direct debit: does NOT revert; sets Defaulted and emits event
        vm.expectEmit(true, true, false, true);
        emit DirectDebitFailed(pId, userBAccount, "TransferFailed");

        vm.prank(keeper);
        settlementRouter.executeDirectDebit(pId);

        PledgeLedger.Pledge memory pDefaulted = pledgeLedger.getPledge(pId);
        assertEq(uint256(pDefaulted.status), uint256(PledgeLedger.Status.Defaulted));
    }

    // ── Scenario 7: Reputation Escalation & Blacklist (All 4 Contracts) ──────
    function test_lifecycle_7_reputationEscalation_and_blacklistEnforcement() public {
        assertEq(reputationEngine.getDisapprovalCount(userBAccount), 0);
        assertEq(uint256(reputationEngine.getTier(userBAccount)), uint256(ReputationEngine.Tier.Normal));
        assertFalse(identityRegistry.isBlacklisted(userBAccount));

        // Drive debtor B to 5 disapprovals
        for (uint256 i = 0; i < 5; i++) {
            PledgeLedger.Track track = i >= 3 ? PledgeLedger.Track.Enforced : PledgeLedger.Track.Voluntary;

            vm.prank(userAAccount);
            uint256 pId = pledgeLedger.createPledge(
                userBAccount,
                100e6,
                address(token),
                uint64(block.timestamp + 1 days),
                track
            );

            vm.prank(userBAccount);
            pledgeLedger.confirmPledge(pId);

            vm.prank(userBAccount);
            pledgeLedger.markPaidOffChain(pId);

            // Lender disapproves
            vm.prank(userAAccount);
            settlementRouter.lenderRespond(pId, false);
        }

        // Check full cross-contract state:
        // 1. ReputationEngine disapproval count == 5
        assertEq(reputationEngine.getDisapprovalCount(userBAccount), 5);
        // 2. ReputationEngine tier == Blacklisted
        assertEq(uint256(reputationEngine.getTier(userBAccount)), uint256(ReputationEngine.Tier.Blacklisted));
        // 3. IdentityRegistry blacklisted == true
        assertTrue(identityRegistry.isBlacklisted(userBAccount));

        // 4. PledgeLedger rejects any new pledge where B is debtor
        vm.prank(userAAccount);
        vm.expectRevert(PledgeLedger.PartyBlacklisted.selector);
        pledgeLedger.createPledge(
            userBAccount,
            100e6,
            address(token),
            uint64(block.timestamp + 1 days),
            PledgeLedger.Track.Voluntary
        );

        // 5. PledgeLedger rejects any new pledge where B is lender
        vm.prank(userBAccount);
        vm.expectRevert(PledgeLedger.PartyBlacklisted.selector);
        pledgeLedger.createPledge(
            userAAccount,
            100e6,
            address(token),
            uint64(block.timestamp + 1 days),
            PledgeLedger.Track.Voluntary
        );
    }
}
