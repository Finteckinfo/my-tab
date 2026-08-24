import { Injectable, ConflictException, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RelayerService } from '../relayer/relayer.service';
import * as jwt from 'jsonwebtoken';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { PUBLIC_CLIENT } from '../chain/chain.module';
import type { PublicClient } from 'viem';
import { MY_TAB_ACCOUNT_FACTORY_ABI } from '../abis/MyTabAccountFactory.abi';

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly prisma = new PrismaClient();
  private readonly mockOtpStore = new Map<string, string>(); // In-memory for dev/test

  constructor(
    private readonly config: ConfigService,
    private readonly relayer: RelayerService,
    @Inject(PUBLIC_CLIENT) private readonly publicClient: PublicClient,
  ) {}

  async requestOtp(phone: string): Promise<void> {
    this.logger.log(`Requesting OTP for phone: ${phone}`);
    // Mocking Africa's Talking API
    const otp = process.env.NODE_ENV === 'test' ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
    this.mockOtpStore.set(phone, otp);
    
    // In reality we would call AT API here
    this.logger.log(`Mock sent OTP ${otp} to phone ${phone}`);
  }

  async verifyOtp(phone: string, otp: string): Promise<string> {
    const stored = this.mockOtpStore.get(phone);
    if (!stored || stored !== otp) {
      throw new UnauthorizedException('Invalid OTP');
    }
    
    this.mockOtpStore.delete(phone);
    
    const token = jwt.sign({ phone }, this.config.getOrThrow<string>('JWT_SECRET'), {
      expiresIn: '15m',
    });
    
    return token;
  }

  async register(token: string, username: string, clientHash: string, signerAddress: string) {
    try {
      jwt.verify(token, this.config.getOrThrow<string>('JWT_SECRET'));
    } catch (e) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const pepper = this.config.get<string>('PROTOCOL_PEPPER');
    
    // Double hashing: Argon2id hash of the client hash + pepper
    // Using simple concatenation for the pepper
    const serverHash = await argon2.hash(clientHash + pepper, { type: argon2.argon2id });
    
    const factoryAddress = this.config.getOrThrow<string>('FACTORY_ADDRESS') as `0x${string}`;
    const smartAccountAddress = await this.publicClient.readContract({
      address: factoryAddress,
      abi: MY_TAB_ACCOUNT_FACTORY_ABI,
      functionName: 'getAddress',
      args: [signerAddress as `0x${string}`, 0n]
    }) as string;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            username,
            smartAccountAddress,
            signerAddress,
            onboardingStatus: 'registered',
          }
        });

        await tx.phoneHashAudit.create({
          data: {
            hashReference: serverHash,
          }
        });
        
        await tx.walletRecord.create({
          data: {
            address: smartAccountAddress,
            deploymentStatus: 'counterfactual',
            chain: 'baseSepolia'
          }
        });
      });
      
      // Enqueue job to Relayer
      await this.relayer.queueTransaction({
        type: 'registerIdentity',
        address: smartAccountAddress,
        usernameHash: username, // Actually keccak256
        phoneHash: serverHash
      });

      return { status: 'counterfactual', smartAccountAddress };
    } catch (e: any) {
      if (e.code === 'P2002') {
        const target = e.meta?.target as string[];
        if (target && target.includes('username')) {
          throw new ConflictException('UsernameAlreadyRegistered');
        } else {
          throw new ConflictException('PhoneAlreadyRegistered');
        }
      }
      throw e;
    }
  }

  async migrate(token: string, signature: string, newOwner: string) {
    // Enqueue migration job
    await this.relayer.queueTransaction({
      type: 'migrate',
      signature,
      newOwner,
    });
    return { success: true };
  }
}
