import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { PUBLIC_CLIENT, BUNDLER_CLIENT, SPONSOR_ACCOUNT } from '../chain/chain.module';

// ── Helpers ───────────────────────────────────────────────────────────────────
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const LENDER_ADDR = '0x000000000000000000000000000000000000000A';
const DEBTOR_ADDR = '0x000000000000000000000000000000000000000B';
const VALID_TOKEN = '0x000000000000000000000000000000000000000C';
const VALID_DUE = Math.floor(Date.now() / 1000) + 86400; // 24h from now
const USER_OP_HASH = '0xdeadbeefdead';

const validJwt = (() => {
  // Build a minimal JWT manually to avoid jsonwebtoken in test boot
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ smartAccountAddress: LENDER_ADDR })).toString('base64url');
  return `${header}.${payload}.fakesig`;
})();

// ── Mock factories ────────────────────────────────────────────────────────────
const makeConfig = (overrides: Record<string, string> = {}) => ({
  getOrThrow: (key: string) => {
    const vals: Record<string, string> = {
      JWT_SECRET: 'test_secret',
      IDENTITY_REGISTRY_ADDRESS: '0x' + 'a'.repeat(40),
      REPUTATION_ENGINE_ADDRESS: '0x' + 'b'.repeat(40),
      PLEDGE_LEDGER_ADDRESS: '0x' + 'c'.repeat(40),
      PAYMASTER_ADDRESS: '0x' + 'd'.repeat(40),
      ...overrides,
    };
    return vals[key];
  },
  get: (key: string) => undefined,
});

/** Build a PublicClient mock with controllable readContract behaviour */
function makePublicClient(overrides: {
  resolveByUsername?: string;
  lenderBlacklisted?: boolean;
  debtorBlacklisted?: boolean;
  requiresEnforcedTrack?: boolean;
  nonce?: bigint;
} = {}) {
  const {
    resolveByUsername = DEBTOR_ADDR,
    lenderBlacklisted = false,
    debtorBlacklisted = false,
    requiresEnforcedTrack = false,
    nonce = 0n,
  } = overrides;

  return {
    readContract: jest.fn(({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'resolveByUsername':   return Promise.resolve(resolveByUsername);
        case 'isBlacklisted':       return Promise.resolve(lenderBlacklisted || debtorBlacklisted);
        case 'requiresEnforcedTrack': return Promise.resolve(requiresEnforcedTrack);
        case 'getNonce':            return Promise.resolve(nonce);
        default:                    return Promise.resolve(null);
      }
    }),
  };
}

/** BundlerClient that accepts the UserOp */
const makeBundlerClient = (hash = USER_OP_HASH) => ({
  readContract: jest.fn().mockResolvedValue(0n),
  request: jest.fn().mockResolvedValue(hash),
});

const makeSponsorAccount = () => ({
  address: LENDER_ADDR,
  signMessage: jest.fn().mockResolvedValue('0x' + '00'.repeat(65)),
});

const makeTrackerQueue = () => ({
  add: jest.fn().mockResolvedValue(undefined),
});

