import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookService } from './webhook.service';
import { CreatorEventMatch } from '../creator-events/entities/creator-event-match.entity';
import { ConfigService } from '@nestjs/config';
import { WebhookMatchResultDto, WinningTeam } from './dto/webhook-match-result.dto';
import { NotFoundException, ConflictException } from '@nestjs/common';

describe('WebhookService', () => {
  let service: WebhookService;
  let matchRepository: Repository<CreatorEventMatch>;
  let configService: ConfigService;

  const mockMatch = {
    id: 'match-1',
    on_chain_match_id: '123',
    team_a: 'Team A',
    team_b: 'Team B',
    match_time: new Date(Date.now() - 3600000), // 1 hour ago
    result_submitted: false,
    winning_team: null,
    prediction_count: 10,
    created_at: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: getRepositoryToken(CreatorEventMatch),
          useClass: Repository,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'WEBHOOK_SECRET') return 'test-secret';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
    matchRepository = module.get<Repository<CreatorEventMatch>>(getRepositoryToken(CreatorEventMatch));
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('processMatchResult', () => {
    it('should accept valid match result and return job ID', async () => {
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(mockMatch as any);
      jest.spyOn(matchRepository, 'save').mockResolvedValue(mockMatch as any);
      jest.spyOn(service as any, 'simulateOracleSubmission').mockResolvedValue(undefined);

      const result = await service.processMatchResult(dto);

      expect(result).toHaveProperty('job_id');
      expect(result.status).toBe('accepted');
      expect(result.message).toBe('Match result queued for submission');
    });

    it('should throw NotFoundException if match does not exist', async () => {
      const dto: WebhookMatchResultDto = {
        match_id: '999',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/999',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(null);

      await expect(service.processMatchResult(dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException if match already resolved', async () => {
      const resolvedMatch = { ...mockMatch, result_submitted: true };
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(resolvedMatch as any);

      await expect(service.processMatchResult(dto)).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException if match has not started', async () => {
      const futureMatch = { ...mockMatch, match_time: new Date(Date.now() + 7200000) }; // 2 hours in future
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(futureMatch as any);

      await expect(service.processMatchResult(dto)).rejects.toThrow(ConflictException);
    });

    it('should accept match result if match time is within 1 hour buffer', async () => {
      const futureMatch = { ...mockMatch, match_time: new Date(Date.now() + 1800000) }; // 30 minutes in future
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(futureMatch as any);
      jest.spyOn(matchRepository, 'save').mockResolvedValue(futureMatch as any);
      jest.spyOn(service as any, 'simulateOracleSubmission').mockResolvedValue(undefined);

      const result = await service.processMatchResult(dto);

      expect(result.status).toBe('accepted');
    });
  });

  describe('retry logic', () => {
    it('should retry failed submissions', async () => {
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(mockMatch as any);
      jest.spyOn(matchRepository, 'save').mockResolvedValue(mockMatch as any);
      
      // Simulate failure on first attempt
      jest.spyOn(service as any, 'simulateOracleSubmission')
        .mockRejectedValueOnce(new Error('Submission failed'))
        .mockResolvedValue(undefined);

      const result = await service.processMatchResult(dto);

      expect(result.status).toBe('accepted');
      
      const queueStatus = service.getQueueStatus();
      expect(queueStatus.total).toBeGreaterThan(0);
    });

    it('should remove job after max retries', async () => {
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(mockMatch as any);
      jest.spyOn(service as any, 'simulateOracleSubmission').mockRejectedValue(new Error('Submission failed'));

      await service.processMatchResult(dto);

      // Manually trigger retry processing to exhaust retries
      const jobId = service.getQueueStatus().jobs[0].id;
      for (let i = 0; i < 4; i++) {
        const job = await service.getJobStatus(jobId);
        if (job) {
          await service['submitToOracle'](job);
        }
      }

      const queueStatus = service.getQueueStatus();
      expect(queueStatus.total).toBe(0);
    });
  });

  describe('queue status', () => {
    it('should return queue status', () => {
      const status = service.getQueueStatus();

      expect(status).toHaveProperty('total');
      expect(status).toHaveProperty('pending');
      expect(status).toHaveProperty('retrying');
      expect(status).toHaveProperty('jobs');
      expect(Array.isArray(status.jobs)).toBe(true);
    });

    it('should return job status by ID', async () => {
      const dto: WebhookMatchResultDto = {
        match_id: '123',
        winning_team: WinningTeam.TEAM_A,
        confidence_score: 95,
        data_source: 'https://api.example.com/match/123',
        timestamp: new Date().toISOString(),
      };

      jest.spyOn(matchRepository, 'findOne').mockResolvedValue(mockMatch as any);
      jest.spyOn(matchRepository, 'save').mockResolvedValue(mockMatch as any);
      jest.spyOn(service as any, 'simulateOracleSubmission').mockResolvedValue(undefined);

      const result = await service.processMatchResult(dto);
      const job = await service.getJobStatus(result.job_id);

      expect(job).not.toBeNull();
      expect(job?.matchId).toBe('123');
    });

    it('should return null for non-existent job ID', async () => {
      const job = await service.getJobStatus('non-existent-job-id');
      expect(job).toBeNull();
    });
  });
});
