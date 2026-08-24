// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {IdentityRegistry} from "../src/IdentityRegistry.sol";
import {ReputationEngine} from "../src/ReputationEngine.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract DeployCore is Script {
    function run() external returns (IdentityRegistry, ReputationEngine) {
        address multisigAdmin = vm.envAddress("MULTISIG_ADMIN");
        address relayerAddress = vm.envAddress("RELAYER_ADDRESS");
        address testReporter = vm.envAddress("TEST_REPORTER");

        require(multisigAdmin != address(0), "DeployCore: MULTISIG_ADMIN is zero");
        require(relayerAddress != address(0), "DeployCore: RELAYER_ADDRESS is zero");
        require(testReporter != address(0), "DeployCore: TEST_REPORTER is zero");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy IdentityRegistry with deployer as initial admin temporarily to allow configuration
        IdentityRegistry identityRegistry = new IdentityRegistry(deployer);

        // 2. Deploy ReputationEngine implementation
        ReputationEngine reputationEngineImpl = new ReputationEngine();

        // 3. Deploy ERC1967Proxy and initialize with deployer as admin temporarily
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(reputationEngineImpl),
            abi.encodeWithSelector(ReputationEngine.initialize.selector, address(identityRegistry), deployer)
        );
        ReputationEngine reputationEngine = ReputationEngine(address(proxy));

        // 4. Wire roles on IdentityRegistry
        identityRegistry.grantRole(identityRegistry.REPUTATION_ROLE(), address(reputationEngine));
        identityRegistry.grantRole(identityRegistry.REGISTRAR_ROLE(), relayerAddress);
        identityRegistry.grantRole(identityRegistry.DEFAULT_ADMIN_ROLE(), multisigAdmin);

        // 5. Wire roles on ReputationEngine
        reputationEngine.grantRole(reputationEngine.DISAPPROVAL_REPORTER_ROLE(), testReporter);
        reputationEngine.grantRole(reputationEngine.DEFAULT_ADMIN_ROLE(), multisigAdmin);
        reputationEngine.grantRole(reputationEngine.UPGRADER_ROLE(), multisigAdmin);

        // 6. Renounce deployer roles to ensure only the intended parties have access
        identityRegistry.renounceRole(identityRegistry.DEFAULT_ADMIN_ROLE(), deployer);
        reputationEngine.renounceRole(reputationEngine.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopBroadcast();

        return (identityRegistry, reputationEngine);
    }
}
