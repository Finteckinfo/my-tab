import { Module } from '@nestjs/common';
import { IndexerService } from './indexer.service';
import { ChainModule } from '../chain/chain.module';
import { HealthModule } from '../health/health.module';
import { IndexerAdminController } from './indexer-admin.controller';

@Module({
  imports: [ChainModule, HealthModule],
  controllers: [IndexerAdminController],
  providers: [IndexerService],
})
export class IndexerModule {}
