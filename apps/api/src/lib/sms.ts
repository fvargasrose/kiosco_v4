/**
 * =============================================================================
 * SMS Sender - Twilio adapter con modo mock para desarrollo
 * =============================================================================
 */

import { logger, maskPhone } from './logger.js';
import { config, features } from './config.js';

export interface SmsSender {
  send(to: string, body: string): Promise<{ sid: string }>;
}

/**
 * Mock para desarrollo: solo loguea, no envía.
 * En logs muestra el OTP solo si DEV_LOG_OTP=true.
 */
class MockSmsSender implements SmsSender {
  async send(to: string, body: string): Promise<{ sid: string }> {
    if (config.DEV_LOG_OTP) {
      logger.info(
        { to: maskPhone(to), body, channel: 'sms', mock: true },
        '[MOCK SMS]',
      );
    } else {
      logger.info(
        { to: maskPhone(to), channel: 'sms', mock: true },
        '[MOCK SMS] (body redactado)',
      );
    }
    return { sid: `mock-sms-${Date.now()}` };
  }
}

/**
 * Adaptador Twilio real.
 * NOTA: el módulo twilio se importa dinámicamente para no requerirlo en dev.
 */
class TwilioSmsSender implements SmsSender {
  private client: any = null;

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    // Import dinámico para no obligar a tener twilio instalado en dev
    const twilioMod = await import('twilio').catch(() => null);
    if (!twilioMod) {
      throw new Error('Módulo "twilio" no instalado. Run: npm install twilio');
    }
    this.client = twilioMod.default(
      config.TWILIO_ACCOUNT_SID!,
      config.TWILIO_AUTH_TOKEN!,
    );
    return this.client;
  }

  async send(to: string, body: string): Promise<{ sid: string }> {
    const client = await this.getClient();
    const message = await client.messages.create({
      to,
      from: config.TWILIO_FROM_NUMBER,
      body,
    });
    logger.info(
      { to: maskPhone(to), sid: message.sid, channel: 'sms' },
      'SMS sent via Twilio',
    );
    return { sid: message.sid };
  }
}

let _instance: SmsSender | null = null;

export function getSmsSender(): SmsSender {
  if (_instance) return _instance;

  if (config.DEV_MOCK_EXTERNAL_SERVICES || !features.twilioConfigured) {
    _instance = new MockSmsSender();
    logger.info('SMS: using MockSmsSender (dev mode or Twilio not configured)');
  } else {
    _instance = new TwilioSmsSender();
    logger.info('SMS: using TwilioSmsSender');
  }

  return _instance;
}

/**
 * Para tests: permite inyectar un sender custom.
 */
export function setSmsSender(sender: SmsSender): void {
  _instance = sender;
}
