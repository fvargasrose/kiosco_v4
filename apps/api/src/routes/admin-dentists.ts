/**
 * =============================================================================
 * Routes: /admin/dentists/* + /public/dentist-photo/:id
 * =============================================================================
 *
 * Gestión de fotos de odontólogos desde el panel admin.
 *
 * Endpoints:
 *   GET    /admin/dentists              — lista dentistas (Dentalink) + foto local
 *   POST   /admin/dentists/:id/photo   — sube/reemplaza foto de un dentista
 *   DELETE /admin/dentists/:id/photo   — elimina foto de un dentista
 *   GET    /public/dentist-photo/:id   — sirve la foto sin auth (para <img src>)
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink } from '../lib/dentalink.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../lib/auth-middleware.js';
import { config } from '../lib/config.js';

const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB para fotos de odontólogos
const ALLOWED_PHOTO_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

function dentistsDir(): string {
  return path.resolve(process.cwd(), config.UPLOADS_DIR, 'dentists');
}

function photoFilePath(dentistId: string, ext: string): string {
  // Sanitize dentistId to prevent path traversal
  const safe = dentistId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dentistsDir(), `photo_${safe}.${ext}`);
}

async function getDentalinkToken(): Promise<string | null> {
  const r = await db.query<{ dentalink_token_encrypted: Buffer | null }>(
    `SELECT dentalink_token_encrypted FROM clinic WHERE id = 1`,
  );
  return decrypt(r.rows[0]?.dentalink_token_encrypted ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function adminDentistRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /admin/dentists ────────────────────────────────────────────────────
  // Retorna todos los odontólogos habilitados en Dentalink, enriquecidos con
  // los metadatos de foto guardados localmente.
  app.get('/admin/dentists', { preHandler: requireAdmin }, async (_req, reply) => {
    const token = await getDentalinkToken();
    let dentists;
    try {
      dentists = await dentalink.getAllDentists(token);
    } catch (err) {
      logger.error({ err }, 'admin-dentists: getAllDentists failed');
      return reply.code(502).send({ error: 'UPSTREAM_ERROR', message: 'Error al consultar Dentalink.' });
    }

    // Cargar fotos locales de una sola consulta
    const ids = dentists.map((d) => d.id);
    const photos = ids.length > 0
      ? await db.query<{ dentalink_dentist_id: string; photo_hash: string; uploaded_at: string }>(
          `SELECT dentalink_dentist_id, photo_hash, uploaded_at
           FROM dentist_photos
           WHERE dentalink_dentist_id = ANY($1)`,
          [ids],
        )
      : { rows: [] };

    const photoMap = new Map(photos.rows.map((p) => [p.dentalink_dentist_id, p]));

    const data = dentists.map((d) => {
      const photo = photoMap.get(d.id);
      return {
        id:           d.id,
        nombre:       d.nombre,
        apellido:     d.apellido ?? null,
        especialidad: d.especialidad ?? null,
        id_sucursal:  d.id_sucursal,
        has_photo:    !!photo,
        photo_hash:   photo?.photo_hash ?? null,
        photo_updated_at: photo?.uploaded_at ?? null,
        photo_url:    photo ? `/public/dentist-photo/${encodeURIComponent(d.id)}` : null,
      };
    });

    return reply.send({ data, total: data.length });
  });

  // ── POST /admin/dentists/:id/photo ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/admin/dentists/:id/photo',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const dentistId = req.params.id;
      if (!dentistId || !/^[\w-]+$/.test(dentistId)) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'ID de dentista inválido.' });
      }

      const data = await (req as any).file();
      if (!data) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Se requiere un archivo de imagen.' });
      }

      const mime: string = data.mimetype ?? '';
      const ext = ALLOWED_PHOTO_MIME[mime];
      if (!ext) {
        data.file.resume();
        return reply.code(400).send({
          error: 'INVALID_FILE_TYPE',
          message: `Tipo no permitido (${mime}). Usa JPEG, PNG o WebP.`,
        });
      }

      // Leer stream con límite de tamaño
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let tooLarge = false;
      for await (const chunk of data.file) {
        totalBytes += chunk.length;
        if (totalBytes > PHOTO_MAX_BYTES) { tooLarge = true; break; }
        chunks.push(chunk);
      }
      if (tooLarge) {
        return reply.code(413).send({ error: 'FILE_TOO_LARGE', message: 'La foto no puede superar 5 MB.' });
      }

      const buf  = Buffer.concat(chunks);
      const hash = createHash('sha256').update(buf).digest('hex');

      await mkdir(dentistsDir(), { recursive: true });

      // Borrar fotos anteriores de este dentista (cualquier extensión)
      for (const oldExt of Object.values(ALLOWED_PHOTO_MIME)) {
        const old = photoFilePath(dentistId, oldExt);
        if (existsSync(old)) { try { unlinkSync(old); } catch { /* ignorar */ } }
      }

      // Guardar nueva foto
      const filePath = photoFilePath(dentistId, ext);
      await import('node:fs/promises').then((fs) => fs.writeFile(filePath, buf));

      // Upsert en BD
      await db.query(
        `INSERT INTO dentist_photos (dentalink_dentist_id, photo_path, photo_hash, uploaded_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (dentalink_dentist_id)
         DO UPDATE SET photo_path = $2, photo_hash = $3, uploaded_at = now()`,
        [dentistId, filePath, hash],
      );

      logger.info({ dentistId, bytes: buf.length, hash }, 'Dentist photo uploaded');
      return reply.code(201).send({ ok: true, hash, bytes: buf.length });
    },
  );

  // ── DELETE /admin/dentists/:id/photo ──────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/admin/dentists/:id/photo',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const dentistId = req.params.id;
      const r = await db.query<{ photo_path: string }>(
        `SELECT photo_path FROM dentist_photos WHERE dentalink_dentist_id = $1`,
        [dentistId],
      );
      const p = r.rows[0]?.photo_path;
      if (p && existsSync(p)) { try { unlinkSync(p); } catch { /* ignorar */ } }
      await db.query(
        `DELETE FROM dentist_photos WHERE dentalink_dentist_id = $1`,
        [dentistId],
      );
      return reply.send({ ok: true });
    },
  );

  // ── GET /public/dentist-photo/:id ─────────────────────────────────────────
  // Endpoint público (sin auth) para servir fotos de odontólogos.
  // Las fotos de odontólogos no son información sensible y se muestran en el
  // kiosco (pantalla pública) y en el panel admin.
  app.get<{ Params: { id: string } }>(
    '/public/dentist-photo/:id',
    async (req, reply) => {
      const dentistId = req.params.id;
      const r = await db.query<{ photo_path: string }>(
        `SELECT photo_path FROM dentist_photos WHERE dentalink_dentist_id = $1`,
        [dentistId],
      );
      const filePath = r.rows[0]?.photo_path;
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }

      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mimeMap: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
      const mime = mimeMap[ext] ?? 'image/jpeg';

      reply.header('Content-Type', mime);
      reply.header('Cache-Control', 'public, max-age=3600');
      return reply.send(createReadStream(filePath));
    },
  );
}
