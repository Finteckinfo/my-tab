import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PublicClient, WalletClient, getAddress } from 'viem';
import { PUBLIC_CLIENT, WALLET_CLIENT } from '../chain/chain.module';
import { SETTLEMENT_ROUTER_ABI } from '../abis/SettlementRouter.abi';
import { MetricsService } from '../health/metrics.service';
import { NotificationPayload, AutomationRunResult } from './automation.types';

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);
  public prisma: PrismaClient;

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    @Inject(PUBLIC_CLIENT) private readonly publicClient: PublicClient,
    @Inject(WALLET_CLIENT) private readonly walletClient: WalletClient,
    @Optional() prismaClient?: PrismaClient,
  ) {
    this.prisma = prismaClient || new PrismaClient();
  }

  // ── Auto-Clear Sweep (Hourly) ───────────────────────────────────────────────
  async runAutoClearSweep(forcedNowSec?: number): Promise<AutomationRunResult> {
    const jobName = 'auto-clear';
    this.metrics.recordJobRun(jobName);

    const nowSec = forcedNowSec ?? Math.floor(Date.now() / 1000);
    const fourteenDaysAgo = nowSec - 14 * 86400;

    let scanned = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const eligiblePledges = await this.prisma.pledgeMirror.findMany({
        where: {
          status: 'SettlementClaimed',
          claimedAt: { lte: fourteenDaysAgo },
        },
      });

      scanned = eligiblePledges.length;
      this.logger.log(`[AutoClearSweep] Found ${scanned} eligible pledges for auto-clear at timestamp ${nowSec}`);

      const settlementRouterAddress = this.config.getOrThrow<string>('SETTLEMENT_ROUTER_ADDRESS') as `0x${string}`;

      for (const pledge of eligiblePledges) {
        const opTag = `autoApproveOffChainSettlement:${pledge.pledgeId}`;

        // Idempotency check: don't double submit if pending
        const pendingOp = await this.prisma.userOpTracking.findFirst({
          where: {
            operation: opTag,
            status: 'pending',
          },
        });

        if (pendingOp) {
          this.logger.warn(`[AutoClearSweep] Skipping pledge ${pledge.pledgeId}; operation already pending`);
          skipped++;
          continue;
        }

        try {
          const txHash = await this.walletClient.writeContract({
            address: getAddress(settlementRouterAddress),
            abi: SETTLEMENT_ROUTER_ABI,
            functionName: 'autoApproveOffChainSettlement',
            args: [BigInt(pledge.pledgeId)],
            account: this.walletClient.account!,
            chain: this.walletClient.chain,
          });

          const userOpHash = `${txHash}_${pledge.pledgeId}`;
          await this.prisma.userOpTracking.upsert({
            where: { userOpHash },
            update: {
              status: 'included',
              txHash,
            },
            create: {
              userOpHash,
              sender: this.walletClient.account?.address ?? 'relayer',
              operation: opTag,
              status: 'included',
              txHash,
              attempts: 1,
            },
          });

          this.logger.log({ pledgeId: pledge.pledgeId, txHash }, `[AutoClearSweep] Auto-cleared settlement for pledge ${pledge.pledgeId}`);
          processed++;
        } catch (err: any) {
          errors++;
          this.metrics.recordJobFailure(jobName, err);
          this.logger.error(
            {
              job: jobName,
              pledgeId: pledge.pledgeId,
              error: err.message,
              stack: err.stack,
            },
            `[AutoClearSweep] Failed to auto-clear pledge ${pledge.pledgeId}`,
          );

          await this.prisma.userOpTracking.create({
            data: {
              userOpHash: `failed_autoclear_${pledge.pledgeId}_${nowSec}`,
              sender: this.walletClient.account?.address ?? 'relayer',
              operation: opTag,
              status: 'failed',
              revertReason: err.message,
              attempts: 1,
            },
          });
        }
      }

      this.metrics.recordJobSuccess(jobName);
    } catch (err: any) {
      this.metrics.recordJobFailure(jobName, err);
      this.logger.error({ job: jobName, error: err.message, stack: err.stack }, `[AutoClearSweep] Fatal error during sweep`);
      throw err;
    }

    return { job: jobName, scanned, processed, skipped, errors };
  }

  // ── Direct Debit Keeper (Every 15 min) ──────────────────────────────────────
  async runDirectDebitKeeper(forcedNowSec?: number): Promise<AutomationRunResult> {
    const jobName = 'direct-debit';
    this.metrics.recordJobRun(jobName);

    const nowSec = forcedNowSec ?? Math.floor(Date.now() / 1000);

    let scanned = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const eligiblePledges = await this.prisma.pledgeMirror.findMany({
        where: {
          track: 'Enforced',
          status: 'Active',
          dueTimestamp: { lte: nowSec },
        },
      });

      scanned = eligiblePledges.length;
      this.logger.log(`[DirectDebitKeeper] Found ${scanned} eligible enforced pledges due for direct debit`);

      const settlementRouterAddress = this.config.getOrThrow<string>('SETTLEMENT_ROUTER_ADDRESS') as `0x${string}`;

      for (const pledge of eligiblePledges) {
        const opTag = `executeDirectDebit:${pledge.pledgeId}`;

        // Idempotency check: don't double submit if pending
        const pendingOp = await this.prisma.userOpTracking.findFirst({
          where: {
            operation: opTag,
            status: 'pending',
          },
        });

        if (pendingOp) {
          this.logger.warn(`[DirectDebitKeeper] Skipping pledge ${pledge.pledgeId}; operation already pending`);
          skipped++;
          continue;
        }

        try {
          const txHash = await this.walletClient.writeContract({
            address: getAddress(settlementRouterAddress),
            abi: SETTLEMENT_ROUTER_ABI,
            functionName: 'executeDirectDebit',
            args: [BigInt(pledge.pledgeId)],
            account: this.walletClient.account!,
            chain: this.walletClient.chain,
          });

          const userOpHash = `${txHash}_${pledge.pledgeId}`;
          await this.prisma.userOpTracking.upsert({
            where: { userOpHash },
            update: {
              status: 'included',
              txHash,
            },
            create: {
              userOpHash,
              sender: this.walletClient.account?.address ?? 'keeper',
              operation: opTag,
              status: 'included',
              txHash,
              attempts: 1,
            },
          });

          this.logger.log({ pledgeId: pledge.pledgeId, txHash }, `[DirectDebitKeeper] Direct debit executed for pledge ${pledge.pledgeId}`);
          processed++;
        } catch (err: any) {
          errors++;
          this.metrics.recordJobFailure(jobName, err);
          this.logger.error(
            {
              job: jobName,
              pledgeId: pledge.pledgeId,
              error: err.message,
              stack: err.stack,
            },
            `[DirectDebitKeeper] Failed to execute direct debit for pledge ${pledge.pledgeId}`,
          );

          await this.prisma.userOpTracking.create({
            data: {
              userOpHash: `failed_debit_${pledge.pledgeId}_${nowSec}`,
              sender: this.walletClient.account?.address ?? 'keeper',
              operation: opTag,
              status: 'failed',
              revertReason: err.message,
              attempts: 1,
            },
          });
        }
      }

      this.metrics.recordJobSuccess(jobName);
    } catch (err: any) {
      this.metrics.recordJobFailure(jobName, err);
      this.logger.error({ job: jobName, error: err.message, stack: err.stack }, `[DirectDebitKeeper] Fatal error during keeper run`);
      throw err;
    }

    return { job: jobName, scanned, processed, skipped, errors };
  }

  // ── Notification Triggers (Hourly) ──────────────────────────────────────────
  async runNotificationTriggers(forcedNowSec?: number): Promise<AutomationRunResult> {
    const jobName = 'notifications';
    this.metrics.recordJobRun(jobName);

    const nowSec = forcedNowSec ?? Math.floor(Date.now() / 1000);

    let scanned = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const activePledges = await this.prisma.pledgeMirror.findMany({
        where: {
          status: { in: ['Active', 'Pending'] },
        },
      });

      scanned = activePledges.length;

      for (const pledge of activePledges) {
        const intervalsToEmit: string[] = [];

        // 1. 48 hours before due
        if (nowSec >= pledge.dueTimestamp - 48 * 3600 && nowSec < pledge.dueTimestamp) {
          intervalsToEmit.push('48h_before');
        }

        // 2. At due (within the first 24h of being due)
        if (pledge.status === 'Active' && nowSec >= pledge.dueTimestamp && nowSec < pledge.dueTimestamp + 24 * 3600) {
          intervalsToEmit.push('at_due');
        }

        // 3. Daily while overdue
        if (pledge.status === 'Active' && nowSec >= pledge.dueTimestamp + 24 * 3600) {
          const daysOverdue = Math.floor((nowSec - pledge.dueTimestamp) / 86400);
          intervalsToEmit.push(`overdue_day_${daysOverdue}`);
        }

        for (const interval of intervalsToEmit) {
          try {
            // Check if already emitted for this pledge and interval
            const existing = await this.prisma.notificationRecord.findUnique({
              where: {
                pledgeId_interval: {
                  pledgeId: pledge.pledgeId,
                  interval,
                },
              },
            });

            if (existing) {
              skipped++;
              continue;
            }

            const payload: NotificationPayload = {
              type: 'NOTIFICATION_TRIGGERED',
              interval,
              pledgeId: pledge.pledgeId,
              debtorAddress: pledge.debtorAddress,
              lenderAddress: pledge.lenderAddress,
              amount: pledge.amount,
              token: pledge.token,
              dueTimestamp: pledge.dueTimestamp,
              status: pledge.status,
              track: pledge.track,
              emittedAt: new Date(nowSec * 1000).toISOString(),
            };

            // Structured logging of notification payload
            this.logger.log(
              {
                event: 'NOTIFICATION_EMITTED',
                payload,
              },
              `[Notifications] Notification emitted for pledge ${pledge.pledgeId} (interval: ${interval})`,
            );

            await this.prisma.notificationRecord.create({
              data: {
                pledgeId: pledge.pledgeId,
                interval,
                emittedAt: new Date(nowSec * 1000),
              },
            });

            processed++;
          } catch (err: any) {
            errors++;
            this.metrics.recordJobFailure(jobName, err);
            this.logger.error(
              {
                job: jobName,
                pledgeId: pledge.pledgeId,
                interval,
                error: err.message,
                stack: err.stack,
              },
              `[Notifications] Failed to emit notification for pledge ${pledge.pledgeId}`,
            );
          }
        }
      }

      this.metrics.recordJobSuccess(jobName);
    } catch (err: any) {
      this.metrics.recordJobFailure(jobName, err);
      this.logger.error({ job: jobName, error: err.message, stack: err.stack }, `[Notifications] Fatal error during notifications run`);
      throw err;
    }

    return { job: jobName, scanned, processed, skipped, errors };
  }
}
