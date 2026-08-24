import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get(':username')
  async getWallet(@Param('username') username: string) {
    const wallet = await this.walletsService.getWalletByUsername(username);
    if (!wallet) {
      throw new NotFoundException('Wallet not found for this username');
    }
    return wallet;
  }
}
