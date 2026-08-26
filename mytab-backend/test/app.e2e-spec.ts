import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, toHex, parseAbi, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { PUBLIC_CLIENT, BUNDLER_CLIENT, SPONSOR_ACCOUNT } from '../src/chain/chain.module';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { getUserOperationHash } from 'viem/account-abstraction';

describe('End-to-End Integration (e2e)', () => {
  let app: INestApplication<App>;
  const phone = `+1234567${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
  const username = `testuser_${Date.now()}`;
  const clientHash = 'mockClientHash123';
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const signerAddress = account.address;
  let token = '';
  let smartAccountAddress = '';

  beforeAll(async () => {
    jest.setTimeout(30000);

    const prisma = new PrismaClient();
    await prisma.notificationRecord.deleteMany();
    await prisma.pledgeMirror.deleteMany();
    await prisma.reputationMirror.deleteMany();
    await prisma.userOpTracking.deleteMany();
    await prisma.user.deleteMany();
    await prisma.walletRecord.deleteMany();
    await prisma.phoneHashAudit.deleteMany();
    await prisma.$disconnect();

    const publicClientMock = {
      readContract: jest.fn(({ functionName, args }: any) => {
        if (functionName === 'getAddress') {
          return Promise.resolve('0x000000000000000000000000000000000000000a');
        }
        if (functionName === 'getNonce') return Promise.resolve(0n);
        return Promise.resolve(null);
      }),
      getBlockNumber: jest.fn().mockResolvedValue(100n),
      getLogs: jest.fn().mockResolvedValue([]),
      getBytecode: jest.fn().mockResolvedValue('0x608060405234801561001057600080fd5b50'),
    };

    const bundlerClientMock = {
      request: jest.fn(({ method }: any) => {
        if (method === 'eth_getUserOperationReceipt') {
          return Promise.resolve({ success: true, userOpHash: '0x' + '00'.repeat(32) });
        }
        return Promise.resolve('0x' + Math.random().toString(16).slice(2).padEnd(64, '0'));
      }),
      readContract: jest.fn().mockResolvedValue(0n),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PUBLIC_CLIENT)
      .useValue(publicClientMock)
      .overrideProvider(BUNDLER_CLIENT)
      .useValue(bundlerClientMock)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200);
  });

  it('/identity/otp/request (POST)', async () => {
    const res = await request(app.getHttpServer())
      .post('/identity/otp/request')
      .send({ phone })
      .expect(201);
      
    expect(res.body.success).toBe(true);
  });

  it('/identity/otp/verify (POST)', async () => {
    const res = await request(app.getHttpServer())
      .post('/identity/otp/verify')
      .send({ phone, otp: '123456' })
      .expect(201);
      
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    token = res.body.token; // Save JWT token for registration
  });

  it('/identity/register (POST)', async () => {
    const res = await request(app.getHttpServer())
      .post('/identity/register')
      .send({ token, username, clientHash, signerAddress })
      .expect(201);
      
    expect(res.body.status).toBe('counterfactual');
    expect(res.body.smartAccountAddress).toBeDefined();
    smartAccountAddress = res.body.smartAccountAddress;
  });

  it('/identity/register (POST) duplicate - should 409', async () => {
    // Attempt registration with same phone hash using the same token
    const res = await request(app.getHttpServer())
      .post('/identity/register')
      .send({ token, username: `anotheruser_${Date.now()}`, clientHash, signerAddress })
      .expect(409);
      
    expect(res.body.message).toBe('PhoneAlreadyRegistered');
  });

  it('/wallets/:username (GET)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/wallets/${username}`)
      .expect(200);
      
    expect(res.body.deploymentStatus).toBeDefined();
    expect(res.body.address).toBeDefined();
    expect(res.body.ownerSigner).toBeDefined();
  });

  it('sends a sponsored no-op UserOp to deploy the account', async () => {
    const config = app.get(ConfigService);
    const bundlerClient = app.get(BUNDLER_CLIENT);
    const sponsorAccount = app.get(SPONSOR_ACCOUNT);

    const factoryAddress = config.getOrThrow<string>('FACTORY_ADDRESS');
    const paymasterAddress = config.getOrThrow<string>('PAYMASTER_ADDRESS');
    const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

    // Construct initCode
    const initCode = factoryAddress + encodeFunctionData({
      abi: parseAbi(['function createAccount(address owner, uint256 salt) returns (address)']),
      functionName: 'createAccount',
      args: [signerAddress, 0n]
    }).slice(2);

    // CallData is execute(smartAccountAddress, 0, 0x) which is a no-op
    const callData = encodeFunctionData({
      abi: parseAbi(['function execute(address to, uint256 value, bytes data)']),
      functionName: 'execute',
      args: [smartAccountAddress as `0x${string}`, 0n, '0x']
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const validUntil = BigInt(nowSec + 900);
    const validAfter = 0n;

    // We hardcode a nonce of 0 since it's the first deployment
    const nonce = 0n;

    // Build the hash for the paymaster
    const callDataHash = keccak256(callData);
    const encoded = encodeAbiParameters(
      parseAbiParameters('address, uint256, uint48, uint48, bytes32'),
      [smartAccountAddress as `0x${string}`, nonce, Number(validUntil), Number(validAfter), callDataHash],
    );
    const hash = keccak256(encoded);

    // Sign with sponsor
    const sig = await sponsorAccount.signMessage({ message: { raw: hash } });
    const gasSlots = '0'.repeat(64);
    const validUntilHex = validUntil.toString(16).padStart(12, '0');
    const validAfterHex = validAfter.toString(16).padStart(12, '0');
    const paymasterAndData = `${paymasterAddress}${gasSlots}${validUntilHex}${validAfterHex}${sig.slice(2)}`;

    // Build the UserOp for signing
    // EP v0.7 userOp hash requires packing fields. viem might not have it built-in directly here,
    // wait, we can just use pimlico's eth_sendUserOperation.
    // To sign the userOp, we need the userOpHash. We can ask the bundler! Wait, the bundler doesn't give us the hash before sending.
    // We can just construct the hash locally.
    
    // Actually, we can use viem's Account Abstraction utilities if available, or just compute the UserOpHash manually.
    const userOp = {
      sender: smartAccountAddress,
      nonce: toHex(nonce),
      initCode,
      callData,
      callGasLimit: toHex(200000n),
      verificationGasLimit: toHex(400000n), // Higher for deployment
      preVerificationGas: toHex(100000n),
      maxFeePerGas: toHex(1000000000n),
      maxPriorityFeePerGas: toHex(100000000n),
      paymasterAndData,
      signature: '0x',
    };

    const userOpHash = getUserOperationHash({
      userOperation: userOp as any,
      entryPointAddress: entryPoint,
      entryPointVersion: '0.7',
      chainId: 84532,
    });

    const signature = await account.signMessage({ message: { raw: userOpHash } });
    userOp.signature = signature;

    const txHash = await bundlerClient.request({
      method: 'eth_sendUserOperation' as any,
      params: [userOp, entryPoint] as any,
    });
    expect(txHash).toBeDefined();

    // Wait for the bundler to mine it (simple poll)
    let receipt = null;
    for (let i = 0; i < 20; i++) {
      try {
        receipt = await bundlerClient.request({
          method: 'eth_getUserOperationReceipt' as any,
          params: [txHash] as any,
        });
        if (receipt) break;
      } catch (e) {}
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(receipt).toBeDefined();
    expect(receipt.success).toBe(true);

    // Assert the WalletsService now says it's deployed
    const res = await request(app.getHttpServer())
      .get(`/wallets/${username}`)
      .expect(200);
      
    expect(res.body.deploymentStatus).toBe('deployed');
  }, 60000); // 60s timeout for mining
});
