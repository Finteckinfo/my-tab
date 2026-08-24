// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

interface IIdentityRegistry {
    function isBlacklisted(address wallet) external view returns (bool);
}

interface IReputationEngine {
    function requiresEnforcedTrack(address user) external view returns (bool);
}

contract PledgeLedger is Initializable, AccessControlUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

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

    uint64 public constant CONFIRMATION_WINDOW = 7 days;
    uint64 public constant CLAIM_COOLDOWN = 30 days;

    IIdentityRegistry public identityRegistry;
    IReputationEngine public reputationEngine;

    mapping(uint256 => Pledge) private _pledges;
    uint256 private _nextPledgeId;
    mapping(address => uint256[]) private _pledgesByLender;
    mapping(address => uint256[]) private _pledgesByDebtor;

    event PledgeCreated(uint256 indexed pledgeId, address indexed lender, address indexed debtor, uint128 amount, address token, uint64 dueTimestamp, Track track);
    event PledgeConfirmed(uint256 indexed pledgeId);
    event PledgeCancelled(uint256 indexed pledgeId);
    event SettlementClaimedEvent(uint256 indexed pledgeId);
    event PledgeStatusChanged(uint256 indexed pledgeId, Status oldStatus, Status newStatus);

    error PartyBlacklisted();
    error SelfPledgeNotAllowed();
    error InvalidDueTimestamp();
    error EnforcedTrackRequired();
    error Unauthorized();
    error InvalidStatus();
    error ConfirmationWindowExpired();
    error ClaimCooldownNotElapsed();
    error InvalidPledgeId();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _identityRegistry, address _reputationEngine, address initialAdmin) initializer public {
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        identityRegistry = IIdentityRegistry(_identityRegistry);
        reputationEngine = IReputationEngine(_reputationEngine);
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}

    function createPledge(address debtor, uint128 amount, address token, uint64 dueTimestamp, Track track) external returns (uint256 pledgeId) {
        if (debtor == msg.sender) revert SelfPledgeNotAllowed();
        if (dueTimestamp <= block.timestamp) revert InvalidDueTimestamp();
        if (identityRegistry.isBlacklisted(msg.sender) || identityRegistry.isBlacklisted(debtor)) revert PartyBlacklisted();
        if (track == Track.Voluntary && reputationEngine.requiresEnforcedTrack(debtor)) revert EnforcedTrackRequired();

        pledgeId = ++_nextPledgeId;

        Pledge storage pledge = _pledges[pledgeId];
        pledge.lender = msg.sender;
        pledge.debtor = debtor;
        pledge.amount = amount;
        pledge.token = token;
        pledge.dueTimestamp = dueTimestamp;
        pledge.createdAt = uint64(block.timestamp);
        pledge.status = Status.Pending;
        pledge.track = track;

        _pledgesByLender[msg.sender].push(pledgeId);
        _pledgesByDebtor[debtor].push(pledgeId);

        emit PledgeCreated(pledgeId, msg.sender, debtor, amount, token, dueTimestamp, track);
    }

    function confirmPledge(uint256 pledgeId) external {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) revert InvalidPledgeId();
        if (msg.sender != pledge.debtor) revert Unauthorized();
        if (pledge.status != Status.Pending) revert InvalidStatus();
        if (block.timestamp > pledge.createdAt + CONFIRMATION_WINDOW) revert ConfirmationWindowExpired();

        pledge.status = Status.Active;
        emit PledgeConfirmed(pledgeId);
        emit PledgeStatusChanged(pledgeId, Status.Pending, Status.Active);
    }

    function cancelPledge(uint256 pledgeId) external {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) revert InvalidPledgeId();
        if (msg.sender != pledge.lender) revert Unauthorized();
        if (pledge.status != Status.Pending) revert InvalidStatus();

        pledge.status = Status.Cancelled;
        emit PledgeCancelled(pledgeId);
        emit PledgeStatusChanged(pledgeId, Status.Pending, Status.Cancelled);
    }

    function markPaidOffChain(uint256 pledgeId) external {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) revert InvalidPledgeId();
        if (msg.sender != pledge.debtor) revert Unauthorized();
        if (pledge.status != Status.Active) revert InvalidStatus();
        
        if (pledge.lastClaimAt > 0 && block.timestamp < pledge.lastClaimAt + CLAIM_COOLDOWN) {
            revert ClaimCooldownNotElapsed();
        }

        pledge.status = Status.SettlementClaimed;
        pledge.claimedAt = uint64(block.timestamp);
        pledge.lastClaimAt = uint64(block.timestamp);

        emit SettlementClaimedEvent(pledgeId);
        emit PledgeStatusChanged(pledgeId, Status.Active, Status.SettlementClaimed);
    }

    // SETTLEMENT_ROLE functions for router to manage status
    function setSettled(uint256 pledgeId) external onlyRole(SETTLEMENT_ROLE) {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) revert InvalidPledgeId();
        
        Status oldStatus = pledge.status;
        pledge.status = Status.Settled;
        emit PledgeStatusChanged(pledgeId, oldStatus, Status.Settled);
    }

    function setDefaulted(uint256 pledgeId) external onlyRole(SETTLEMENT_ROLE) {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) revert InvalidPledgeId();
        
        Status oldStatus = pledge.status;
        pledge.status = Status.Defaulted;
        emit PledgeStatusChanged(pledgeId, oldStatus, Status.Defaulted);
    }

    function setDisapproved(uint256 pledgeId) external onlyRole(SETTLEMENT_ROLE) {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) revert InvalidPledgeId();
        if (pledge.status != Status.SettlementClaimed) revert InvalidStatus();

        pledge.status = Status.Active;
        emit PledgeStatusChanged(pledgeId, Status.SettlementClaimed, Status.Active);
    }

    // View Functions
    function getPledge(uint256 pledgeId) external view returns (Pledge memory) {
        return _pledges[pledgeId];
    }

    function isOverdue(uint256 pledgeId) external view returns (bool) {
        Pledge storage pledge = _pledges[pledgeId];
        if (pledge.lender == address(0)) return false; // Or revert? Let's just return false for non-existent, or maybe check.
        
        return pledge.status == Status.Active && block.timestamp > pledge.dueTimestamp;
    }

    function getPledgesByLender(address lender) external view returns (uint256[] memory) {
        return _pledgesByLender[lender];
    }

    function getPledgesByDebtor(address debtor) external view returns (uint256[] memory) {
        return _pledgesByDebtor[debtor];
    }

    uint256[50] private __gap;
}
