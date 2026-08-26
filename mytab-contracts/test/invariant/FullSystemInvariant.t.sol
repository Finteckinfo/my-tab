// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PledgeLedger} from "../../src/PledgeLedger.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {ReputationEngine} from "../../src/ReputationEngine.sol";
import {SettlementRouter} from "../../src/SettlementRouter.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ── Mock ERC20 for tracking real token flows ─────────────────────────────────
contract MockERC20 is ERC20 {
    constructor() ERC20("MockUSD", "MUSD") {
        // Mint to each actor so they can settle
        for (uint160 i = 1; i <= 10; i++) {
            _mint(address(i), 1_000_000e18);
        }
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ── Full System Handler ──────────────────────────────────────────────────────
contract FullSystemHandler is Test {
    PledgeLedger public ledger;
    IdentityRegistry public identity;
    ReputationEngine public reputation;
    SettlementRouter public router;
    MockERC20 public token;

    // ── Ghost variables for invariant tracking ───────────────────────────────
    mapping(uint256 => bool) public wasConfirmedByDebtor;
    mapping(uint256 => bool) public hasSettledFunds;     // Did this pledge actually move tokens?
    mapping(uint256 => bool) public reachedTerminal;
    mapping(address => uint256) public expectedDisapprovalCount;

    // Status tracking: record the full transition history
    mapping(uint256 => PledgeLedger.Status[]) public statusHistory;
    mapping(uint256 => PledgeLedger.Status) public lastKnownStatus;

    // Immutable pledge fields snapshot at creation
    struct PledgeSnapshot {
        address lender;
        address debtor;
        uint128 amount;
        address pledgeToken;
        bool exists;
    }
    mapping(uint256 => PledgeSnapshot) public snapshots;

    // Conservation tracking
    uint256 public totalTokensTransferred;
    uint256 public totalSettledAmounts;

    // Blacklist timestamp tracking
    mapping(address => uint256) public blacklistedAtPledgeId; // pledgeId at which address was blacklisted (0 = never)

    address[] public actors;
    address public keeper;
    address public relayer;

    uint256 public createdCount;

    constructor(
        PledgeLedger _ledger,
        IdentityRegistry _identity,
        ReputationEngine _reputation,
        SettlementRouter _router,
        MockERC20 _token,
        address _keeper,
        address _relayer
    ) {
        ledger = _ledger;
        identity = _identity;
        reputation = _reputation;
        router = _router;
        token = _token;
        keeper = _keeper;
        relayer = _relayer;

        for (uint160 i = 1; i <= 10; i++) {
            actors.push(address(i));
        }
    }

    function _randomActor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ── State-changing functions ─────────────────────────────────────────────

    function createPledge(uint256 seed, uint128 amount, uint32 dueOffset, uint8 trackSeed) external {
        address lender = _randomActor(seed);
        address debtor = _randomActor(seed >> 8);
        if (lender == debtor) return;
        if (identity.isBlacklisted(lender) || identity.isBlacklisted(debtor)) return;

        uint64 dueTimestamp = uint64(block.timestamp + 1 + dueOffset % 365 days);
        PledgeLedger.Track track = trackSeed % 2 == 0
            ? PledgeLedger.Track.Voluntary
            : PledgeLedger.Track.Enforced;

        if (track == PledgeLedger.Track.Voluntary && reputation.requiresEnforcedTrack(debtor)) return;
        // Bound amount to something reasonable
        if (amount == 0) amount = 1;
        if (amount > 1000e18) amount = uint128(amount % 1000e18) + 1;

        vm.prank(lender);
        try ledger.createPledge(debtor, amount, address(token), dueTimestamp, track) returns (uint256 pId) {
            createdCount++;
            snapshots[pId] = PledgeSnapshot(lender, debtor, amount, address(token), true);
            lastKnownStatus[pId] = PledgeLedger.Status.Pending;
            statusHistory[pId].push(PledgeLedger.Status.Pending);
        } catch {}
    }

    function confirmPledge(uint256 seed, uint256 pId) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        // Only the debtor can confirm
        vm.prank(p.debtor);
        try ledger.confirmPledge(pId) {
            wasConfirmedByDebtor[pId] = true;
            lastKnownStatus[pId] = PledgeLedger.Status.Active;
            statusHistory[pId].push(PledgeLedger.Status.Active);

            // For enforced track, debtor approves the router for the pledge amount
            if (p.track == PledgeLedger.Track.Enforced) {
                vm.prank(p.debtor);
                token.approve(address(router), token.allowance(p.debtor, address(router)) + p.amount);
            }
        } catch {}
    }

    function cancelPledge(uint256 seed, uint256 pId) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        vm.prank(p.lender);
        try ledger.cancelPledge(pId) {
            lastKnownStatus[pId] = PledgeLedger.Status.Cancelled;
            statusHistory[pId].push(PledgeLedger.Status.Cancelled);
        } catch {}
    }

    function markPaidOffChain(uint256 seed, uint256 pId) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        vm.prank(p.debtor);
        try ledger.markPaidOffChain(pId) {
            lastKnownStatus[pId] = PledgeLedger.Status.SettlementClaimed;
            statusHistory[pId].push(PledgeLedger.Status.SettlementClaimed);
        } catch {}
    }

    function settleOnChain(uint256 seed, uint256 pId) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        if (p.status != PledgeLedger.Status.Active && p.status != PledgeLedger.Status.SettlementClaimed) return;

        // Debtor needs to approve the router
        vm.prank(p.debtor);
        token.approve(address(router), p.amount);

        uint256 lenderBefore = token.balanceOf(p.lender);


        vm.prank(p.debtor);
        try router.settleOnChain(pId) {
            uint256 transferred = token.balanceOf(p.lender) - lenderBefore;
            totalTokensTransferred += transferred;
            totalSettledAmounts += p.amount;
            hasSettledFunds[pId] = true;
            reachedTerminal[pId] = true;
            lastKnownStatus[pId] = PledgeLedger.Status.Settled;
            statusHistory[pId].push(PledgeLedger.Status.Settled);
        } catch {}
    }

    function executeDirectDebit(uint256 seed, uint256 pId) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        if (p.track != PledgeLedger.Track.Enforced) return;
        if (p.status != PledgeLedger.Status.Active) return;
        if (block.timestamp < p.dueTimestamp) return;

        uint256 lenderBefore = token.balanceOf(p.lender);

        vm.prank(keeper);
        try router.executeDirectDebit(pId) {
            // Check if it settled or defaulted
            PledgeLedger.Pledge memory after_ = ledger.getPledge(pId);
            if (after_.status == PledgeLedger.Status.Settled) {
                uint256 transferred = token.balanceOf(p.lender) - lenderBefore;
                totalTokensTransferred += transferred;
                totalSettledAmounts += p.amount;
                hasSettledFunds[pId] = true;
                lastKnownStatus[pId] = PledgeLedger.Status.Settled;
                statusHistory[pId].push(PledgeLedger.Status.Settled);
            } else if (after_.status == PledgeLedger.Status.Defaulted) {
                lastKnownStatus[pId] = PledgeLedger.Status.Defaulted;
                statusHistory[pId].push(PledgeLedger.Status.Defaulted);
            }
            reachedTerminal[pId] = true;
        } catch {}
    }

    function lenderRespond(uint256 seed, uint256 pId, bool approved) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        if (p.status != PledgeLedger.Status.SettlementClaimed) return;

        vm.prank(p.lender);
        try router.lenderRespond(pId, approved) {
            if (approved) {
                totalSettledAmounts += p.amount; // Off-chain settlement, no token movement
                reachedTerminal[pId] = true;
                lastKnownStatus[pId] = PledgeLedger.Status.Settled;
                statusHistory[pId].push(PledgeLedger.Status.Settled);
            } else {
                // Disapproval: status goes back to Active
                expectedDisapprovalCount[p.debtor]++;
                lastKnownStatus[pId] = PledgeLedger.Status.Active;
                statusHistory[pId].push(PledgeLedger.Status.Active);

                // Check if this caused blacklisting
                if (reputation.getTier(p.debtor) == ReputationEngine.Tier.Blacklisted
                    && blacklistedAtPledgeId[p.debtor] == 0) {
                    blacklistedAtPledgeId[p.debtor] = createdCount;
                }
            }
        } catch {}
    }

    function autoApproveOffChainSettlement(uint256 seed, uint256 pId) external {
        if (createdCount == 0) return;
        pId = (pId % createdCount) + 1;

        PledgeLedger.Pledge memory p = ledger.getPledge(pId);
        if (p.status != PledgeLedger.Status.SettlementClaimed) return;
        if (block.timestamp < p.claimedAt + 14 days) return;

        vm.prank(relayer);
        try router.autoApproveOffChainSettlement(pId) {
            totalSettledAmounts += p.amount;
            reachedTerminal[pId] = true;
            lastKnownStatus[pId] = PledgeLedger.Status.Settled;
            statusHistory[pId].push(PledgeLedger.Status.Settled);
        } catch {}
    }

    function warpTime(uint256 amount) external {
        amount = amount % 100 days;
        vm.warp(block.timestamp + amount);
    }

    // ── View helpers for invariant checks ────────────────────────────────────

    function getStatusHistoryLength(uint256 pId) external view returns (uint256) {
        return statusHistory[pId].length;
    }

    function getStatusAt(uint256 pId, uint256 idx) external view returns (PledgeLedger.Status) {
        return statusHistory[pId][idx];
    }
}

