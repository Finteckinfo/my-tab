import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class AutomationScheduler implements OnModuleInit {
  private readonly logger = new Logger(AutomationScheduler.name);

  constructor(@InjectQueue('automation') private readonly automationQueue: Queue) {}

  async onModuleInit() {
    this.logger.log('Registering repeatable automation jobs with BullMQ');

    try {
      // Auto-clear sweep: hourly (every 3600000ms)
      await this.automationQueue.add(
        'auto-clear',
        {},
        {
          repeat: { every: 3600000 },
          jobId: 'auto-clear-repeat',
        },
      );

      // Direct debit keeper: every 15 minutes (every 900000ms)
      await this.automationQueue.add(
        'direct-debit',
        {},
        {
          repeat: { every: 900000 },
          jobId: 'direct-debit-repeat',
        },
      );

      // Notifications: hourly (every 3600000ms)
      await this.automationQueue.add(
        'notifications',
        {},
        {
          repeat: { every: 3600000 },
          jobId: 'notifications-repeat',
        },
      );

      this.logger.log('Repeatable automation jobs successfully scheduled in BullMQ');
    } catch (err: any) {
      this.logger.error('Failed to schedule automation jobs in BullMQ', err.stack);
    }
  }
}
