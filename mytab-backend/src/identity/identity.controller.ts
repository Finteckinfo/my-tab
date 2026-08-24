import { Controller, Post, Body, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

@Controller('identity')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60000 } }) // 3 requests per minute per IP
  @Post('otp/request')
  async requestOtp(@Body('phone') phone: string) {
    if (!phone) {
      throw new HttpException('Phone number is required', HttpStatus.BAD_REQUEST);
    }
    await this.identityService.requestOtp(phone);
    return { success: true };
  }

  @Post('otp/verify')
  async verifyOtp(@Body('phone') phone: string, @Body('otp') otp: string) {
    if (!phone || !otp) {
      throw new HttpException('Phone and OTP are required', HttpStatus.BAD_REQUEST);
    }
    const token = await this.identityService.verifyOtp(phone, otp);
    return { success: true, token };
  }

  @Post('register')
  async register(
    @Body('token') token: string,
    @Body('username') username: string,
    @Body('clientHash') clientHash: string,
    @Body('signerAddress') signerAddress: string
  ) {
    if (!token || !username || !clientHash || !signerAddress) {
      throw new HttpException('Missing registration payload', HttpStatus.BAD_REQUEST);
    }
    return this.identityService.register(token, username, clientHash, signerAddress);
  }

  @Post('migrate')
  async migrate(
    @Body('token') token: string,
    @Body('signature') signature: string,
    @Body('newOwner') newOwner: string
  ) {
    if (!token || !signature || !newOwner) {
      throw new HttpException('Missing migration payload', HttpStatus.BAD_REQUEST);
    }
    return this.identityService.migrate(token, signature, newOwner);
  }
}
