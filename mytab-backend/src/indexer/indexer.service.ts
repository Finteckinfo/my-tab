import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { decodeEventLog, getAddress } from 'viem';
import type { PublicClient, Log } from 'viem';
import { PUBLIC_CLIENT } from '../chain/chain.module';
import { MetricsService } from '../health/metrics.service';
import { IDENTITY_REGISTRY_ABI } from '../abis/IdentityRegistry.abi';
import { REPUTATION_ENGINE_ABI } from '../abis/ReputationEngine.abi';
import { PLEDGE_LEDGER_ABI } from '../abis/PledgeLedger.abi';
import { MY_TAB_ACCOUNT_FACTORY_ABI } from '../abis/MyTabAccountFactory.abi';

const CONFIRMATION_LAG = 5n;
const MAX_RANGE = 2000n;
const GLOBAL_CURSOR_ID = 'GLOBAL_INDEXER';

const COMBINED_ABI = [
  ...IDENTITY_REGISTRY_ABI,
  ...REPUTATION_ENGINE_ABI,
  ...PLEDGE_LEDGER_ABI,
  ...MY_TAB_ACCOUNT_FACTORY_ABI,
];

@Injectable()
export class IndexerService implements OnModuleInit {
  private readonly logger = new Logger(IndexerService.name);
  private isProcessing = false;
  private isReconciling = false;

  private readonly prisma = new PrismaClient();

