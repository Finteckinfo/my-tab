import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AutomationService } from './automation.service';
import { MetricsService } from '../health/metrics.service';
import { PUBLIC_CLIENT, WALLET_CLIENT } from '../chain/chain.module';

describe('AutomationService', () => {
  let service: AutomationService;
  let metricsService: MetricsService;
  let walletClientMock: any;
  let publicClientMock: any;
  let prismaMock: any;

  const ROUTER_ADDR = '0x000000000000000000000000000000000000000E';
  const RELAYER_ADDR = '0x000000000000000000000000000000000000000A';

  beforeEach(async () => {
    metricsService = new MetricsService();

    walletClientMock = {
      account: { address: RELAYER_ADDR },
      chain: { id: 84532 },
      writeContract: jest.fn().mockResolvedValue('0x' + '11'.repeat(32)),
    };

    publicClientMock = {
      readContract: jest.fn(),
    };

    prismaMock = {
      pledgeMirror: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      userOpTracking: {
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      notificationRecord: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutomationService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) => {
              if (key === 'SETTLEMENT_ROUTER_ADDRESS') return ROUTER_ADDR;
              return undefined;
            },
          },
        },
        { provide: MetricsService, useValue: metricsService },
        { provide: PUBLIC_CLIENT, useValue: publicClientMock },
        { provide: WALLET_CLIENT, useValue: walletClientMock },
      ],
    }).compile();

    service = module.get<AutomationService>(AutomationService);
    service.prisma = prismaMock;
  });

  describe('Auto-clear sweep', () => {
    it('picks up exactly eligible pledges (SettlementClaimed and claimedAt <= now - 14 days)', async () => {
      const nowSec = 1700000000;
      const eligiblePledges = [
        { pledgeId: '101', status: 'SettlementClaimed', claimedAt: nowSec - 15 * 86400 },
        { pledgeId: '102', status: 'SettlementClaimed', claimedAt: nowSec - 14 * 86400 },
      ];

      prismaMock.pledgeMirror.findMany.mockResolvedValue(eligiblePledges);
      prismaMock.userOpTracking.findFirst.mockResolvedValue(null);

      const result = await service.runAutoClearSweep(nowSec);

      expect(result.scanned).toBe(2);
      expect(result.processed).toBe(2);
      expect(result.errors).toBe(0);
      expect(walletClientMock.writeContract).toHaveBeenCalledTimes(2);
      expect(walletClientMock.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'autoApproveOffChainSettlement',
          args: [101n],
        }),
      );
      expect(walletClientMock.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'autoApproveOffChainSettlement',
          args: [102n],
        }),
      );
    });

    it('a failing pledge does not abort the sweep for other pledges', async () => {
      const nowSec = 1700000000;
      const eligiblePledges = [
        { pledgeId: '201', status: 'SettlementClaimed', claimedAt: nowSec - 15 * 86400 },
        { pledgeId: '202', status: 'SettlementClaimed', claimedAt: nowSec - 15 * 86400 },
      ];

      prismaMock.pledgeMirror.findMany.mockResolvedValue(eligiblePledges);
      prismaMock.userOpTracking.findFirst.mockResolvedValue(null);

      // First pledge fails, second succeeds
      walletClientMock.writeContract
        .mockRejectedValueOnce(new Error('RPC Timeout on 201'))
        .mockResolvedValueOnce('0x' + '22'.repeat(32));

      const result = await service.runAutoClearSweep(nowSec);

      expect(result.scanned).toBe(2);
      expect(result.processed).toBe(1);
      expect(result.errors).toBe(1);
      expect(walletClientMock.writeContract).toHaveBeenCalledTimes(2);
    });

    it('re-running produces no duplicate submissions when operation is already pending', async () => {
      const nowSec = 1700000000;
      const eligiblePledges = [
        { pledgeId: '301', status: 'SettlementClaimed', claimedAt: nowSec - 15 * 86400 },
      ];

      prismaMock.pledgeMirror.findMany.mockResolvedValue(eligiblePledges);
      // Pending operation exists in DB
      prismaMock.userOpTracking.findFirst.mockResolvedValue({ id: 'op-1', status: 'pending' });

      const result = await service.runAutoClearSweep(nowSec);

      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.processed).toBe(0);
      expect(walletClientMock.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('Direct debit keeper', () => {
    it('picks up eligible enforced pledges and executes direct debit', async () => {
      const nowSec = 1700000000;
      const eligiblePledges = [
        { pledgeId: '401', track: 'Enforced', status: 'Active', dueTimestamp: nowSec - 100 },
      ];

      prismaMock.pledgeMirror.findMany.mockResolvedValue(eligiblePledges);
      prismaMock.userOpTracking.findFirst.mockResolvedValue(null);

      const result = await service.runDirectDebitKeeper(nowSec);

      expect(result.scanned).toBe(1);
      expect(result.processed).toBe(1);
      expect(walletClientMock.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'executeDirectDebit',
          args: [401n],
        }),
      );
    });

    it('re-running direct debit keeper skips already pending operations', async () => {
      const nowSec = 1700000000;
      prismaMock.pledgeMirror.findMany.mockResolvedValue([
        { pledgeId: '402', track: 'Enforced', status: 'Active', dueTimestamp: nowSec - 100 },
      ]);
      prismaMock.userOpTracking.findFirst.mockResolvedValue({ id: 'op-2', status: 'pending' });

      const result = await service.runDirectDebitKeeper(nowSec);

      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.processed).toBe(0);
      expect(walletClientMock.writeContract).not.toHaveBeenCalled();
    });
  });

  describe('Notification triggers', () => {
    it('emits notifications for 48h before, at due, and daily while overdue', async () => {
      const nowSec = 1700000000;
      const pledges = [
        // 48h before due: due in 24h
        {
          pledgeId: '501',
          status: 'Active',
          track: 'Voluntary',
          dueTimestamp: nowSec + 24 * 3600,
          debtorAddress: '0x1',
          lenderAddress: '0x2',
          amount: '100',
          token: '0xT',
        },
        // At due: due now
        {
          pledgeId: '502',
          status: 'Active',
          track: 'Voluntary',
          dueTimestamp: nowSec,
          debtorAddress: '0x1',
          lenderAddress: '0x2',
          amount: '200',
          token: '0xT',
        },
        // Overdue: due 2 days ago
        {
          pledgeId: '503',
          status: 'Active',
          track: 'Enforced',
          dueTimestamp: nowSec - 2 * 86400,
          debtorAddress: '0x1',
          lenderAddress: '0x2',
          amount: '300',
          token: '0xT',
        },
      ];

      prismaMock.pledgeMirror.findMany.mockResolvedValue(pledges);
      prismaMock.notificationRecord.findUnique.mockResolvedValue(null);

      const result = await service.runNotificationTriggers(nowSec);

      expect(result.scanned).toBe(3);
      expect(result.processed).toBe(3);
      expect(prismaMock.notificationRecord.create).toHaveBeenCalledTimes(3);

      expect(prismaMock.notificationRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pledgeId: '501',
          interval: '48h_before',
        }),
      });

      expect(prismaMock.notificationRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pledgeId: '502',
          interval: 'at_due',
        }),
      });

      expect(prismaMock.notificationRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          pledgeId: '503',
          interval: 'overdue_day_2',
        }),
      });
    });

    it('does not re-emit notifications if already recorded', async () => {
      const nowSec = 1700000000;
      const pledges = [
        {
          pledgeId: '501',
          status: 'Active',
          track: 'Voluntary',
          dueTimestamp: nowSec + 24 * 3600,
          debtorAddress: '0x1',
          lenderAddress: '0x2',
          amount: '100',
          token: '0xT',
        },
      ];

      prismaMock.pledgeMirror.findMany.mockResolvedValue(pledges);
      // Already emitted previously
      prismaMock.notificationRecord.findUnique.mockResolvedValue({ id: 'notif-1' });

      const result = await service.runNotificationTriggers(nowSec);

      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.processed).toBe(0);
      expect(prismaMock.notificationRecord.create).not.toHaveBeenCalled();
    });
  });

  describe('Health alert verification (3x interval rule)', () => {
    it('triggers health alert when auto-clear job has not completed in 3x its interval (3 hours)', () => {
      const startTime = 1700000000000;
      const mService = new MetricsService();
      mService.setStartTime(startTime);
      const checkTime = startTime + 3.1 * 3600 * 1000; // 3.1 hours later

      const health = mService.checkAutomationHealth(checkTime);
      expect(health.healthy).toBe(false);
      expect(health.alerts.some((a) => a.includes('auto-clear'))).toBe(true);
    });

    it('triggers health alert when direct-debit job has not completed in 3x its interval (45 minutes)', () => {
      const startTime = 1700000000000;
      const mService = new MetricsService();
      mService.setStartTime(startTime);
      const checkTime = startTime + 46 * 60 * 1000; // 46 minutes later

      const health = mService.checkAutomationHealth(checkTime);
      expect(health.healthy).toBe(false);
      expect(health.alerts.some((a) => a.includes('direct-debit'))).toBe(true);
    });

    it('reports healthy when jobs succeed within their 3x intervals', () => {
      const now = Date.now();
      const mService = new MetricsService();
      mService.setStartTime(now);
      mService.recordJobSuccess('auto-clear');
      mService.recordJobSuccess('direct-debit');
      mService.recordJobSuccess('notifications');

      const health = mService.checkAutomationHealth(now + 10 * 60 * 1000); // 10 minutes later
      expect(health.healthy).toBe(true);
      expect(health.alerts).toHaveLength(0);
    });
  });
});
