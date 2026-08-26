import { Test, TestingModule } from '@nestjs/testing';
import { IndexerService } from './indexer.service';
// removed PrismaService
import { ConfigService } from '@nestjs/config';
import { PUBLIC_CLIENT } from '../chain/chain.module';
import { MetricsService } from '../health/metrics.service';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { PLEDGE_LEDGER_ABI } from '../abis/PledgeLedger.abi';
import { MY_TAB_ACCOUNT_FACTORY_ABI } from '../abis/MyTabAccountFactory.abi';

describe('IndexerService', () => {
  let service: IndexerService;
  let prismaMock: any;
  let publicClientMock: any;
  let configMock: any;
  let metricsMock: any;

  beforeEach(async () => {
    prismaMock = {
      indexerCursor: {
        findUnique: jest.fn().mockResolvedValue({ lastIndexedBlock: 10 }),
        create: jest.fn(),
        update: jest.fn(),
      },
      processedEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      pledgeMirror: {
        upsert: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      walletRecord: {
        updateMany: jest.fn(),
      },
      user: {
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(async (cb) => {
        return cb(prismaMock);
      }),
    };

    publicClientMock = {
      getBlockNumber: jest.fn().mockResolvedValue(20n),
      getLogs: jest.fn().mockResolvedValue([]),
      readContract: jest.fn(),
    };

    metricsMock = {
      incrementReconciliationMismatches: jest.fn(),
      incrementIndexerErrors: jest.fn(),
      incrementEventsProcessed: jest.fn(),
      updateIndexerStatus: jest.fn(),
    };

    configMock = {
      getOrThrow: jest.fn((key) => {
        if (key === 'IDENTITY_REGISTRY_ADDRESS') return '0x0000000000000000000000000000000000000001';
        if (key === 'REPUTATION_ENGINE_ADDRESS') return '0x0000000000000000000000000000000000000002';
        if (key === 'PLEDGE_LEDGER_ADDRESS') return '0x0000000000000000000000000000000000000003';
        return '0x0000000000000000000000000000000000000004';
      }),
      get: jest.fn().mockReturnValue('0x0000000000000000000000000000000000000004'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IndexerService,
        { provide: ConfigService, useValue: configMock },
        { provide: PUBLIC_CLIENT, useValue: publicClientMock },
        { provide: MetricsService, useValue: metricsMock },
      ],
    }).compile();

    service = module.get<IndexerService>(IndexerService);
    (service as any).prisma = prismaMock;
  });

  const createMockLog = (eventName: string, args: any, txHash: string, logIndex: number): any => {
    let abi;
    if (eventName.startsWith('Pledge')) abi = PLEDGE_LEDGER_ABI;
    else if (eventName === 'AccountCreated') abi = MY_TAB_ACCOUNT_FACTORY_ABI;
    else throw new Error('Add ABI to mock');

    const item = abi.find((a: any) => a.name === eventName && a.type === 'event');
    const topics = encodeEventTopics({ abi, eventName, args } as any);
    
    // Viem getLogs format
    return {
      transactionHash: txHash,
      logIndex,
      blockNumber: 15n,
      topics,
      data: '0x' + encodeAbiParameters(item.inputs.filter((i: any) => !i.indexed), Object.values(args).slice(topics.length - 1)).substring(2),
      // Actually viem encodeEventTopics handles topics. The data part is tricky to mock perfectly without full encoding.
      // We will override decodeEventLog behavior if needed, but viem handles it if we provide valid logs.
      // Since it's hard to mock raw hex data perfectly, let's mock the decodeEventLog internally or use valid encodings.
    };
  };

  // For testing, since viem's decodeEventLog requires perfectly valid hex, it's easier to spy on it, or mock the publicClient to return correctly formatted data. 
  // Let's just mock decodeEventLog.
  describe('Polling and Transactions', () => {
    it('idempotency: replaying same log batch skips processing', async () => {
      // Mock decodeEventLog directly on the module, or since we can't easily, we will mock processLog to use decoded data directly?
      // No, we can just spy on viem
      const viem = require('viem');
      jest.spyOn(viem, 'decodeEventLog').mockReturnValue({
        eventName: 'PledgeConfirmed',
        args: { pledgeId: 1n },
      });

      publicClientMock.getLogs.mockResolvedValue([
        { transactionHash: '0x1', logIndex: 0, blockNumber: 15n, data: '0x', topics: [] },
      ]);

      // First run: does not exist
      await service.pollEvents();
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenCalledTimes(1);
      expect(prismaMock.processedEvent.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.indexerCursor.update).toHaveBeenCalledTimes(1);

      // Second run: return already exists
      prismaMock.pledgeMirror.upsert.mockClear();
      prismaMock.processedEvent.create.mockClear();
      prismaMock.processedEvent.findUnique.mockResolvedValue({ id: 'exists' });
      service['isProcessing'] = false; // reset
      await service.pollEvents();
      
      // Upsert should not be called
      expect(prismaMock.pledgeMirror.upsert).not.toHaveBeenCalled();
      // Cursor should still advance
      expect(prismaMock.indexerCursor.update).toHaveBeenCalledTimes(2);
    });

    it('handler throwing mid-batch leaves cursor unadvanced', async () => {
      const viem = require('viem');
      jest.spyOn(viem, 'decodeEventLog')
        .mockReturnValueOnce({ eventName: 'PledgeConfirmed', args: { pledgeId: 1n } })
        .mockReturnValueOnce({ eventName: 'PledgeConfirmed', args: { pledgeId: 2n } });

      publicClientMock.getLogs.mockResolvedValue([
        { transactionHash: '0x1', logIndex: 0, blockNumber: 15n, data: '0x', topics: [] },
        { transactionHash: '0x2', logIndex: 1, blockNumber: 15n, data: '0x', topics: [] },
      ]);

      // Make the second upsert throw
      prismaMock.pledgeMirror.upsert
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('DB Error'));

      await service.pollEvents();

      // First upsert succeeded, second threw
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenCalledTimes(2);
      // Cursor should NOT be updated because the batch threw
      expect(prismaMock.indexerCursor.update).not.toHaveBeenCalled();
    });

    it('events arriving out of order converge correctly', async () => {
      const viem = require('viem');
      jest.spyOn(viem, 'decodeEventLog')
        .mockReturnValueOnce({ eventName: 'PledgeConfirmed', args: { pledgeId: 1n } })
        .mockReturnValueOnce({ 
          eventName: 'PledgeCreated', 
          args: { 
            pledgeId: 1n, 
            lender: '0x000000000000000000000000000000000000000a', 
            debtor: '0x000000000000000000000000000000000000000b', 
            amount: 100n, 
            token: '0x000000000000000000000000000000000000000c', 
            dueTimestamp: 10000n, 
            track: 0 
          } 
        });

      publicClientMock.getLogs.mockResolvedValue([
        { transactionHash: '0x1', logIndex: 0, blockNumber: 15n, data: '0x', topics: [] }, // Confirmed
        { transactionHash: '0x2', logIndex: 1, blockNumber: 15n, data: '0x', topics: [] }, // Created
      ]);

      await service.pollEvents();

      // First call (Confirmed) upserts status to Active
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenNthCalledWith(1, {
        where: { pledgeId: '1' },
        update: { status: 'Active' },
        create: expect.objectContaining({ status: 'Active' }),
      });

      expect(prismaMock.pledgeMirror.upsert).toHaveBeenNthCalledWith(2, {
        where: { pledgeId: '1' },
        update: expect.objectContaining({
          lenderAddress: '0x000000000000000000000000000000000000000A',
          debtorAddress: '0x000000000000000000000000000000000000000b',
        }),
        create: expect.any(Object),
      });
      // The state in the DB will reflect both: it has the lender/debtor AND the Active status
      // because Prisma's `update` on PledgeCreated doesn't touch the `status` field!
      // Wait, is that true? Let's check `applyStateChange`.
      // Yes, in `PledgeCreated` update, `status` is intentionally NOT included in `update`, so it preserves the existing 'Active' status.
      // This is exactly out-of-order convergence.
      // This is exactly out-of-order convergence.
    });
  });

  describe('Reconciliation, Backfill, and Gap Detection', () => {
    it('reconciliation corrects a deliberately corrupted mirror row', async () => {
      // Mock db returns a corrupted row
      prismaMock.pledgeMirror.findMany = jest.fn().mockResolvedValue([
        { pledgeId: '1', status: 'Pending', blockNumber: 15 },
      ]);
      // Mock chain returns actual status
      publicClientMock.readContract.mockResolvedValue({
        status: 1, // Active
        lender: '0x000000000000000000000000000000000000000A',
        debtor: '0x000000000000000000000000000000000000000b',
        amount: 100n,
        token: '0x000000000000000000000000000000000000000C',
        dueTimestamp: 10000n,
        track: 0,
      });

      await service.reconcilePledges();

      expect(publicClientMock.readContract).toHaveBeenCalled();
      expect(prismaMock.pledgeMirror.update).toHaveBeenCalledWith({
        where: { pledgeId: '1' },
        data: expect.objectContaining({ status: 'Active' }),
      });
      expect(metricsMock.incrementReconciliationMismatches).toHaveBeenCalledTimes(1);
    });

    it('backfill over an already-indexed range changes nothing', async () => {
      const viem = require('viem');
      jest.spyOn(viem, 'decodeEventLog').mockReturnValue({
        eventName: 'PledgeConfirmed',
        args: { pledgeId: 1n },
      });

      publicClientMock.getLogs.mockResolvedValue([
        { transactionHash: '0x1', logIndex: 0, blockNumber: 15n, data: '0x', topics: [] },
      ]);
      prismaMock.processedEvent.findUnique.mockResolvedValue({ id: 'exists' });

      await service.backfill(10, 20);

      expect(publicClientMock.getLogs).toHaveBeenCalled();
      // Should check if exists
      expect(prismaMock.processedEvent.findUnique).toHaveBeenCalled();
      // Should not apply changes or insert marker
      expect(prismaMock.pledgeMirror.upsert).not.toHaveBeenCalled();
      expect(prismaMock.processedEvent.create).not.toHaveBeenCalled();
      // Should record metrics for logs processed (it attempted to process)
      expect(metricsMock.incrementEventsProcessed).toHaveBeenCalledWith(1);
    });

    it('startup gap detection triggers on large gaps', async () => {
      // Gap > 100 blocks
      publicClientMock.getBlockNumber.mockResolvedValue(150n);
      
      let currentBlock = 10;
      prismaMock.indexerCursor.findUnique.mockImplementation(() => {
        return Promise.resolve({ lastIndexedBlock: currentBlock });
      });
      prismaMock.indexerCursor.update.mockImplementation((args: any) => {
        currentBlock = args.data.lastIndexedBlock;
        return Promise.resolve();
      });

      await service.onModuleInit();

      // Because head is 150 and lag is 5, target will be min(150-5, 10+2000) = 145
      // So processNextBatch updates cursor to 145.
      // Next iteration: currentBlock=145, head=150. 150-145 = 5 <= CONFIRMATION_LAG. Loop breaks.
      expect(prismaMock.indexerCursor.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastIndexedBlock: 145 } })
      );
    });

    it('indexer-down scenario: worker stops, 3 pledges created, worker restarts and indexes all 3', async () => {
      const viem = require('viem');
      jest.spyOn(viem, 'decodeEventLog')
        .mockReturnValueOnce({
          eventName: 'PledgeCreated',
          args: {
            pledgeId: 101n,
            lender: '0x0000000000000000000000000000000000000001',
            debtor: '0x0000000000000000000000000000000000000002',
            amount: 500n,
            token: '0x0000000000000000000000000000000000000003',
            dueTimestamp: 20000n,
            track: 0,
          },
        })
        .mockReturnValueOnce({
          eventName: 'PledgeCreated',
          args: {
            pledgeId: 102n,
            lender: '0x0000000000000000000000000000000000000001',
            debtor: '0x0000000000000000000000000000000000000002',
            amount: 600n,
            token: '0x0000000000000000000000000000000000000003',
            dueTimestamp: 21000n,
            track: 1,
          },
        })
        .mockReturnValueOnce({
          eventName: 'PledgeCreated',
          args: {
            pledgeId: 103n,
            lender: '0x0000000000000000000000000000000000000001',
            debtor: '0x0000000000000000000000000000000000000002',
            amount: 700n,
            token: '0x0000000000000000000000000000000000000003',
            dueTimestamp: 22000n,
            track: 0,
          },
        });

      publicClientMock.getBlockNumber.mockResolvedValue(50n);
      prismaMock.indexerCursor.findUnique.mockResolvedValue({ lastIndexedBlock: 10 });
      publicClientMock.getLogs.mockResolvedValue([
        { transactionHash: '0x101', logIndex: 0, blockNumber: 25n, data: '0x', topics: [] },
        { transactionHash: '0x102', logIndex: 1, blockNumber: 26n, data: '0x', topics: [] },
        { transactionHash: '0x103', logIndex: 2, blockNumber: 27n, data: '0x', topics: [] },
      ]);

      // Worker starts / runs pollEvents
      await service.pollEvents();

      // All 3 pledges must be upserted
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenCalledTimes(3);
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: { pledgeId: '101' },
          create: expect.objectContaining({ pledgeId: '101', status: 'Pending', track: 'Voluntary' }),
        }),
      );
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { pledgeId: '102' },
          create: expect.objectContaining({ pledgeId: '102', status: 'Pending', track: 'Enforced' }),
        }),
      );
      expect(prismaMock.pledgeMirror.upsert).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          where: { pledgeId: '103' },
          create: expect.objectContaining({ pledgeId: '103', status: 'Pending', track: 'Voluntary' }),
        }),
      );

      // Processed events created for all 3
      expect(prismaMock.processedEvent.create).toHaveBeenCalledTimes(3);
      // Cursor advanced to min(50-5, 10+2000) = 45
      expect(prismaMock.indexerCursor.update).toHaveBeenCalledWith({
        where: { contractAddress: 'GLOBAL_INDEXER' },
        data: { lastIndexedBlock: 45 },
      });
    });
  });
});
