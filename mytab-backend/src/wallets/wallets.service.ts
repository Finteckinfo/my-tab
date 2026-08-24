import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PUBLIC_CLIENT } from '../chain/chain.module';
import { getAddress } from 'viem';
import type { PublicClient } from 'viem';

@Injectable()
export class WalletsService {
  private readonly prisma = new PrismaClient();

  constructor(
    @Inject(PUBLIC_CLIENT) private readonly publicClient: PublicClient
  ) {}

  async getWalletByUsername(username: string) {
    // Look up the user first
    const user = await this.prisma.user.findUnique({
      where: { username }
    });

    if (!user) {
      return null;
    }

    // Now find the WalletRecord
    const walletRecord = await this.prisma.walletRecord.findUnique({
      where: { address: user.smartAccountAddress }
    });

    if (!walletRecord) {
      return null;
    }

    // Fallback chain verification if it still says counterfactual
    if (walletRecord.deploymentStatus === 'counterfactual') {
      try {
        const bytecode = await this.publicClient.getBytecode({ 
          address: getAddress(walletRecord.address) 
        });

        // If there's bytecode, the account is actually deployed!
        if (bytecode && bytecode !== '0x') {
          const updated = await this.prisma.walletRecord.update({
            where: { id: walletRecord.id },
            data: { deploymentStatus: 'deployed' }
          });
          return {
            ...updated,
            ownerSigner: user.signerAddress,
          };
        }
      } catch (err) {
        // If the RPC call fails, we just ignore it and return the database state
      }
    }

    return {
      ...walletRecord,
      ownerSigner: user.signerAddress,
    };
  }
}
