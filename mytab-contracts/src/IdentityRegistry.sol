// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract IdentityRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant REPUTATION_ROLE = keccak256("REPUTATION_ROLE");

    mapping(bytes32 => address) private _phoneHashToWallet;
    mapping(bytes32 => address) private _usernameHashToWallet;
    mapping(address => bytes32) private _walletToUsernameHash;
    mapping(address => bool) private _blacklist;

    event IdentityRegistered(bytes32 indexed phoneHash, bytes32 indexed usernameHash, address indexed wallet);
    event BlacklistStatusChanged(address indexed wallet, bool status);

    error PhoneAlreadyRegistered(address existingWallet);
    error UsernameTaken();
    error WalletAlreadyRegistered();

    constructor(address initialAdmin) {
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    function registerIdentity(bytes32 phoneHash, bytes32 usernameHash, address wallet) external onlyRole(REGISTRAR_ROLE) {
        address existingWallet = _phoneHashToWallet[phoneHash];
        if (existingWallet != address(0)) {
            revert PhoneAlreadyRegistered(existingWallet);
        }
        if (_usernameHashToWallet[usernameHash] != address(0)) {
            revert UsernameTaken();
        }
        if (_walletToUsernameHash[wallet] != bytes32(0)) {
            revert WalletAlreadyRegistered();
        }

        _phoneHashToWallet[phoneHash] = wallet;
        _usernameHashToWallet[usernameHash] = wallet;
        _walletToUsernameHash[wallet] = usernameHash;

        emit IdentityRegistered(phoneHash, usernameHash, wallet);
    }

    function resolveByUsername(bytes32 usernameHash) external view returns (address) {
        return _usernameHashToWallet[usernameHash];
    }

    function resolveByPhoneHash(bytes32 phoneHash) external view returns (address) {
        return _phoneHashToWallet[phoneHash];
    }

    function isBlacklisted(address wallet) external view returns (bool) {
        return _blacklist[wallet];
    }

    function setBlacklisted(address wallet, bool status) external onlyRole(REPUTATION_ROLE) {
        _blacklist[wallet] = status;
        emit BlacklistStatusChanged(wallet, status);
    }
}
