import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from './logger/logger.module';
import { ChainModule } from './chain/chain.module';
import { HealthModule } from './health/health.module';
import { BullModule } from '@nestjs/bullmq';
import { RelayerModule } from './relayer/relayer.module';
import { IdentityModule } from './identity/identity.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { WalletsModule } from './wallets/wallets.module';
import { LedgerModule } from './ledger/ledger.module';
import { ScheduleModule } from '@nestjs/schedule';
import { IndexerModule } from './indexer/indexer.module';
import { ReputationModule } from './reputation/reputation.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    ChainModule,
    HealthModule,
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 3,
    }]),
    ...(process.env.NODE_ENV === 'test' ? [] : [
      BullModule.forRootAsync({
        inject: [ConfigService],
        useFactory: (config: ConfigService) => {
          const redisUrl = new URL(config.getOrThrow<string>('REDIS_URL'));
          return {
            connection: {
              host: redisUrl.hostname,
              port: Number(redisUrl.port),
            },
          };
        },
      }),
      IndexerModule,
    ]),
    RelayerModule,
    IdentityModule,
    WalletsModule,
    LedgerModule,
    ReputationModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
