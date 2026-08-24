import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { PublicClient } from 'viem';
import { PrismaClient } from '@prisma/client';
import { BUNDLER_CLIENT } from '../../chain/chain.module';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PollReceiptJobData {
  userOpHash: string;
  operation: string;
}

@Processor('userop-tracker')
export class UserOpTrackerProcessor extends WorkerHost {
  private readonly logger = new Logger(UserOpTrackerProcessor.name);
  private readonly prisma = new PrismaClient();

  constructor(@Inject(BUNDLER_CLIENT) private readonly bundlerClient: PublicClient) {
    super();
  }

  async process(job: Job<PollReceiptJobData>): Promise<void> {
    const { userOpHash, operation } = job.data;

    // Fetch the tracking row to check creation time
    const tracking = await this.prisma.userOpTracking.findUnique({
      where: { userOpHash },
    });

    if (!tracking) {
      this.logger.warn(`UserOpTracking row not found for ${userOpHash} — skipping`);
      return;
    }

    // ── Timeout guard ──────────────────────────────────────────────────────
    const ageMs = Date.now() - tracking.createdAt.getTime();
    if (ageMs > TIMEOUT_MS) {
      await this.prisma.userOpTracking.update({
        where: { userOpHash },
        data: { status: 'timeout', updatedAt: new Date() },
      });
      this.logger.warn(`UserOp ${userOpHash} timed out after ${Math.round(ageMs / 1000)}s`);
      return; // Do NOT rethrow — job is done, just failed gracefully
    }

    // ── Poll for receipt ───────────────────────────────────────────────────
    let receipt: any;
    try {
      receipt = await this.bundlerClient.request({
        method: 'eth_getUserOperationReceipt' as any,
        params: [userOpHash] as any,
      });
    } catch (err: any) {
      this.logger.warn(`Bundler RPC error for ${userOpHash}: ${err?.message}`);
      // Re-throw so BullMQ applies the backoff and retries
      throw err;
    }

    await this.prisma.userOpTracking.update({
      where: { userOpHash },
      data: { attempts: { increment: 1 }, updatedAt: new Date() },
    });

    if (!receipt) {
      // Not yet included — re-throw to trigger next retry
      throw new Error(`Receipt not yet available for ${userOpHash}`);
    }

    // ── Receipt received ────────────────────────────────────────────────────
    if (receipt.success) {
      await this.prisma.userOpTracking.update({
        where: { userOpHash },
        data: {
          status: 'included',
          txHash: receipt.receipt?.transactionHash ?? null,
          updatedAt: new Date(),
        },
      });
      this.logger.log(`UserOp ${userOpHash} included in tx ${receipt.receipt?.transactionHash}`);
    } else {
      // Decode revert reason if available
      const revertReason = receipt.reason ?? receipt.revertData ?? 'unknown';
      await this.prisma.userOpTracking.update({
        where: { userOpHash },
        data: {
          status: 'failed',
          txHash: receipt.receipt?.transactionHash ?? null,
          revertReason: String(revertReason),
          updatedAt: new Date(),
        },
      });
      this.logger.warn(`UserOp ${userOpHash} reverted: ${revertReason}`);
      // Do NOT re-throw for reverted UserOps — the job is complete (with failure info)
    }
  }
}
