import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ReputationService {
  private readonly prisma = new PrismaClient();

  async getReputation(username: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });

    if (!user) {
      throw new NotFoundException(`User ${username} not found`);
    }

    const mirror = await this.prisma.reputationMirror.findUnique({
      where: { walletAddress: user.smartAccountAddress },
    });

    const tierInt = mirror ? mirror.tier : 0;
    const isBlacklisted = mirror ? mirror.isBlacklisted : false;

    // Spec: red/amber/green indicator derived from whether the user has any pledge where status = Active and dueTimestamp < now
    // Red is hard enforcement — one overdue pledge anywhere makes them red.
    const nowSec = Math.floor(Date.now() / 1000);

    const overdueCount = await this.prisma.pledgeMirror.count({
      where: {
        debtorAddress: user.smartAccountAddress,
        status: 'Active',
        dueTimestamp: { lt: nowSec },
      },
    });

    const hasOverdue = overdueCount > 0;

    let color = 'green';
    if (hasOverdue) {
      color = 'red';
    } else {
      // Check for amber: active pledge due within 48 hours
      const upcoming48h = await this.prisma.pledgeMirror.count({
        where: {
          debtorAddress: user.smartAccountAddress,
          status: 'Active',
          dueTimestamp: { gte: nowSec, lt: nowSec + 48 * 3600 },
        },
      });
      if (upcoming48h > 0) {
        color = 'amber';
      }
    }

    return {
      tier: tierInt,
      color,
      isBlacklisted,
      hasOverdue,
    };
  }

  async validateTierRule(debtorAddress: string, track: string) {
    if (track === 'Voluntary') {
      const mirror = await this.prisma.reputationMirror.findUnique({
        where: { walletAddress: debtorAddress.toLowerCase() }, // the indexer stores checksummed, but we will assume checksummed is passed in
      });
      
      // If address in DB is checksummed but input is not, we might miss. Let's do a case insensitive lookup if necessary, or ensure we pass checksummed addresses
      // Note: we can just check if mirror exists
      let tier = 0;
      let isBlacklisted = false;

      if (mirror) {
        tier = mirror.tier;
        isBlacklisted = mirror.isBlacklisted;
      } else {
        // Fallback case-insensitive lookup
        const user = await this.prisma.user.findFirst({
          where: { smartAccountAddress: { equals: debtorAddress, mode: 'insensitive' } }
        });
        if (user) {
          const actualMirror = await this.prisma.reputationMirror.findUnique({
            where: { walletAddress: user.smartAccountAddress }
          });
          if (actualMirror) {
            tier = actualMirror.tier;
            isBlacklisted = actualMirror.isBlacklisted;
          }
        }
      }

      // Tier 2 (DarkCharcoal) or Tier 3 (Blacklisted) requires Enforced track
      if (tier >= 2 || isBlacklisted) {
        throw new UnprocessableEntityException('EnforcedTrackRequired');
      }
    }
  }
}
