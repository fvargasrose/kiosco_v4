/**
 * =============================================================================
 * Tests integración: POST /kiosk/register — registro de paciente nuevo
 * =============================================================================
 *
 * Usa:
 *   - Postgres real (migraciones aplicadas)
 *   - Redis real
 *   - Mock de Dentalink (DEV_MOCK_EXTERNAL_SERVICES=true forzado en vitest.config.ts)
 *
 * Los pacientes mock iniciales (dentalink.ts MOCK_PATIENTS_INITIAL):
 *   { rut: '1061700000', email: 'maria.perez@demo.local', celular: '+573001234567' }
 *   { rut: '1061700001', email: 'juan.gomez@demo.local',  celular: '+573009876543' }
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { _resetMockDataForTests } from '../src/lib/dentalink.js';

let app: FastifyInstance;

const VALID_BODY = {
  cedula:          '9876543210',
  cedula_confirm:  '9876543210',
  celular:         '3112223344',
  celular_confirm: '3112223344',
  email:           'nuevo.paciente@test.co',
  email_confirm:   'nuevo.paciente@test.co',
  nombres:         'Carlos',
  apellidos:       'Ramírez',
  fecha_nacimiento:'1992-07-20',
  sexo:            'M',
  direccion:       'Calle 10 # 5-20',
  ciudad:          'Popayán',
  comuna:          'Centro',
  ocupacion:       'Docente',
};

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Asegurar clínica
  const existing = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM clinic WHERE id = 1`);
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash,
                          habeas_data_policy_text)
       VALUES (1, 'Reg Test', 'RegTest', '000', 'TEST', 'reg-v1', $1, 'policy')`,
      [createHash('sha256').update('policy').digest('hex')],
    );
  }

  // Hito A: el registro es web público; no se crea kiosco ni token de kiosco.
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _resetMockDataForTests();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function post(body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/kiosk/register',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /kiosk/register', () => {
  // Hito A (Opción A): el registro es PÚBLICO (sin kiosk_token), gobernado por
  // FEATURE_REGISTRO. Se reemplaza la antigua aserción "401 sin kiosk token".
  it('no exige kiosk token: una solicitud sin auth llega a validación (no 401)', async () => {
    const res = await post({}); // body vacío → debe fallar validación, NO 401
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it('403 FEATURE_DISABLED cuando FEATURE_REGISTRO está apagado', async () => {
    const original = config.FEATURE_REGISTRO;
    (config as { FEATURE_REGISTRO: boolean }).FEATURE_REGISTRO = false;
    try {
      const res = await post(VALID_BODY);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('FEATURE_DISABLED');
    } finally {
      (config as { FEATURE_REGISTRO: boolean }).FEATURE_REGISTRO = original;
    }
  });

  it('400 campo obligatorio faltante (nombres vacío)', async () => {
    const res = await post({ ...VALID_BODY, nombres: '' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.fields.some((f: any) => f.field === 'nombres')).toBe(true);
  });

  it('400 cédula con formato inválido (letras)', async () => {
    const res = await post({ ...VALID_BODY, cedula: 'abc123', cedula_confirm: 'abc123' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'cedula')).toBe(true);
  });

  it('400 cédula_confirm no coincide con cédula', async () => {
    const res = await post({ ...VALID_BODY, cedula_confirm: '0000000000' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'cedula_confirm')).toBe(true);
  });

  it('400 celular_confirm no coincide', async () => {
    const res = await post({ ...VALID_BODY, celular_confirm: '3199999999' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'celular_confirm')).toBe(true);
  });

  it('400 email_confirm no coincide', async () => {
    const res = await post({ ...VALID_BODY, email_confirm: 'otro@test.co' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'email_confirm')).toBe(true);
  });

  it('400 email mal formado', async () => {
    const res = await post({ ...VALID_BODY, email: 'no-es-email', email_confirm: 'no-es-email' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'email')).toBe(true);
  });

  it('400 sexo inválido', async () => {
    const res = await post({ ...VALID_BODY, sexo: 'X' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'sexo')).toBe(true);
  });

  it('400 fecha_nacimiento fuera de rango (futuro)', async () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const iso = future.toISOString().slice(0, 10);
    const res = await post({ ...VALID_BODY, fecha_nacimiento: iso });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.fields.some((f: any) => f.field === 'fecha_nacimiento')).toBe(true);
  });

  it('409 paciente ya existe — email coincide con mock', async () => {
    const res = await post({
      ...VALID_BODY,
      email: 'maria.perez@demo.local',
      email_confirm: 'maria.perez@demo.local',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PATIENT_EXISTS');
  });

  it('409 paciente ya existe — celular coincide con mock', async () => {
    const res = await post({
      ...VALID_BODY,
      celular: '3001234567',
      celular_confirm: '3001234567',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('PATIENT_EXISTS');
  });

  it('201 creación exitosa — responde patient_id', async () => {
    const res = await post(VALID_BODY);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.patient_id).toBe('string');
    expect(body.patient_id.length).toBeGreaterThan(0);
  });

  it('201 creación exitosa — segunda vez con mismos datos es 409 (mock acumula)', async () => {
    const firstRes = await post(VALID_BODY);
    expect(firstRes.statusCode).toBe(201);

    // El mock ya lo tiene guardado, segunda llamada debe detectarlo
    const secondRes = await post(VALID_BODY);
    expect(secondRes.statusCode).toBe(409);
  });
});
