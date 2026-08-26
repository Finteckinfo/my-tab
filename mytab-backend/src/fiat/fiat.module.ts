import { Module } from '@nestjs/common';
import { FiatController } from './fiat.controller';
import { FiatService } from './fiat.service';
import { FiatEnabledGuard } from './fiat.guard';

/**
 * FiatModule — M-Pesa Daraja sandbox integration.
 *
 * The module is always registered but every endpoint is gated by FiatEnabledGuard,
 * which returns 503 unless FIAT_ENABLED=true. This means the code path is
 * completely unreachable without the explicit config flag.
 */
@Module({
  controllers: [FiatController],
  providers: [FiatService, FiatEnabledGuard],
  exports: [FiatService],
})
export class FiatModule {}
