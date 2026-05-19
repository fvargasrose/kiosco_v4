/**
 * =============================================================================
 * Routes: /admin/dashboard
 * =============================================================================
 *
 * Métricas resumidas para la pantalla de inicio del panel admin.
 *
 * Endpoints:
 *   GET /admin/dashboard   — kioscos activos, pagos del día, últimas transacciones
 */

import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAdmin } from '../lib/auth-middleware.js';

// ─────────────────────────────────────────────────────────────────────────────

export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /admin/dashboard ───────────────────────────────────────────────────
  app.get('/admin/dashboard', { preHandler: requireAdmin }, async (_req, reply) => {
    // Una sola consulta con CTEs para minimizar round-trips
    const { rows } = await db.query<{
      kiosks_total: string;
      kiosks_active: string;
      tx_today_total: string;
      tx_today_approved: string;
      tx_today_amount_cop: string;
      tx_pending_total: string;
    }>(`
      WITH
        kiosk_stats AS (
          SELECT
            COUNT(*)                            AS kiosks_total,
            COUNT(*) FILTER (WHERE is_active)   AS kiosks_active
          FROM kiosks
        ),
        tx_today AS (
          SELECT
            COUNT(*)                                        AS tx_today_total,
            COUNT(*) FILTER (WHERE status = 'approved')     AS tx_today_approved,
            COALESCE(SUM(amount_cop) FILTER (WHERE status = 'approved'), 0)
                                                            AS tx_today_amount_cop
          FROM transactions
          WHERE created_at >= CURRENT_DATE
        ),
        tx_pending AS (
          SELECT COUNT(*) AS tx_pending_total
          FROM transactions
          WHERE status = 'pending'
        )
      SELECT
        k.kiosks_total,
        k.kiosks_active,
        t.tx_today_total,
        t.tx_today_approved,
        t.tx_today_amount_cop,
        p.tx_pending_total
      FROM kiosk_stats k, tx_today t, tx_pending p
    `);

    const stats = rows[0]!;

    // Últimas 10 transacciones para la tabla del dashboard
    const recent = await db.query<{
      id: string;
      wompi_reference: string;
      amount_cop: string;
      status: string;
      patient_phone_masked: string | null;
      patient_email_masked: string | null;
      wompi_payment_method_type: string | null;
      created_at: string;
      kiosk_name: string | null;
    }>(`
      SELECT
        t.id,
        t.wompi_reference,
        t.amount_cop::text,
        t.status,
        t.patient_phone_masked,
        t.patient_email_masked,
        t.wompi_payment_method_type,
        t.created_at,
        k.name AS kiosk_name
      FROM transactions t
      LEFT JOIN kiosks k ON k.id = t.kiosk_id
      ORDER BY t.created_at DESC
      LIMIT 10
    `);

    return reply.send({
      kiosks: {
        total:  parseInt(stats.kiosks_total,  10),
        active: parseInt(stats.kiosks_active, 10),
      },
      today: {
        transactions: parseInt(stats.tx_today_total,      10),
        approved:     parseInt(stats.tx_today_approved,   10),
        amount_cop:   parseInt(stats.tx_today_amount_cop, 10),
      },
      pending_transactions: parseInt(stats.tx_pending_total, 10),
      recent_transactions: recent.rows.map((r) => ({
        ...r,
        amount_cop: parseInt(r.amount_cop, 10),
      })),
    });
  });
}
