import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { FiatService } from './fiat.service';
import { FiatEnabledGuard } from './fiat.guard';
import { OnrampRequest, OfframpRequest, StkPushCallback, B2CResultCallback } from './fiat.types';

/**
 * FiatController — all endpoints guarded by FiatEnabledGuard.
 *
 * Webhook endpoints are NOT auth-guarded (they come from the provider),
 * but are idempotent and should be signature-verified in production.
 *
 * Client-facing endpoints require the authenticated user session.
 */
@Controller('fiat')
export class FiatController {
  private readonly logger = new Logger(FiatController.name);

  constructor(private readonly fiatService: FiatService) {}

  /**
   * POST /fiat/onramp — initiate STK Push.
   * Requires authenticated session. Phone provided in body.
   */
  @Post('onramp')
  @UseGuards(FiatEnabledGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async initiateOnramp(
    @Body() body: OnrampRequest,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Authentication required', HttpStatus.UNAUTHORIZED);
    }

    if (!body.phone || !body.amount || body.amount <= 0) {
      throw new HttpException(
        { message: 'Invalid request: phone and amount are required', code: 'INVALID_ONRAMP_REQUEST' },
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.fiatService.initiateOnramp(userId, body);
  }

  /**
   * POST /fiat/offramp — initiate B2C payout.
   * Requires { phone, otp } — phone re-verified via OTP at request time.
   * No phone column exists anywhere in the database.
   */
  @Post('offramp')
  @UseGuards(FiatEnabledGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async initiateOfframp(
    @Body() body: OfframpRequest,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new HttpException('Authentication required', HttpStatus.UNAUTHORIZED);
    }

    if (!body.phone || !body.otp || !body.amount || body.amount <= 0) {
      throw new HttpException(
        { message: 'phone, otp, and amount are required', code: 'INVALID_OFFRAMP_REQUEST' },
        HttpStatus.BAD_REQUEST,
      );
    }

    // OTP verification would be done here via the identity/OTP service.
    // For sandbox, we accept any OTP.
    // In production: await this.otpService.verify(body.phone, body.otp);
    this.logger.debug(`OTP verification for offramp (sandbox: accepting any OTP)`);

    return this.fiatService.initiateOfframp(userId, body);
  }

  /**
   * POST /fiat/webhook/onramp — M-Pesa STK Push callback.
   * Not auth-guarded. Idempotent on CheckoutRequestID.
   */
  @Post('webhook/onramp')
  @UseGuards(FiatEnabledGuard)
  @HttpCode(HttpStatus.OK)
  async onrampWebhook(@Body() body: StkPushCallback) {
    this.logger.debug('Received onramp webhook');
    await this.fiatService.handleOnrampWebhook(body);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  /**
   * POST /fiat/webhook/offramp — M-Pesa B2C result callback.
   * Not auth-guarded. Idempotent on ConversationID.
   */
  @Post('webhook/offramp')
  @UseGuards(FiatEnabledGuard)
  @HttpCode(HttpStatus.OK)
  async offrampWebhook(@Body() body: B2CResultCallback) {
    this.logger.debug('Received offramp webhook');
    await this.fiatService.handleOfframpWebhook(body);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
