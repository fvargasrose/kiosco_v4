/**
 * =============================================================================
 * Email Sender - SMTP adapter con modo mock para desarrollo
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

class SmtpEmailSender implements EmailSender {
  private transporter: any = null;

  private async getTransporter(): Promise<any> {
    if (this.transporter) return this.transporter;

    const nodemailer = await import('nodemailer');
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_SERVER,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: {
        user: config.SENDER_EMAIL,
        pass: config.SENDER_PASSWORD,
      },
      // Un SMTP que no responde (p. ej. auto-entrega from==to) no debe colgar
      // el envío indefinidamente: que falle rápido y deje rastro en logs.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    return this.transporter;
  }

  async send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ id: string }> {
    const transporter = await this.getTransporter();

    const from = config.SENDER_NAME
      ? `${config.SENDER_NAME} <${config.SENDER_EMAIL}>`
      : config.SENDER_EMAIL;

    const info = await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text && { text: input.text }),
    });

    logger.info(
      { to: maskEmail(input.to), messageId: info.messageId, channel: 'email' },
      'Email sent via SMTP',
    );
    return { id: info.messageId ?? `smtp-${Date.now()}` };
  }
}

let _instance: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (_instance) return _instance;

  if (config.DEV_MOCK_EXTERNAL_SERVICES || !features.smtpConfigured) {
    _instance = new MockEmailSender();
    logger.info('Email: using MockEmailSender');
  } else {
    _instance = new SmtpEmailSender();
    logger.info(`Email: using SmtpEmailSender (${config.SMTP_SERVER}:${config.SMTP_PORT})`);
  }

  return _instance;
}

export function setEmailSender(sender: EmailSender): void {
  _instance = sender;
}
