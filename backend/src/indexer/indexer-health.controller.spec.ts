import { Test, TestingModule } from '@nestjs/testing';
import { IndexerHealthController } from './indexer-health.controller';
import { IndexerHealthService } from './health.service';

describe('IndexerHealthController', () => {
  let controller: IndexerHealthController;
  let healthService: jest.Mocked<
    Pick<
      IndexerHealthService,
      'getHealth' | 'getDashboard' | 'getPrometheusMetrics' | 'triggerManualSync'
    >
  >;

  beforeEach(async () => {
    healthService = {
      getHealth: jest.fn(),
      getDashboard: jest.fn(),
      getPrometheusMetrics: jest.fn(),
      triggerManualSync: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [IndexerHealthController],
      providers: [{ provide: IndexerHealthService, useValue: healthService }],
    }).compile();

    controller = module.get<IndexerHealthController>(IndexerHealthController);
  });

  it('returns health status', async () => {
    healthService.getHealth.mockResolvedValue({
      status: 'healthy',
      metrics: {} as any,
      alerts: [],
    });

    const result = await controller.getHealth();
    expect(result.status).toBe('healthy');
  });

  it('returns prometheus metrics as plain text', async () => {
    healthService.getPrometheusMetrics.mockResolvedValue(
      'indexer_lag_in_ledgers 0\n',
    );

    const result = await controller.getPrometheusMetrics();
    expect(result).toContain('indexer_lag_in_ledgers');
  });
});