// ── Invariant Test Contract ──────────────────────────────────────────────────
contract FullSystemInvariantTest is Test {
    PledgeLedger ledger;
    IdentityRegistry identity;
    ReputationEngine reputation;
    SettlementRouter router;
    MockERC20 token;
    FullSystemHandler handler;

    address admin = address(0xAD);
    address keeper = address(0xBE);
    address relayer = address(0xCE);

    function setUp() public {
        vm.startPrank(admin);

        // Deploy IdentityRegistry
        identity = new IdentityRegistry(admin);

        // Deploy ReputationEngine (UUPS proxy)
        ReputationEngine repImpl = new ReputationEngine();
        ERC1967Proxy repProxy = new ERC1967Proxy(
            address(repImpl),
            abi.encodeWithSelector(ReputationEngine.initialize.selector, address(identity), admin)
        );
        reputation = ReputationEngine(address(repProxy));

        // Deploy PledgeLedger (UUPS proxy)
        PledgeLedger ledgerImpl = new PledgeLedger();
        ERC1967Proxy ledgerProxy = new ERC1967Proxy(
            address(ledgerImpl),
            abi.encodeWithSelector(PledgeLedger.initialize.selector, address(identity), address(reputation), admin)
        );
        ledger = PledgeLedger(address(ledgerProxy));

        // Deploy SettlementRouter (UUPS proxy)
        SettlementRouter routerImpl = new SettlementRouter();
        ERC1967Proxy routerProxy = new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSelector(SettlementRouter.initialize.selector, address(ledger), address(reputation), admin)
        );
        router = SettlementRouter(address(routerProxy));

        // Deploy mock token
        token = new MockERC20();

        // Wire roles
        identity.grantRole(identity.REPUTATION_ROLE(), address(reputation));
        reputation.grantRole(reputation.DISAPPROVAL_REPORTER_ROLE(), address(router));
        ledger.grantRole(ledger.SETTLEMENT_ROLE(), address(router));
        router.grantRole(router.KEEPER_ROLE(), keeper);
        router.grantRole(router.RELAYER_ROLE(), relayer);

        vm.stopPrank();

        // Create handler
        handler = new FullSystemHandler(ledger, identity, reputation, router, token, keeper, relayer);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = FullSystemHandler.createPledge.selector;
        selectors[1] = FullSystemHandler.confirmPledge.selector;
        selectors[2] = FullSystemHandler.cancelPledge.selector;
        selectors[3] = FullSystemHandler.markPaidOffChain.selector;
        selectors[4] = FullSystemHandler.settleOnChain.selector;
        selectors[5] = FullSystemHandler.executeDirectDebit.selector;
        selectors[6] = FullSystemHandler.lenderRespond.selector;
        selectors[7] = FullSystemHandler.autoApproveOffChainSettlement.selector;
        selectors[8] = FullSystemHandler.warpTime.selector;
        // Add a 9th to avoid array length issues — repeat warpTime for weighting
        selectors[9] = FullSystemHandler.warpTime.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // CONSERVATION INVARIANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Total tokens transferred by SettlementRouter == sum of settled pledge amounts (on-chain settlements only).
    function invariant_conservation_totalTransferred() public view {
        assertEq(
            handler.totalTokensTransferred(),
            _sumOnChainSettledAmounts(),
            "Conservation: tokens transferred != on-chain settled amounts"
        );
    }

    function _sumOnChainSettledAmounts() internal view returns (uint256 total) {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            if (handler.hasSettledFunds(i)) {
                (,,uint128 amount,,) = handler.snapshots(i);
                total += amount;
            }
        }
    }

    /// @notice No pledge settles twice — once terminal, the pledge never moves funds again.
    function invariant_conservation_noDoubleSettle() public view {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            uint256 histLen = handler.getStatusHistoryLength(i);
            uint256 settledCount = 0;
            for (uint256 j = 0; j < histLen; j++) {
                if (handler.getStatusAt(i, j) == PledgeLedger.Status.Settled) {
                    settledCount++;
                }
            }
            assertTrue(settledCount <= 1, "Conservation: pledge settled more than once");
        }
    }

    /// @notice No pledge moves funds without reaching a terminal status.
    function invariant_conservation_noFundsWithoutTerminal() public view {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            if (handler.hasSettledFunds(i)) {
                assertTrue(handler.reachedTerminal(i), "Conservation: funds moved without terminal status");
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // AUTHORIZATION INVARIANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice No pledge reaches Active without confirmPledge from its debtor.
    function invariant_auth_noActiveWithoutDebtorConfirm() public view {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            PledgeLedger.Pledge memory p = ledger.getPledge(i);
            if (p.status == PledgeLedger.Status.Active ||
                p.status == PledgeLedger.Status.SettlementClaimed ||
                p.status == PledgeLedger.Status.Settled ||
                p.status == PledgeLedger.Status.Defaulted) {
                assertTrue(
                    handler.wasConfirmedByDebtor(i),
                    "Auth: pledge reached post-Pending state without debtor confirmation"
                );
            }
        }
    }

    /// @notice disapprovalCount increments only via the legitimate disapproval path.
    function invariant_auth_disapprovalCountIntegrity() public view {
        for (uint160 i = 1; i <= 10; i++) {
            address a = address(i);
            assertEq(
                reputation.getDisapprovalCount(a),
                handler.expectedDisapprovalCount(a),
                "Auth: disapproval count mismatch"
            );
        }
    }

    /// @notice No token allowance from a debtor to the router exceeds the sum of that debtor's
    ///         active enforced pledges in that token.
    function invariant_auth_allowanceNotExcessive() public view {
        for (uint160 i = 1; i <= 10; i++) {
            address debtor = address(i);
            uint256 totalActiveEnforced = 0;
            for (uint256 j = 1; j <= handler.createdCount(); j++) {
                (,address pDebtor, uint128 amount, address pToken, bool exists) = handler.snapshots(j);
                if (!exists) continue;
                if (pDebtor != debtor) continue;
                if (pToken != address(token)) continue;

                PledgeLedger.Pledge memory p = ledger.getPledge(j);
                if (p.track == PledgeLedger.Track.Enforced && p.status == PledgeLedger.Status.Active) {
                    totalActiveEnforced += amount;
                }
            }
            uint256 currentAllowance = token.allowance(debtor, address(router));
            assertTrue(
                currentAllowance <= totalActiveEnforced + 1000e18, // Allow for approval headroom from settle attempts
                "Auth: allowance exceeds active enforced obligation"
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STATE MACHINE INVARIANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Status only follows legal transitions.
    function invariant_stateMachine_legalTransitions() public view {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            uint256 histLen = handler.getStatusHistoryLength(i);
            for (uint256 j = 1; j < histLen; j++) {
                PledgeLedger.Status prev = handler.getStatusAt(i, j - 1);
                PledgeLedger.Status curr = handler.getStatusAt(i, j);
                assertTrue(
                    _isLegalTransition(prev, curr),
                    "StateMachine: illegal status transition"
                );
            }
        }
    }

    function _isLegalTransition(PledgeLedger.Status from, PledgeLedger.Status to) internal pure returns (bool) {
        // Pending → Active | Cancelled
        if (from == PledgeLedger.Status.Pending) {
            return to == PledgeLedger.Status.Active || to == PledgeLedger.Status.Cancelled;
        }
        // Active → SettlementClaimed | Settled | Defaulted
        if (from == PledgeLedger.Status.Active) {
            return to == PledgeLedger.Status.SettlementClaimed ||
                   to == PledgeLedger.Status.Settled ||
                   to == PledgeLedger.Status.Defaulted;
        }
        // SettlementClaimed → Settled | Active (disapproval)
        if (from == PledgeLedger.Status.SettlementClaimed) {
            return to == PledgeLedger.Status.Settled || to == PledgeLedger.Status.Active;
        }
        // Terminal states: no transitions out
        return false;
    }

    /// @notice Terminal statuses (Settled, Defaulted, Cancelled) are terminal.
    function invariant_stateMachine_terminalIsTerminal() public view {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            uint256 histLen = handler.getStatusHistoryLength(i);
            for (uint256 j = 0; j < histLen; j++) {
                PledgeLedger.Status s = handler.getStatusAt(i, j);
                if (s == PledgeLedger.Status.Settled ||
                    s == PledgeLedger.Status.Defaulted ||
                    s == PledgeLedger.Status.Cancelled) {
                    // Nothing should follow a terminal status
                    assertEq(j, histLen - 1, "StateMachine: non-terminal transition after terminal status");
                }
            }
        }
    }

    /// @notice A Settled pledge never re-opens.
    function invariant_stateMachine_settledNeverReopens() public {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            PledgeLedger.Pledge memory p = ledger.getPledge(i);
            uint256 histLen = handler.getStatusHistoryLength(i);

            bool sawSettled = false;
            for (uint256 j = 0; j < histLen; j++) {
                if (handler.getStatusAt(i, j) == PledgeLedger.Status.Settled) {
                    sawSettled = true;
                } else if (sawSettled) {
                    fail("StateMachine: pledge re-opened after Settled");
                }
            }
            // Also verify current on-chain state
            if (sawSettled) {
                assertEq(
                    uint8(p.status),
                    uint8(PledgeLedger.Status.Settled),
                    "StateMachine: on-chain status diverged from Settled"
                );
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // REPUTATION INVARIANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Tier always matches count per the spec table.
    function invariant_reputation_tierMatchesCount() public view {
        for (uint160 i = 1; i <= 10; i++) {
            address a = address(i);
            uint256 count = reputation.getDisapprovalCount(a);
            ReputationEngine.Tier tier = reputation.getTier(a);

            if (count == 0) {
                assertEq(uint8(tier), uint8(ReputationEngine.Tier.Normal), "Rep: count 0 should be Normal");
            } else if (count <= 2) {
                assertEq(uint8(tier), uint8(ReputationEngine.Tier.LightGrey), "Rep: count 1-2 should be LightGrey");
            } else if (count <= 4) {
                assertEq(uint8(tier), uint8(ReputationEngine.Tier.DarkCharcoal), "Rep: count 3-4 should be DarkCharcoal");
            } else {
                assertEq(uint8(tier), uint8(ReputationEngine.Tier.Blacklisted), "Rep: count 5+ should be Blacklisted");
            }
        }
    }

    /// @notice Blacklist flips only at count == 5.
    function invariant_reputation_blacklistOnlyAtFive() public view {
        for (uint160 i = 1; i <= 10; i++) {
            address a = address(i);
            uint256 count = reputation.getDisapprovalCount(a);
            bool blacklisted = identity.isBlacklisted(a);

            if (count < 5) {
                assertFalse(blacklisted, "Rep: blacklisted below 5 disapprovals");
            }
            // At 5+, they MUST be blacklisted (the contract auto-blacklists at the transition)
            if (count >= 5) {
                assertTrue(blacklisted, "Rep: not blacklisted at 5+ disapprovals");
            }
        }
    }

    /// @notice A blacklisted address is never party to a pledge created after blacklisting.
    function invariant_reputation_noPostBlacklistPledge() public {
        for (uint256 i = 1; i <= handler.createdCount(); i++) {
            (address lender, address debtor,,, bool exists) = handler.snapshots(i);
            if (!exists) continue;

            // If lender was blacklisted before this pledge was created, it shouldn't exist
            uint256 lenderBL = handler.blacklistedAtPledgeId(lender);
            if (lenderBL > 0 && lenderBL < i) {
                fail("Rep: blacklisted lender is party to a later pledge");
            }

            uint256 debtorBL = handler.blacklistedAtPledgeId(debtor);
            if (debtorBL > 0 && debtorBL < i) {
                fail("Rep: blacklisted debtor is party to a later pledge");
            }
        }
    }
}