  constructor(
    private readonly config: ConfigService,
    @Inject(PUBLIC_CLIENT) private readonly publicClient: PublicClient,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit() {
    this.logger.log('Running startup backfill check...');
    let cursor = await this.prisma.indexerCursor.findUnique({
      where: { contractAddress: GLOBAL_CURSOR_ID },
    });
    
    let lastIndexedBlock = 0n;
    const head = await this.publicClient.getBlockNumber();

    if (!cursor) {
      lastIndexedBlock = head > 5n ? head - 5n : 0n;
      await this.prisma.indexerCursor.create({
        data: {
          contractAddress: GLOBAL_CURSOR_ID,
          lastIndexedBlock: Number(lastIndexedBlock),
        },
      });
    } else {
      lastIndexedBlock = BigInt(cursor.lastIndexedBlock);
    }

    if (head - lastIndexedBlock > 100n) {
      this.logger.warn(`Significant gap detected on startup! Head: ${head}, Last Indexed: ${lastIndexedBlock}. Backfilling...`);
      // Run processNextBatch repeatedly until caught up before returning
      // We will set isProcessing = true to prevent interval from overlapping
      this.isProcessing = true;
      try {
        while (true) {
          const currentCursor = await this.prisma.indexerCursor.findUnique({
            where: { contractAddress: GLOBAL_CURSOR_ID },
          });
          const curr = currentCursor ? BigInt(currentCursor.lastIndexedBlock) : 0n;
          const currHead = await this.publicClient.getBlockNumber();
          if (currHead - curr <= CONFIRMATION_LAG) {
            break; // Caught up
          }
          await this.processNextBatch();
        }
        this.logger.log('Startup backfill complete.');
      } catch (err: any) {
        this.logger.error(`Error during startup backfill: ${err.message}`, err.stack);
      } finally {
        this.isProcessing = false;
      }
    }
  }

  @Interval(2000)
  async pollEvents() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await this.processNextBatch();
    } catch (err: any) {
      this.metrics.incrementIndexerErrors();
      this.logger.error(`Indexer error: ${err.message}`, err.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  @Interval(300000)
  async reconcilePledges() {
    if (this.isReconciling) return;
    this.isReconciling = true;
    try {
      this.logger.log('Running reconciliation job...');
      const head = await this.publicClient.getBlockNumber();
      const cutoff = head - 200n;

      const pledgesToVerify = await this.prisma.pledgeMirror.findMany({
        where: { blockNumber: { gt: Number(cutoff) } },
      });

      const pledgeLedger = getAddress(this.config.getOrThrow<string>('PLEDGE_LEDGER_ADDRESS'));

      for (const p of pledgesToVerify) {
        try {
          const onChainPledge = await this.publicClient.readContract({
            address: pledgeLedger,
            abi: PLEDGE_LEDGER_ABI,
            functionName: 'getPledge',
            args: [BigInt(p.pledgeId)],
          });
          const statusMap = ['Pending', 'Active', 'SettlementClaimed', 'Settled', 'Defaulted', 'Cancelled'];
          const chainStatus = statusMap[onChainPledge.status];
          if (chainStatus && chainStatus !== p.status) {
            this.metrics.incrementReconciliationMismatches();
            this.logger.warn(`Reconciliation mismatch on pledge ${p.pledgeId}. DB: ${p.status}, Chain: ${chainStatus}. Overwriting DB.`);
            
            const trackEnum = onChainPledge.track === 1 ? 'Enforced' : 'Voluntary';
            
            await this.prisma.pledgeMirror.update({
              where: { pledgeId: p.pledgeId },
              data: {
                status: chainStatus,
                lenderAddress: getAddress(onChainPledge.lender),
                debtorAddress: getAddress(onChainPledge.debtor),
                amount: onChainPledge.amount.toString(),
                token: getAddress(onChainPledge.token),
                dueTimestamp: Number(onChainPledge.dueTimestamp),
                track: trackEnum,
              },
            });
          }
        } catch (err: any) {
          this.logger.error(`Failed to reconcile pledge ${p.pledgeId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`Reconciliation error: ${err.message}`);
    } finally {
      this.isReconciling = false;
    }
  }

  async getStatus() {
    let cursor = await this.prisma.indexerCursor.findUnique({
      where: { contractAddress: GLOBAL_CURSOR_ID },
    });
    const lastIndexedBlock = cursor ? Number(cursor.lastIndexedBlock) : 0;
    const head = Number(await this.publicClient.getBlockNumber());
    return {
      lastIndexedBlock,
      head,
      lag: head - lastIndexedBlock,
    };
  }

  /**
   * Manually re-run indexing over a specific block range idempotently.
   */
  async backfill(fromBlock: number, toBlock: number) {
    this.logger.log(`Manual backfill requested from ${fromBlock} to ${toBlock}`);
    
    const identityRegistry = getAddress(this.config.getOrThrow<string>('IDENTITY_REGISTRY_ADDRESS'));
    const reputationEngine = getAddress(this.config.getOrThrow<string>('REPUTATION_ENGINE_ADDRESS'));
    const pledgeLedger = getAddress(this.config.getOrThrow<string>('PLEDGE_LEDGER_ADDRESS'));
    const factoryAddressStr = this.config.get<string>('ACCOUNT_FACTORY_ADDRESS');
    const addresses: `0x${string}`[] = [identityRegistry, reputationEngine, pledgeLedger];
    if (factoryAddressStr) addresses.push(getAddress(factoryAddressStr));

    // Chunk the backfill range by MAX_RANGE to prevent RPC limits
    let currentFrom = BigInt(fromBlock);
    const endTarget = BigInt(toBlock);

    while (currentFrom <= endTarget) {
      let currentTo = currentFrom + MAX_RANGE;
      if (currentTo > endTarget) {
        currentTo = endTarget;
      }

      this.logger.log(`Backfilling chunk ${currentFrom} to ${currentTo}...`);
      const logs = await this.publicClient.getLogs({
        address: addresses,
        fromBlock: currentFrom,
        toBlock: currentTo,
      });

      for (const log of logs) {
        await this.processLog(log);
      }
      if (logs.length > 0) {
        this.metrics.incrementEventsProcessed(logs.length);
        this.logger.log(`Backfilled ${logs.length} logs in chunk ${currentFrom}-${currentTo}`);
      }

      currentFrom = currentTo + 1n;
    }
  }

  private async processNextBatch() {
    // Read the global cursor
    let cursor = await this.prisma.indexerCursor.findUnique({
      where: { contractAddress: GLOBAL_CURSOR_ID },
    });

    if (!cursor) {
      // Initialize to something. In production, this would be deployment block.
      // For now, let's just use current head - 5.
      const head = await this.publicClient.getBlockNumber();
      cursor = await this.prisma.indexerCursor.create({
        data: {
          contractAddress: GLOBAL_CURSOR_ID,
          lastIndexedBlock: Number(head > 5n ? head - 5n : 0n),
        },
      });
    }

    const lastIndexedBlock = BigInt(cursor.lastIndexedBlock);
    const head = await this.publicClient.getBlockNumber();
    
    // min(head - CONFIRMATION_LAG, lastIndexedBlock + MAX_RANGE)
    let target = head - CONFIRMATION_LAG;
    if (target > lastIndexedBlock + MAX_RANGE) {
      target = lastIndexedBlock + MAX_RANGE;
    }

    if (target <= lastIndexedBlock) {
      return; // Nothing to do
    }

    const identityRegistry = getAddress(this.config.getOrThrow<string>('IDENTITY_REGISTRY_ADDRESS'));
    const reputationEngine = getAddress(this.config.getOrThrow<string>('REPUTATION_ENGINE_ADDRESS'));
    const pledgeLedger = getAddress(this.config.getOrThrow<string>('PLEDGE_LEDGER_ADDRESS'));
    // We don't have account factory explicitly injected in config yet? We'll leave it as all addresses or add it if needed.
    // Actually, we can just fetch logs for the 3 contracts. Wait, AccountCreated is emitted by MyTabAccountFactory.
    const factoryAddressStr = this.config.get<string>('ACCOUNT_FACTORY_ADDRESS');
    const addresses: `0x${string}`[] = [identityRegistry, reputationEngine, pledgeLedger];
    if (factoryAddressStr) addresses.push(getAddress(factoryAddressStr));

    const logs = await this.publicClient.getLogs({
      address: addresses,
      fromBlock: lastIndexedBlock + 1n,
      toBlock: target,
    });

    for (const log of logs) {
      await this.processLog(log);
    }

    // Advance cursor after whole batch commits successfully
    await this.prisma.indexerCursor.update({
      where: { contractAddress: GLOBAL_CURSOR_ID },
      data: { lastIndexedBlock: Number(target) },
    });

    if (logs.length > 0) {
      this.metrics.incrementEventsProcessed(logs.length);
      this.logger.log(`Indexed ${logs.length} logs up to block ${target}`);
    }
  }

  private async processLog(log: Log) {
    if (!log.transactionHash || log.logIndex === null || log.logIndex === undefined) return;
    const txHash = log.transactionHash;
    const logIndex = log.logIndex;

    let decoded: any;
    try {
      decoded = decodeEventLog({
        abi: COMBINED_ABI,
        data: log.data,
        topics: log.topics,
      });
    } catch (e) {
      // Event not in ABI, ignore
      return;
    }

    const eventName = decoded.eventName;

    // We only care about specific events
    const supportedEvents = [
      'IdentityRegistered',
      'BlacklistStatusChanged',
      'AccountCreated',
      'PledgeCreated',
      'PledgeConfirmed',
      'PledgeStatusChanged',
      'ReputationTierChanged',
    ];
    if (!supportedEvents.includes(eventName)) return;

    await this.prisma.$transaction(async (tx) => {
      // 1. Check idempotency marker
      const exists = await tx.processedEvent.findUnique({
        where: { txHash_logIndex: { txHash, logIndex } },
      });
      if (exists) return; // Already processed

      // 2. Apply state changes
      await this.applyStateChange(tx, eventName, decoded.args, txHash, Number(log.blockNumber || 0));

      // 3. Insert idempotency marker
      await tx.processedEvent.create({
        data: {
          txHash,
          logIndex,
          eventName,
        },
      });
    });
  }

  private async applyStateChange(tx: any, eventName: string, args: any, txHash: string, blockNumber: number) {
    if (eventName === 'PledgeCreated') {
      const pledgeId = args.pledgeId.toString();
      const trackEnum = Number(args.track) === 1 ? 'Enforced' : 'Voluntary';
      
      await tx.pledgeMirror.upsert({
        where: { pledgeId },
        update: {
          lenderAddress: getAddress(args.lender),
          debtorAddress: getAddress(args.debtor),
          amount: args.amount.toString(),
          token: getAddress(args.token),
          dueTimestamp: Number(args.dueTimestamp),
          track: trackEnum,
          createdAt: Math.floor(Date.now() / 1000), // Ideally from block timestamp, but close enough
          txHash,
          blockNumber,
        },
        create: {
          pledgeId,
          lenderAddress: getAddress(args.lender),
          debtorAddress: getAddress(args.debtor),
          amount: args.amount.toString(),
          token: getAddress(args.token),
          dueTimestamp: Number(args.dueTimestamp),
          status: 'Pending',
          track: trackEnum,
          createdAt: Math.floor(Date.now() / 1000),
          txHash,
          blockNumber,
        },
      });
    } else if (eventName === 'PledgeConfirmed') {
      const pledgeId = args.pledgeId.toString();
      await tx.pledgeMirror.upsert({
        where: { pledgeId },
        update: { status: 'Active' },
        create: {
          pledgeId,
          status: 'Active',
          lenderAddress: '',
          debtorAddress: '',
          amount: '0',
          token: '',
          dueTimestamp: 0,
          track: '',
          createdAt: 0,
        },
      });
    } else if (eventName === 'PledgeStatusChanged') {
      const pledgeId = args.pledgeId.toString();
      const statusMap = ['Pending', 'Active', 'SettlementClaimed', 'Settled', 'Defaulted', 'Cancelled'];
      const newStatus = statusMap[Number(args.newStatus)];
      if (newStatus) {
        await tx.pledgeMirror.upsert({
          where: { pledgeId },
          update: { status: newStatus },
          create: {
            pledgeId,
            status: newStatus,
            lenderAddress: '',
            debtorAddress: '',
            amount: '0',
            token: '',
            dueTimestamp: 0,
            track: '',
            createdAt: 0,
          },
        });
      }
    } else if (eventName === 'AccountCreated') {
      // Update WalletRecord deploymentStatus
      const account = getAddress(args.account);
      await tx.walletRecord.updateMany({
        where: { address: account },
        data: { deploymentStatus: 'deployed' },
      });
    } else if (eventName === 'IdentityRegistered') {
      // Update User onboarding status
      const wallet = getAddress(args.wallet);
      await tx.user.updateMany({
        where: { smartAccountAddress: wallet },
        data: { onboardingStatus: 'completed' },
      });
    } else if (eventName === 'ReputationTierChanged') {
      const wallet = getAddress(args.user);
      await tx.reputationMirror.upsert({
        where: { walletAddress: wallet },
        update: { tier: Number(args.newTier), disapprovalCount: Number(args.disapprovalCount) },
        create: { walletAddress: wallet, tier: Number(args.newTier), disapprovalCount: Number(args.disapprovalCount) },
      });
    } else if (eventName === 'BlacklistStatusChanged') {
      const wallet = getAddress(args.wallet);
      await tx.reputationMirror.upsert({
        where: { walletAddress: wallet },
        update: { isBlacklisted: args.status },
        create: { walletAddress: wallet, isBlacklisted: args.status },
      });
    }
  }
}
