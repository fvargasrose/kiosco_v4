/**
 * =============================================================================
 * Routes: /kiosk/* (kiosco autenticado con kiosk_token)
 * =============================================================================
 *
 * Estos endpoints son consumidos por el frontend del kiosco al arrancar
 * y periódicamente para refrescar configuración.
 *
 * El kiosco no almacena configuración localmente — siempre la lee del backend.
 * Esto permite que cambios desde el admin web aparezcan en el kiosco al
 * siguiente refresh (sin necesidad de reiniciar el kiosco).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { db } from '../lib/db.js';
import { verifyKioskToken, type KioskClaims } from '../lib/jwt.js';
import { audit } from '../lib/audit.js';
import { config } from '../lib/config.js';

declare module 'fastify' {
  interface FastifyRequest {
    kiosk?: KioskClaims;
  }
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match ? match[1]! : null;
}

async function requireKiosk(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractBearer(request.headers.authorization);
  if (!token) {
    return reply.code(401).send({ error: 'KIOSK_TOKEN_REQUIRED' });
  }

  let claims: KioskClaims;
  try {
    claims = await verifyKioskToken(token);
  } catch {
    await audit({
      actorType: 'system',
      action: 'kiosk.invalid_token',
      result: 'denied',
      ip: request.ip,
    });
    return reply.code(401).send({ error: 'INVALID_KIOSK_TOKEN' });
  }

  // Verificar que el kiosco esté activo
  const result = await db.query<{ is_active: boolean }>(
    `SELECT is_active FROM kiosks WHERE id = $1`,
    [claims.sub],
  );
  if (!result.rows[0]?.is_active) {
    return reply.code(403).send({ error: 'KIOSK_INACTIVE' });
  }

  request.kiosk = claims;
}

export async function kioskRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /kiosk/bootstrap
   *
   * Devuelve toda la configuración que el frontend del kiosco necesita:
   *   - Datos de la clínica (nombre, logo)
   *   - Política Habeas Data (texto + hash + versión)
   *   - Procedimientos disponibles
   *   - FAQ
   *   - Configuración WhatsApp asistente
   *   - ID del kiosco (para logging client-side)
   *
   * NUNCA expone tokens ni datos sensibles.
   */
  app.get('/kiosk/bootstrap', { preHandler: requireKiosk }, async (request, reply) => {
    const kiosk = request.kiosk!;

    // Actualizar last_seen_at del kiosco (telemetría)
    await db.query(
      `UPDATE kiosks
       SET last_seen_at = now(),
           last_ip = $1,
           last_user_agent = $2
       WHERE id = $3`,
      [request.ip, request.headers['user-agent'] ?? null, kiosk.sub],
    );

    // Cargar config de la clínica (solo campos públicos)
    const clinicResult = await db.query<{
      display_name: string;
      logo_path: string | null;
      logo_hash: string | null;
      habeas_data_policy_text: string | null;
      habeas_data_policy_version: string;
      habeas_data_policy_hash: string | null;
      faq: Array<{ question: string; answer: string }>;
      whatsapp_number: string | null;
      whatsapp_welcome_message: string | null;
      duracion_cita_minutos: number;
      standby_mode: string;
      standby_title: string | null;
      standby_subtitle: string | null;
      standby_video_sound: boolean;
    }>(`
      SELECT display_name, logo_path, logo_hash,
             habeas_data_policy_text, habeas_data_policy_version, habeas_data_policy_hash,
             faq,
             whatsapp_number, whatsapp_welcome_message,
             duracion_cita_minutos,
             standby_mode, standby_title, standby_subtitle, standby_video_sound
      FROM clinic WHERE id = 1
    `);

    const clinic = clinicResult.rows[0];
    if (!clinic) {
      return reply.code(503).send({
        error: 'NOT_CONFIGURED',
        message: 'La clínica aún no ha sido configurada. Contacte al administrador.',
      });
    }

    // Procedimientos activos del catálogo local
    const proceduresResult = await db.query<{
      id: string;
      name: string;
      duration_minutes: number;
      description: string | null;
    }>(`
      SELECT id, name, duration_minutes, description
      FROM clinic_procedures
      WHERE clinic_id = 1 AND active = true
      ORDER BY name ASC
    `);

    return reply.send({
      kiosk: {
        id: kiosk.sub,
        name: kiosk.kiosk_name,
      },
      clinic: {
        display_name: clinic.display_name,
        // URL pública del logo con cache-buster basado en el hash (404 si no hay logo subido).
        logo_url: clinic.logo_path
          ? `/public/clinic-logo${clinic.logo_hash ? `?v=${clinic.logo_hash.slice(0, 12)}` : ''}`
          : null,
      },
      habeas_data: {
        version: clinic.habeas_data_policy_version,
        hash: clinic.habeas_data_policy_hash,
        text: clinic.habeas_data_policy_text,
      },
      procedures: proceduresResult.rows,
      faq: clinic.faq ?? [],
      whatsapp: clinic.whatsapp_number
        ? {
            number: clinic.whatsapp_number,
            welcome_message: clinic.whatsapp_welcome_message,
          }
        : null,
      duracion_cita_minutos: clinic.duracion_cita_minutos,
      standby: {
        mode:        clinic.standby_mode,
        title:       clinic.standby_title ?? clinic.display_name,
        subtitle:    clinic.standby_subtitle ?? 'Bienvenido a nuestro autoservicio',
        video_sound: clinic.standby_video_sound,
      },
      otp_required: config.OTP_REQUIRED,
      feature_registro: config.FEATURE_REGISTRO,
      theme: config.KIOSK_THEME,
      server_time: new Date().toISOString(),
    });
  });

  // ── GET /kiosk/standby ────────────────────────────────────────────────────
  // Devuelve la configuración de standby: modo, textos y, si aplica, hash del
  // archivo y URL de descarga. El kiosco compara el hash con su copia local
  // para saber si debe re-descargar.
  app.get('/kiosk/standby', { preHandler: requireKiosk }, async (_req, reply) => {
    const r = await db.query<{
      standby_mode: string;
      standby_title: string | null;
      standby_subtitle: string | null;
      standby_media_path: string | null;
      standby_media_hash: string | null;
      standby_media_updated_at: string | null;
      standby_video_sound: boolean;
      display_name: string;
    }>(`
      SELECT standby_mode, standby_title, standby_subtitle,
             standby_media_path, standby_media_hash, standby_media_updated_at,
             standby_video_sound,
             display_name
      FROM clinic WHERE id = 1
    `);
    const c = r.rows[0];
    if (!c) return reply.code(503).send({ error: 'NOT_CONFIGURED' });

    const hasFile = !!(c.standby_media_path && existsSync(c.standby_media_path));
    const ext = c.standby_media_path ? path.extname(c.standby_media_path).slice(1) : null;

    return reply.send({
      mode:        c.standby_mode,
      title:       c.standby_title ?? c.display_name,
      subtitle:    c.standby_subtitle ?? 'Bienvenido a nuestro autoservicio',
      video_sound: c.standby_video_sound,
      media_hash:  hasFile ? c.standby_media_hash : null,
      media_ext:   hasFile ? ext : null,
      media_url:   hasFile ? '/kiosk/standby/media' : null,
    });
  });

  // ── GET /kiosk/standby/media ──────────────────────────────────────────────
  // Descarga el archivo GIF/video actual. El kiosco lo cachea en IndexedDB.
  app.get('/kiosk/standby/media', { preHandler: requireKiosk }, async (_req, reply) => {
    const r = await db.query<{
      standby_media_path: string | null;
    }>(`SELECT standby_media_path FROM clinic WHERE id = 1`);

    const filePath = r.rows[0]?.standby_media_path;
    if (!filePath || !existsSync(filePath)) {
      return reply.code(404).send({ error: 'NO_MEDIA' });
    }

    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mimeMap: Record<string, string> = {
      gif:  'image/gif',
      mp4:  'video/mp4',
      webm: 'video/webm',
    };
    const mime = mimeMap[ext] ?? 'application/octet-stream';

    return reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'private, max-age=0')
      .send(createReadStream(filePath));
  });
}
