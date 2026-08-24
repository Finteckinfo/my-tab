import { createWalletClient, createPublicClient, http, getAddress, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { PLEDGE_LEDGER_ABI } from '../src/abis/PledgeLedger.abi';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const account = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as `0x${string}`);
  
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(process.env.RPC_URL),
  });

  const ledger = getAddress(process.env.PLEDGE_LEDGER_ADDRESS!);

  console.log('Stopping any background tasks (assumes Nest is not running).');
  console.log('Creating 3 pledges...');

  for (let i = 0; i < 3; i++) {
    const debtor = '0x000000000000000000000000000000000000000b'; // dummy debtor
    const { request } = await publicClient.simulateContract({
      address: ledger,
      abi: PLEDGE_LEDGER_ABI,
      functionName: 'createPledge',
      args: [
        debtor,
        parseEther('0.001'), // amount
        '0x0000000000000000000000000000000000000000', // token (native)
        BigInt(Math.floor(Date.now() / 1000) + 86400), // due timestamp
        0, // track (voluntary)
      ],
      account,
    });
    const hash = await walletClient.writeContract(request);
    console.log(`Pledge ${i + 1} created in tx: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  console.log('Pledges created on-chain. Now we verify DB before and after starting backfill.');

  const prisma = new PrismaClient();
  const beforeCount = await prisma.pledgeMirror.count();
  console.log(`DB has ${beforeCount} pledges before startup.`);

  // Now, I'll let the agent start the Nest server to see it backfill.
}

main().catch(console.error);
