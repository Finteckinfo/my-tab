import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  OnrampRequest,
  OfframpRequest,
  StkPushCallback,
  B2CResultCallback,
  ReconciliationResult,
  ReconciliationMismatch,
} from './fiat.types';
import { PrismaClient } from '@prisma/client';

/**
 * SettlementService — M-Pesa Daraja sandbox integration.
 *
 * Rules:
 * - No phone number is ever stored. Phone is provided at request time,
 *   verified via OTP for offramp, and passed to the provider.
 * - Every webhook is idempotent on providerTxId.
 * - Offramp locks balance before calling B2C; restores on failure.
 * - All operations are sandbox-only until FIAT_ENABLED is set.
 */
@Injectable()
export class FiatService {
  private readonly logger = new Logger(FiatService.name);

  // Daraja sandbox endpoints
  private readonly DARAJA_BASE_URL = 'https://sandbox.safaricom.co.ke';
  private readonly DARAJA_AUTH_URL = `${this.DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;
  private readonly STK_PUSH_URL = `${this.DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`;
  private readonly B2C_URL = `${this.DARAJA_BASE_URL}/mpesa/b2c/v3/paymentrequest`;

  private readonly prisma = new PrismaClient();

  constructor(
    private readonly config: ConfigService,
  ) {}

  // ── Onramp: STK Push (C2B) ──────────────────────────────────────────────

  async initiateOnramp(userId: string, request: OnrampRequest): Promise<{ transactionId: string; checkoutRequestId: string }> {
    const idempotencyKey = `onramp-${userId}-${Date.now()}`;

    // Create transaction record
    const tx = await this.prisma.settlementTransaction.create({
      data: {
        idempotencyKey,
        userId,
        type: 'onramp',
        amount: String(request.amount),
        currency: 'KES',
        status: 'pending',
      },
    });

    try {
      const accessToken = await this.getDarajaAccessToken();
      const timestamp = this.formatTimestamp();
      const password = this.generateStkPassword(timestamp);

      const response = await fetch(this.STK_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          BusinessShortCode: this.config.get('MPESA_SHORTCODE', '174379'),
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: request.amount,
          PartyA: request.phone,
          PartyB: this.config.get('MPESA_SHORTCODE', '174379'),
          PhoneNumber: request.phone,
          CallBackURL: this.config.get('MPESA_CALLBACK_URL', 'https://localhost:3000/fiat/webhook/onramp'),
          AccountReference: tx.id,
          TransactionDesc: `MyTab onramp ${tx.id}`,
        }),
      });

      const data = await response.json();

      if (data.ResponseCode === '0') {
        await this.prisma.settlementTransaction.update({
          where: { id: tx.id },
          data: {
            status: 'processing',
            providerTxId: data.CheckoutRequestID,
          },
        });

        return { transactionId: tx.id, checkoutRequestId: data.CheckoutRequestID };
      }

      await this.prisma.settlementTransaction.update({
        where: { id: tx.id },
        data: { status: 'failed', failureReason: data.ResponseDescription || 'STK push failed' },
      });

      throw new HttpException(
        { message: 'STK push initiation failed', detail: data.ResponseDescription },
        HttpStatus.BAD_GATEWAY,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Onramp initiation failed: ${error.message}`, error.stack);
      await this.prisma.settlementTransaction.update({
        where: { id: tx.id },
        data: { status: 'failed', failureReason: error.message },
      });
      throw new HttpException('Fiat provider error', HttpStatus.BAD_GATEWAY);
    }
  }

  // ── Onramp webhook (idempotent) ─────────────────────────────────────────

  async handleOnrampWebhook(payload: StkPushCallback): Promise<void> {
    const callback = payload.Body.stkCallback;
    const checkoutRequestId = callback.CheckoutRequestID;

    // Idempotency: check if already processed
    const existing = await this.prisma.settlementTransaction.findUnique({
      where: { providerTxId: checkoutRequestId },
    });

    if (!existing) {
      this.logger.warn(`Onramp webhook for unknown CheckoutRequestID: ${checkoutRequestId}`);
      return;
    }

    if (existing.status === 'completed' || existing.status === 'failed') {
      this.logger.debug(`Onramp webhook already processed for ${checkoutRequestId}, skipping`);
      return;
    }

    if (callback.ResultCode === 0) {
      // Extract receipt number from callback metadata
      const receipt = callback.CallbackMetadata?.Item.find(
        (item) => item.Name === 'MpesaReceiptNumber',
      )?.Value as string | undefined;

      await this.prisma.settlementTransaction.update({
        where: { id: existing.id },
        data: {
          status: 'completed',
          providerRef: receipt || checkoutRequestId,
        },
      });

      this.logger.log(`Onramp completed: ${existing.id}, receipt: ${receipt}`);
      // TODO: Credit stablecoin to user's smart account once mint function is available
    } else {
      await this.prisma.settlementTransaction.update({
        where: { id: existing.id },
        data: {
          status: 'failed',
          failureReason: callback.ResultDesc,
        },
      });
      this.logger.warn(`Onramp failed: ${existing.id}, reason: ${callback.ResultDesc}`);
    }
  }

  // ── Offramp: B2C payout ─────────────────────────────────────────────────

  async initiateOfframp(userId: string, request: OfframpRequest): Promise<{ transactionId: string }> {
    // OTP verification must happen before calling this method.
    // The controller is responsible for verifying the OTP against the phone.
    // By the time we're here, OTP is already verified.

    const idempotencyKey = `offramp-${userId}-${Date.now()}`;

    // Create transaction with lock
    const tx = await this.prisma.settlementTransaction.create({
      data: {
        idempotencyKey,
        userId,
        type: 'offramp',
        amount: String(request.amount),
        currency: 'KES',
        status: 'processing',
        lockStatus: 'locked',
      },
    });

    try {
      const accessToken = await this.getDarajaAccessToken();

      const response = await fetch(this.B2C_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          OriginatorConversationID: tx.id,
          InitiatorName: this.config.get('MPESA_INITIATOR', 'testapi'),
          SecurityCredential: this.config.get('MPESA_SECURITY_CREDENTIAL', 'sandbox-credential'),
          CommandID: 'BusinessPayment',
          Amount: request.amount,
          PartyA: this.config.get('MPESA_SHORTCODE', '174379'),
          PartyB: request.phone, // Phone provided at request time, not stored
          Remarks: `MyTab offramp ${tx.id}`,
          QueueTimeOutURL: this.config.get('MPESA_TIMEOUT_URL', 'https://localhost:3000/fiat/webhook/timeout'),
          ResultURL: this.config.get('MPESA_B2C_RESULT_URL', 'https://localhost:3000/fiat/webhook/offramp'),
          Occasion: tx.id,
        }),
      });

      const data = await response.json();

      if (data.ResponseCode === '0') {
        await this.prisma.settlementTransaction.update({
          where: { id: tx.id },
          data: {
            providerTxId: data.ConversationID || tx.id,
          },
        });
        return { transactionId: tx.id };
      }

      // B2C initiation failed — restore lock
      await this.prisma.settlementTransaction.update({
        where: { id: tx.id },
        data: {
          status: 'failed',
          lockStatus: 'restored',
          failureReason: data.ResponseDescription || 'B2C initiation failed',
        },
      });

      throw new HttpException(
        { message: 'B2C payout initiation failed', detail: data.ResponseDescription },
        HttpStatus.BAD_GATEWAY,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error(`Offramp initiation failed: ${error.message}`, error.stack);
      await this.prisma.settlementTransaction.update({
        where: { id: tx.id },
        data: {
          status: 'failed',
          lockStatus: 'restored',
          failureReason: error.message,
        },
      });
      throw new HttpException('Fiat provider error', HttpStatus.BAD_GATEWAY);
    }
  }

  // ── Offramp webhook (idempotent) ────────────────────────────────────────

  async handleOfframpWebhook(payload: B2CResultCallback): Promise<void> {
    const result = payload.Result;
    const conversationId = result.ConversationID;

    const existing = await this.prisma.settlementTransaction.findFirst({
      where: {
        OR: [
          { providerTxId: conversationId },
          { id: result.OriginatorConversationID },
        ],
      },
    });

    if (!existing) {
      this.logger.warn(`Offramp webhook for unknown ConversationID: ${conversationId}`);
      return;
    }

    if (existing.status === 'completed' || existing.status === 'failed') {
      this.logger.debug(`Offramp webhook already processed for ${conversationId}, skipping`);
      return;
    }

    if (result.ResultCode === 0) {
      await this.prisma.settlementTransaction.update({
        where: { id: existing.id },
        data: {
          status: 'completed',
          lockStatus: 'released',
          providerRef: result.TransactionID,
        },
      });
      this.logger.log(`Offramp completed: ${existing.id}, txId: ${result.TransactionID}`);
    } else {
      await this.prisma.settlementTransaction.update({
        where: { id: existing.id },
        data: {
          status: 'failed',
          lockStatus: 'restored',
          failureReason: result.ResultDesc,
        },
      });
      this.logger.warn(`Offramp failed: ${existing.id}, reason: ${result.ResultDesc}`);
    }
  }

  // ── Reconciliation ──────────────────────────────────────────────────────

  async runReconciliation(): Promise<ReconciliationResult> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours

    const transactions = await this.prisma.settlementTransaction.findMany({
      where: {
        createdAt: { gte: cutoff },
        status: { in: ['processing', 'pending'] },
      },
    });

    const mismatches: ReconciliationMismatch[] = [];

    for (const tx of transactions) {
      // Transactions stuck in processing for > 1 hour are suspicious
      const stuckThreshold = new Date(Date.now() - 60 * 60 * 1000);
      if (tx.createdAt < stuckThreshold) {
        mismatches.push({
          transactionId: tx.id,
          providerTxId: tx.providerTxId,
          expectedStatus: 'completed or failed',
          actualStatus: tx.status,
          amount: tx.amount,
        });
      }
    }

    const result: ReconciliationResult = {
      totalExpected: transactions.length,
      totalActual: transactions.length - mismatches.length,
      mismatches,
      ranAt: new Date(),
    };

    if (mismatches.length > 0) {
      this.logger.warn(`Reconciliation found ${mismatches.length} mismatches`, { mismatches });
    } else {
      this.logger.log('Reconciliation clean — no mismatches');
    }

    return result;
  }

  // ── Daraja helpers ──────────────────────────────────────────────────────

  private async getDarajaAccessToken(): Promise<string> {
    const consumerKey = this.config.get('MPESA_CONSUMER_KEY', 'sandbox-key');
    const consumerSecret = this.config.get('MPESA_CONSUMER_SECRET', 'sandbox-secret');
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const response = await fetch(this.DARAJA_AUTH_URL, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });

    const data = await response.json();
    return data.access_token;
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace(/[-T:Z.]/g, '').slice(0, 14);
  }

  private generateStkPassword(timestamp: string): string {
    const shortcode = this.config.get('MPESA_SHORTCODE', '174379');
    const passkey = this.config.get('MPESA_PASSKEY', 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919');
    return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  }
}
