import { Test, TestingModule } from '@nestjs/testing';
import { ReputationService } from './reputation.service';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';

describe('ReputationService', () => {
  let service: ReputationService;
  let prismaMock: any;

  const mockUser = {
    username: 'alice',
    smartAccountAddress: '0x000000000000000000000000000000000000000A',
  };

  beforeEach(async () => {
    prismaMock = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      reputationMirror: {
        findUnique: jest.fn(),
      },
      pledgeMirror: {
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ReputationService],
    }).compile();

    service = module.get<ReputationService>(ReputationService);
    (service as any).prisma = prismaMock;
  });

  describe('getReputation', () => {
    it('throws NotFoundException if user does not exist', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      await expect(service.getReputation('unknown')).rejects.toThrow(NotFoundException);
    });

    it('returns strictly { tier, color, isBlacklisted, hasOverdue } and nothing else', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser);
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 1,
        isBlacklisted: false,
        disapprovalCount: 2,
      });
      // count for overdue: 0, count for 48h: 0
      prismaMock.pledgeMirror.count.mockResolvedValue(0);

      const result = await service.getReputation('alice');
      expect(result).toEqual({
        tier: 1,
        color: 'green',
        isBlacklisted: false,
        hasOverdue: false,
      });

      expect(Object.keys(result).sort()).toEqual(['color', 'hasOverdue', 'isBlacklisted', 'tier']);
      expect((result as any).disapprovalCount).toBeUndefined();
      expect((result as any).pledgeCount).toBeUndefined();
      expect((result as any).amount).toBeUndefined();
    });

    it('evaluates color as red if user has any active overdue pledge (hard enforcement)', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser);
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 0,
        isBlacklisted: false,
      });
      // Overdue count = 1
      prismaMock.pledgeMirror.count.mockResolvedValueOnce(1);

      const result = await service.getReputation('alice');
      expect(result.color).toBe('red');
      expect(result.hasOverdue).toBe(true);
    });

    it('evaluates color as amber if user has active pledge due within 48 hours', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser);
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 0,
        isBlacklisted: false,
      });
      // Overdue count = 0, Upcoming 48h count = 1
      prismaMock.pledgeMirror.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      const result = await service.getReputation('alice');
      expect(result.color).toBe('amber');
      expect(result.hasOverdue).toBe(false);
    });

    it('evaluates color as green when no overdue and no 48h pledges', async () => {
      prismaMock.user.findUnique.mockResolvedValue(mockUser);
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 0,
        isBlacklisted: false,
      });
      prismaMock.pledgeMirror.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getReputation('alice');
      expect(result.color).toBe('green');
      expect(result.hasOverdue).toBe(false);
    });
  });

  describe('validateTierRule (shared validation)', () => {
    it('allows Voluntary track for Tier 0 (Normal) and Tier 1 (LightGrey)', async () => {
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 1,
        isBlacklisted: false,
      });

      await expect(
        service.validateTierRule(mockUser.smartAccountAddress, 'Voluntary')
      ).resolves.toBeUndefined();
    });

    it('rejects Voluntary track for Tier 2 (DarkCharcoal) with EnforcedTrackRequired', async () => {
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 2,
        isBlacklisted: false,
      });

      await expect(
        service.validateTierRule(mockUser.smartAccountAddress, 'Voluntary')
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('rejects Voluntary track if debtor is blacklisted', async () => {
      prismaMock.reputationMirror.findUnique.mockResolvedValue({
        tier: 0,
        isBlacklisted: true,
      });

      await expect(
        service.validateTierRule(mockUser.smartAccountAddress, 'Voluntary')
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('allows Enforced track even if debtor is Tier 2 or blacklisted', async () => {
      await expect(
        service.validateTierRule(mockUser.smartAccountAddress, 'Enforced')
      ).resolves.toBeUndefined();
    });
  });
});
