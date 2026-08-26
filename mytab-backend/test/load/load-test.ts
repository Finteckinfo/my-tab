import { PrismaClient } from '@prisma/client';
import { performance } from 'perf_hooks';
import * as crypto from 'crypto';

/**
 * Load Test Script — Day 4
 *
 * Simulates heavy load on the system by generating 1000 pledges and tracking:
 * 1. Database write throughput.
 * 2. Database read latency on complex queries.
 *
 * To run: npx ts-node test/load/load-test.ts
 */

const NUM_PLEDGES = 1000;
const prisma = new PrismaClient();

async function runLoadTest() {
  console.log(`Starting load test for ${NUM_PLEDGES} pledges...`);

  // 1. Database Write Load (Pledge creation + confirmations)
  console.log('\n--- Phase 1: Database Write Load ---');
  
  const startTime = performance.now();
  const pledges = [];

  for (let i = 0; i < NUM_PLEDGES; i++) {
    const pledgeId = `0x${crypto.randomBytes(32).toString('hex')}`;
    const debtor = `0x${crypto.randomBytes(20).toString('hex')}`;
    const lender = `0x${crypto.randomBytes(20).toString('hex')}`;
    
    // Simulate what the indexer writes for PledgeCreated + PledgeConfirmed
    pledges.push({
      pledgeId,
      debtorAddress: debtor,
      lenderAddress: lender,
      amount: '1000000',
      token: '0x545A57F8076E7a7B50215bC53FC3038b8dD5897b',
      dueTimestamp: Math.floor(Date.now() / 1000) + 86400,
      status: 'Active',
      track: 'Enforced',
      txHash: `0x${crypto.randomBytes(32).toString('hex')}`,
      blockNumber: 100000 + i,
      confirmedDepth: 64,
    });
  }

  // Batch insert
  await prisma.pledgeMirror.createMany({
    data: pledges,
  });

  const endTime = performance.now();
  const durationSec = (endTime - startTime) / 1000;
  const insertsPerSec = NUM_PLEDGES / durationSec;
  
  console.log(`Created ${NUM_PLEDGES} active pledges in DB.`);
  console.log(`DB Write Throughput: ${insertsPerSec.toFixed(2)} pledges/sec`);


  // 2. Database Read Latency (Queries)
  console.log('\n--- Phase 2: Database Read Latency ---');
  
  // Timeline query (indexed fields)
  const timelineStart = performance.now();
  await prisma.pledgeMirror.findMany({
    where: {
      status: 'Active',
      dueTimestamp: { lte: Math.floor(Date.now() / 1000) + 100000 }
    },
    orderBy: { dueTimestamp: 'asc' },
    take: 50,
  });
  const timelineDuration = performance.now() - timelineStart;
  console.log(`Timeline Query Latency: ${timelineDuration.toFixed(2)} ms`);

  // Summary query (aggregations)
  const summaryStart = performance.now();
  const debtorAddr = pledges[0].debtorAddress;
  await prisma.pledgeMirror.aggregate({
    where: { debtorAddress: debtorAddr },
    _sum: { amount: true },
    _count: true,
  });
  const summaryDuration = performance.now() - summaryStart;
  console.log(`Summary Query Latency: ${summaryDuration.toFixed(2)} ms`);


  // Cleanup
  console.log('\n--- Cleanup ---');
  await prisma.pledgeMirror.deleteMany({
    where: {
      pledgeId: { in: pledges.map(p => p.pledgeId) }
    }
  });
  console.log('Test data cleaned up.');
}

runLoadTest()
  .catch(e => {
    console.error('Load test failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
