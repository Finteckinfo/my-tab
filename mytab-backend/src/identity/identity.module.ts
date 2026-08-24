import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { RelayerModule } from '../relayer/relayer.module';
import { ChainModule } from '../chain/chain.module';

@Module({
  imports: [RelayerModule, ChainModule],
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
