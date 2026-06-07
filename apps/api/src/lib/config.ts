/**
 * =============================================================================
 * Config - Validación de variables de entorno con Zod
 * =============================================================================
 *
 * Toda variable de entorno se valida al arrancar. Si falta o es inválida,
 * el proceso falla con un mensaje claro en lugar de fallar más adelante
 * con errores crípticos.
 */

import { z } from 'zod';

// z.coerce.boolean() usa Boolean("false") === true (cualquier string no vacío es truthy).
// Este helper convierte los strings "true"/"false" al booleano correcto.
const boolEnv = (defaultVal: boolean) =>
  z
    .preprocess(
      (v) => (v === 'true' ? true : v === 'false' ? false : v),
      z.boolean(),
    )
    .default(defaultVal);

const ConfigSchema = z.object({
  // -------- Identificación --------
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  APP_VERSION: z.string().default('3.0.0-alpha.1'),
  INSTALLATION_ID: z.string().default('local-dev'),
  LICENSE_KEY: z.string().default('DEV-LOCAL-NOLICENSE-LOCAL'),

  // -------- Servidor --------
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost'),

  // -------- Base de datos --------
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default('dentalkiosco'),
  POSTGRES_USER: z.string().default('dentalkiosco'),
  POSTGRES_PASSWORD: z.string().min(1, 'POSTGRES_PASSWORD requerido'),

  // -------- Redis --------
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().min(1, 'REDIS_PASSWORD requerido'),

  // -------- JWT / Cifrado --------
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe ser >= 32 caracteres'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY debe ser >= 32 caracteres'),

  JWT_KIOSK_TTL_DAYS: z.coerce.number().int().positive().default(90),
  JWT_PATIENT_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  // Máximo absoluto de vida de una sesión de paciente (web pública, §10): por
  // mucho que se renueve con /auth/refresh (sesión deslizante), nunca supera
  // este tope contado desde el login original (patient_sessions.created_at).
  JWT_PATIENT_SESSION_ABSOLUTE_MAX_HOURS: z.coerce.number().int().positive().default(8),
  JWT_ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
  OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),

  // -------- Rate limiting --------
  RATE_LIMIT_OTP_PER_PHONE_PER_HOUR: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_OTP_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_OTP_PER_KIOSK_PER_HOUR: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_LOGIN_ATTEMPTS_BEFORE_LOCK: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  // -------- License server --------
  LICENSE_SERVER_URL: z.string().url().default('https://license.allcreative.app'),
  LICENSE_HEARTBEAT_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
  LICENSE_GRACE_PERIOD_DAYS: z.coerce.number().int().positive().default(7),
  LICENSE_SHUTDOWN_PERIOD_DAYS: z.coerce.number().int().positive().default(14),
  LICENSE_DEV_MODE: boolEnv(false),

  // -------- Servicios externos (opcionales en dev) --------
  WOMPI_PUBLIC_KEY: z.string().optional(),
  WOMPI_PRIVATE_KEY: z.string().optional(),
  WOMPI_EVENTS_SECRET: z.string().optional(),
  WOMPI_INTEGRITY_SECRET: z.string().optional(),
  WOMPI_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  WOMPI_API_URL: z.string().url().default('https://sandbox.wompi.co/v1'),

  DENTALINK_TOKEN: z.string().optional(),
  DENTALINK_API_URL: z.string().url().default('https://api.dentalink.healthatom.com'),
  // Override opcional del id_estado de "Cancelada" por clínica. Si se define,
  // tiene prioridad sobre el descubrimiento por nombre en getCancelEstadoId.
  DENTALINK_CANCEL_ESTADO_ID: z.coerce.number().int().positive().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  SMTP_SERVER: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SENDER_EMAIL: z.string().email().optional(),
  SENDER_NAME: z.string().optional(),
  SENDER_PASSWORD: z.string().optional(),
  // Email alternativo para la notificación de pago a la clínica. Siempre presente
  // en el .env; se usa como fallback cuando notification_email (panel) está vacío
  // o coincide con SENDER_EMAIL (loop from==to). Ver resolveAdminEmail.
  CORREO_NOTIFICACION: z.string().email().optional(),

  // -------- Observabilidad --------
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('json'),
  SENTRY_DSN: z.string().optional(),

  // -------- Habeas Data --------
  HABEAS_DATA_POLICY_VERSION: z.string().default('v1.0'),

  // -------- Archivos subidos por el admin --------
  UPLOADS_DIR: z.string().default('./uploads'),
  // Tamaño máximo de archivo de standby (bytes). Default 50 MB.
  UPLOADS_MAX_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  // -------- Autenticación paciente --------
  // false = el paciente accede solo con cédula + teléfono, sin enviar código OTP.
  // true  = flujo normal: se envía código por SMS/email y el paciente lo verifica.
  OTP_REQUIRED: boolEnv(true),

  // -------- Feature flags UI --------
  // false = el botón "Regístrate aquí" del login y la pantalla register se ocultan.
  //         El endpoint POST /kiosk/register sigue respondiendo (no se desmonta).
  FEATURE_REGISTRO: boolEnv(false),

  // false = el booking NO pregunta por procedimiento; usa una "Consulta general"
  //         con la duración por defecto de la clínica (duracion_cita_minutos).
  //         El admin sigue gestionando procedimientos; solo se oculta al paciente.
  // true  = el paciente elige procedimiento como paso del booking.
  PROCEDIMIENTOS_ACTIVOS: boolEnv(true),

  // -------- Cloudflare Turnstile (anti-abuso de OTP en web pública) --------
  // Hook del Hito A: se definen las claves pero el enforcement (verificación
  // server-side del token en /auth/request-otp) se implementa en el Hito B.
  // El SITEKEY se expone vía /public/bootstrap para que el frontend renderice
  // el widget. Si TURNSTILE_SECRET está vacío, no hay verificación (dev).
  TURNSTILE_SECRET: z.string().optional(),
  TURNSTILE_SITEKEY: z.string().optional(),

  // -------- Tema visual del kiosco --------
  KIOSK_THEME: z.enum(['apple', 'default']).default('apple'),

  // -------- Dev helpers --------
  DEV_MOCK_EXTERNAL_SERVICES: boolEnv(false),
  DEV_LOG_OTP: boolEnv(false),
  DEV_MOCK_WOMPI: boolEnv(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('\n❌ Configuración inválida:\n');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('\nRevisa tu archivo .env. Plantilla en .env.example\n');
    process.exit(1);
  }

  // En producción, Turnstile es obligatorio (anti-abuso de OTP en web pública).
  // En dev/test/staging es opcional: si falta, el enforcement se omite.
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.TURNSTILE_SECRET) {
    console.error('\n❌ TURNSTILE_SECRET es obligatorio en producción (anti-abuso OTP).\n');
    process.exit(1);
  }

  return parsed.data;
}

export const config = loadConfig();

/**
 * Helpers de conveniencia para chequear si servicios externos están configurados.
 */
export const features = {
  wompiConfigured: !!(
    config.WOMPI_PUBLIC_KEY &&
    config.WOMPI_PRIVATE_KEY &&
    config.WOMPI_EVENTS_SECRET
  ),
  dentalinkConfigured: !!config.DENTALINK_TOKEN,
  twilioConfigured: !!(
    config.TWILIO_ACCOUNT_SID &&
    config.TWILIO_AUTH_TOKEN &&
    config.TWILIO_FROM_NUMBER
  ),
  smtpConfigured: !!(config.SMTP_SERVER && config.SENDER_EMAIL && config.SENDER_PASSWORD),
  // Turnstile listo para enforcement (Hito B): requiere el secret server-side.
  turnstileConfigured: !!config.TURNSTILE_SECRET,
} as const;