// ── Test suite ────────────────────────────────────────────────────────────────
describe('LedgerService', () => {
  let service: LedgerService;
  let publicClientMock: ReturnType<typeof makePublicClient>;
  let bundlerClientMock: ReturnType<typeof makeBundlerClient>;
  let trackerQueueMock: ReturnType<typeof makeTrackerQueue>;

  async function buildModule(clientOverrides?: Parameters<typeof makePublicClient>[0]) {
    publicClientMock = makePublicClient(clientOverrides);
    bundlerClientMock = makeBundlerClient();
    trackerQueueMock = makeTrackerQueue();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        { provide: ConfigService, useValue: makeConfig() },
        { provide: PUBLIC_CLIENT, useValue: publicClientMock },
        { provide: BUNDLER_CLIENT, useValue: bundlerClientMock },
        { provide: SPONSOR_ACCOUNT, useValue: makeSponsorAccount() },
        { provide: getQueueToken('userop-tracker'), useValue: trackerQueueMock },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);

    // Patch prisma to avoid real DB
    (service as any).prisma = {
      userOpTracking: { create: jest.fn().mockResolvedValue({}) },
    };

    // Patch JWT verify to extract smartAccountAddress from our test payload
    jest.spyOn(require('jsonwebtoken'), 'verify').mockImplementation((_t: any, _s: any) => ({
      smartAccountAddress: LENDER_ADDR,
    }));
  }

  afterEach(() => jest.restoreAllMocks());

  const validDto = () => ({
    debtorUsername: 'alice',
    amount: '1000000',
    token: VALID_TOKEN,
    dueTimestamp: VALID_DUE,
    track: 'Voluntary' as const,
  });

  // ── Pre-flight rejections ─────────────────────────────────────────────────

  it('404 when debtor username resolves to zero address', async () => {
    await buildModule({ resolveByUsername: ZERO_ADDR });
    await expect(service.createPledge(`Bearer ${validJwt}`, validDto())).rejects.toThrow(NotFoundException);
  });

  it('403 LenderBlacklisted', async () => {
    await buildModule({ lenderBlacklisted: true });
    // Both blacklist checks run; lender check is first — need to differentiate calls
    publicClientMock.readContract = jest.fn()
      .mockResolvedValueOnce(DEBTOR_ADDR)           // resolveByUsername
      .mockResolvedValueOnce(true)                  // isBlacklisted(lender)
      .mockResolvedValueOnce(false);                // isBlacklisted(debtor)
    await expect(service.createPledge(`Bearer ${validJwt}`, validDto())).rejects.toThrow(ForbiddenException);
  });

  it('403 DebtorBlacklisted', async () => {
    await buildModule();
    publicClientMock.readContract = jest.fn()
      .mockResolvedValueOnce(DEBTOR_ADDR)
      .mockResolvedValueOnce(false)                 // lender ok
      .mockResolvedValueOnce(true);                 // debtor blacklisted
    await expect(service.createPledge(`Bearer ${validJwt}`, validDto())).rejects.toThrow(ForbiddenException);
  });

  it('400 SelfPledgeNotAllowed when debtor == lender', async () => {
    await buildModule();
    publicClientMock.readContract = jest.fn()
      .mockResolvedValueOnce(LENDER_ADDR)           // resolveByUsername returns lender's own address
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    await expect(service.createPledge(`Bearer ${validJwt}`, validDto())).rejects.toThrow(BadRequestException);
  });

  it('400 DueDateInPast', async () => {
    await buildModule();
    const dto = { ...validDto(), dueTimestamp: Math.floor(Date.now() / 1000) - 1 };
    await expect(service.createPledge(`Bearer ${validJwt}`, dto)).rejects.toThrow(BadRequestException);
  });

  it('422 EnforcedTrackRequired when debtor has DarkCharcoal tier and track is Voluntary', async () => {
    await buildModule({ requiresEnforcedTrack: true });
    publicClientMock.readContract = jest.fn()
      .mockResolvedValueOnce(DEBTOR_ADDR)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);                 // requiresEnforcedTrack
    await expect(service.createPledge(`Bearer ${validJwt}`, validDto())).rejects.toThrow(UnprocessableEntityException);
  });

  it('Enforced track bypasses the requiresEnforcedTrack check', async () => {
    await buildModule({ requiresEnforcedTrack: true });
    publicClientMock.readContract = jest.fn()
      .mockResolvedValueOnce(DEBTOR_ADDR)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(0n);                   // getNonce
    bundlerClientMock.request = jest.fn().mockResolvedValue(USER_OP_HASH);
    const result = await service.createPledge(`Bearer ${validJwt}`, { ...validDto(), track: 'Enforced' });
    expect(result.status).toBe('pending');
  });

  // ── Successful submission ──────────────────────────────────────────────────

  it('returns { userOpHash, status: pending } on success', async () => {
    await buildModule();
    publicClientMock.readContract = jest.fn()
      .mockResolvedValueOnce(DEBTOR_ADDR)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)                 // requiresEnforcedTrack
      .mockResolvedValueOnce(0n);                   // getNonce

    const result = await service.createPledge(`Bearer ${validJwt}`, validDto());
    expect(result).toEqual({ userOpHash: USER_OP_HASH, status: 'pending' });
    expect(trackerQueueMock.add).toHaveBeenCalledWith('pollReceipt', { userOpHash: USER_OP_HASH, operation: 'createPledge' }, expect.any(Object));
  });

  // ── Day 2 Endpoints ───────────────────────────────────────────────────────

  describe('getPendingConfirmations', () => {
    it('returns pledges from DB', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: {
          findMany: jest.fn().mockResolvedValue([{ pledgeId: '1', status: 'Pending' }]),
        },
      };
      // lender's token, but the function extracts the address and queries it
      const res = await service.getPendingConfirmations(`Bearer ${validJwt}`);
      expect(res).toEqual([{ pledgeId: '1', status: 'Pending' }]);
      expect((service as any).prisma.pledgeMirror.findMany).toHaveBeenCalledWith({
        where: { debtorAddress: LENDER_ADDR, status: 'Pending' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('confirmPledge', () => {
    it('404 if pledge not found', async () => {
      await buildModule();
      (service as any).prisma = { pledgeMirror: { findUnique: jest.fn().mockResolvedValue(null) } };
      await expect(service.confirmPledge(`Bearer ${validJwt}`, '1')).rejects.toThrow(NotFoundException);
    });

    it('403 if caller is not the debtor', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: {
          findUnique: jest.fn().mockResolvedValue({ debtorAddress: DEBTOR_ADDR, status: 'Pending', createdAt: Math.floor(Date.now() / 1000) }),
        },
      };
      // validJwt has smartAccountAddress = LENDER_ADDR
      await expect(service.confirmPledge(`Bearer ${validJwt}`, '1')).rejects.toThrow(ForbiddenException);
    });

    it('400 if status is not Pending', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: {
          findUnique: jest.fn().mockResolvedValue({ debtorAddress: LENDER_ADDR, status: 'Active', createdAt: Math.floor(Date.now() / 1000) }),
        },
      };
      await expect(service.confirmPledge(`Bearer ${validJwt}`, '1')).rejects.toThrow(BadRequestException);
    });

    it('400 if confirmation window expired', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: {
          // 8 days ago
          findUnique: jest.fn().mockResolvedValue({ debtorAddress: LENDER_ADDR, status: 'Pending', createdAt: Math.floor(Date.now() / 1000) - 8 * 86400 }),
        },
      };
      await expect(service.confirmPledge(`Bearer ${validJwt}`, '1')).rejects.toThrow(BadRequestException);
    });

    it('submits UserOp on success', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: { findUnique: jest.fn().mockResolvedValue({ debtorAddress: LENDER_ADDR, status: 'Pending', createdAt: Math.floor(Date.now() / 1000) }) },
        userOpTracking: { create: jest.fn().mockResolvedValue({}) },
      };
      const res = await service.confirmPledge(`Bearer ${validJwt}`, '1');
      expect(res.status).toBe('pending');
      expect(trackerQueueMock.add).toHaveBeenCalledWith('pollReceipt', { userOpHash: USER_OP_HASH, operation: 'confirmPledge' }, expect.any(Object));
    });
  });

  describe('cancelPledge', () => {
    it('403 if caller is not the lender', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: { findUnique: jest.fn().mockResolvedValue({ lenderAddress: DEBTOR_ADDR, status: 'Pending' }) },
      };
      await expect(service.cancelPledge(`Bearer ${validJwt}`, '1')).rejects.toThrow(ForbiddenException);
    });

    it('400 if status is not Pending', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: { findUnique: jest.fn().mockResolvedValue({ lenderAddress: LENDER_ADDR, status: 'Active' }) },
      };
      await expect(service.cancelPledge(`Bearer ${validJwt}`, '1')).rejects.toThrow(BadRequestException);
    });

    it('submits UserOp on success', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: { findUnique: jest.fn().mockResolvedValue({ lenderAddress: LENDER_ADDR, status: 'Pending' }) },
        userOpTracking: { create: jest.fn().mockResolvedValue({}) },
      };
      const res = await service.cancelPledge(`Bearer ${validJwt}`, '1');
      expect(res.status).toBe('pending');
    });
  });

  describe('markPaidOffChain', () => {
    it('403 if caller is not the debtor', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: { findUnique: jest.fn().mockResolvedValue({ debtorAddress: DEBTOR_ADDR, status: 'Active' }) },
      };
      await expect(service.markPaidOffChain(`Bearer ${validJwt}`, '1')).rejects.toThrow(ForbiddenException);
    });

    it('400 if status is not Active', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: { findUnique: jest.fn().mockResolvedValue({ debtorAddress: LENDER_ADDR, status: 'Settled' }) },
      };
      await expect(service.markPaidOffChain(`Bearer ${validJwt}`, '1')).rejects.toThrow(BadRequestException);
    });

    it('400 if claim cooldown has not elapsed', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: {
          findUnique: jest.fn().mockResolvedValue({
            debtorAddress: LENDER_ADDR,
            status: 'Active',
            lastClaimAt: Math.floor(Date.now() / 1000) - 10 * 86400, // 10 days ago
          }),
        },
      };
      await expect(service.markPaidOffChain(`Bearer ${validJwt}`, '1')).rejects.toThrow(BadRequestException);
    });

    it('submits UserOp on success', async () => {
      await buildModule();
      (service as any).prisma = {
        pledgeMirror: {
          findUnique: jest.fn().mockResolvedValue({
            debtorAddress: LENDER_ADDR,
            status: 'Active',
            lastClaimAt: Math.floor(Date.now() / 1000) - 31 * 86400, // 31 days ago
          }),
        },
        userOpTracking: { create: jest.fn().mockResolvedValue({}) },
      };
      const res = await service.markPaidOffChain(`Bearer ${validJwt}`, '1');
      expect(res.status).toBe('pending');
    });
  });
});

