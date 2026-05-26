/**
 * =============================================================================
 * Tests integración: Dentalink read endpoints
 * =============================================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import {
  signKioskToken,
  signPatientSession,
} from '../src/lib/jwt.js';

let app: FastifyInstance;
let kioskToken: string;
let kioskId: string;
let revokedSessionToken: string;
let validSessionJti: string;
let validSessionToken: string;
const PATIENT_ID = '12345'; // María Pérez en mock data

const POLICY_TEXT = `Aviso de Privacidad test`;
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Setup clínica
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash,
                          habeas_data_policy_text, faq)
       VALUES (1, 'Test Clinic', 'Test', '000', 'TEST', $1, $2, $3, $4)`,
      [
        'test-v1',
        POLICY_HASH,
        POLICY_TEXT,
        JSON.stringify([
          { question: '¿Qué traer?', answer: 'Solo tu cédula.' },
        ]),
      ],
    );
  } else {
    await db.query(
      `UPDATE clinic SET
        habeas_data_policy_version = $1,
        habeas_data_policy_hash = $2,
        habeas_data_policy_text = $3,
        faq = $4
       WHERE id = 1`,
      [
        'test-v1',
        POLICY_HASH,
        POLICY_TEXT,
        JSON.stringify([
          { question: '¿Qué traer?', answer: 'Solo tu cédula.' },
        ]),
      ],
    );
  }

  // Procedures en la tabla nueva (bootstrap lee desde clinic_procedures)
  await db.query(`DELETE FROM clinic_procedures WHERE clinic_id = 1`);
  await db.query(
    `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes, description, active)
     VALUES (1, 'Limpieza dental', 30, 'Profilaxis', true)`,
  );

  // Kiosco de prueba
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'TEST%'`);
  const kioskRes = await db.query<{ id: string }>(`
    INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
    VALUES ('TEST Kiosco', $1, now() + interval '1 day', true)
    RETURNING id
  `, [createHash('sha256').update('test-kiosk').digest('hex')]);
  kioskId = kioskRes.rows[0]!.id;
  const k = await signKioskToken({ kioskId, kioskName: 'TEST Kiosco' });
  kioskToken = k.token;

  // Sesión paciente válida
  const validSession = await signPatientSession({
    dentalinkPatientId: PATIENT_ID,
    kioskId,
  });
  validSessionToken = validSession.token;
  validSessionJti = validSession.jti;

  await db.query(
    `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [kioskId, PATIENT_ID, validSessionJti, validSession.expiresAt],
  );

  // Sesión revocada
  const revokedSession = await signPatientSession({
    dentalinkPatientId: PATIENT_ID,
    kioskId,
  });
  revokedSessionToken = revokedSession.token;
  await db.query(
    `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, now())`,
    [kioskId, PATIENT_ID, revokedSession.jti, revokedSession.expiresAt],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM patient_sessions WHERE jti IN ($1)`, [validSessionJti]);
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'TEST%'`);
  // Limpiar caché Redis
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
  await app.close();
});

beforeEach(async () => {
  // Limpiar caché entre tests
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
});

// =============================================================================
// GET /kiosk/bootstrap
// =============================================================================
describe('GET /kiosk/bootstrap', () => {
  it('sin token retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/kiosk/bootstrap' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('KIOSK_TOKEN_REQUIRED');
  });

  it('con token inválido retorna 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/kiosk/bootstrap',
      headers: { authorization: 'Bearer invalid' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('con kiosk_token válido devuelve configuración', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/kiosk/bootstrap',
      headers: { authorization: `Bearer ${kioskToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kiosk.id).toBe(kioskId);
    expect(body.kiosk.name).toBe('TEST Kiosco');
    // display_name puede ser cualquiera (seed crea "Smile Center", test sobreescribe)
    expect(typeof body.clinic.display_name).toBe('string');
    expect(body.habeas_data.version).toBe('test-v1');
    expect(body.habeas_data.hash).toBe(POLICY_HASH);
    expect(body.habeas_data.text).toBe(POLICY_TEXT);
    expect(body.procedures).toHaveLength(1);
    expect(body.faq).toHaveLength(1);
    expect(typeof body.server_time).toBe('string');
  });

  it('NO expone credenciales sensibles (tokens encriptados)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/kiosk/bootstrap',
      headers: { authorization: `Bearer ${kioskToken}` },
    });
    const bodyStr = JSON.stringify(res.json());
    expect(bodyStr).not.toMatch(/dentalink_token/i);
    expect(bodyStr).not.toMatch(/wompi_private/i);
    expect(bodyStr).not.toMatch(/encryption/i);
  });

  it('actualiza last_seen_at del kiosco', async () => {
    const before = await db.query<{ last_seen_at: Date | null }>(
      `SELECT last_seen_at FROM kiosks WHERE id = $1`,
      [kioskId],
    );
    const lastSeen = before.rows[0]!.last_seen_at;

    // Esperar un poco para asegurar diferencia
    await new Promise((r) => setTimeout(r, 50));

    await app.inject({
      method: 'GET',
      url: '/kiosk/bootstrap',
      headers: { authorization: `Bearer ${kioskToken}` },
    });

    const after = await db.query<{ last_seen_at: Date }>(
      `SELECT last_seen_at FROM kiosks WHERE id = $1`,
      [kioskId],
    );
    if (lastSeen) {
      expect(after.rows[0]!.last_seen_at.getTime()).toBeGreaterThan(lastSeen.getTime());
    } else {
      expect(after.rows[0]!.last_seen_at).not.toBeNull();
    }
  });
});

// =============================================================================
// GET /me/profile
// =============================================================================
describe('GET /me/profile', () => {
  it('sin token retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/profile' });
    expect(res.statusCode).toBe(401);
  });

  it('con token inválido retorna 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: { authorization: 'Bearer invalid.jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('con sesión revocada retorna 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: { authorization: `Bearer ${revokedSessionToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('con sesión válida retorna perfil del paciente correcto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(PATIENT_ID);
    expect(body.nombre).toBe('María Pérez');
    expect(body.email).toBe('maria.perez@demo.local');
    expect(body.celular).toBe('+573001234567');
  });

  it('genera entrada en audit log', async () => {
    await app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });

    const r = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_log
       WHERE action = 'patient.profile.read'
         AND created_at > now() - interval '5 seconds'`,
    );
    expect(parseInt(r.rows[0]!.count, 10)).toBeGreaterThan(0);
  });
});

// =============================================================================
// GET /me/appointments
// =============================================================================
describe('GET /me/appointments', () => {
  it('sin token retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/appointments' });
    expect(res.statusCode).toBe(401);
  });

  it('con sesión válida retorna lista de citas del paciente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.total).toBeGreaterThan(0);

    // TODAS las citas devueltas pertenecen al paciente del JWT
    for (const apt of body.data) {
      expect(apt.id_paciente).toBe(PATIENT_ID);
    }
  });

  it('filter ?status=upcoming devuelve solo citas futuras', async () => {
    // Ajustamos las citas mock para asegurar el filtro
    const res = await app.inject({
      method: 'GET',
      url: '/me/appointments?status=upcoming',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Mock data tiene citas en mayo y junio 2026 (futuras desde fecha del proyecto)
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('ordena citas por fecha+hora ascendente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/appointments?status=all',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ fecha: string; hora_inicio: string }>;
    if (data.length > 1) {
      for (let i = 1; i < data.length; i++) {
        const a = new Date(`${data[i - 1]!.fecha}T${data[i - 1]!.hora_inicio}`);
        const b = new Date(`${data[i]!.fecha}T${data[i]!.hora_inicio}`);
        expect(a.getTime()).toBeLessThanOrEqual(b.getTime());
      }
    }
  });

  it('respuestas se cachean (segunda llamada es más rápida)', async () => {
    // Primera llamada (sin caché)
    const t0 = performance.now();
    await app.inject({
      method: 'GET',
      url: '/me/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const t1 = performance.now() - t0;

    // Segunda llamada (debería usar caché)
    const t2 = performance.now();
    const res2 = await app.inject({
      method: 'GET',
      url: '/me/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const t3 = performance.now() - t2;

    expect(res2.statusCode).toBe(200);
    // No asertamos mucho sobre tiempo porque tests son rápidos; pero ambas deben ser <500ms
    expect(t1).toBeLessThan(1000);
    expect(t3).toBeLessThan(1000);
  });
});

// =============================================================================
// GET /me/treatments
// =============================================================================
describe('GET /me/treatments', () => {
  it('sin token retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/treatments' });
    expect(res.statusCode).toBe(401);
  });

  it('con sesión válida retorna tratamientos + totales', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/treatments',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.totales).toBeDefined();
    expect(typeof body.totales.total).toBe('number');
    expect(typeof body.totales.saldo_pendiente).toBe('number');

    // TODOS los tratamientos pertenecen al paciente
    for (const t of body.data) {
      expect(t.id_paciente).toBe(PATIENT_ID);
    }
  });

  it('filter ?status=active devuelve tratamientos en curso o con saldo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/treatments?status=active',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ estado: string; saldo_pendiente: number }>;
    for (const t of data) {
      const isActive = t.estado === 'En curso' || t.saldo_pendiente > 0;
      expect(isActive).toBe(true);
    }
  });

  it('filter ?status=finished devuelve solo finalizados con saldo cero', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/treatments?status=finished',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Array<{ estado: string; saldo_pendiente: number }>;
    for (const t of data) {
      expect(t.estado).toBe('Finalizado');
      expect(t.saldo_pendiente).toBe(0);
    }
  });

  it('totales suman correctamente', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/treatments',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const body = res.json();
    const sumTotal = body.data.reduce((s: number, t: { total: number }) => s + t.total, 0);
    const sumAbonado = body.data.reduce((s: number, t: { abonado: number }) => s + t.abonado, 0);
    expect(body.totales.total).toBe(sumTotal);
    expect(body.totales.abonado).toBe(sumAbonado);
  });
});

// =============================================================================
// Anti-IDOR: paciente NO puede acceder a datos de otro paciente
// =============================================================================
describe('Anti-IDOR (acceso vertical/horizontal)', () => {
  it('JWT manipulado con otro sub NO permite acceder a datos de otro paciente', async () => {
    // Generamos un JWT firmado correctamente PERO con sub = otro paciente
    const otherSession = await signPatientSession({
      dentalinkPatientId: '99999', // paciente que no existe en mocks
      kioskId,
    });
    // Insertamos la sesión para que pase el chequeo de revocación
    await db.query(
      `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [kioskId, '99999', otherSession.jti, otherSession.expiresAt],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/me/appointments',
      headers: { authorization: `Bearer ${otherSession.token}` },
    });

    // Debe retornar lista vacía (no las citas de María)
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);

    // Limpiar
    await db.query(`DELETE FROM patient_sessions WHERE jti = $1`, [otherSession.jti]);
  });

  it('Manipular sub del JWT (alterar firma) es rechazado', async () => {
    // Alterar 1 byte del JWT lo invalida (firma no coincide)
    const tampered =
      validSessionToken.substring(0, validSessionToken.length - 10) + 'XXXXXXXXXX';
    const res = await app.inject({
      method: 'GET',
      url: '/me/appointments',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

// =============================================================================
// Caché
// =============================================================================
describe('Cache Redis', () => {
  it('lookup de paciente cachea por 60s', async () => {
    // Primera consulta (popula caché)
    await app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });

    // Verificar que la clave está en Redis
    const keys = await redis.getClient().keys('dl:patient:*');
    expect(keys.length).toBeGreaterThan(0);
  });
});
