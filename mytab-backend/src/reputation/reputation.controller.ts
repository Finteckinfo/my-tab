import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { ReputationService } from './reputation.service';

@Controller('reputation')
export class ReputationController {
  constructor(private readonly reputationService: ReputationService) {}

  @Get(':username')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 3600 } }) // 20 requests per hour
  async getReputation(@Param('username') username: string) {
    return this.reputationService.getReputation(username);
  }
}
