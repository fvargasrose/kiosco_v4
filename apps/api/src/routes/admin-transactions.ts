/**
 * =============================================================================
 * Routes: /admin/transactions/*
 * =============================================================================
 *
 * Vista de transacciones de pago para el panel admin.
 *
 * Endpoints:
 *   GET /admin/transactions   — lista paginada con filtros por status y fecha
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAdmin } from '../lib/auth-middleware.js';

// ─────────────────────────────────────────────────────────────────────────────

const TX_STATUSES = ['pending', 'approved', 'declined', 'voided', 'error', 'expired'] as const;

const QuerySchema = z.object({
  status:   z.enum(TX_STATUSES).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page:      z.coerce.number().int().min(1).default(1),
  per_page:  z.coerce.number().int().min(1).max(100).default(20),
});

// ─────────────────────────────────────────────────────────────────────────────

export async function adminTransactionRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /admin/transactions ────────────────────────────────────────────────
  app.get('/admin/transactions', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
    }

    const { status, date_from, date_to, page, per_page } = parsed.data;
    const offset = (page - 1) * per_page;

    // Construir WHERE dinámico
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (status) {
      conditions.push(`t.status = $${idx++}`);
      values.push(status);
    }
    if (date_from) {
      conditions.push(`t.created_at >= $${idx++}::date`);
      values.push(date_from);
    }
    if (date_to) {
      // Incluir el día completo de date_to
      conditions.push(`t.created_at < ($${idx++}::date + interval '1 day')`);
      values.push(date_to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Total (para paginación)
    const countResult = await db.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM transactions t ${where}`,
      values,
    );
    const total = parseInt(countResult.rows[0]!.total, 10);

    // Datos paginados con nombre del kiosco
    const dataValues = [...values, per_page, offset];
    const limitIdx  = idx;
    const offsetIdx = idx + 1;

    const { rows } = await db.query<{
      id: string;
      wompi_reference: string;
      amount_cop: string;
      status: string;
      status_message: string | null;
      patient_phone_masked: string | null;
      patient_email_masked: string | null;
      dentalink_patient_id: string;
      dentalink_treatment_id: string | null;
      wompi_payment_method_type: string | null;
      receipt_sent_at: string | null;
      created_at: string;
      approved_at: string | null;
      expires_at: string | null;
      kiosk_id: string | null;
      kiosk_name: string | null;
    }>(
      `SELECT
         t.id,
         t.wompi_reference,
         t.amount_cop::text,
         t.status,
         t.status_message,
         t.patient_phone_masked,
         t.patient_email_masked,
         t.dentalink_patient_id,
         t.dentalink_treatment_id,
         t.wompi_payment_method_type,
         t.receipt_sent_at,
         t.created_at,
         t.approved_at,
         t.expires_at,
         t.kiosk_id,
         k.name AS kiosk_name
       FROM transactions t
       LEFT JOIN kiosks k ON k.id = t.kiosk_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      dataValues,
    );

    return reply.send({
      data: rows.map((r) => ({
        ...r,
        amount_cop: parseInt(r.amount_cop, 10),
      })),
      total,
      page,
      per_page,
      pages: Math.ceil(total / per_page),
    });
  });
}
