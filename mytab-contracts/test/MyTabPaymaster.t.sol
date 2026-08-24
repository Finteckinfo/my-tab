// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MyTabPaymaster} from "../src/MyTabPaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract MyTabPaymasterTest is Test {
    using MessageHashUtils for bytes32;

    MyTabPaymaster public paymaster;
    EntryPoint public entryPoint;
    
    address public admin = address(0xA);
    address public user = address(0xB);
    
    uint256 public sponsorPrivateKey = 0x1234;
    address public sponsorSigner = vm.addr(sponsorPrivateKey);

    uint256 public constant MIN_DEPOSIT = 0.5 ether;

    receive() external payable {}

    function setUp() public {
        entryPoint = new EntryPoint();
        paymaster = new MyTabPaymaster(entryPoint, admin, sponsorSigner, MIN_DEPOSIT);
        
        // Deposit enough ETH
        vm.deal(admin, 10 ether);
        vm.prank(admin);
        paymaster.adminDeposit{value: 1 ether}();
    }

    function _buildUserOp() internal view returns (PackedUserOperation memory op) {
        op.sender = user;
        op.nonce = 1;
        op.initCode = "";
        op.callData = hex"12345678";
        // Mock gas limits 
        op.accountGasLimits = bytes32(uint256(100000) << 128 | uint256(100000));
        op.preVerificationGas = 50000;
        op.gasFees = bytes32(uint256(1e9) << 128 | uint256(1e9));
        op.paymasterAndData = "";
        op.signature = "";
    }

    function _signPaymasterData(
        PackedUserOperation memory op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 privateKey
    ) internal view returns (bytes memory paymasterAndData) {
        bytes32 hash = keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                validUntil,
                validAfter,
                keccak256(op.callData)
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, hash.toEthSignedMessageHash());
        bytes memory signature = abi.encodePacked(r, s, v);

        // Pack [paymaster (20)][validationGas (16)][postOpGas (16)][validUntil (6)][validAfter (6)][sig (65)]
        bytes memory verificationGas = abi.encodePacked(uint128(100000));
        bytes memory postOpGas = abi.encodePacked(uint128(100000));
        
        return abi.encodePacked(
            address(paymaster),
            verificationGas,
            postOpGas,
            validUntil,
            validAfter,
            signature
        );
    }

    function test_ValidSponsorshipPasses() public {
        PackedUserOperation memory op = _buildUserOp();
        
        uint48 validUntil = uint48(block.timestamp + 15 minutes);
        uint48 validAfter = uint48(block.timestamp);
        
        op.paymasterAndData = _signPaymasterData(op, validUntil, validAfter, sponsorPrivateKey);

        // Mock EntryPoint calling the paymaster
        vm.prank(address(entryPoint));
        (bytes memory context, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        
        // Assert validationData returns sigFailed = false (0)
        assertEq(validationData & type(uint160).max, 0, "Signature should be valid");
        assertEq(abi.decode(context, (address)), op.sender, "Context should be sender");
    }

    function test_ExpiredSignatureRejected() public {
        PackedUserOperation memory op = _buildUserOp();
        
        // Expired 1 second ago
        uint48 validUntil = uint48(block.timestamp - 1);
        uint48 validAfter = 0;
        
        op.paymasterAndData = _signPaymasterData(op, validUntil, validAfter, sponsorPrivateKey);

        vm.prank(address(entryPoint));
        vm.expectRevert(MyTabPaymaster.ExpiredSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_WrongSignerRejected() public {
        PackedUserOperation memory op = _buildUserOp();
        
        uint48 validUntil = uint48(block.timestamp + 15 minutes);
        uint48 validAfter = 0;
        
        uint256 wrongKey = 0x9999;
        op.paymasterAndData = _signPaymasterData(op, validUntil, validAfter, wrongKey);

        vm.prank(address(entryPoint));
        vm.expectRevert(MyTabPaymaster.InvalidSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_ReplayRejectedByCallDataOrNonce() public {
        PackedUserOperation memory op = _buildUserOp();
        
        uint48 validUntil = uint48(block.timestamp + 15 minutes);
        uint48 validAfter = 0;
        
        op.paymasterAndData = _signPaymasterData(op, validUntil, validAfter, sponsorPrivateKey);

        // Suppose attacker changes the callData to an expensive operation
        op.callData = hex"FFFFFFFF";
        
        vm.prank(address(entryPoint));
        vm.expectRevert(MyTabPaymaster.InvalidSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);

        // Suppose attacker tries to replay with a different nonce
        op.callData = hex"12345678"; // Reset to valid
        op.nonce = 2; // Different nonce
        
        vm.prank(address(entryPoint));
        vm.expectRevert(MyTabPaymaster.InvalidSignature.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_SponsorshipRefusedBelowDepositThreshold() public {
        PackedUserOperation memory op = _buildUserOp();
        uint48 validUntil = uint48(block.timestamp + 15 minutes);
        op.paymasterAndData = _signPaymasterData(op, validUntil, 0, sponsorPrivateKey);

        // Withdraw deposit so it falls below threshold
        vm.prank(admin);
        paymaster.withdrawTo(payable(address(this)), 0.6 ether); // 1.0 - 0.6 = 0.4 < 0.5

        vm.prank(address(entryPoint));
        vm.expectRevert(MyTabPaymaster.LowDeposit.selector);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }
    
    function test_AdminRolesCorrect() public {
        vm.prank(user);
        vm.expectRevert();
        paymaster.setSponsorSigner(user);
        
        vm.prank(admin);
        paymaster.setSponsorSigner(user);
        assertEq(paymaster.sponsorSigner(), user);
    }
}
