// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployCore} from "../../script/DeployCore.s.sol";
import {IdentityRegistry} from "../../src/IdentityRegistry.sol";
import {ReputationEngine} from "../../src/ReputationEngine.sol";

contract CoreWiringTest is Test {
    address multisigAdmin = address(0x100);
    address relayerAddress = address(0x101);
    address testReporter = address(0x102);
    address deployer;

    IdentityRegistry registry;
    ReputationEngine engine;

    function setUp() public {
        vm.setEnv("MULTISIG_ADMIN", vm.toString(multisigAdmin));
        vm.setEnv("RELAYER_ADDRESS", vm.toString(relayerAddress));
        vm.setEnv("TEST_REPORTER", vm.toString(testReporter));
        vm.setEnv("PRIVATE_KEY", "0x1234");
        deployer = vm.addr(0x1234);

        DeployCore deployScript = new DeployCore();
        (registry, engine) = deployScript.run();
    }

    function test_rolesAreCorrectlyAssigned() public {
        // IdentityRegistry roles
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), multisigAdmin));
        assertTrue(registry.hasRole(registry.REGISTRAR_ROLE(), relayerAddress));
        assertTrue(registry.hasRole(registry.REPUTATION_ROLE(), address(engine)));

        // ReputationEngine roles
        assertTrue(engine.hasRole(engine.DEFAULT_ADMIN_ROLE(), multisigAdmin));
        assertTrue(engine.hasRole(engine.DISAPPROVAL_REPORTER_ROLE(), testReporter));
        assertTrue(engine.hasRole(engine.UPGRADER_ROLE(), multisigAdmin));

        // Deployer holds NO roles
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(registry.hasRole(registry.REGISTRAR_ROLE(), deployer));
        assertFalse(registry.hasRole(registry.REPUTATION_ROLE(), deployer));
        
        assertFalse(engine.hasRole(engine.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(engine.hasRole(engine.DISAPPROVAL_REPORTER_ROLE(), deployer));
        assertFalse(engine.hasRole(engine.UPGRADER_ROLE(), deployer));
    }
}
