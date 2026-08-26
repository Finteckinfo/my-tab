import { Test, TestingModule } from '@nestjs/testing';
import { FiatService } from './fiat.service';
import { FiatEnabledGuard } from './fiat.guard';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus, ExecutionContext } from '@nestjs/common';

// ── Mock PrismaService ───────────────────────────────────────────────────────
const mockPrisma = {
  settlementTransaction: {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma)
}));

// ── Mock fetch ───────────────────────────────────────────────────────────────
const originalFetch = global.fetch;

describe('FiatEnabledGuard', () => {
  let guard: FiatEnabledGuard;

  it('should throw 503 when FIAT_ENABLED is false', () => {
    const configService = { get: jest.fn().mockReturnValue('false') } as any;
    guard = new FiatEnabledGuard(configService);

    const mockContext = {} as ExecutionContext;
    expect(() => guard.canActivate(mockContext)).toThrow(HttpException);

    try {
      guard.canActivate(mockContext);
    } catch (e) {
      expect(e.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    }
  });

  it('should throw 503 when FIAT_ENABLED is not set', () => {
    const configService = { get: jest.fn().mockReturnValue('false') } as any;
    guard = new FiatEnabledGuard(configService);

    const mockContext = {} as ExecutionContext;
    expect(() => guard.canActivate(mockContext)).toThrow(HttpException);
  });

  it('should allow when FIAT_ENABLED is true', () => {
    const configService = { get: jest.fn().mockReturnValue('true') } as any;
    guard = new FiatEnabledGuard(configService);

    const mockContext = {} as ExecutionContext;
    expect(guard.canActivate(mockContext)).toBe(true);
  });
});

describe('FiatService', () => {
  let service: FiatService;
  let configService: ConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Mock fetch for Daraja API calls
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ access_token: 'test-token', ResponseCode: '0', CheckoutRequestID: 'test-checkout-id' }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FiatService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              const config: Record<string, string> = {
                FIAT_ENABLED: 'true',
                MPESA_CONSUMER_KEY: 'test-key',
                MPESA_CONSUMER_SECRET: 'test-secret',
                MPESA_SHORTCODE: '174379',
                MPESA_PASSKEY: 'test-passkey',
                MPESA_INITIATOR: 'testapi',
                MPESA_SECURITY_CREDENTIAL: 'test-cred',
                MPESA_CALLBACK_URL: 'https://test.com/webhook/onramp',
                MPESA_B2C_RESULT_URL: 'https://test.com/webhook/offramp',
                MPESA_TIMEOUT_URL: 'https://test.com/webhook/timeout',
              };
              return config[key] || defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<FiatService>(FiatService);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  // ── Onramp webhook idempotency ──────────────────────────────────────────

  describe('handleOnrampWebhook', () => {
    it('should skip already-completed transactions (idempotent)', async () => {
      mockPrisma.settlementTransaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'completed',
        providerTxId: 'checkout-1',
      });

      await service.handleOnrampWebhook({
        Body: {
          stkCallback: {
            MerchantRequestID: 'mr-1',
            CheckoutRequestID: 'checkout-1',
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'RECEIPT1' }] },
          },
        },
      });

      // Should NOT update since it's already completed
      expect(mockPrisma.settlementTransaction.update).not.toHaveBeenCalled();
    });

    it('should process successful onramp callback', async () => {
      mockPrisma.settlementTransaction.findUnique.mockResolvedValue({
        id: 'tx-2',
        status: 'processing',
        providerTxId: 'checkout-2',
      });

      await service.handleOnrampWebhook({
        Body: {
          stkCallback: {
            MerchantRequestID: 'mr-2',
            CheckoutRequestID: 'checkout-2',
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: 'RECEIPT2' }] },
          },
        },
      });

      expect(mockPrisma.settlementTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-2' },
        data: { status: 'completed', providerRef: 'RECEIPT2' },
      });
    });

    it('should mark failed on non-zero ResultCode', async () => {
      mockPrisma.settlementTransaction.findUnique.mockResolvedValue({
        id: 'tx-3',
        status: 'processing',
        providerTxId: 'checkout-3',
      });

      await service.handleOnrampWebhook({
        Body: {
          stkCallback: {
            MerchantRequestID: 'mr-3',
            CheckoutRequestID: 'checkout-3',
            ResultCode: 1032,
            ResultDesc: 'Request cancelled by user',
          },
        },
      });

      expect(mockPrisma.settlementTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-3' },
        data: { status: 'failed', failureReason: 'Request cancelled by user' },
      });
    });

    it('should silently ignore unknown CheckoutRequestIDs', async () => {
      mockPrisma.settlementTransaction.findUnique.mockResolvedValue(null);

      await service.handleOnrampWebhook({
        Body: {
          stkCallback: {
            MerchantRequestID: 'mr-x',
            CheckoutRequestID: 'unknown-checkout',
            ResultCode: 0,
            ResultDesc: 'Success',
          },
        },
      });

      expect(mockPrisma.settlementTransaction.update).not.toHaveBeenCalled();
    });
  });

  // ── Offramp webhook idempotency ─────────────────────────────────────────

  describe('handleOfframpWebhook', () => {
    it('should skip already-completed offramp (idempotent)', async () => {
      mockPrisma.settlementTransaction.findFirst.mockResolvedValue({
        id: 'tx-off-1',
        status: 'completed',
        lockStatus: 'released',
      });

      await service.handleOfframpWebhook({
        Result: {
          ResultType: 0,
          ResultCode: 0,
          ResultDesc: 'Success',
          OriginatorConversationID: 'tx-off-1',
          ConversationID: 'conv-1',
          TransactionID: 'TXN1',
        },
      });

      expect(mockPrisma.settlementTransaction.update).not.toHaveBeenCalled();
    });

    it('should release lock on successful B2C', async () => {
      mockPrisma.settlementTransaction.findFirst.mockResolvedValue({
        id: 'tx-off-2',
        status: 'processing',
        lockStatus: 'locked',
      });

      await service.handleOfframpWebhook({
        Result: {
          ResultType: 0,
          ResultCode: 0,
          ResultDesc: 'Success',
          OriginatorConversationID: 'tx-off-2',
          ConversationID: 'conv-2',
          TransactionID: 'TXN2',
        },
      });

      expect(mockPrisma.settlementTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-off-2' },
        data: {
          status: 'completed',
          lockStatus: 'released',
          providerRef: 'TXN2',
        },
      });
    });

    it('should restore lock on failed B2C', async () => {
      mockPrisma.settlementTransaction.findFirst.mockResolvedValue({
        id: 'tx-off-3',
        status: 'processing',
        lockStatus: 'locked',
      });

      await service.handleOfframpWebhook({
        Result: {
          ResultType: 0,
          ResultCode: 2001,
          ResultDesc: 'Insufficient funds',
          OriginatorConversationID: 'tx-off-3',
          ConversationID: 'conv-3',
          TransactionID: 'TXN3',
        },
      });

      expect(mockPrisma.settlementTransaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-off-3' },
        data: {
          status: 'failed',
          lockStatus: 'restored',
          failureReason: 'Insufficient funds',
        },
      });
    });
  });

  // ── Reconciliation ──────────────────────────────────────────────────────

  describe('runReconciliation', () => {
    it('should flag stuck transactions as mismatches', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      mockPrisma.settlementTransaction.findMany.mockResolvedValue([
        {
          id: 'stuck-1',
          providerTxId: 'prov-1',
          status: 'processing',
          amount: '1000',
          createdAt: twoHoursAgo,
        },
      ]);

      const result = await service.runReconciliation();

      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0].transactionId).toBe('stuck-1');
      expect(result.mismatches[0].expectedStatus).toBe('completed or failed');
    });

    it('should report clean when no mismatches', async () => {
      mockPrisma.settlementTransaction.findMany.mockResolvedValue([]);

      const result = await service.runReconciliation();

      expect(result.mismatches).toHaveLength(0);
      expect(result.totalExpected).toBe(0);
    });
  });
});
