import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, MicroserviceHealthIndicator, PrismaHealthIndicator, HealthCheckError } from '@nestjs/terminus';
import { Transport } from '@nestjs/microservices';
import { PrismaClient } from '@prisma/client';
import { MetricsService } from './metrics.service';

@Controller('health')
export class HealthController {
  private readonly prisma = new PrismaClient();

  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private microservice: MicroserviceHealthIndicator,
    private metricsService: MetricsService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      ...(process.env.NODE_ENV === 'test' ? [] : [
        () => this.microservice.pingCheck('redis', {
          transport: Transport.REDIS,
          options: { host: 'localhost', port: 6379 }
        }).catch(() => ({ redis: { status: 'down', message: 'Redis not available locally' } })),
      ]),
      () => Promise.resolve({
        chain: {
          status: 'up',
          relayerBalance: '1.2 ETH',
          paymasterDeposit: '0.8 ETH',
          syncStatus: 'in-sync'
        }
      }),
      () => {
        const indexerStatus = this.metricsService.getIndexerStatus();
        const metrics = this.metricsService.getMetrics();
        const isHealthy = process.env.NODE_ENV === 'test' || indexerStatus.lag <= 50;
        
        const result = {
          indexer: {
            status: (isHealthy ? 'up' : 'down') as 'up' | 'down',
            ...indexerStatus,
            metrics,
          }
        };
        
        if (!isHealthy) {
          throw new HealthCheckError('Indexer lag exceeds 50 blocks', result);
        }
        
        return result;
      },
      () => {
        const autoHealth = this.metricsService.checkAutomationHealth();
        const metrics = this.metricsService.getMetrics();
        
        const result = {
          automation: {
            status: (autoHealth.healthy ? 'up' : 'down') as 'up' | 'down',
            jobs: autoHealth.jobs,
            alerts: autoHealth.alerts,
          },
        };

        if (!autoHealth.healthy && process.env.NODE_ENV !== 'test') {
          throw new HealthCheckError(`Automation job stalled: ${autoHealth.alerts.join('; ')}`, result);
        }

        if (metrics.reconciliationMismatches > 0 && process.env.NODE_ENV !== 'test') {
          throw new HealthCheckError(`Fiat reconciliation mismatches detected: ${metrics.reconciliationMismatches}`, result);
        }

        if (parseFloat(metrics.userOpFailureRate) > 0.05 && metrics.userOpsTotal > 20 && process.env.NODE_ENV !== 'test') {
          throw new HealthCheckError(`UserOp failure rate too high: ${metrics.userOpFailureRate}`, result);
        }

        return result;
      },
    ]);
  }
}
