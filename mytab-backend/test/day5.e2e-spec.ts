import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { PUBLIC_CLIENT, BUNDLER_CLIENT, SPONSOR_ACCOUNT, WALLET_CLIENT } from '../src/chain/chain.module';
import { AutomationService } from '../src/automation/automation.service';
import { ConfigService } from '@nestjs/config';
import { getAddress } from 'viem';

describe('Day 5 End-to-End Integration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwtSecret: string;
  let automationService: AutomationService;
  let publicClientMock: any;
  let walletClientMock: any;

  // Test data
  const userAPhone = `+1000000000A`;
  const userBPhone = `+1000000000B`;
  const userAUsername = `usera_${Date.now()}`;
  const userBUsername = `userb_${Date.now()}`;
  const signerAddressA = getAddress('0x0000000000000000000000000000000000000001');
  const signerAddressB = getAddress('0x0000000000000000000000000000000000000002');
  const smartAccountA = getAddress('0x000000000000000000000000000000000000000a');
  const smartAccountB = getAddress('0x000000000000000000000000000000000000000b');
  const tokenAddress = getAddress('0x000000000000000000000000000000000000000c');

  let tokenA = '';
  let tokenB = '';
  const voluntaryPledgeId = String(Date.now());
  const enforcedPledgeId = String(Date.now() + 1);

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.notificationRecord.deleteMany();
    await prisma.pledgeMirror.deleteMany();
    await prisma.reputationMirror.deleteMany();
    await prisma.userOpTracking.deleteMany();
    await prisma.user.deleteMany();
    await prisma.walletRecord.deleteMany();
    await prisma.phoneHashAudit.deleteMany();

    publicClientMock = {
      readContract: jest.fn(({ functionName, args }: any) => {
        if (functionName === 'resolveByUsername') {
          return Promise.resolve(smartAccountB);
        }
        if (functionName === 'isBlacklisted') {
          return Promise.resolve(false);
        }
        if (functionName === 'requiresEnforcedTrack') {
          return Promise.resolve(false);
        }
        if (functionName === 'allowance') {
          return Promise.resolve(2000000n);
        }
        if (functionName === 'getAddress') {
          return Promise.resolve(args?.[0] === signerAddressA ? smartAccountA : smartAccountB);
        }
        if (functionName === 'getNonce') {
          return Promise.resolve(0n);
        }
        if (functionName === 'getPledge') {
          return Promise.resolve({
            lender: smartAccountA,
            debtor: smartAccountB,
            amount: 1000000n,
            token: tokenAddress,
            dueTimestamp: BigInt(Math.floor(Date.now() / 1000) + 10000),
            status: 0,
            track: 0,
          });
        }
        return Promise.resolve(null);
      }),
      getBlockNumber: jest.fn().mockResolvedValue(100n),
      getLogs: jest.fn().mockResolvedValue([]),
    };

    walletClientMock = {
      account: { address: '0x000000000000000000000000000000000000000A' },
      chain: { id: 84532 },
      writeContract: jest.fn().mockResolvedValue('0x' + 'aa'.repeat(32)),
    };

    const bundlerClientMock = {
      request: jest.fn(() => Promise.resolve('0x' + Math.random().toString(16).slice(2).padEnd(64, '0'))),
      readContract: jest.fn().mockResolvedValue(0n),
    };

    const sponsorAccountMock = {
      address: '0x545A57F8076E7a7B50215bC53FC3038b8dD5897b',
      signMessage: jest.fn().mockResolvedValue('0x' + '00'.repeat(65)),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PUBLIC_CLIENT)
      .useValue(publicClientMock)
      .overrideProvider(WALLET_CLIENT)
      .useValue(walletClientMock)
      .overrideProvider(BUNDLER_CLIENT)
      .useValue(bundlerClientMock)
      .overrideProvider(SPONSOR_ACCOUNT)
      .useValue(sponsorAccountMock)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const config = app.get(ConfigService);
    jwtSecret = config.getOrThrow<string>('JWT_SECRET');
    automationService = app.get(AutomationService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const getOtpAndToken = async (phone: string, username: string, signerAddress: string) => {
    await request(app.getHttpServer()).post('/identity/otp/request').send({ phone }).expect(201);
    const verifyRes = await request(app.getHttpServer()).post('/identity/otp/verify').send({ phone, otp: '123456' }).expect(201);
    const otpToken = verifyRes.body.token;

    const regRes = await request(app.getHttpServer())
      .post('/identity/register')
      .send({ token: otpToken, username, clientHash: 'hash', signerAddress })
      .expect(201);

    const smartAccount = regRes.body.smartAccountAddress;
    const sessionToken = jwt.sign({ smartAccountAddress: smartAccount }, jwtSecret, { expiresIn: '1h' });

    return { token: sessionToken, smartAccount };
  };

  it('1. Onboard two users', async () => {
    const a = await getOtpAndToken(userAPhone, userAUsername, signerAddressA);
    tokenA = a.token;

    const b = await getOtpAndToken(userBPhone, userBUsername, signerAddressB);
    tokenB = b.token;

    expect(a.smartAccount).toBe(smartAccountA);
    expect(b.smartAccount).toBe(smartAccountB);
  });

  it('2. User A creates a voluntary pledge for User B', async () => {
    const res = await request(app.getHttpServer())
      .post('/pledges')
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        debtorUsername: userBUsername,
        amount: '1000000',
        token: tokenAddress,
        dueTimestamp: Math.floor(Date.now() / 1000) + 10000,
        track: 'Voluntary',
      })
      .expect(202);

    expect(res.body.status).toBe('pending');
    expect(res.body.userOpHash).toBeDefined();

    // Mirror entry created by indexer in DB
    await prisma.pledgeMirror.create({
      data: {
        pledgeId: voluntaryPledgeId,
        lenderAddress: smartAccountA,
        debtorAddress: smartAccountB,
        amount: '1000000',
        token: tokenAddress,
        dueTimestamp: Math.floor(Date.now() / 1000) + 10000,
        status: 'Pending',
        track: 'Voluntary',
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    const timelineA = await request(app.getHttpServer())
      .get('/pledges/timeline')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(timelineA.body.upcoming.some((p: any) => p.pledgeId === voluntaryPledgeId)).toBe(true);
  });

  it('3. User B confirms the pledge', async () => {
    const res = await request(app.getHttpServer())
      .post(`/pledges/${voluntaryPledgeId}/confirm`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(202);

    expect(res.body.status).toBe('pending');

    // Indexer updates status to Active
    await prisma.pledgeMirror.update({
      where: { pledgeId: voluntaryPledgeId },
      data: { status: 'Active' },
    });
  });

  it('4. Assert summary shows expectedIn and goingOut', async () => {
    const summaryA = await request(app.getHttpServer())
      .get('/pledges/summary')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(summaryA.body.expectedIn[tokenAddress]).toBe('1000000');
    expect(summaryA.body.goingOut).toEqual({});

    const summaryB = await request(app.getHttpServer())
      .get('/pledges/summary')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(summaryB.body.goingOut[tokenAddress]).toBe('1000000');
    expect(summaryB.body.expectedIn).toEqual({});
  });

  it('5. Advance chain time past due, assert hasOverdue and timeline bucket', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    await prisma.pledgeMirror.update({
      where: { pledgeId: voluntaryPledgeId },
      data: { dueTimestamp: nowSec - 100 },
    });

    // Check Reputation endpoint for User B (Debtor)
    const repRes = await request(app.getHttpServer())
      .get(`/reputation/${userBUsername}`)
      .expect(200);

    expect(repRes.body.hasOverdue).toBe(true);
    expect(repRes.body.color).toBe('red');

    // Check Timeline for User B
    const timelineB = await request(app.getHttpServer())
      .get('/pledges/timeline')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(timelineB.body.overdue.some((p: any) => p.pledgeId === voluntaryPledgeId)).toBe(true);
  });

  it('6. B claims paid off-chain and assert SettlementClaimed', async () => {
    const res = await request(app.getHttpServer())
      .post(`/pledges/${voluntaryPledgeId}/claim-paid`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(202);

    expect(res.body.status).toBe('pending');

    const nowSec = Math.floor(Date.now() / 1000);
    await prisma.pledgeMirror.update({
      where: { pledgeId: voluntaryPledgeId },
      data: {
        status: 'SettlementClaimed',
        claimedAt: nowSec,
        lastClaimAt: nowSec,
      },
    });

    const timelineB = await request(app.getHttpServer())
      .get('/pledges/timeline')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(timelineB.body.overdue.some((p: any) => p.pledgeId === voluntaryPledgeId)).toBe(false);
  });

  it('7. Auto-clear sweep after 14 days settles the pledge', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Simulate claimedAt 15 days ago
    await prisma.pledgeMirror.update({
      where: { pledgeId: voluntaryPledgeId },
      data: {
        claimedAt: nowSec - 15 * 86400,
      },
    });

    const sweepResult = await automationService.runAutoClearSweep(nowSec);
    expect(sweepResult.scanned).toBe(1);
    expect(sweepResult.processed).toBe(1);
    expect(sweepResult.errors).toBe(0);
    expect(walletClientMock.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'autoApproveOffChainSettlement',
        args: [BigInt(voluntaryPledgeId)],
      }),
    );

    // Indexer sets status to Settled
    await prisma.pledgeMirror.update({
      where: { pledgeId: voluntaryPledgeId },
      data: { status: 'Settled' },
    });
  });

  it('8. Enforced Track: create, batched confirm, check allowance, and direct debit', async () => {
    // A creates Enforced pledge for B
    await request(app.getHttpServer())
      .post('/pledges')
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        debtorUsername: userBUsername,
        amount: '2000000',
        token: tokenAddress,
        dueTimestamp: Math.floor(Date.now() / 1000) + 5000,
        track: 'Enforced',
      })
      .expect(202);

    await prisma.pledgeMirror.create({
      data: {
        pledgeId: enforcedPledgeId,
        lenderAddress: smartAccountA,
        debtorAddress: smartAccountB,
        amount: '2000000',
        token: tokenAddress,
        dueTimestamp: Math.floor(Date.now() / 1000) + 5000,
        status: 'Pending',
        track: 'Enforced',
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    // B confirms via batched UserOp
    await request(app.getHttpServer())
      .post(`/pledges/${enforcedPledgeId}/confirm`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(202);

    await prisma.pledgeMirror.update({
      where: { pledgeId: enforcedPledgeId },
      data: { status: 'Active' },
    });

    // Debtor checks allowance
    const allowanceRes = await request(app.getHttpServer())
      .get(`/pledges/${enforcedPledgeId}/allowance`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);

    expect(allowanceRes.body.isSufficient).toBe(true);
    expect(allowanceRes.body.requiredAllowance).toBe('2000000');

    // Advance time past due
    const nowSec = Math.floor(Date.now() / 1000) + 6000;

    // Keeper runs direct debit
    const keeperResult = await automationService.runDirectDebitKeeper(nowSec);
    expect(keeperResult.scanned).toBe(1);
    expect(keeperResult.processed).toBe(1);
    expect(walletClientMock.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'executeDirectDebit',
        args: [BigInt(enforcedPledgeId)],
      }),
    );

    // Indexer updates status to Settled
    await prisma.pledgeMirror.update({
      where: { pledgeId: enforcedPledgeId },
      data: { status: 'Settled' },
    });
  });

  it('9. Reputation escalation: 5 disapprovals blacklists debtor and rejects new pledges', async () => {
    // Update debtor B in ReputationMirror to 5 disapprovals
    await prisma.reputationMirror.upsert({
      where: { walletAddress: smartAccountB },
      update: { tier: 3, isBlacklisted: true, disapprovalCount: 5 },
      create: { walletAddress: smartAccountB, tier: 3, isBlacklisted: true, disapprovalCount: 5 },
    });

    // Update publicClient mock to reflect on-chain blacklisting
    publicClientMock.readContract.mockImplementation(({ functionName, args }: any) => {
      if (functionName === 'resolveByUsername') return Promise.resolve(smartAccountB);
      if (functionName === 'isBlacklisted') {
        return Promise.resolve(args?.[0]?.toLowerCase() === smartAccountB.toLowerCase());
      }
      if (functionName === 'requiresEnforcedTrack') return Promise.resolve(true);
      return Promise.resolve(null);
    });

    // Creating a pledge against blacklisted user B is rejected (403 Forbidden)
    const rejectRes = await request(app.getHttpServer())
      .post('/pledges')
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        debtorUsername: userBUsername,
        amount: '1000000',
        token: tokenAddress,
        dueTimestamp: Math.floor(Date.now() / 1000) + 10000,
        track: 'Voluntary',
      })
      .expect(403);

    expect(rejectRes.body.message).toContain('DebtorBlacklisted');
  });
});
