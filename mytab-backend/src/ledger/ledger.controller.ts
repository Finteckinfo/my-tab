import { Controller, Get, Post, Delete, Body, Headers, HttpCode, Param } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { CreatePledgeDto } from './dto/create-pledge.dto';

@Controller('pledges')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  /** POST /pledges — submit a new pledge as a sponsored UserOp. Returns 202 pending. */
  @Post()
  @HttpCode(202)
  createPledge(
    @Headers('authorization') auth: string,
    @Body() dto: CreatePledgeDto,
  ) {
    return this.ledgerService.createPledge(auth, dto);
  }

  @Get('pending-confirmation')
  async getPendingConfirmations(@Headers('authorization') authHeader: string) {
    return this.ledgerService.getPendingConfirmations(authHeader);
  }

  @Get('timeline')
  async getTimeline(@Headers('authorization') authHeader: string) {
    return this.ledgerService.getTimeline(authHeader);
  }

  @Get('summary')
  async getSummary(@Headers('authorization') authHeader: string) {
    return this.ledgerService.getSummary(authHeader);
  }

  @Post(':id/confirm')
  @HttpCode(202)
  confirmPledge(
    @Headers('authorization') auth: string,
    @Param('id') pledgeId: string,
  ) {
    return this.ledgerService.confirmPledge(auth, pledgeId);
  }

  @Delete(':id')
  @HttpCode(202)
  cancelPledge(
    @Headers('authorization') auth: string,
    @Param('id') pledgeId: string,
  ) {
    return this.ledgerService.cancelPledge(auth, pledgeId);
  }

  @Post(':id/claim-paid')
  @HttpCode(202)
  markPaidOffChain(
    @Headers('authorization') auth: string,
    @Param('id') pledgeId: string,
  ) {
    return this.ledgerService.markPaidOffChain(auth, pledgeId);
  }
}
