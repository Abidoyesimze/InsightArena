import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EmailService } from './email.service';
import { User } from '../users/entities/user.entity';
import { UserPreferences } from '../users/entities/user-preferences.entity';

describe('EmailService', () => {
  let service: EmailService;
  let userRepository: jest.Mocked<Pick<import('typeorm').Repository<User>, 'findOne'>>;
  let preferencesRepository: jest.Mocked<
    Pick<import('typeorm').Repository<UserPreferences>, 'findOne'>
  >;

  beforeEach(async () => {
    userRepository = { findOne: jest.fn() };
    preferencesRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(() => undefined),
          },
        },
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: getRepositoryToken(UserPreferences),
          useValue: preferencesRepository,
        },
      ],
    }).compile();

    service = module.get<EmailService>(EmailService);
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('queues templated emails when preferences allow', async () => {
    userRepository.findOne.mockResolvedValue(null);

    const result = await service.sendTemplatedEmail(
      'user@example.com',
      'event_created',
      { eventTitle: 'World Cup', inviteCode: 'WC2026' },
    );

    expect(result.queued).toBe(true);
    expect(service.getQueueLength()).toBe(1);
  });

  it('respects email opt-out preferences', async () => {
    userRepository.findOne.mockResolvedValue({ id: 'user-1' } as User);
    preferencesRepository.findOne.mockResolvedValue({
      email_notifications: false,
    } as UserPreferences);

    const result = await service.sendTemplatedEmail(
      'user@example.com',
      'match_result_available',
      { eventTitle: 'World Cup' },
      'GSTELLAR123',
    );

    expect(result.queued).toBe(false);
    expect(result.reason).toContain('opted out');
  });

  it('renders all template types without throwing', async () => {
    userRepository.findOne.mockResolvedValue(null);

    const templates = [
      'event_created',
      'match_result_available',
      'event_won',
      'event_cancelled',
    ] as const;

    for (const template of templates) {
      const result = await service.sendTemplatedEmail(
        'user@example.com',
        template,
        { eventTitle: 'Test Event' },
      );
      expect(result.queued).toBe(true);
    }

    expect(service.getQueueLength()).toBe(4);
  });
});
