import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, getAddress, concat, pad, toHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import * as dotenv from 'dotenv';


dotenv.config();

const ENTRYPOINT_ADDRESS = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS!;
const PAYMASTER_ADDRESS = process.env.PAYMASTER_ADDRESS!;
const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY!;
const BUNDLER_URL = `https://api.pimlico.io/v2/84532/rpc?apikey=${PIMLICO_API_KEY}`;
const SPONSOR_KEY = process.env.SPONSOR_SIGNER_PRIVATE_KEY!;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(BUNDLER_URL), // Using pimlico RPC for consistency
});

async function main() {
  console.log('--- Step 1: Generate Keypair ---');
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log(`Generated Signer EOA: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Signer Balance: ${balance} wei`);
  
  if (balance > 0n) {
    throw new Error('Signer balance must be zero for the test.');
  }

  console.log('\n--- Step 2: Compute Counterfactual Address ---');
  // Need to call `getAddress(owner, salt)` on our factory.
  // We'll just read it using publicClient.
  const salt = 0n;
  const smartAccountAddress = await publicClient.readContract({
    address: getAddress(FACTORY_ADDRESS),
    abi: [{
      "inputs": [{"internalType": "address", "name": "owner", "type": "address"}, {"internalType": "uint256", "name": "salt", "type": "uint256"}],
      "name": "getAddress",
      "outputs": [{"internalType": "address", "name": "", "type": "address"}],
      "stateMutability": "view",
      "type": "function"
    }],
    functionName: 'getAddress',
    args: [account.address, salt],
  });
  console.log(`Counterfactual Smart Account: ${smartAccountAddress}`);
  
  const bytecodeBefore = await publicClient.getBytecode({ address: smartAccountAddress as `0x${string}` });
  console.log(`Bytecode length before deploy: ${bytecodeBefore ? bytecodeBefore.length : 0}`);

  console.log('\n--- Step 3: Construct UserOp ---');
  // To manually construct and sponsor a UserOp requires permissionless.js bundler client or Pimlico's SDK.
  // For this script, you will run it when requested.
  console.log('Script is ready to be expanded with full UserOp logic once .env is provided.');
  console.log('We will use permissionless.js to build the user operation and send it.');
}

main().catch(console.error);
