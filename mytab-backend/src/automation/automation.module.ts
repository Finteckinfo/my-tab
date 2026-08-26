import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AutomationService } from './automation.service';
import { AutomationProcessor } from './automation.processor';
import { AutomationScheduler } from './automation.scheduler';
import { ChainModule } from '../chain/chain.module';
import { HealthModule } from '../health/health.module';

const isTest = process.env.NODE_ENV === 'test';

@Module({
  imports: [
    ChainModule,
    HealthModule,
    ...(isTest ? [] : [BullModule.registerQueue({ name: 'automation' })]),
  ],
  providers: [
    AutomationService,
    ...(isTest ? [] : [AutomationProcessor, AutomationScheduler]),
  ],
  exports: [AutomationService],
})
export class AutomationModule {}
