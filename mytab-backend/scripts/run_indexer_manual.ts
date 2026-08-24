import { IndexerService } from '../src/indexer/indexer.service';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../src/health/metrics.service';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.RPC_URL),
  });

  const configService = new ConfigService();
  const metricsService = new MetricsService();
  
  const prisma = new PrismaClient();
  const head = await publicClient.getBlockNumber();
  await prisma.indexerCursor.deleteMany();
  await prisma.indexerCursor.create({ data: { contractAddress: 'GLOBAL_INDEXER', lastIndexedBlock: Number(head - 200n) } });
  await prisma.pledgeMirror.deleteMany(); // clean up old records for a fresh test
  
  const indexerService = new IndexerService(
    configService,
    publicClient as any,
    metricsService
  );

  console.log('Running indexer backfill check manually...');
  await indexerService.onModuleInit();
  
  const status = await indexerService.getStatus();
  console.log('Indexer status after backfill:', status);
}

main().catch(console.error);
