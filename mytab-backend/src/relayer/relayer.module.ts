import { Module } from '@nestjs/common';
import { RelayerService } from './relayer.service';
import { BullModule } from '@nestjs/bullmq';
import { RelayerProcessor } from './relayer.processor';

const isTest = process.env.NODE_ENV === 'test';

@Module({
  imports: [
    ...(isTest ? [] : [BullModule.registerQueue({ name: 'relayer' })]),
  ],
  providers: [
    isTest ? { provide: RelayerService, useValue: { queueTransaction: async () => {} } } : RelayerService,
    ...(isTest ? [] : [RelayerProcessor]),
  ],
  exports: [RelayerService],
})
export class RelayerModule {}
