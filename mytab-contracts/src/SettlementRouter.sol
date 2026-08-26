// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPledgeLedger {
    enum Status { Pending, Active, SettlementClaimed, Settled, Defaulted, Cancelled }
    enum Track { Voluntary, Enforced }

    struct Pledge {
        address lender;
        address debtor;
        uint128 amount;
        address token;
        uint64 dueTimestamp;
        uint64 createdAt;
        uint64 claimedAt;
        Status status;
        Track track;
        uint64 lastClaimAt;
    }

    function getPledge(uint256 pledgeId) external view returns (Pledge memory);
    function setSettled(uint256 pledgeId) external;
    function setDefaulted(uint256 pledgeId) external;
    function setDisapproved(uint256 pledgeId) external;
}

interface IReputationEngine {
    function recordDisapproval(address debtor) external;
}

contract SettlementRouter is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint64 public constant AUTO_CLEAR_WINDOW = 14 days;

    enum SettlementMethod { OnChain, OffChain, DirectDebit, AutoCleared }

    IPledgeLedger public pledgeLedger;
    IReputationEngine public reputationEngine;

    event PledgeSettled(
        uint256 indexed pledgeId,
        address indexed debtor,
        address indexed lender,
        uint256 amount,
        address token,
        SettlementMethod method
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

    error Unauthorized();
    error InvalidStatus();
    error InvalidPledge();
    error InvalidTrack();
    error NotDue();
    error WindowNotElapsed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _pledgeLedger,
        address _reputationEngine,
        address initialAdmin
    ) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        pledgeLedger = IPledgeLedger(_pledgeLedger);
        reputationEngine = IReputationEngine(_reputationEngine);
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    /**
     * @notice Settles a pledge on-chain by transferring ERC20 tokens directly from debtor to lender.
     * @dev Works from both Active and SettlementClaimed statuses.
     * @param pledgeId The on-chain pledge ID.
     */
    function settleOnChain(uint256 pledgeId) external nonReentrant {
        IPledgeLedger.Pledge memory pledge = pledgeLedger.getPledge(pledgeId);
        if (pledge.lender == address(0)) revert InvalidPledge();
        if (msg.sender != pledge.debtor) revert Unauthorized();

        if (
            pledge.status != IPledgeLedger.Status.Active &&
            pledge.status != IPledgeLedger.Status.SettlementClaimed
        ) {
            revert InvalidStatus();
        }

        // Checks-effects-interactions: update state on ledger first, emit event, then transfer
        pledgeLedger.setSettled(pledgeId);

        emit PledgeSettled(
            pledgeId,
            pledge.debtor,
            pledge.lender,
            pledge.amount,
            pledge.token,
            SettlementMethod.OnChain
        );

        IERC20(pledge.token).safeTransferFrom(
            pledge.debtor,
            pledge.lender,
            pledge.amount
        );
    }

    /**
     * @notice Allows a lender to approve or dispute an off-chain settlement claim.
     * @param pledgeId The on-chain pledge ID.
     * @param approved True if lender confirms payment received, false to dispute.
     */
    function lenderRespond(
        uint256 pledgeId,
        bool approved
    ) external nonReentrant {
        IPledgeLedger.Pledge memory pledge = pledgeLedger.getPledge(pledgeId);
        if (pledge.lender == address(0)) revert InvalidPledge();
        if (msg.sender != pledge.lender) revert Unauthorized();

        if (pledge.status != IPledgeLedger.Status.SettlementClaimed) {
            revert InvalidStatus();
        }

        if (approved) {
            pledgeLedger.setSettled(pledgeId);

            emit PledgeSettled(
                pledgeId,
                pledge.debtor,
                pledge.lender,
                pledge.amount,
                pledge.token,
                SettlementMethod.OffChain
            );
        } else {
            pledgeLedger.setDisapproved(pledgeId);
            reputationEngine.recordDisapproval(pledge.debtor);

            emit OffChainClaimDisputed(pledgeId, pledge.debtor, pledge.lender);
        }
    }

    /**
     * @notice Executes automated direct debit on an overdue Enforced pledge.
     * @dev Only callable by KEEPER_ROLE. On transfer failure, sets Defaulted and emits DirectDebitFailed instead of reverting.
     * @param pledgeId The on-chain pledge ID.
     */
    function executeDirectDebit(
        uint256 pledgeId
    ) external onlyRole(KEEPER_ROLE) nonReentrant {
        IPledgeLedger.Pledge memory pledge = pledgeLedger.getPledge(pledgeId);
        if (pledge.lender == address(0)) revert InvalidPledge();
        if (pledge.track != IPledgeLedger.Track.Enforced) revert InvalidTrack();
        if (pledge.status != IPledgeLedger.Status.Active) revert InvalidStatus();
        if (block.timestamp < pledge.dueTimestamp) revert NotDue();

        // Attempt transferFrom with low-level call so failures do not revert the transaction
        (bool success, bytes memory returnData) = pledge.token.call(
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                pledge.debtor,
                pledge.lender,
                pledge.amount
            )
        );

        bool transferOk = success &&
            (returnData.length == 0 || abi.decode(returnData, (bool)));

        if (!transferOk) {
            pledgeLedger.setDefaulted(pledgeId);
            emit DirectDebitFailed(pledgeId, pledge.debtor, "TransferFailed");
            return;
        }

        pledgeLedger.setSettled(pledgeId);
        emit PledgeSettled(
            pledgeId,
            pledge.debtor,
            pledge.lender,
            pledge.amount,
            pledge.token,
            SettlementMethod.DirectDebit
        );
    }

    /**
     * @notice Automatically approves an off-chain settlement claim if 14 days have passed without lender response.
     * @dev Only callable by RELAYER_ROLE. Verified against claimedAt (which updates on each new claim).
     * @param pledgeId The on-chain pledge ID.
     */
    function autoApproveOffChainSettlement(
        uint256 pledgeId
    ) external onlyRole(RELAYER_ROLE) nonReentrant {
        IPledgeLedger.Pledge memory pledge = pledgeLedger.getPledge(pledgeId);
        if (pledge.lender == address(0)) revert InvalidPledge();
        if (pledge.status != IPledgeLedger.Status.SettlementClaimed) {
            revert InvalidStatus();
        }
        if (block.timestamp < pledge.claimedAt + AUTO_CLEAR_WINDOW) {
            revert WindowNotElapsed();
        }

        pledgeLedger.setSettled(pledgeId);
        emit PledgeSettled(
            pledgeId,
            pledge.debtor,
            pledge.lender,
            pledge.amount,
            pledge.token,
            SettlementMethod.AutoCleared
        );
    }

    uint256[50] private __gap;
}
