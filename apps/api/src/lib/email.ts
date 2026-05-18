/**
 * =============================================================================
 * Email Sender - Resend adapter con modo mock para desarrollo
 * =============================================================================
 */

import { logger, maskEmail } from './logger.js';
import { config, features } from './config.js';

export interface EmailSender {
  send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ id: string }>;
}

class MockEmailSender implements EmailSender {
  async send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ id: string }> {
    if (config.DEV_LOG_OTP) {
      logger.info(
        {
          to: maskEmail(input.to),
          subject: input.subject,
          text: input.text,
          channel: 'email',
          mock: true,
        },
        '[MOCK EMAIL]',
      );
    } else {
      logger.info(
        { to: maskEmail(input.to), subject: input.subject, channel: 'email', mock: true },
        '[MOCK EMAIL] (body redactado)',
      );
    }
    return { id: `mock-email-${Date.now()}` };
  }
}

class ResendEmailSender implements EmailSender {
  private client: any = null;

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const resendMod = await import('resend').catch(() => null);
    if (!resendMod) {
      throw new Error('Módulo "resend" no instalado. Run: npm install resend');
    }
    this.client = new resendMod.Resend(config.RESEND_API_KEY);
    return this.client;
  }

  async send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ id: string }> {
    const client = await this.getClient();
    const result = await client.emails.send({
      from: config.RESEND_FROM_EMAIL,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(config.RESEND_REPLY_TO_EMAIL && { reply_to: config.RESEND_REPLY_TO_EMAIL }),
    });

    if (result.error) {
      throw new Error(`Resend error: ${JSON.stringify(result.error)}`);
    }

    logger.info(
      { to: maskEmail(input.to), id: result.data?.id, channel: 'email' },
      'Email sent via Resend',
    );
    return { id: result.data?.id ?? 'unknown' };
  }
}

let _instance: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (_instance) return _instance;

  if (config.DEV_MOCK_EXTERNAL_SERVICES || !features.resendConfigured) {
    _instance = new MockEmailSender();
    logger.info('Email: using MockEmailSender');
  } else {
    _instance = new ResendEmailSender();
    logger.info('Email: using ResendEmailSender');
  }

  return _instance;
}

export function setEmailSender(sender: EmailSender): void {
  _instance = sender;
}
