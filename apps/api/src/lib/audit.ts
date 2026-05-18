/**
 * =============================================================================
 * Audit log - Helper para registrar eventos en la tabla inmutable
 * =============================================================================
 *
 * USO:
 *   await audit({
 *     actorType: 'admin',
 *     actorId: adminId,
 *     action: 'admin.login.success',
 *     metadata: { method: 'password+totp' },
 *     ip: '1.2.3.4',
 *   });
 *
 * NUNCA fallar la operación principal si el audit log falla.
 * Sólo loguear el error de audit y continuar.
 */

import { db } from './db.js';
import { logger } from './logger.js';

export type ActorType =
  | 'admin'
  | 'kiosk'
  | 'patient'
  | 'system'
  | 'webhook'
  | 'license_server'
  | 'support';

export type AuditResult = 'success' | 'failure' | 'denied' | 'error';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  result?: AuditResult;
  errorMessage?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Registra una entrada en audit_log.
 * Es "fire-and-forget" desde la perspectiva del caller — nunca tira.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (
        actor_type, actor_id, actor_email, actor_ip, actor_user_agent,
        action, resource_type, resource_id, metadata, result, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.actorType,
        entry.actorId ?? null,
        entry.actorEmail ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.result ?? 'success',
        entry.errorMessage ?? null,
      ],
    );
  } catch (err) {
    // No falle la operación principal por culpa del audit.
    logger.error(
      { err, action: entry.action, actorType: entry.actorType },
      'Failed to write audit entry',
    );
  }
}