// ── UserOpTrackerProcessor tests ───────────────────────────────────────────────
describe('UserOpTrackerProcessor', () => {
  const { UserOpTrackerProcessor } = require('./jobs/userop-tracker.processor');

  function makeProcessor(receiptResponse: any) {
    const bundler = {
      request: jest.fn().mockResolvedValue(receiptResponse),
    };
    const proc = new UserOpTrackerProcessor(bundler as any);
    (proc as any).prisma = {
      userOpTracking: {
        findUnique: jest.fn().mockResolvedValue({ createdAt: new Date(), userOpHash: USER_OP_HASH }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    return proc;
  }

  const makeJob = (data = { userOpHash: USER_OP_HASH, operation: 'createPledge' }) => ({ data });

  it('updates status to included on successful receipt', async () => {
    const proc = makeProcessor({ success: true, receipt: { transactionHash: '0xabc' } });
    await proc.process(makeJob());
    expect((proc as any).prisma.userOpTracking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'included' }) }),
    );
  });

  it('updates status to failed and stores revert reason without crashing', async () => {
    const proc = makeProcessor({ success: false, reason: 'EnforcedTrackRequired' });
    await expect(proc.process(makeJob())).resolves.toBeUndefined();
    expect((proc as any).prisma.userOpTracking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', revertReason: 'EnforcedTrackRequired' }) }),
    );
  });

  it('throws when receipt is null so BullMQ retries', async () => {
    const proc = makeProcessor(null);
    await expect(proc.process(makeJob())).rejects.toThrow();
  });

  it('marks timeout and does not throw when job is too old', async () => {
    const proc = makeProcessor(null);
    const oldDate = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    (proc as any).prisma.userOpTracking.findUnique = jest.fn().mockResolvedValue({ createdAt: oldDate });
    await expect(proc.process(makeJob())).resolves.toBeUndefined();
    expect((proc as any).prisma.userOpTracking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'timeout' }) }),
    );
  });
});
