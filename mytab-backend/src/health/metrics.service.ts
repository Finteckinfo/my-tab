import { Injectable } from '@nestjs/common';

export interface AutomationJobStats {
  intervalMs: number;
  runs: number;
  successes: number;
  failures: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

@Injectable()
export class MetricsService {
  private reconciliationMismatches = 0;
  private indexerErrors = 0;
  private eventsProcessed = 0;
  private userOpsTotal = 0;
  private userOpsFailed = 0;
  private startTime: number;
  
  private indexerStatus = {
    head: 0,
    lastIndexedBlock: 0,
    lag: 0,
  };

  private automationJobs: Record<string, AutomationJobStats>;

  constructor() {
    const now = Date.now();
    this.startTime = now;
    this.automationJobs = {
      'auto-clear': {
        intervalMs: 60 * 60 * 1000, // 1 hour
        runs: 0,
        successes: 0,
        failures: 0,
        lastRunAt: null,
        lastSuccessAt: now,
        lastError: null,
      },
      'direct-debit': {
        intervalMs: 15 * 60 * 1000, // 15 minutes
        runs: 0,
        successes: 0,
        failures: 0,
        lastRunAt: null,
        lastSuccessAt: now,
        lastError: null,
      },
      'notifications': {
        intervalMs: 60 * 60 * 1000, // 1 hour
        runs: 0,
        successes: 0,
        failures: 0,
        lastRunAt: null,
        lastSuccessAt: now,
        lastError: null,
      },
    };
  }

  setStartTime(time: number) {
    this.startTime = time;
    for (const job of Object.values(this.automationJobs)) {
      job.lastSuccessAt = time;
    }
  }

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

  recordUserOpAttempt(failed: boolean) {
    this.userOpsTotal++;
    if (failed) this.userOpsFailed++;
  }

  recordJobRun(jobName: string) {
    if (!this.automationJobs[jobName]) {
      this.automationJobs[jobName] = {
        intervalMs: 60 * 60 * 1000,
        runs: 0,
        successes: 0,
        failures: 0,
        lastRunAt: null,
        lastSuccessAt: Date.now(),
        lastError: null,
      };
    }
    this.automationJobs[jobName].runs++;
    this.automationJobs[jobName].lastRunAt = Date.now();
  }

  recordJobSuccess(jobName: string) {
    if (this.automationJobs[jobName]) {
      this.automationJobs[jobName].successes++;
      this.automationJobs[jobName].lastSuccessAt = Date.now();
      this.automationJobs[jobName].lastError = null;
    }
  }

  recordJobFailure(jobName: string, error?: any) {
    if (this.automationJobs[jobName]) {
      this.automationJobs[jobName].failures++;
      this.automationJobs[jobName].lastError = error?.message || String(error);
    }
  }

  checkAutomationHealth(now: number = Date.now()): { healthy: boolean; alerts: string[]; jobs: Record<string, AutomationJobStats> } {
    const alerts: string[] = [];

    for (const [jobName, stats] of Object.entries(this.automationJobs)) {
      const maxAllowedSilenceMs = 3 * stats.intervalMs;
      const lastSuccess = stats.lastSuccessAt ?? this.startTime;
      const silenceMs = now - lastSuccess;

      if (silenceMs > maxAllowedSilenceMs) {
        alerts.push(
          `Job [${jobName}] has not completed successfully in ${Math.round(silenceMs / 1000)}s (exceeds 3x interval of ${Math.round(maxAllowedSilenceMs / 1000)}s). Potential dead job breaking neutrality guarantee.`
        );
      }
    }

    return {
      healthy: alerts.length === 0,
      alerts,
      jobs: this.automationJobs,
    };
  }

  getMetrics() {
    const uptimeMinutes = Math.max((Date.now() - this.startTime) / 60000, 1);
    const eventsPerMinute = this.eventsProcessed / uptimeMinutes;
    const userOpFailureRate = this.userOpsTotal > 0 ? this.userOpsFailed / this.userOpsTotal : 0;

    return {
      reconciliationMismatches: this.reconciliationMismatches,
      indexerErrors: this.indexerErrors,
      eventsProcessedTotal: this.eventsProcessed,
      eventsProcessedPerMinute: eventsPerMinute.toFixed(2),
      userOpsTotal: this.userOpsTotal,
      userOpsFailed: this.userOpsFailed,
      userOpFailureRate: userOpFailureRate.toFixed(4),
      uptimeMinutes: uptimeMinutes.toFixed(2),
      automation: this.automationJobs,
    };
  }

  getIndexerStatus() {
    return this.indexerStatus;
  }
}

