// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationEngine} from "../src/ReputationEngine.sol";
import {PledgeLedger} from "../src/PledgeLedger.sol";
import {SettlementRouter} from "../src/SettlementRouter.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Deploys IdentityRegistry, ReputationEngine (proxy), PledgeLedger (proxy), and SettlementRouter (proxy).
///         Wires all roles and renounces deployer admin before returning.
contract DeployAllCore is Script {
    function run() external returns (
        IdentityRegistry identityRegistry,
        ReputationEngine reputationEngine,
        PledgeLedger pledgeLedger,
        SettlementRouter settlementRouter
    ) {
        address multisigAdmin   = vm.envAddress("MULTISIG_ADMIN");
        address relayerAddress  = vm.envAddress("RELAYER_ADDRESS");
        address keeperAddress   = vm.envOr("KEEPER_ADDRESS", relayerAddress);

        require(multisigAdmin  != address(0), "DeployAllCore: MULTISIG_ADMIN is zero");
        require(relayerAddress != address(0), "DeployAllCore: RELAYER_ADDRESS is zero");

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

        // ── 4. SettlementRouter (UUPS proxy) ──────────────────────────────────
        SettlementRouter routerImpl = new SettlementRouter();
        ERC1967Proxy routerProxy = new ERC1967Proxy(
            address(routerImpl),
            abi.encodeWithSelector(
                SettlementRouter.initialize.selector,
                address(pledgeLedger),
                address(reputationEngine),
                deployer
            )
        );
        settlementRouter = SettlementRouter(address(routerProxy));

        // ── 5. Wire IdentityRegistry roles ────────────────────────────────────
        identityRegistry.grantRole(identityRegistry.REPUTATION_ROLE(),    address(reputationEngine));
        identityRegistry.grantRole(identityRegistry.REGISTRAR_ROLE(),     relayerAddress);
        identityRegistry.grantRole(identityRegistry.DEFAULT_ADMIN_ROLE(), multisigAdmin);

        // ── 6. Wire ReputationEngine roles ────────────────────────────────────
        reputationEngine.grantRole(reputationEngine.DISAPPROVAL_REPORTER_ROLE(), address(settlementRouter));
        reputationEngine.grantRole(reputationEngine.DEFAULT_ADMIN_ROLE(),        multisigAdmin);
        reputationEngine.grantRole(reputationEngine.UPGRADER_ROLE(),             multisigAdmin);

        // ── 7. Wire PledgeLedger roles ────────────────────────────────────────
        pledgeLedger.grantRole(pledgeLedger.SETTLEMENT_ROLE(),    address(settlementRouter));
        pledgeLedger.grantRole(pledgeLedger.DEFAULT_ADMIN_ROLE(), multisigAdmin);
        pledgeLedger.grantRole(pledgeLedger.UPGRADER_ROLE(),      multisigAdmin);

        // ── 8. Wire SettlementRouter roles ────────────────────────────────────
        settlementRouter.grantRole(settlementRouter.RELAYER_ROLE(),       relayerAddress);
        settlementRouter.grantRole(settlementRouter.KEEPER_ROLE(),        keeperAddress);
        settlementRouter.grantRole(settlementRouter.DEFAULT_ADMIN_ROLE(), multisigAdmin);
        settlementRouter.grantRole(settlementRouter.UPGRADER_ROLE(),      multisigAdmin);

        // ── 9. Renounce deployer admin on all contracts ───────────────────────
        identityRegistry.renounceRole(identityRegistry.DEFAULT_ADMIN_ROLE(), deployer);
        reputationEngine.renounceRole(reputationEngine.DEFAULT_ADMIN_ROLE(), deployer);
        pledgeLedger.renounceRole(pledgeLedger.DEFAULT_ADMIN_ROLE(),         deployer);
        settlementRouter.renounceRole(settlementRouter.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopBroadcast();

        console.log("IdentityRegistry:", address(identityRegistry));
        console.log("ReputationEngine:", address(reputationEngine));
        console.log("PledgeLedger:    ", address(pledgeLedger));
        console.log("SettlementRouter:", address(settlementRouter));
    }
}
