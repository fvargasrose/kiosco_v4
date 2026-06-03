/**
 * =============================================================================
 * Tests integración: sendPaymentReceipt + notificación al administrador
 * =============================================================================
 *
 * Cubre el nuevo flujo: además del recibo al paciente, si la clínica tiene
 * `notification_email` configurado, se envía un email enriquecido al admin.
 *
 * Reglas validadas:
 *   - notification_email = null → cae al fallback CORREO_NOTIFICACION (.env) si
 *     está configurado; si no, no se envía al admin (sin error en logs).
 *   - notification_email seteado (distinto del remitente) → ambos correos salen.
 *   - Si el envío al admin lanza, receipt_sent_at del paciente se persiste igual.
 *   - El email del paciente aparece ENMASCARADO en el body del admin.
 *   - Idempotencia: si receipt_sent_at != null, segunda invocación es no-op.
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { setEmailSender, type EmailSender } from '../src/lib/email.js';
import { setSmsSender, type SmsSender } from '../src/lib/sms.js';
import { sendPaymentReceipt, resolveAdminEmail, sendWithTimeout } from '../src/lib/notifications.js';
import { randomUUID } from 'crypto';

// Paciente mock '12345' tiene email maria.perez@demo.local, celular +573001234567.
// Tratamiento 'tx-001' es Ortodoncia con saldo_pendiente=1500000.
const MOCK_PATIENT_ID = '12345';
const MOCK_TREATMENT_ID = 'tx-001';

const captured: {
  emails: Array<{ to: string; subject: string; html: string; text?: string }>;
  sms: Array<{ to: string; body: string }>;
  failOn: Set<string>; // emails que deben lanzar al enviar (por destinatario)
} = { emails: [], sms: [], failOn: new Set() };

const mockEmail: EmailSender = {
  async send(input) {
    if (captured.failOn.has(input.to)) {
      throw new Error(`mock failure for ${input.to}`);
    }
    captured.emails.push({ to: input.to, subject: input.subject, html: input.html, text: input.text });
    return { id: `mock-email-${Date.now()}` };
  },
};

const mockSms: SmsSender = {
  async send(to, body) {
    captured.sms.push({ to, body });
    return { sid: `mock-sms-${Date.now()}` };
  },
};

function makeReference(): string {
  return `DK-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function insertApprovedTx(opts: {
  reference: string;
  treatmentId?: string | null;
  amountCop?: number;
}): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO transactions (
       dentalink_patient_id, dentalink_treatment_id,
       patient_phone_masked, patient_email_masked,
       wompi_reference, wompi_transaction_id, wompi_payment_method_type,
       amount_cop, status, approved_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', now())
     RETURNING id`,
    [
      MOCK_PATIENT_ID,
      opts.treatmentId === undefined ? MOCK_TREATMENT_ID : opts.treatmentId,
      '+57***67',
      'ma***@demo.local',
      opts.reference,
      `wompi-tx-${randomUUID()}`,
      'NEQUI',
      opts.amountCop ?? 100000,
    ],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  setEmailSender(mockEmail);
  setSmsSender(mockSms);

  // Asegurar clinic singleton
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key)
       VALUES (1, 'Notif Test Clinic', 'Notif Test', '900111222', 'TEST')`,
    );
  }
});

afterAll(async () => {
  // Limpia transactions de prueba (no tocamos clinic)
  await db.query(
    `DELETE FROM transactions WHERE wompi_reference LIKE 'DK-test-%'`,
  );
  await db.query(`UPDATE clinic SET notification_email = NULL WHERE id = 1`);
});

beforeEach(() => {
  captured.emails.length = 0;
  captured.sms.length = 0;
  captured.failOn.clear();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('sendPaymentReceipt — notificación al admin', () => {
  it('con notification_email NULL, cae al fallback CORREO_NOTIFICACION (o solo paciente si no hay fallback)', async () => {
    await db.query(`UPDATE clinic SET notification_email = NULL WHERE id = 1`);

    const reference = makeReference();
    await insertApprovedTx({ reference });

    await sendPaymentReceipt({ reference });

    const fallback = config.CORREO_NOTIFICACION ?? null;
    if (fallback) {
      // Paciente + admin al fallback del .env
      const tos = captured.emails.map((e) => e.to).sort();
      expect(captured.emails).toHaveLength(2);
      expect(tos).toContain('maria.perez@demo.local');
      expect(tos).toContain(fallback);
    } else {
      // Sin fallback configurado: solo el paciente recibe
      expect(captured.emails).toHaveLength(1);
      expect(captured.emails[0]!.to).toBe('maria.perez@demo.local');
    }
    expect(captured.sms).toHaveLength(1);
  });

  it('envía al admin cuando notification_email está configurado', async () => {
    await db.query(
      `UPDATE clinic SET notification_email = 'admin@clinica.test' WHERE id = 1`,
    );

    const reference = makeReference();
    await insertApprovedTx({ reference });

    await sendPaymentReceipt({ reference });

    // Paciente + admin
    const tos = captured.emails.map((e) => e.to).sort();
    expect(tos).toEqual(['admin@clinica.test', 'maria.perez@demo.local']);

    const adminEmail = captured.emails.find((e) => e.to === 'admin@clinica.test');
    expect(adminEmail).toBeTruthy();
    expect(adminEmail!.subject).toMatch(/Comprobante de pago/);
    expect(adminEmail!.subject).toMatch(/—\s+\$\s*100\.000/); // monto en el subject
  });

  it('email del paciente aparece enmascarado en el body del admin', async () => {
    await db.query(
      `UPDATE clinic SET notification_email = 'admin@clinica.test' WHERE id = 1`,
    );

    const reference = makeReference();
    await insertApprovedTx({ reference });

    await sendPaymentReceipt({ reference });

    const adminEmail = captured.emails.find((e) => e.to === 'admin@clinica.test');
    expect(adminEmail).toBeTruthy();
    // maskEmail produce "ma***@demo.local" para maria.perez@demo.local
    expect(adminEmail!.html).toContain('ma***@demo.local');
    // El email completo NUNCA debe aparecer
    expect(adminEmail!.html).not.toContain('maria.perez@demo.local');
    // Phone enmascarado también
    expect(adminEmail!.html).toMatch(/\+57\*+/);
  });

  it('incluye nombre del tratamiento y saldos cuando Dentalink responde', async () => {
    await db.query(
      `UPDATE clinic SET notification_email = 'admin@clinica.test' WHERE id = 1`,
    );

    const reference = makeReference();
    await insertApprovedTx({ reference, treatmentId: MOCK_TREATMENT_ID, amountCop: 100000 });

    await sendPaymentReceipt({ reference });

    const adminEmail = captured.emails.find((e) => e.to === 'admin@clinica.test');
    expect(adminEmail!.html).toContain('Ortodoncia');
    // Saldo después = 1500000 (mock); saldo antes = 1500000 + 100000 = 1600000
    expect(adminEmail!.html).toContain('1.500.000');
    expect(adminEmail!.html).toContain('1.600.000');
  });

  it('si el envío al admin falla, el paciente igual recibe Y receipt_sent_at persiste', async () => {
    await db.query(
      `UPDATE clinic SET notification_email = 'broken@clinica.test' WHERE id = 1`,
    );
    captured.failOn.add('broken@clinica.test');

    const reference = makeReference();
    const txId = await insertApprovedTx({ reference });

    const result = await sendPaymentReceipt({ reference });

    // El paciente sí recibió (no falla porque su sender es OK)
    expect(result.emailSent).toBe(true);
    expect(captured.emails.some((e) => e.to === 'maria.perez@demo.local')).toBe(true);
    // El admin NO está capturado (lanzó), pero la función no propagó el error
    expect(captured.emails.some((e) => e.to === 'broken@clinica.test')).toBe(false);

    // receipt_sent_at se actualizó (idempotencia intacta)
    const r = await db.query<{ receipt_sent_at: Date | null }>(
      `SELECT receipt_sent_at FROM transactions WHERE id = $1`,
      [txId],
    );
    expect(r.rows[0]?.receipt_sent_at).not.toBeNull();
  });

  it('idempotencia: segunda llamada con receipt_sent_at != null es no-op para ambos', async () => {
    await db.query(
      `UPDATE clinic SET notification_email = 'admin@clinica.test' WHERE id = 1`,
    );

    const reference = makeReference();
    await insertApprovedTx({ reference });

    await sendPaymentReceipt({ reference });
    expect(captured.emails).toHaveLength(2); // paciente + admin

    // Segunda invocación: skip total
    await sendPaymentReceipt({ reference });
    expect(captured.emails).toHaveLength(2); // no se añade nada
  });

  it('pago sin tratamiento: email al admin sale sin sección de saldos', async () => {
    await db.query(
      `UPDATE clinic SET notification_email = 'admin@clinica.test' WHERE id = 1`,
    );

    const reference = makeReference();
    await insertApprovedTx({ reference, treatmentId: null });

    await sendPaymentReceipt({ reference });

    const adminEmail = captured.emails.find((e) => e.to === 'admin@clinica.test');
    expect(adminEmail).toBeTruthy();
    expect(adminEmail!.html).toContain('Pago sin tratamiento asociado');
    // No debe haber filas de saldo
    expect(adminEmail!.html).not.toContain('Saldo antes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: resolveAdminEmail — destinatario del correo a la clínica con fallback.
// Regla acordada: usar el email del panel; si está vacío O coincide con el
// remitente (SENDER_EMAIL → loop from==to), usar CORREO_NOTIFICACION (.env).
// Si tras el fallback el destinatario sigue siendo == SENDER, no enviar (null).
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAdminEmail — fallback panel / CORREO_NOTIFICACION', () => {
  const SENDER = 'notificaciones@2ways.us';
  const FALLBACK = 'fabiavargas@gmail.com';

  it('panel con valor distinto del remitente → usa el del panel', () => {
    expect(resolveAdminEmail('recepcion@clinica.test', SENDER, FALLBACK)).toBe(
      'recepcion@clinica.test',
    );
  });

  it('panel null → usa el fallback (CORREO_NOTIFICACION)', () => {
    expect(resolveAdminEmail(null, SENDER, FALLBACK)).toBe(FALLBACK);
  });

  it('panel vacío ("") → usa el fallback', () => {
    expect(resolveAdminEmail('', SENDER, FALLBACK)).toBe(FALLBACK);
  });

  it('panel == SENDER (loop from==to) → usa el fallback', () => {
    expect(resolveAdminEmail(SENDER, SENDER, FALLBACK)).toBe(FALLBACK);
  });

  it('panel == SENDER ignorando mayúsculas → usa el fallback', () => {
    expect(resolveAdminEmail('Notificaciones@2Ways.US', SENDER, FALLBACK)).toBe(FALLBACK);
  });

  it('panel == SENDER y fallback == SENDER → null (evita loop garantizado)', () => {
    expect(resolveAdminEmail(SENDER, SENDER, SENDER)).toBeNull();
  });

  it('panel null y fallback == SENDER → null', () => {
    expect(resolveAdminEmail(null, SENDER, SENDER)).toBeNull();
  });

  it('todo null/sin configurar → null', () => {
    expect(resolveAdminEmail(null, null, null)).toBeNull();
  });

  it('sin SENDER (null) y panel con valor → usa el panel sin comparar', () => {
    expect(resolveAdminEmail('admin@clinica.test', null, FALLBACK)).toBe(
      'admin@clinica.test',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit: sendWithTimeout — un SMTP que se cuelga no debe colgar la tarea.
// Debe rechazar al expirar el timeout (deja rastro vía el try/catch del caller).
// ─────────────────────────────────────────────────────────────────────────────

describe('sendWithTimeout — corta envíos colgados', () => {
  it('rechaza si el sender nunca resuelve (timeout)', async () => {
    const hangingSender: EmailSender = {
      send() {
        return new Promise<{ id: string }>(() => {
          /* nunca resuelve */
        });
      },
    };

    await expect(
      sendWithTimeout(
        hangingSender,
        { to: 'x@y.test', subject: 's', html: '<p>h</p>' },
        50,
      ),
    ).rejects.toThrow(/timeout/i);
  });

  it('resuelve normalmente si el sender responde a tiempo', async () => {
    const captured: Array<{ to: string }> = [];
    const okSender: EmailSender = {
      async send(input) {
        captured.push({ to: input.to });
        return { id: 'ok-1' };
      },
    };

    const res = await sendWithTimeout(
      okSender,
      { to: 'a@b.test', subject: 's', html: '<p>h</p>' },
      1000,
    );

    expect(res.id).toBe('ok-1');
    expect(captured).toEqual([{ to: 'a@b.test' }]);
  });
});
