import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import type { LocalAccount } from 'viem';

interface SignPaymasterDataParams {
  sponsorAccount: LocalAccount;
  paymasterAddress: `0x${string}`;
  sender: `0x${string}`;
  nonce: bigint;
  callData: `0x${string}`;
  validUntil: bigint;
  validAfter: bigint;
}

/**
 * Builds paymasterAndData and signs it with SPONSOR_SIGNER_PRIVATE_KEY ONLY.
 * This function MUST NOT import or read RELAYER_PRIVATE_KEY at any point.
 *
 * Mirrors MyTabPaymaster._validatePaymasterUserOp exactly:
 *
 *   bytes32 hash = keccak256(abi.encode(
 *       userOp.sender, userOp.nonce, validUntil, validAfter, keccak256(userOp.callData)
 *   ));
 *   address recovered = hash.toEthSignedMessageHash().recover(signature);
 *
 * paymasterAndData layout (EP v0.7):
 *   [20 bytes paymaster]
 *   [16 bytes validationGasLimit  — set to 0 by bundler, ignored in decode]
 *   [16 bytes postOpGasLimit      — set to 0 by bundler, ignored in decode]
 *   [6 bytes validUntil]
 *   [6 bytes validAfter]
 *   [65 bytes ECDSA signature]
 */
export async function signPaymasterData(params: SignPaymasterDataParams): Promise<`0x${string}`> {
  const { sponsorAccount, paymasterAddress, sender, nonce, callData, validUntil, validAfter } = params;

  // Step 1: keccak256(callData)
  const callDataHash = keccak256(callData);

  // Step 2: keccak256(abi.encode(sender, nonce, validUntil, validAfter, callDataHash))
  // abi.encode pads every value to 32 bytes — use encodeAbiParameters
  const encoded = encodeAbiParameters(
    parseAbiParameters('address, uint256, uint48, uint48, bytes32'),
    [sender, nonce, Number(validUntil), Number(validAfter), callDataHash],
  );
  const hash = keccak256(encoded);

  // Step 3: sponsorAccount.signMessage applies the "\x19Ethereum Signed Message:\n32" prefix,
  // matching hash.toEthSignedMessageHash().recover(sig) in Solidity.
  const sig = await sponsorAccount.signMessage({ message: { raw: hash } });

  // Step 4: Assemble paymasterAndData
  // Slots [20:52] are validationGasLimit + postOpGasLimit (32 bytes total, zero for now)
  const gasSlots = '0'.repeat(64); // 32 bytes zeroed
  const validUntilHex = validUntil.toString(16).padStart(12, '0'); // 6 bytes
  const validAfterHex = validAfter.toString(16).padStart(12, '0'); // 6 bytes

  return `${paymasterAddress}${gasSlots}${validUntilHex}${validAfterHex}${sig.slice(2)}` as `0x${string}`;
}
