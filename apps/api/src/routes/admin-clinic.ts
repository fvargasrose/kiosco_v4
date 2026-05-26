/**
 * =============================================================================
 * Routes: /admin/clinic/*
 * =============================================================================
 *
 * Gestión de configuración de la clínica desde el panel admin.
 *
 * Endpoints:
 *   GET  /admin/clinic              — lee config pública + standby + logo
 *   PATCH /admin/clinic             — actualiza campos de texto/modo
 *   POST  /admin/clinic/standby-media  — sube GIF o video de standby
 *   DELETE /admin/clinic/standby-media — elimina el archivo de standby
 *   PUT  /admin/clinic/logo         — sube logo (PNG/JPG/WEBP, max 2MB)
 *   DELETE /admin/clinic/logo       — elimina el logo
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, unlinkSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../lib/auth-middleware.js';
import { config } from '../lib/config.js';

// Tipos de archivo permitidos para standby
const ALLOWED_MIME: Record<string, string> = {
  'image/gif':  'gif',
  'video/mp4':  'mp4',
  'video/webm': 'webm',
};

const MAX_BYTES = config.UPLOADS_MAX_BYTES;

// Logo de la clínica: límite más estricto y formatos solo de imagen
const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const LOGO_EXTS = ['png', 'jpg', 'webp'] as const;

// Resuelve el directorio de uploads relativo al CWD del proceso
function uploadsDir(): string {
  return path.resolve(process.cwd(), config.UPLOADS_DIR);
}

function standbyFilePath(ext: string): string {
  return path.join(uploadsDir(), `standby.${ext}`);
}

function logoFilePath(ext: string): string {
  return path.join(uploadsDir(), `clinic-logo.${ext}`);
}

// Calcula SHA-256 hex de un Buffer
function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Detecta el tipo real de imagen por magic bytes.
 * No confía en el mimetype declarado por el cliente (puede mentir).
 * Solo acepta PNG, JPEG y WEBP.
 */
