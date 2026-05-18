/**
 * =============================================================================
 * Logger - Pino con redacción de datos sensibles
 * =============================================================================
 *
 * Configuración crítica de seguridad: ciertos campos NUNCA deben aparecer
 * en los logs (passwords, tokens, OTPs, cédulas completas, etc).
 * Pino tiene soporte nativo para redaction.
 */

import pino from 'pino';
import { config } from './config.js';

// Campos que se redactan automáticamente en logs
const REDACT_PATHS = [
  // Headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',

  // Body (común)
  '*.password',
  '*.password_hash',
  '*.passwordHash',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.code', // OTP
  '*.totp_code',
  '*.totp_secret',

  // PII (parcial - solo redactamos)
  '*.cedula',
  '*.dni',
  '*.phone',
  '*.celular',
  '*.email',

  // Credenciales Wompi/Dentalink
  '*.wompi_private_key',
  '*.wompi_events_secret',
  '*.dentalink_token',
  '*.twilio_auth_token',
  '*.resend_api_key',

  // Encriptados (no son útiles en logs)
  '*.dentalink_token_encrypted',
  '*.wompi_private_key_encrypted',
  '*.wompi_events_secret_encrypted',
  '*.totp_secret_encrypted',
];

const isProduction = config.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  // Pretty print en development, JSON en producción
  ...(config.LOG_FORMAT === 'pretty' && !isProduction
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  // Base fields en todos los logs
  base: {
    app: 'dentalkiosco-api',
    version: config.APP_VERSION,
    env: config.NODE_ENV,
    installation: config.INSTALLATION_ID,
  },
  // Serializers consistentes
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      remoteAddress: req.ip,
      // No incluir headers completos por defecto (los redactamos arriba)
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err,
  },
});

/**
 * Helper para enmascarar PII en mensajes de log.
 * Uso: logger.info({ phone: maskPhone(phone) }, 'OTP sent');
 */
export function maskPhone(phone: string | undefined | null): string {
  if (!phone || phone.length < 8) return '[REDACTED]';
  return phone.substring(0, 3) + '****' + phone.substring(phone.length - 2);
}

export function maskEmail(email: string | undefined | null): string {
  if (!email || !email.includes('@')) return '[REDACTED]';
  const [local, domain] = email.split('@');
  if (!local || !domain) return '[REDACTED]';
  const visible = local.length > 2 ? local.substring(0, 2) : local[0];
  return `${visible}***@${domain}`;
}

export function maskCedula(cedula: string | undefined | null): string {
  if (!cedula || cedula.length < 4) return '[REDACTED]';
  return cedula.substring(0, 2) + '****' + cedula.substring(cedula.length - 2);
}
