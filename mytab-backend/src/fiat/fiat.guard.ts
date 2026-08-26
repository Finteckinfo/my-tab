import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * FiatEnabledGuard — returns 503 Service Unavailable when FIAT_ENABLED !== 'true'.
 *
 * Per the spec: the fiat bridge stays stubbed against sandbox only.
 * Nothing touching real money until credentials and compliance clear.
 * This guard makes every fiat endpoint unreachable without an explicit config flag.
 */
@Injectable()
export class FiatEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const enabled = this.config.get<string>('FIAT_ENABLED', 'false');
    if (enabled !== 'true') {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Fiat bridge is not enabled. Set FIAT_ENABLED=true to activate.',
          error: 'Service Unavailable',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return true;
  }
}
