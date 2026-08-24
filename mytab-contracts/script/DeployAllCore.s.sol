// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationEngine} from "../src/ReputationEngine.sol";
import {PledgeLedger} from "../src/PledgeLedger.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Deploys IdentityRegistry, ReputationEngine (proxy), and PledgeLedger (proxy).
///         Wires all roles and renounces deployer admin before returning.
contract DeployAllCore is Script {
    function run() external returns (
        IdentityRegistry identityRegistry,
        ReputationEngine reputationEngine,
        PledgeLedger pledgeLedger
    ) {
        address multisigAdmin   = vm.envAddress("MULTISIG_ADMIN");
        address relayerAddress  = vm.envAddress("RELAYER_ADDRESS");
        address testReporter    = vm.envAddress("TEST_REPORTER");

        require(multisigAdmin  != address(0), "DeployAllCore: MULTISIG_ADMIN is zero");
        require(relayerAddress != address(0), "DeployAllCore: RELAYER_ADDRESS is zero");
        require(testReporter   != address(0), "DeployAllCore: TEST_REPORTER is zero");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // ── 1. IdentityRegistry (not upgradeable) ─────────────────────────────
        identityRegistry = new IdentityRegistry(deployer);

        // ── 2. ReputationEngine (UUPS proxy) ──────────────────────────────────
        ReputationEngine repImpl = new ReputationEngine();
        ERC1967Proxy repProxy = new ERC1967Proxy(
            address(repImpl),
            abi.encodeWithSelector(
                ReputationEngine.initialize.selector,
                address(identityRegistry),
                deployer
            )
        );
        reputationEngine = ReputationEngine(address(repProxy));

        // ── 3. PledgeLedger (UUPS proxy) ──────────────────────────────────────
        PledgeLedger ledgerImpl = new PledgeLedger();
        ERC1967Proxy ledgerProxy = new ERC1967Proxy(
            address(ledgerImpl),
            abi.encodeWithSelector(
                PledgeLedger.initialize.selector,
                address(identityRegistry),
                address(reputationEngine),
                deployer
            )
        );
        pledgeLedger = PledgeLedger(address(ledgerProxy));

        // ── 4. Wire IdentityRegistry roles ────────────────────────────────────
        identityRegistry.grantRole(identityRegistry.REPUTATION_ROLE(),    address(reputationEngine));
        identityRegistry.grantRole(identityRegistry.REGISTRAR_ROLE(),     relayerAddress);
        identityRegistry.grantRole(identityRegistry.DEFAULT_ADMIN_ROLE(), multisigAdmin);

        // ── 5. Wire ReputationEngine roles ────────────────────────────────────
        reputationEngine.grantRole(reputationEngine.DISAPPROVAL_REPORTER_ROLE(), testReporter);
        reputationEngine.grantRole(reputationEngine.DEFAULT_ADMIN_ROLE(),        multisigAdmin);
        reputationEngine.grantRole(reputationEngine.UPGRADER_ROLE(),             multisigAdmin);

        // ── 6. Wire PledgeLedger roles ────────────────────────────────────────
        // SETTLEMENT_ROLE will be granted to SettlementRouter in week 4.
        // Grant DEFAULT_ADMIN_ROLE and UPGRADER_ROLE to multisig.
        pledgeLedger.grantRole(pledgeLedger.DEFAULT_ADMIN_ROLE(), multisigAdmin);
        pledgeLedger.grantRole(pledgeLedger.UPGRADER_ROLE(),      multisigAdmin);

        // ── 7. Renounce deployer admin on all contracts ───────────────────────
        identityRegistry.renounceRole(identityRegistry.DEFAULT_ADMIN_ROLE(), deployer);
        reputationEngine.renounceRole(reputationEngine.DEFAULT_ADMIN_ROLE(), deployer);
        pledgeLedger.renounceRole(pledgeLedger.DEFAULT_ADMIN_ROLE(),         deployer);

        vm.stopBroadcast();

        console.log("IdentityRegistry:", address(identityRegistry));
        console.log("ReputationEngine:", address(reputationEngine));
        console.log("PledgeLedger:    ", address(pledgeLedger));
    }
}
