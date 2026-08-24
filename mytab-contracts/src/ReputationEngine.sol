// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

interface IIdentityRegistry {
    function setBlacklisted(address wallet, bool status) external;
}

contract ReputationEngine is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant DISAPPROVAL_REPORTER_ROLE = keccak256("DISAPPROVAL_REPORTER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    enum Tier {
        Normal,
        LightGrey,
        DarkCharcoal,
        Blacklisted
    }

    IIdentityRegistry public identityRegistry;
    mapping(address => uint256) private _disapprovalCount;

    event ReputationTierChanged(address indexed user, Tier oldTier, Tier newTier, uint256 disapprovalCount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _identityRegistry, address initialAdmin) initializer public {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        identityRegistry = IIdentityRegistry(_identityRegistry);
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}

    function recordDisapproval(address debtor) external onlyRole(DISAPPROVAL_REPORTER_ROLE) {
        Tier oldTier = getTier(debtor);
        
        _disapprovalCount[debtor] += 1;
        uint256 newCount = _disapprovalCount[debtor];
        
        Tier newTier = getTier(debtor);
        
        if (oldTier != newTier) {
            emit ReputationTierChanged(debtor, oldTier, newTier, newCount);
            if (newTier == Tier.Blacklisted) {
                identityRegistry.setBlacklisted(debtor, true);
            }
        }
    }

    function getTier(address user) public view returns (Tier) {
        uint256 count = _disapprovalCount[user];
        if (count == 0) {
            return Tier.Normal;
        } else if (count <= 2) {
            return Tier.LightGrey;
        } else if (count <= 4) {
            return Tier.DarkCharcoal;
        } else {
            return Tier.Blacklisted;
        }
    }

    function getDisapprovalCount(address user) external view returns (uint256) {
        return _disapprovalCount[user];
    }

    function requiresEnforcedTrack(address user) external view returns (bool) {
        Tier tier = getTier(user);
        return tier == Tier.DarkCharcoal || tier == Tier.Blacklisted;
    }

    uint256[50] private __gap;
}
