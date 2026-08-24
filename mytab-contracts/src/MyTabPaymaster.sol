// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";

contract MyTabPaymaster is BasePaymaster, AccessControl {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    error InvalidSignature();
    error ExpiredSignature();
    error LowDeposit();

    bytes32 public constant SPONSOR_SIGNER_ROLE = keccak256("SPONSOR_SIGNER_ROLE");

    uint256 public minDepositThreshold;
    address public sponsorSigner;

    event SponsorshipGranted(address indexed user, uint256 amount);

    constructor(
        IEntryPoint _entryPoint,
        address _admin,
        address _sponsorSigner,
        uint256 _minDepositThreshold
    ) BasePaymaster(_entryPoint) {
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        sponsorSigner = _sponsorSigner;
        minDepositThreshold = _minDepositThreshold;
        
        // BasePaymaster inherits Ownable. We transfer its ownership to the multisig
        // to maintain compatibility with `withdrawTo` and `addStake` which are gated by `onlyOwner`.
        _transferOwnership(_admin);
    }

    /// @notice Allows the admin to deposit ETH for paying gas fees.
    function adminDeposit() public payable onlyRole(DEFAULT_ADMIN_ROLE) {
        deposit();
    }

    /// @notice Updates the signer that can authorise sponsored transactions.
    function setSponsorSigner(address _signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sponsorSigner = _signer;
    }

    /// @notice Updates the minimum deposit required before refusing sponsorship.
    function setMinDeposit(uint256 _threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minDepositThreshold = _threshold;
    }

    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 /*maxCost*/
    ) internal override returns (bytes memory context, uint256 validationData) {
        if (getDeposit() < minDepositThreshold) {
            revert LowDeposit();
        }

        // paymasterAndData format for EP v0.7:
        // [20 bytes paymaster] [16 bytes validationGas] [16 bytes postOpGas] [dynamic paymasterData]
        // Our paymasterData: [6 bytes validUntil] [6 bytes validAfter] [65 bytes signature]
        // Total expected length: 52 + 6 + 6 + 65 = 129
        require(userOp.paymasterAndData.length >= 129, "Invalid paymasterAndData length");

        uint48 validUntil = uint48(bytes6(userOp.paymasterAndData[52:58]));
        uint48 validAfter = uint48(bytes6(userOp.paymasterAndData[58:64]));

        if (block.timestamp > validUntil || block.timestamp < validAfter) {
            revert ExpiredSignature();
        }

        bytes calldata signature = userOp.paymasterAndData[64:129];

        // Ensure the signer hasn't been unset
        if (sponsorSigner == address(0)) {
            revert InvalidSignature();
        }

        // The hash covers the callData to prevent the signature being used on a different expensive tx
        bytes32 hash = keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                validUntil,
                validAfter,
                keccak256(userOp.callData)
            )
        );

        address recovered = hash.toEthSignedMessageHash().recover(signature);
        if (recovered != sponsorSigner) {
            revert InvalidSignature();
        }

        // Return context for postOp (sender address)
        context = abi.encode(userOp.sender);

        // Validation data combines sigFailed(false), validUntil, validAfter
        return (context, _packValidationData(false, validUntil, validAfter));
    }

    function _postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) internal override {
        address user = abi.decode(context, (address));
        emit SponsorshipGranted(user, actualGasCost);
    }
}
