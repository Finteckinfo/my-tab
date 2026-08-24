import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class RelayerService {
  private readonly logger = new Logger(RelayerService.name);

  constructor(@InjectQueue('relayer') private readonly relayerQueue: Queue) {}

  async queueTransaction(data: any) {
    this.logger.log('Queueing transaction to relayer');
    await this.relayerQueue.add('processTransaction', data);
  }
}
