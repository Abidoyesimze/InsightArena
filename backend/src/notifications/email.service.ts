import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreferences } from '../users/entities/user-preferences.entity';
import { User } from '../users/entities/user.entity';
import {
  EmailTemplateContext,
  EmailTemplateType,
  renderEmailTemplate,
} from './email-templates';

export interface QueuedEmail {
  id: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  userAddress?: string;
  queuedAt: number;
}

const DEFAULT_RATE_LIMIT = 30;
const QUEUE_PROCESS_INTERVAL_MS = 2000;

@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private readonly queue: QueuedEmail[] = [];
  private readonly sentTimestamps: number[] = [];
  private processTimer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserPreferences)
    private readonly preferencesRepository: Repository<UserPreferences>,
  ) {}

  onModuleInit(): void {
    this.processTimer = setInterval(() => {
      void this.processQueue();
    }, QUEUE_PROCESS_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
    }
  }

  async sendTemplatedEmail(
    to: string,
    template: EmailTemplateType,
    context: EmailTemplateContext,
    userAddress?: string,
  ): Promise<{ queued: boolean; reason?: string }> {
    if (userAddress) {
      const allowed = await this.isEmailAllowed(userAddress, template);
      if (!allowed) {
        return { queued: false, reason: 'User has opted out of email notifications' };
      }
    }

    const { subject, html, text } = renderEmailTemplate(template, context);

    return this.queueEmail({ to, subject, html, text, userAddress });
  }

  async queueEmail(params: {
    to: string;
    subject: string;
    html: string;
    text: string;
    userAddress?: string;
  }): Promise<{ queued: boolean; reason?: string }> {
    if (!params.to?.trim()) {
      return { queued: false, reason: 'Recipient email is required' };
    }

    if (params.userAddress) {
      const allowed = await this.isEmailAllowed(params.userAddress);
      if (!allowed) {
        return { queued: false, reason: 'User has opted out of email notifications' };
      }
    }

    this.queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      to: params.to.trim(),
      subject: params.subject,
      html: params.html,
      text: params.text,
      userAddress: params.userAddress,
      queuedAt: Date.now(),
    });

    return { queued: true };
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  private async isEmailAllowed(
    userAddress: string,
    template?: EmailTemplateType,
  ): Promise<boolean> {
    const user = await this.userRepository.findOne({
      where: { stellar_address: userAddress },
    });

    if (!user) {
      return true;
    }

    const prefs = await this.preferencesRepository.findOne({
      where: { userId: user.id },
    });

    if (!prefs) {
      return true;
    }

    if (!prefs.email_notifications) {
      return false;
    }

    if (template === 'event_cancelled' || template === 'event_created') {
      return prefs.competition_notifications;
    }

    if (template === 'match_result_available') {
      return prefs.market_resolution_notifications;
    }

    if (template === 'event_won') {
      return prefs.leaderboard_notifications;
    }

    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    if (!this.canSendMore()) {
      return;
    }

    this.isProcessing = true;

    try {
      const email = this.queue.shift();
      if (!email) {
        return;
      }

      await this.deliverEmail(email);
      this.sentTimestamps.push(Date.now());
    } catch (error) {
      this.logger.error(
        `Failed to process email queue: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  private canSendMore(): boolean {
    const limit = Number(
      this.configService.get<string>('EMAIL_RATE_LIMIT_PER_MINUTE') ??
        DEFAULT_RATE_LIMIT,
    );
    const cutoff = Date.now() - 60_000;
    const recent = this.sentTimestamps.filter((t) => t >= cutoff);
    this.sentTimestamps.splice(0, this.sentTimestamps.length, ...recent);
    return recent.length < limit;
  }

  private async deliverEmail(email: QueuedEmail): Promise<void> {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY');
    const fromEmail =
      this.configService.get<string>('EMAIL_FROM') ??
      'notifications@insightarena.app';

    if (apiKey) {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: email.to }] }],
          from: { email: fromEmail, name: 'InsightArena' },
          subject: email.subject,
          content: [
            { type: 'text/plain', value: email.text },
            { type: 'text/html', value: email.html },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`SendGrid error (${response.status}): ${body}`);
      }

      this.logger.log(`Email sent to ${email.to}: ${email.subject}`);
      return;
    }

    this.logger.log(
      `[DEV] Email queued for ${email.to}: ${email.subject}\n${email.text}`,
    );
  }
}
