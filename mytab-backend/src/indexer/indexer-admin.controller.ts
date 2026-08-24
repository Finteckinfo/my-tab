import { Controller, Post, Body, HttpCode, HttpStatus, UnauthorizedException, Headers } from '@nestjs/common';
import { IndexerService } from './indexer.service';
import { ConfigService } from '@nestjs/config';

@Controller('admin/indexer')
export class IndexerAdminController {
  constructor(
    private readonly indexerService: IndexerService,
    private readonly configService: ConfigService,
  ) {}

  @Post('backfill')
  @HttpCode(HttpStatus.ACCEPTED)
  async backfill(
    @Body('fromBlock') fromBlock: number,
    @Body('toBlock') toBlock: number,
    @Headers('authorization') authHeader: string,
  ) {
    const adminKey = this.configService.get('ADMIN_API_KEY');
    if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
      throw new UnauthorizedException('Invalid or missing admin API key');
    }

    if (!fromBlock || !toBlock || fromBlock > toBlock) {
      return { error: 'Invalid block range' };
    }

    // Fire and forget because it might take a while
    this.indexerService.backfill(fromBlock, toBlock).catch((err) => {
      console.error('Backfill failed:', err);
    });

    return { message: `Backfill queued from block ${fromBlock} to ${toBlock}` };
  }
}
