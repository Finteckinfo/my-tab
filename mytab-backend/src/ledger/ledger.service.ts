import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Inject } from '@nestjs/common';
import {
  createPublicClient,
  encodeFunctionData,
  keccak256,
  toBytes,
  http,
  toHex,
  getAddress,
} from 'viem';
import type { PublicClient, WalletClient, LocalAccount } from 'viem';
import { baseSepolia } from 'viem/chains';
import * as jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

import { PUBLIC_CLIENT, BUNDLER_CLIENT, SPONSOR_ACCOUNT } from '../chain/chain.module';
import { IDENTITY_REGISTRY_ABI } from '../abis/IdentityRegistry.abi';
import { REPUTATION_ENGINE_ABI } from '../abis/ReputationEngine.abi';
import { PLEDGE_LEDGER_ABI } from '../abis/PledgeLedger.abi';
import { ERC20_ABI } from '../abis/ERC20.abi';
import { LIGHT_ACCOUNT_ABI } from '../abis/LightAccount.abi';
import type { CreatePledgeDto } from './dto/create-pledge.dto';
import { signPaymasterData } from './userop/paymaster-signer';

const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);
  private readonly prisma = new PrismaClient();

  constructor(
    private readonly config: ConfigService,
    @Inject(PUBLIC_CLIENT) private readonly publicClient: PublicClient,
    @Inject(BUNDLER_CLIENT) private readonly bundlerClient: PublicClient,
    @Inject(SPONSOR_ACCOUNT) private readonly sponsorAccount: LocalAccount,
    @InjectQueue('userop-tracker') private readonly trackerQueue: Queue,
  ) {}

  async createPledge(authHeader: string, dto: CreatePledgeDto) {
    const lenderAddress = this._extractAddress(authHeader);

    const identityRegistryAddress = this.config.getOrThrow<string>('IDENTITY_REGISTRY_ADDRESS') as `0x${string}`;
    const reputationEngineAddress = this.config.getOrThrow<string>('REPUTATION_ENGINE_ADDRESS') as `0x${string}`;
    const pledgeLedgerAddress = this.config.getOrThrow<string>('PLEDGE_LEDGER_ADDRESS') as `0x${string}`;
    const paymasterAddress = this.config.getOrThrow<string>('PAYMASTER_ADDRESS') as `0x${string}`;

    // ── Pre-flight 1: resolve debtor username via IdentityRegistry ────────────
    const usernameHash = keccak256(toBytes(dto.debtorUsername.toLowerCase()));
    const debtorAddress = await this.publicClient.readContract({
      address: identityRegistryAddress,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'resolveByUsername',
      args: [usernameHash],
    }) as string;

    if (!debtorAddress || debtorAddress === '0x0000000000000000000000000000000000000000') {
      throw new NotFoundException(`Unknown username: ${dto.debtorUsername}`);
    }

    // ── Pre-flight 2: blacklist checks ────────────────────────────────────────
    const [lenderBlacklisted, debtorBlacklisted] = await Promise.all([
      this.publicClient.readContract({
        address: identityRegistryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'isBlacklisted',
        args: [lenderAddress as `0x${string}`],
      }),
      this.publicClient.readContract({
        address: identityRegistryAddress,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'isBlacklisted',
        args: [debtorAddress as `0x${string}`],
      }),
    ]);

    if (lenderBlacklisted) throw new ForbiddenException('LenderBlacklisted');
    if (debtorBlacklisted) throw new ForbiddenException('DebtorBlacklisted');

    // ── Pre-flight 3: self-pledge check ───────────────────────────────────────
    if (lenderAddress.toLowerCase() === debtorAddress.toLowerCase()) {
      throw new BadRequestException('SelfPledgeNotAllowed');
    }

    // ── Pre-flight 4: due date in the past ────────────────────────────────────
    const nowSec = Math.floor(Date.now() / 1000);
    if (dto.dueTimestamp <= nowSec) {
      throw new BadRequestException('DueDateInPast');
    }

    // ── Pre-flight 5: enforced track check ────────────────────────────────────
    if (dto.track === 'Voluntary') {
      const requiresEnforced = await this.publicClient.readContract({
        address: reputationEngineAddress,
        abi: REPUTATION_ENGINE_ABI,
        functionName: 'requiresEnforcedTrack',
        args: [getAddress(debtorAddress)],
      });

      if (requiresEnforced) {
        throw new UnprocessableEntityException('EnforcedTrackRequired');
      }
    }

    // ── Build callData for PledgeLedger.createPledge ──────────────────────────
    const trackEnum = dto.track === 'Voluntary' ? 0 : 1;
    const callData = encodeFunctionData({
      abi: PLEDGE_LEDGER_ABI,
      functionName: 'createPledge',
      args: [
        getAddress(debtorAddress),
        BigInt(dto.amount),
        getAddress(dto.token),
        BigInt(dto.dueTimestamp),
        trackEnum,
      ],
    });

    return this._submitSponsoredUserOp(lenderAddress, callData, 'createPledge');
  }

  // ── GET /pledges/timeline ───────────────────────────────────────────────────
  async getTimeline(authHeader: string) {
    const callerAddress = this._extractAddress(authHeader);
    const nowSec = Math.floor(Date.now() / 1000);
    const in48Hours = nowSec + 48 * 3600;

    const pledges = await this.prisma.pledgeMirror.findMany({
      where: {
        OR: [{ debtorAddress: callerAddress }, { lenderAddress: callerAddress }],
        status: { in: ['Pending', 'Active'] },
      },
      orderBy: { dueTimestamp: 'asc' },
    });

    return {
      overdue: pledges.filter(p => p.status === 'Active' && p.dueTimestamp < nowSec),
      dueWithin48Hours: pledges.filter(p => p.status === 'Active' && p.dueTimestamp >= nowSec && p.dueTimestamp < in48Hours),
      upcoming: pledges.filter(p => (p.status === 'Active' && p.dueTimestamp >= in48Hours) || p.status === 'Pending'),
    };
  }

  // ── GET /pledges/summary ────────────────────────────────────────────────────
  async getSummary(authHeader: string) {
    const callerAddress = this._extractAddress(authHeader);

    const activePledges = await this.prisma.pledgeMirror.findMany({
      where: {
        OR: [{ debtorAddress: callerAddress }, { lenderAddress: callerAddress }],
        status: 'Active',
      },
    });

    const expectedIn: Record<string, string> = {};
    const goingOut: Record<string, string> = {};

    for (const p of activePledges) {
      if (p.lenderAddress.toLowerCase() === callerAddress.toLowerCase()) {
        const current = expectedIn[p.token] ? BigInt(expectedIn[p.token]) : 0n;
        expectedIn[p.token] = (current + BigInt(p.amount)).toString();
      }
      if (p.debtorAddress.toLowerCase() === callerAddress.toLowerCase()) {
        const current = goingOut[p.token] ? BigInt(goingOut[p.token]) : 0n;
        goingOut[p.token] = (current + BigInt(p.amount)).toString();
      }
    }

    return { expectedIn, goingOut };
  }

  // ── GET /pledges/pending-confirmation ───────────────────────────────────────
  async getPendingConfirmations(authHeader: string) {
    const debtorAddress = this._extractAddress(authHeader);
    return this.prisma.pledgeMirror.findMany({
      where: {
        debtorAddress,
        status: 'Pending',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── POST /pledges/:id/confirm ───────────────────────────────────────────────
  async confirmPledge(authHeader: string, pledgeId: string) {
    const callerAddress = this._extractAddress(authHeader);
    const pledge = await this._getPledgeOr404(pledgeId);

    if (callerAddress.toLowerCase() !== pledge.debtorAddress.toLowerCase()) {
      throw new ForbiddenException('Unauthorized: caller is not the debtor');
    }
    if (pledge.status !== 'Pending') {
      throw new BadRequestException('InvalidStatus');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // 7 days window (604800 seconds)
    if (nowSec > pledge.createdAt + 604800) {
      throw new BadRequestException('ConfirmationWindowExpired');
    }

    const pledgeLedgerAddress = this.config.getOrThrow<string>('PLEDGE_LEDGER_ADDRESS') as `0x${string}`;
    const settlementRouterAddress = this.config.getOrThrow<string>('SETTLEMENT_ROUTER_ADDRESS') as `0x${string}`;

    const confirmCallData = encodeFunctionData({
      abi: PLEDGE_LEDGER_ABI,
      functionName: 'confirmPledge',
      args: [BigInt(pledgeId)],
    });

    let callData: `0x${string}`;

    if (pledge.track === 'Enforced') {
      // Batched UserOp: token.approve(settlementRouterAddress, pledgeAmount) followed by pledgeLedger.confirmPledge(pledgeId)
      const approveCallData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [settlementRouterAddress, BigInt(pledge.amount)],
      });

      callData = encodeFunctionData({
        abi: LIGHT_ACCOUNT_ABI,
        functionName: 'executeBatch',
        args: [
          [getAddress(pledge.token), pledgeLedgerAddress],
          [approveCallData, confirmCallData],
        ],
      });
    } else {
      // Voluntary track: single confirm call via execute
      callData = encodeFunctionData({
        abi: LIGHT_ACCOUNT_ABI,
        functionName: 'execute',
        args: [pledgeLedgerAddress, 0n, confirmCallData],
      });
    }

    return this._submitSponsoredUserOp(callerAddress, callData, 'confirmPledge');
  }

  // ── GET /pledges/:id/allowance ──────────────────────────────────────────────
  async getAllowance(authHeader: string, pledgeId: string) {
    this._extractAddress(authHeader);
    const pledge = await this._getPledgeOr404(pledgeId);

    const settlementRouterAddress = this.config.getOrThrow<string>('SETTLEMENT_ROUTER_ADDRESS') as `0x${string}`;

    const currentAllowance = await this.publicClient.readContract({
      address: getAddress(pledge.token),
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [getAddress(pledge.debtorAddress), settlementRouterAddress],
    }) as bigint;

    const requiredAllowance = pledge.track === 'Enforced' ? BigInt(pledge.amount) : 0n;
    const isSufficient = currentAllowance >= requiredAllowance;

    return {
      pledgeId: pledge.pledgeId,
      currentAllowance: currentAllowance.toString(),
      requiredAllowance: requiredAllowance.toString(),
      current: currentAllowance.toString(),
      required: requiredAllowance.toString(),
      isSufficient,
    };
  }

  // ── DELETE /pledges/:id ─────────────────────────────────────────────────────
  async cancelPledge(authHeader: string, pledgeId: string) {
    const callerAddress = this._extractAddress(authHeader);
    const pledge = await this._getPledgeOr404(pledgeId);

    if (callerAddress.toLowerCase() !== pledge.lenderAddress.toLowerCase()) {
      throw new ForbiddenException('Unauthorized: caller is not the lender');
    }
    if (pledge.status !== 'Pending') {
      throw new BadRequestException('InvalidStatus');
    }

    const callData = encodeFunctionData({
      abi: PLEDGE_LEDGER_ABI,
      functionName: 'cancelPledge',
      args: [BigInt(pledgeId)],
    });

    return this._submitSponsoredUserOp(callerAddress, callData, 'cancelPledge');
  }

  // ── POST /pledges/:id/claim-paid ────────────────────────────────────────────
  async markPaidOffChain(authHeader: string, pledgeId: string) {
    const callerAddress = this._extractAddress(authHeader);
    const pledge = await this._getPledgeOr404(pledgeId);

    if (callerAddress.toLowerCase() !== pledge.debtorAddress.toLowerCase()) {
      throw new ForbiddenException('Unauthorized: caller is not the debtor');
    }
    if (pledge.status !== 'Active') {
      throw new BadRequestException('InvalidStatus');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // 30 days cooldown (2592000 seconds)
    if (pledge.lastClaimAt && nowSec < pledge.lastClaimAt + 2592000) {
      throw new BadRequestException('ClaimCooldownNotElapsed');
    }

    const callData = encodeFunctionData({
      abi: PLEDGE_LEDGER_ABI,
      functionName: 'markPaidOffChain',
      args: [BigInt(pledgeId)],
    });

    return this._submitSponsoredUserOp(callerAddress, callData, 'markPaidOffChain');
  }

  // ── Internal Helpers ────────────────────────────────────────────────────────

  private _extractAddress(authHeader: string): string {
    const token = authHeader?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing auth token');
    try {
      const payload = jwt.verify(token, this.config.getOrThrow<string>('JWT_SECRET')) as any;
      const addr = payload.smartAccountAddress;
      if (!addr) throw new Error('no smartAccountAddress in token');
      return getAddress(addr);
    } catch {
      throw new ForbiddenException('Invalid or expired token');
    }
  }

  private async _getPledgeOr404(pledgeId: string) {
    const pledge = await this.prisma.pledgeMirror.findUnique({
      where: { pledgeId },
    });
    if (!pledge) {
      throw new NotFoundException(`Pledge ${pledgeId} not found`);
    }
    return pledge;
  }

  private async _submitSponsoredUserOp(senderAddress: string, callData: `0x${string}`, operationName: string) {
    const paymasterAddress = this.config.getOrThrow<string>('PAYMASTER_ADDRESS') as `0x${string}`;
    const nowSec = Math.floor(Date.now() / 1000);

    const nonce = await this.publicClient.readContract({
      address: ENTRY_POINT,
      abi: [{ name: 'getNonce', type: 'function', stateMutability: 'view', inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'uint192' }], outputs: [{ name: 'nonce', type: 'uint256' }] }],
      functionName: 'getNonce',
      args: [senderAddress as `0x${string}`, 0n],
    });

    const validUntil = BigInt(nowSec + 900); // 15 minutes
    const validAfter = 0n;
    const paymasterAndData = await signPaymasterData({
      sponsorAccount: this.sponsorAccount,
      paymasterAddress,
      sender: senderAddress as `0x${string}`,
      nonce,
      callData,
      validUntil,
      validAfter,
    });

    const userOp = {
      sender: senderAddress,
      nonce: toHex(nonce),
      initCode: '0x',
      callData,
      callGasLimit: toHex(200000n),
      verificationGasLimit: toHex(150000n),
      preVerificationGas: toHex(50000n),
      maxFeePerGas: toHex(1000000000n),         // 1 gwei
      maxPriorityFeePerGas: toHex(100000000n),  // 0.1 gwei
      paymasterAndData,
      signature: '0x',
    };

    let userOpHash: string;
    try {
      userOpHash = await this.bundlerClient.request({
        method: 'eth_sendUserOperation' as any,
        params: [userOp, ENTRY_POINT] as any,
      }) as string;
    } catch (err: any) {
      this.logger.error(`Bundler rejected UserOp: ${err?.message}`);
      throw new BadRequestException(`BundlerRejected: ${err?.message}`);
    }

    await this.prisma.userOpTracking.create({
      data: {
        userOpHash,
        sender: senderAddress,
        operation: operationName,
        status: 'pending',
      },
    });

    await this.trackerQueue.add(
      'pollReceipt',
      { userOpHash, operation: operationName },
      {
        attempts: 20,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    this.logger.log(`${operationName} UserOp submitted: ${userOpHash}`);
    return { userOpHash, status: 'pending' };
  }
}
