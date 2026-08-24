import { Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { ChainModule } from '../chain/chain.module';
import { ReputationModule } from '../reputation/reputation.module';
import { UserOpTrackerProcessor } from './jobs/userop-tracker.processor';

const isTest = process.env.NODE_ENV === 'test';

@Module({
  imports: [
    ...(isTest ? [] : [BullModule.registerQueue({ name: 'userop-tracker' })]),
    ChainModule,
    ReputationModule,
  ],
  controllers: [LedgerController],
  providers: [
    LedgerService,
    ...(isTest ? [{ provide: getQueueToken('userop-tracker'), useValue: { add: async () => {} } }] : [UserOpTrackerProcessor]),
  ],
  exports: [LedgerService],
})
export class LedgerModule {}
