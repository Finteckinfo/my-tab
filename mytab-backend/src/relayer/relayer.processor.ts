import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

@Processor('relayer')
export class RelayerProcessor extends WorkerHost {
  private readonly logger = new Logger(RelayerProcessor.name);

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing relayer job ${job.id}`);
    
    // Simulate some work
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    this.logger.log(`Completed relayer job ${job.id}`);
    return { success: true };
  }
}
