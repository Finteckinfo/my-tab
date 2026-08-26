/**
 * Fiat Bridge Types — Week 5
 *
 * M-Pesa Daraja API types for sandbox-only STK Push (C2B) and B2C payouts.
 * No phone number is ever persisted. Phone is provided at request time,
 * verified via OTP, passed to the provider, and discarded.
 */

// ── Request types ────────────────────────────────────────────────────────────

export interface OnrampRequest {
  /** Amount in KES (integer, smallest unit handled by provider) */
  amount: number;
  /** Phone number provided at request time, not stored */
  phone: string;
  /** Pledge ID to credit stablecoin against (optional) */
  pledgeId?: string;
}

export interface OfframpRequest {
  /** Amount in KES */
  amount: number;
  /** Phone number provided at request time, verified via OTP */
  phone: string;
  /** OTP from the phone verification step */
  otp: string;
}

// ── M-Pesa Daraja webhook payloads ───────────────────────────────────────────

export interface StkPushCallback {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{
          Name: string;
          Value?: string | number;
        }>;
      };
    };
  };
}

export interface B2CResultCallback {
  Result: {
    ResultType: number;
    ResultCode: number;
    ResultDesc: string;
    OriginatorConversationID: string;
    ConversationID: string;
    TransactionID: string;
    ResultParameters?: {
      ResultParameter: Array<{
        Key: string;
        Value: string | number;
      }>;
    };
  };
}

// ── Internal types ───────────────────────────────────────────────────────────

export type TransactionType = 'onramp' | 'offramp';
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'reversed';
export type LockStatus = 'locked' | 'released' | 'restored';

export interface ReconciliationResult {
  totalExpected: number;
  totalActual: number;
  mismatches: ReconciliationMismatch[];
  ranAt: Date;
}

export interface ReconciliationMismatch {
  transactionId: string;
  providerTxId: string | null;
  expectedStatus: string;
  actualStatus: string;
  amount: string;
}
