import { Test, TestingModule } from '@nestjs/testing';
import { WebhookAuthGuard } from './webhook-auth.guard';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';

describe('WebhookAuthGuard', () => {
  let guard: WebhookAuthGuard;
  let configService: ConfigService;

  const mockExecutionContext = (headers: Record<string, string>) => {
    const context = {
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({
          headers,
          body: { test: 'data' },
        }),
      }),
    } as unknown as ExecutionContext;
    return context;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookAuthGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'WEBHOOK_SECRET') return 'test-secret-key';
              return null;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<WebhookAuthGuard>(WebhookAuthGuard);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('authentication', () => {
    it('should allow valid signature', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ test: 'data' });
      const message = `${timestamp}.${body}`;
      
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', 'test-secret-key');
      hmac.update(message);
      const signature = hmac.digest('hex');

      const context = mockExecutionContext({
        'x-webhook-signature': signature,
        'x-webhook-timestamp': timestamp,
      });

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should reject missing signature', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const context = mockExecutionContext({
        'x-webhook-timestamp': timestamp,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject missing timestamp', async () => {
      const context = mockExecutionContext({
        'x-webhook-signature': 'some-signature',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject invalid signature', async () => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const context = mockExecutionContext({
        'x-webhook-signature': 'invalid-signature',
        'x-webhook-timestamp': timestamp,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject old timestamp (replay attack)', async () => {
      const oldTimestamp = Math.floor((Date.now() - 400000) / 1000).toString(); // 6+ minutes ago
      const body = JSON.stringify({ test: 'data' });
      const message = `${oldTimestamp}.${body}`;
      
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', 'test-secret-key');
      hmac.update(message);
      const signature = hmac.digest('hex');

      const context = mockExecutionContext({
        'x-webhook-signature': signature,
        'x-webhook-timestamp': oldTimestamp,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject future timestamp', async () => {
      const futureTimestamp = Math.floor((Date.now() + 400000) / 1000).toString(); // 6+ minutes in future
      const body = JSON.stringify({ test: 'data' });
      const message = `${futureTimestamp}.${body}`;
      
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', 'test-secret-key');
      hmac.update(message);
      const signature = hmac.digest('hex');

      const context = mockExecutionContext({
        'x-webhook-signature': signature,
        'x-webhook-timestamp': futureTimestamp,
      });

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should reject when webhook secret not configured', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WebhookAuthGuard,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => null),
            },
          },
        ],
      }).compile();

      const guardWithoutSecret = module.get<WebhookAuthGuard>(WebhookAuthGuard);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const context = mockExecutionContext({
        'x-webhook-signature': 'some-signature',
        'x-webhook-timestamp': timestamp,
      });

      await expect(guardWithoutSecret.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });
  });
});
