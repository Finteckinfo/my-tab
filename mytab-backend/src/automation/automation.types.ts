export type NotificationIntervalType = '48h_before' | 'at_due' | `overdue_day_${number}`;

export interface NotificationPayload {
  type: 'NOTIFICATION_TRIGGERED';
  interval: NotificationIntervalType | string;
  pledgeId: string;
  debtorAddress: string;
  lenderAddress: string;
  amount: string;
  token: string;
  dueTimestamp: number;
  status: string;
  track: string;
  emittedAt: string;
}

export interface AutomationRunResult {
  job: string;
  scanned: number;
  processed: number;
  skipped: number;
  errors: number;
}
