/**
 * =============================================================================
 * Routes: /public/* (acceso web público — sin kiosk_token)
 * =============================================================================
 *
 * Modelo web público (Hito A, Opción A): el frontend del paciente accede desde
 * cualquier dispositivo por internet, SIN kiosk_token. Estas rutas exponen la
 * misma configuración de clínica que antes servía /kiosk/* pero sin exigir
 * identidad de dispositivo y sin telemetría de kiosco.
 *
 * Clínica única (id = 1). NUNCA expone tokens ni datos sensibles.
 *
 * Las rutas /kiosk/* (kiosk.ts) quedan deprecadas pero presentes durante la
 * migración; serán retiradas en una limpieza posterior.
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { db } from '../lib/db.js';
import { config } from '../lib/config.js';

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /public/bootstrap
   *
   * Configuración que el frontend web necesita al arrancar:
   *   - Datos públicos de la clínica (nombre, logo)
   *   - Política Habeas Data (texto + hash + versión)
   *   - Procedimientos disponibles
   *   - FAQ, WhatsApp, standby
   *   - Flags: otp_required, feature_registro, theme, turnstile_sitekey
   */
  app.get('/public/bootstrap', async (_request, reply) => {
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
      clinic: {
        display_name: clinic.display_name,
        // URL pública del logo con cache-buster por hash (404 si no hay logo).
        // Va bajo /api porque el frontend la usa como <img src> directo.
        logo_url: clinic.logo_path
          ? `/api/public/clinic-logo${clinic.logo_hash ? `?v=${clinic.logo_hash.slice(0, 12)}` : ''}`
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
      procedimientos_activos: config.PROCEDIMIENTOS_ACTIVOS,
      theme: config.KIOSK_THEME,
      // SITEKEY de Turnstile para que el frontend renderice el widget (Hito B
      // implementa el enforcement server-side). null si no está configurado.
      turnstile_sitekey: config.TURNSTILE_SITEKEY ?? null,
      server_time: new Date().toISOString(),
    });
  });

  // ── GET /public/standby ────────────────────────────────────────────────────
  // Configuración de standby: modo, textos y, si aplica, hash + URL de descarga.
  app.get('/public/standby', async (_req, reply) => {
    const r = await db.query<{
      standby_mode: string;
      standby_title: string | null;
      standby_subtitle: string | null;
      standby_media_path: string | null;
      standby_media_hash: string | null;
      standby_video_sound: boolean;
      display_name: string;
    }>(`
      SELECT standby_mode, standby_title, standby_subtitle,
             standby_media_path, standby_media_hash,
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
      media_url:   hasFile ? '/public/standby/media' : null,
    });
  });

  // ── GET /public/standby/media ──────────────────────────────────────────────
  // Descarga el archivo GIF/video actual del standby.
  app.get('/public/standby/media', async (_req, reply) => {
    const r = await db.query<{ standby_media_path: string | null }>(
      `SELECT standby_media_path FROM clinic WHERE id = 1`,
    );

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
      .header('Cache-Control', 'public, max-age=300')
      .send(createReadStream(filePath));
  });
}
