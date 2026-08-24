import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private reconciliationMismatches = 0;
  private indexerErrors = 0;
  private eventsProcessed = 0;
  private startTime = Date.now();
  
  private indexerStatus = {
    head: 0,
    lastIndexedBlock: 0,
    lag: 0,
  };

  updateIndexerStatus(head: number, lastIndexedBlock: number) {
    this.indexerStatus = {
      head,
      lastIndexedBlock,
      lag: head - lastIndexedBlock,
    };
  }

  incrementReconciliationMismatches() {
    this.reconciliationMismatches++;
  }

  incrementIndexerErrors() {
    this.indexerErrors++;
  }

  incrementEventsProcessed(count: number = 1) {
    this.eventsProcessed += count;
  }

  getMetrics() {
    const uptimeMinutes = Math.max((Date.now() - this.startTime) / 60000, 1);
    const eventsPerMinute = this.eventsProcessed / uptimeMinutes;

    return {
      reconciliationMismatches: this.reconciliationMismatches,
      indexerErrors: this.indexerErrors,
      eventsProcessedTotal: this.eventsProcessed,
      eventsProcessedPerMinute: eventsPerMinute.toFixed(2),
      uptimeMinutes: uptimeMinutes.toFixed(2),
    };
  }

  getIndexerStatus() {
    return this.indexerStatus;
  }
}
