// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LightAccountFactory} from "light-account/src/LightAccountFactory.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {LightAccount} from "light-account/src/LightAccount.sol";

contract MyTabAccountFactory {
    LightAccountFactory public immutable innerFactory;
    
    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(LightAccountFactory _innerFactory) {
        innerFactory = _innerFactory;
    }

    function createAccount(address owner, uint256 salt) external returns (address account) {
        address expected = getAddress(owner, salt);
        uint256 size;
        assembly { size := extcodesize(expected) }
        
        account = address(innerFactory.createAccount(owner, salt));
        
        if (size == 0) {
            emit AccountCreated(account, owner, salt);
        }
    }
    
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return innerFactory.getAddress(owner, salt);
    }
}
