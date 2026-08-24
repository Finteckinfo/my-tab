// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {MyTabAccountFactory} from "../src/MyTabAccountFactory.sol";
import {MyTabPaymaster} from "../src/MyTabPaymaster.sol";
import {LightAccountFactory} from "light-account/src/LightAccountFactory.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

contract Deploy4337 is Script {
    // Standard EntryPoint v0.7
    address constant ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external returns (MyTabAccountFactory factory, MyTabPaymaster paymaster) {
        address multisigAdmin = vm.envAddress("MULTISIG_ADMIN");
        address sponsorSigner = vm.envAddress("SPONSOR_SIGNER");

        require(multisigAdmin != address(0), "Deploy4337: MULTISIG_ADMIN is zero");
        require(sponsorSigner != address(0), "Deploy4337: SPONSOR_SIGNER is zero");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy LightAccountFactory (usually we'd use a deterministic pre-deployed one, but here we deploy our own instance for simplicity or we can pass an existing one)
        // Alchemy's LightAccountFactory v0.7 for Base Sepolia is usually deployed at a deterministic address, but we deploy a fresh one here to guarantee it exists and works with our wrapper.
        // Actually, it takes the owner as the parameter, wait. LightAccountFactory takes (address _owner, IEntryPoint _entryPoint).
        LightAccountFactory innerFactory = new LightAccountFactory(multisigAdmin, IEntryPoint(ENTRYPOINT));

        // 2. Deploy our wrapper factory
        factory = new MyTabAccountFactory(innerFactory);

        // 3. Deploy our Paymaster
        // Setting min deposit threshold to 0.01 ETH for sponsorship
        paymaster = new MyTabPaymaster(
            IEntryPoint(ENTRYPOINT),
            multisigAdmin,
            sponsorSigner,
            0.005 ether
        );

        // 4. Initial deposit to the paymaster so it can sponsor transactions (e.g., 0.1 ETH)
        // Assuming deployer has ETH
        paymaster.adminDeposit{value: 0.01 ether}();

        vm.stopBroadcast();

        return (factory, paymaster);
    }
}
