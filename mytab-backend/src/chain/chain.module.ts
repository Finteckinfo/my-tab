import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

export const PUBLIC_CLIENT = 'PUBLIC_CLIENT';
export const WALLET_CLIENT = 'WALLET_CLIENT';
export const BUNDLER_CLIENT = 'BUNDLER_CLIENT';
/** Account used ONLY for signing paymaster approvals. Never used for submitting txs. */
export const SPONSOR_ACCOUNT = 'SPONSOR_ACCOUNT';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PUBLIC_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return createPublicClient({
          chain: baseSepolia,
          transport: http(config.get('RPC_URL')),
        });
      },
    },
    {
      provide: WALLET_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pk = config.get<string>('RELAYER_PRIVATE_KEY');
        const account = privateKeyToAccount(pk as `0x${string}`);
        return createWalletClient({
          account,
          chain: baseSepolia,
          transport: http(config.get('RPC_URL')),
        });
      },
    },
    {
      provide: BUNDLER_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pimlicoKey = config.getOrThrow<string>('PIMLICO_API_KEY');
        const bundlerUrl = `https://api.pimlico.io/v2/84532/rpc?apikey=${pimlicoKey}`;
        return createPublicClient({
          chain: baseSepolia,
          transport: http(bundlerUrl),
        });
      },
    },
    {
      // Strictly isolated: only SPONSOR_SIGNER_PRIVATE_KEY. Never reads RELAYER_PRIVATE_KEY.
      provide: SPONSOR_ACCOUNT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pk = config.getOrThrow<string>('SPONSOR_SIGNER_PRIVATE_KEY');
        return privateKeyToAccount(pk as `0x${string}`);
      },
    },
  ],
  exports: [PUBLIC_CLIENT, WALLET_CLIENT, BUNDLER_CLIENT, SPONSOR_ACCOUNT],
})
export class ChainModule {}