function detectImageMime(buf: Buffer): { mime: string; ext: 'png' | 'jpg' | 'webp' } | null {
  if (buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }

  // WEBP: RIFF????WEBP (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

const PatchClinicBody = z.object({
  display_name:        z.string().min(1).max(100).optional(),
  standby_mode:        z.enum(['mensaje', 'gif', 'video']).optional(),
  standby_title:       z.string().max(120).optional().nullable(),
  standby_subtitle:    z.string().max(200).optional().nullable(),
  standby_video_sound: z.boolean().optional(),
  notification_email:  z.string().email().max(254).optional().nullable(),
});

// =============================================================================
// Procedimientos / Tratamientos (clinic_procedures)
// =============================================================================
// Dentalink solo acepta estas duraciones (validado empíricamente). Otras son
// redondeadas silenciosamente por /agendas y rechazadas por POST /citas.
const VALID_DURATIONS = [15, 30, 45, 60, 75, 90, 105, 120] as const;

const DurationSchema = z.number().int().refine(
  (n) => (VALID_DURATIONS as readonly number[]).includes(n),
  {
    message:
      'duration_minutes debe ser uno de: 15, 30, 45, 60, 75, 90, 105, 120 (limitación de la API de Dentalink)',
  },
);

const ProcedureCreateBody = z.object({
  name:             z.string().trim().min(1).max(100),
  duration_minutes: DurationSchema,
  description:      z.string().max(500).optional().nullable(),
  active:           z.boolean().optional(),
});

const ProcedureUpdateBody = z.object({
  name:             z.string().trim().min(1).max(100).optional(),
  duration_minutes: DurationSchema.optional(),
  description:      z.string().max(500).optional().nullable(),
  active:           z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────

export async function adminClinicRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /admin/clinic ──────────────────────────────────────────────────────
  app.get('/admin/clinic', { preHandler: requireAdmin }, async (_req, reply) => {
    const r = await db.query<{
      display_name: string;
      legal_name: string;
      nit: string;
      address: string | null;
      city: string | null;
      phone: string | null;
      email: string | null;
      standby_mode: string;
      standby_title: string | null;
      standby_subtitle: string | null;
      standby_media_path: string | null;
      standby_media_hash: string | null;
      standby_media_updated_at: string | null;
      standby_video_sound: boolean;
      logo_path: string | null;
      logo_hash: string | null;
      logo_mime: string | null;
      logo_updated_at: string | null;
      notification_email: string | null;
    }>(`
      SELECT display_name, legal_name, nit, address, city, phone, email,
             standby_mode, standby_title, standby_subtitle,
             standby_media_path, standby_media_hash, standby_media_updated_at,
             standby_video_sound,
             logo_path, logo_hash, logo_mime, logo_updated_at,
             notification_email
      FROM clinic WHERE id = 1
    `);
    const c = r.rows[0];
    if (!c) return reply.code(503).send({ error: 'NOT_CONFIGURED' });

    const hasMedia = !!(c.standby_media_path && existsSync(c.standby_media_path));
    const hasLogo  = !!(c.logo_path && existsSync(c.logo_path));

    return reply.send({
      display_name:     c.display_name,
      legal_name:       c.legal_name,
      nit:              c.nit,
      address:          c.address,
      city:             c.city,
      phone:            c.phone,
      email:            c.email,
      standby: {
        mode:             c.standby_mode,
        title:            c.standby_title,
        subtitle:         c.standby_subtitle,
        video_sound:      c.standby_video_sound,
        has_media:        hasMedia,
        media_hash:       hasMedia ? c.standby_media_hash : null,
        media_updated_at: hasMedia ? c.standby_media_updated_at : null,
      },
      logo: {
        has:        hasLogo,
        hash:       hasLogo ? c.logo_hash : null,
        mime:       hasLogo ? c.logo_mime : null,
        updated_at: hasLogo ? c.logo_updated_at : null,
      },
      notification_email: c.notification_email,
    });
  });

  // ── PATCH /admin/clinic ────────────────────────────────────────────────────
  app.patch('/admin/clinic', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = PatchClinicBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const {
      display_name,
      standby_mode,
      standby_title,
      standby_subtitle,
      standby_video_sound,
      notification_email,
    } = parsed.data;

    // Si se cambia a "mensaje", borramos el media (ya no aplica)
    const clearMedia = standby_mode === 'mensaje';

    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [];
    let idx = 1;

    if (display_name !== undefined)     { sets.push(`display_name = $${idx++}`);       vals.push(display_name); }
    if (standby_mode !== undefined)     { sets.push(`standby_mode = $${idx++}`);       vals.push(standby_mode); }
    if (standby_title !== undefined)    { sets.push(`standby_title = $${idx++}`);      vals.push(standby_title); }
    if (standby_subtitle !== undefined) { sets.push(`standby_subtitle = $${idx++}`);   vals.push(standby_subtitle); }
    if (standby_video_sound !== undefined) { sets.push(`standby_video_sound = $${idx++}`); vals.push(standby_video_sound); }
    if (notification_email !== undefined) { sets.push(`notification_email = $${idx++}`); vals.push(notification_email); }
    if (clearMedia) {
      sets.push(`standby_media_path = NULL`);
      sets.push(`standby_media_hash = NULL`);
      sets.push(`standby_media_updated_at = NULL`);
    }

    await db.query(`UPDATE clinic SET ${sets.join(', ')} WHERE id = 1`, vals);
    return reply.send({ ok: true });
  });

  // ── POST /admin/clinic/standby-media ──────────────────────────────────────
  // Recibe un archivo multipart (GIF, MP4 o WEBM).
  app.post(
    '/admin/clinic/standby-media',
    { preHandler: requireAdmin },
    async (req, reply) => {
      // @fastify/multipart inyecta req.file()
      const data = await (req as any).file();
      if (!data) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Se requiere un archivo.' });
      }

      const mime: string = data.mimetype ?? '';
      const ext = ALLOWED_MIME[mime];
      if (!ext) {
        data.file.resume(); // drenar el stream para no dejar la conexión colgada
        return reply.code(400).send({
          error: 'INVALID_FILE_TYPE',
          message: `Tipo de archivo no permitido (${mime}). Usa GIF, MP4 o WebM.`,
        });
      }

      // Validar modo actual: gif solo acepta image/gif, video acepta mp4/webm
      const modeRes = await db.query<{ standby_mode: string }>(
        `SELECT standby_mode FROM clinic WHERE id = 1`
      );
      const mode = modeRes.rows[0]?.standby_mode ?? 'mensaje';
      if (mode === 'gif' && mime !== 'image/gif') {
        data.file.resume();
        return reply.code(400).send({
          error: 'MODE_MISMATCH',
          message: 'El modo actual es "gif". Sube un archivo GIF.',
        });
      }
      if (mode === 'video' && mime === 'image/gif') {
        data.file.resume();
        return reply.code(400).send({
          error: 'MODE_MISMATCH',
          message: 'El modo actual es "video". Sube un MP4 o WebM.',
        });
      }

      // Leer el stream a Buffer con límite de tamaño
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;

      for await (const chunk of data.file) {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          tooLarge = true;
          break;
        }
        chunks.push(chunk);
      }

      if (tooLarge) {
        return reply.code(413).send({
          error: 'FILE_TOO_LARGE',
          message: `El archivo supera el límite de ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
        });
      }

      const buf = Buffer.concat(chunks);
      const hash = sha256hex(buf);
      const filePath = standbyFilePath(ext);

      // Borrar archivos anteriores de otros formatos
      await mkdir(uploadsDir(), { recursive: true });
      for (const oldExt of Object.values(ALLOWED_MIME)) {
        const p = standbyFilePath(oldExt);
        if (p !== filePath && existsSync(p)) {
          try { unlinkSync(p); } catch { /* ignorar */ }
        }
      }

      // Escribir nuevo archivo
      const ws = createWriteStream(filePath);
      await pipeline(
        (async function* () { yield buf; })(),
        ws,
      );

      await db.query(
        `UPDATE clinic
         SET standby_media_path = $1,
             standby_media_hash = $2,
             standby_media_updated_at = now(),
             updated_at = now()
         WHERE id = 1`,
        [filePath, hash],
      );

      logger.info({ ext, bytes: buf.length, hash }, 'Standby media uploaded');
      return reply.code(201).send({ ok: true, hash, bytes: buf.length, ext });
    },
  );

  // ── GET /admin/clinic/standby-media ──────────────────────────────────────
  // Permite que el panel admin descargue/previsualice el archivo actual.
  app.get(
    '/admin/clinic/standby-media',
    { preHandler: requireAdmin },
    async (_req, reply) => {
      const r = await db.query<{ standby_media_path: string | null; standby_mode: string }>(
        `SELECT standby_media_path, standby_mode FROM clinic WHERE id = 1`
      );
      const row = r.rows[0];
      if (!row?.standby_media_path || !existsSync(row.standby_media_path)) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      const ext = path.extname(row.standby_media_path).slice(1);
      const mime = ext === 'gif' ? 'image/gif' : ext === 'webm' ? 'video/webm' : 'video/mp4';
      reply.header('Content-Type', mime);
      reply.header('Cache-Control', 'private, max-age=0');
      return reply.send(createReadStream(row.standby_media_path));
    },
  );

  // ── DELETE /admin/clinic/standby-media ────────────────────────────────────
  app.delete(
    '/admin/clinic/standby-media',
    { preHandler: requireAdmin },
    async (_req, reply) => {
      const r = await db.query<{ standby_media_path: string | null }>(
        `SELECT standby_media_path FROM clinic WHERE id = 1`
      );
      const p = r.rows[0]?.standby_media_path;
      if (p && existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignorar */ }
      }
      await db.query(
        `UPDATE clinic
         SET standby_media_path = NULL,
             standby_media_hash = NULL,
             standby_media_updated_at = NULL,
             standby_mode = 'mensaje',
             updated_at = now()
         WHERE id = 1`,
      );
      return reply.send({ ok: true });
    },
  );

  // ===========================================================================
  // Logo de la clínica
  // ===========================================================================

  // ── PUT /admin/clinic/logo ────────────────────────────────────────────────
  // Recibe un archivo multipart (PNG, JPG o WEBP, max 2 MB).
  // Valida el tipo por magic bytes — el mimetype declarado no es confiable.
  app.put(
    '/admin/clinic/logo',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const data = await (req as any).file();
      if (!data) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Se requiere un archivo.' });
      }

      // Leer el stream a Buffer con corte explícito en LOGO_MAX_BYTES
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;

      for await (const chunk of data.file) {
        totalBytes += chunk.length;
        if (totalBytes > LOGO_MAX_BYTES) {
          tooLarge = true;
          break;
        }
        chunks.push(chunk);
      }

      if (tooLarge) {
        return reply.code(413).send({
          error: 'FILE_TOO_LARGE',
          message: `El logo supera el límite de ${Math.round(LOGO_MAX_BYTES / 1024 / 1024)} MB.`,
        });
      }

      const buf = Buffer.concat(chunks);
      const detected = detectImageMime(buf);
      if (!detected) {
        return reply.code(400).send({
          error: 'INVALID_FILE_TYPE',
          message: 'Tipo de archivo no permitido. Solo se aceptan PNG, JPG o WEBP.',
        });
      }

      const { mime, ext } = detected;
      const hash = sha256hex(buf);
      const filePath = logoFilePath(ext);

      // Borrar archivos previos de otras extensiones
      await mkdir(uploadsDir(), { recursive: true });
      for (const oldExt of LOGO_EXTS) {
        const p = logoFilePath(oldExt);
        if (p !== filePath && existsSync(p)) {
          try { unlinkSync(p); } catch { /* ignorar */ }
        }
      }

      const ws = createWriteStream(filePath);
      await pipeline(
        (async function* () { yield buf; })(),
        ws,
      );

      await db.query(
        `UPDATE clinic
         SET logo_path = $1,
             logo_hash = $2,
             logo_mime = $3,
             logo_updated_at = now(),
             updated_at = now()
         WHERE id = 1`,
        [filePath, hash, mime],
      );

      logger.info({ ext, mime, bytes: buf.length, hash }, 'Clinic logo uploaded');
      return reply.code(200).send({ ok: true, hash, bytes: buf.length, ext, mime });
    },
  );

  // ── DELETE /admin/clinic/logo ─────────────────────────────────────────────
  app.delete(
    '/admin/clinic/logo',
    { preHandler: requireAdmin },
    async (_req, reply) => {
      const r = await db.query<{ logo_path: string | null }>(
        `SELECT logo_path FROM clinic WHERE id = 1`,
      );
      const p = r.rows[0]?.logo_path;
      if (p && existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignorar */ }
      }
      await db.query(
        `UPDATE clinic
         SET logo_path = NULL,
             logo_hash = NULL,
             logo_mime = NULL,
             logo_updated_at = NULL,
             updated_at = now()
         WHERE id = 1`,
      );
      return reply.send({ ok: true });
    },
  );

  // ===========================================================================
  // Procedimientos / Tratamientos
  // ===========================================================================

  // ── GET /admin/procedures — lista todos (activos + inactivos) ──────────────
  app.get('/admin/procedures', { preHandler: requireAdmin }, async (_req, reply) => {
    const r = await db.query<{
      id: string;
      name: string;
      duration_minutes: number;
      description: string | null;
      active: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, duration_minutes, description, active, created_at, updated_at
       FROM clinic_procedures
       WHERE clinic_id = 1
       ORDER BY active DESC, name ASC`,
    );
    return reply.send({ data: r.rows, total: r.rows.length });
  });

  // ── POST /admin/procedures — crear ────────────────────────────────────────
  app.post('/admin/procedures', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ProcedureCreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Datos inválidos',
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const { name, duration_minutes, description, active } = parsed.data;

    const r = await db.query<{ id: string }>(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes, description, active)
       VALUES (1, $1, $2, $3, COALESCE($4, true))
       RETURNING id`,
      [name, duration_minutes, description ?? null, active ?? null],
    );

    logger.info(
      { id: r.rows[0]?.id, name, duration_minutes },
      'Procedure created',
    );
    return reply.code(201).send({ ok: true, id: r.rows[0]?.id });
  });

  // ── PUT /admin/procedures/:id — actualizar ────────────────────────────────
  app.put<{ Params: { id: string } }>(
    '/admin/procedures/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = ProcedureUpdateBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: parsed.error.issues[0]?.message ?? 'Datos inválidos',
          details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }

      const sets: string[] = ['updated_at = now()'];
      const vals: unknown[] = [];
      let idx = 1;
      if (parsed.data.name !== undefined) {
        sets.push(`name = $${idx++}`);
        vals.push(parsed.data.name);
      }
      if (parsed.data.duration_minutes !== undefined) {
        sets.push(`duration_minutes = $${idx++}`);
        vals.push(parsed.data.duration_minutes);
      }
      if (parsed.data.description !== undefined) {
        sets.push(`description = $${idx++}`);
        vals.push(parsed.data.description);
      }
      if (parsed.data.active !== undefined) {
        sets.push(`active = $${idx++}`);
        vals.push(parsed.data.active);
      }
      vals.push(id);

      const r = await db.query<{ id: string }>(
        `UPDATE clinic_procedures SET ${sets.join(', ')}
         WHERE id = $${idx} AND clinic_id = 1
         RETURNING id`,
        vals,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      return reply.send({ ok: true });
    },
  );

  // ── DELETE /admin/procedures/:id — soft delete ────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/procedures/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params;
      const r = await db.query(
        `UPDATE clinic_procedures
         SET active = false, updated_at = now()
         WHERE id = $1 AND clinic_id = 1`,
        [id],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
      return reply.send({ ok: true });
    },
  );
}
