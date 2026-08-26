import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { AutomationService } from './automation.service';

@Processor('automation')
export class AutomationProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationProcessor.name);

  constructor(private readonly automationService: AutomationService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing automation job: ${job.name} (id: ${job.id})`);

    switch (job.name) {
      case 'auto-clear':
        return this.automationService.runAutoClearSweep();
      case 'direct-debit':
        return this.automationService.runDirectDebitKeeper();
      case 'notifications':
        return this.automationService.runNotificationTriggers();
      default:
        this.logger.warn(`Unknown automation job name: ${job.name}`);
        return { unhandled: true };
    }
  }
}
