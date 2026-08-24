import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaClient } from '@prisma/client';

describe('Day 5 End-to-End Integration (e2e)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();

  // Test data
  const userAPhone = `+1000000000A`;
  const userBPhone = `+1000000000B`;
  const userAUsername = `usera_${Date.now()}`;
  const userBUsername = `userb_${Date.now()}`;
  let tokenA = '';
  let tokenB = '';
  let smartAccountA = '';
  let smartAccountB = '';
  let pledgeId = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const getOtpAndToken = async (phone: string, username: string) => {
    await request(app.getHttpServer()).post('/identity/otp/request').send({ phone }).expect(201);
    const verifyRes = await request(app.getHttpServer()).post('/identity/otp/verify').send({ phone, otp: '123456' }).expect(201);
    const token = verifyRes.body.token;

    const regRes = await request(app.getHttpServer()).post('/identity/register').send({ token, username, clientHash: 'hash' }).expect(201);
    return { token, smartAccount: regRes.body.smartAccountAddress };
  };

  it('1. Onboard two users', async () => {
    const a = await getOtpAndToken(userAPhone, userAUsername);
    tokenA = a.token;
    smartAccountA = a.smartAccount;

    const b = await getOtpAndToken(userBPhone, userBUsername);
    tokenB = b.token;
    smartAccountB = b.smartAccount;

    expect(smartAccountA).toBeDefined();
    expect(smartAccountB).toBeDefined();
  });

  it('2. User A creates a pledge for User B', async () => {
    const res = await request(app.getHttpServer())
      .post('/pledges')
      .set('authorization', `Bearer ${tokenA}`)
      .send({
        debtorUsername: userBUsername,
        amount: '1000000',
        token: '0x0000000000000000000000000000000000000000', // ETH/native
        dueTimestamp: Math.floor(Date.now() / 1000) + 10000,
        track: 'Voluntary',
      })
      .expect(202);

    expect(res.body.status).toBe('pending');
    expect(res.body.userOpHash).toBeDefined();

    // Since we rely on indexer, we just simulate the indexer updating the DB
    // Normally we'd wait for on-chain indexing, but in unit tests without a mock chain we inject directly.
    pledgeId = '1';
    await prisma.pledgeMirror.create({
      data: {
        pledgeId,
        lenderAddress: smartAccountA,
        debtorAddress: smartAccountB,
        amount: '1000000',
        token: '0x0000000000000000000000000000000000000000',
        dueTimestamp: Math.floor(Date.now() / 1000) + 10000,
        status: 'Pending',
        track: 'Voluntary',
        createdAt: Math.floor(Date.now() / 1000),
      }
    });

    const timelineA = await request(app.getHttpServer())
      .get('/pledges/timeline')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);

    // Pending pledge appears in upcoming timeline
    expect(timelineA.body.upcoming.some((p: any) => p.pledgeId === pledgeId)).toBe(true);
  });

  it('3. User B confirms the pledge', async () => {
    const res = await request(app.getHttpServer())
      .post(`/pledges/${pledgeId}/confirm`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(202);

    expect(res.body.status).toBe('pending');

    // Simulate indexer
    await prisma.pledgeMirror.update({
      where: { pledgeId },
      data: { status: 'Active' },
    });
  });

  it('4. Assert summary shows expectedIn and goingOut', async () => {
    const summaryA = await request(app.getHttpServer())
      .get('/pledges/summary')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    
    expect(summaryA.body.expectedIn['0x0000000000000000000000000000000000000000']).toBe('1000000');
    expect(summaryA.body.goingOut).toEqual({});

    const summaryB = await request(app.getHttpServer())
      .get('/pledges/summary')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);
    
    expect(summaryB.body.goingOut['0x0000000000000000000000000000000000000000']).toBe('1000000');
    expect(summaryB.body.expectedIn).toEqual({});
  });

  it('5. Advance chain time past due, assert hasOverdue and timeline bucket', async () => {
    // We simulate advancing chain time by changing dueTimestamp to the past in DB
    const nowSec = Math.floor(Date.now() / 1000);
    await prisma.pledgeMirror.update({
      where: { pledgeId },
      data: { dueTimestamp: nowSec - 100 },
    });

    // Check Reputation endpoint for User B (Debtor)
    const repRes = await request(app.getHttpServer())
      .get(`/reputation/${userBUsername}`)
      .expect(200);
    
    expect(repRes.body.hasOverdue).toBe(true);
    expect(repRes.body.color).toBe('red');

    // Check Timeline
    const timelineB = await request(app.getHttpServer())
      .get('/pledges/timeline')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);
    
    expect(timelineB.body.overdue.some((p: any) => p.pledgeId === pledgeId)).toBe(true);
  });

  it('6. B claims paid off-chain and assert SettlementClaimed', async () => {
    const res = await request(app.getHttpServer())
      .post(`/pledges/${pledgeId}/claim-paid`)
      .set('authorization', `Bearer ${tokenB}`)
      .expect(202);

    expect(res.body.status).toBe('pending');

    await prisma.pledgeMirror.update({
      where: { pledgeId },
      data: { status: 'SettlementClaimed' },
    });

    // Timeline should no longer show it as overdue (since it is no longer Active)
    const timelineB = await request(app.getHttpServer())
      .get('/pledges/timeline')
      .set('authorization', `Bearer ${tokenB}`)
      .expect(200);
    
    expect(timelineB.body.overdue.some((p: any) => p.pledgeId === pledgeId)).toBe(false);
  });
});
