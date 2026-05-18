/**
 * =============================================================================
 * Seed - Datos iniciales para desarrollo
 * =============================================================================
 *
 * Crea:
 *   - 1 clínica de prueba (Smile Center Demo)
 *   - 1 admin de prueba (password debe cambiarse en primer login)
 *   - 1 kiosco de prueba
 *   - Procedimientos y FAQ de ejemplo
 *
 * NUNCA ejecutar en producción.
 */

import 'dotenv/config';
import { createHash, randomBytes } from 'crypto';
import pg from 'pg';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { hashPassword } from './lib/passwords.js';

const pool = new pg.Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
});

async function seed() {
  if (config.NODE_ENV === 'production') {
    throw new Error('❌ NO ejecutar seed en producción');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Setear encryption key para esta sesión
    // SET LOCAL no acepta parameter binding
    if (config.ENCRYPTION_KEY.includes("'")) {
      throw new Error('ENCRYPTION_KEY no debe contener comillas simples');
    }
    await client.query(`SET LOCAL app.encryption_key = '${config.ENCRYPTION_KEY}'`);

    // ----- Limpiar (solo en dev) -----
    logger.info('Limpiando datos previos de seed...');
    await client.query(`DELETE FROM transactions`);
    await client.query(`DELETE FROM patient_sessions`);
    await client.query(`DELETE FROM otp_codes`);
    await client.query(`DELETE FROM habeas_data_consents WHERE policy_version = 'seed-v1.0'`);
    await client.query(`DELETE FROM rate_limits`);
    await client.query(`DELETE FROM kiosks`);
    await client.query(`DELETE FROM admins WHERE email LIKE '%@demo.local'`);
    await client.query(`DELETE FROM clinic WHERE id = 1`);

    // ----- Crear clínica de prueba -----
    logger.info('Creando clínica de prueba...');
    const policyText = `Aviso de Privacidad - Smile Center Demo
Versión seed-v1.0
Sus datos serán tratados según Ley 1581 de 2012 de Colombia.`;
    const policyHash = createHash('sha256').update(policyText).digest('hex');

    await client.query(
      `
      INSERT INTO clinic (
        id, legal_name, display_name, nit, address, city, phone, email,
        habeas_data_responsible, habeas_data_email,
        habeas_data_policy_text, habeas_data_policy_version, habeas_data_policy_hash,
        license_key, sucursal_id, sillon_id, duracion_cita_minutos,
        procedures, faq
      ) VALUES (
        1, 'Smile Center Demo S.A.S.', 'Smile Center', '900.000.000-0',
        'Calle 5 # 4-44', 'Popayán', '+57 602 8200000', 'contacto@demo.local',
        'Dr. Demo', 'dpo@demo.local',
        $1, 'seed-v1.0', $2,
        'DEV-LOCAL-NOLICENSE-LOCAL', 1, 1, 30,
        $3::jsonb, $4::jsonb
      )
    `,
      [
        policyText,
        policyHash,
        JSON.stringify([
          { name: 'Limpieza dental', duration: 30, description: 'Profilaxis y revisión general' },
          { name: 'Endodoncia', duration: 60, description: 'Tratamiento de conducto' },
          { name: 'Ortodoncia (control)', duration: 30, description: 'Ajuste mensual de brackets' },
          { name: 'Resina', duration: 45, description: 'Restauración con resina compuesta' },
        ]),
        JSON.stringify([
          {
            question: '¿Qué documentos necesito?',
            answer: 'Solo tu cédula de ciudadanía y tu celular registrado en la clínica.',
          },
          {
            question: '¿Puedo cancelar mi cita?',
            answer: 'Sí, con al menos 24 horas de anticipación.',
          },
        ]),
      ],
    );

    // ----- Crear admin de prueba -----
    logger.info('Creando admin de prueba (password = "Admin1234!" - cambiar en primer login)');
    const adminId = '11111111-1111-1111-1111-111111111111';
    const passwordHash = await hashPassword('Admin1234!');
    await client.query(
      `
      INSERT INTO admins (
        id, email, password_hash, full_name, phone, role,
        mfa_enrolled, mfa_required, must_change_password
      ) VALUES (
        $1, $2, $3, $4, $5, $6, false, true, true
      )
    `,
      [
        adminId,
        'admin@demo.local',
        passwordHash,
        'Administrador Demo',
        '+573001234567',
        'admin',
      ],
    );

    // ----- Crear kiosco de prueba -----
    logger.info('Creando kiosco de prueba...');
    const kioskId = '22222222-2222-2222-2222-222222222222';
    // Token de prueba: el JWT real se genera en Hito 3
    const fakeTokenHash = createHash('sha256').update('dev-kiosk-token-placeholder').digest('hex');
    await client.query(
      `
      INSERT INTO kiosks (
        id, name, location, device_type, token_hash, token_expires_at,
        is_active, created_by
      ) VALUES (
        $1, 'Recepción Demo', 'Lobby principal', 'pc', $2,
        now() + interval '90 days', true, $3
      )
    `,
      [kioskId, fakeTokenHash, adminId],
    );

    // ----- Audit log entry inicial -----
    await client.query(
      `
      SELECT fn_audit(
        'system'::TEXT, NULL::UUID, 'system.seed.complete',
        NULL, NULL,
        $1::JSONB, 'success', NULL, NULL
      )
    `,
      [JSON.stringify({ environment: config.NODE_ENV, seeded_at: new Date().toISOString() })],
    );

    await client.query('COMMIT');

    logger.info('✓ Seed completado');
    console.log(`
=== Datos de prueba creados ===

  Clínica: Smile Center Demo (NIT 900.000.000-0)
  Admin:   admin@demo.local
  Kiosco:  Recepción Demo (id: ${kioskId})

  Para usar el admin necesitarás Hito 3 (auth admin) - el password actual es placeholder.

`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

try {
  await seed();
  await pool.end();
  process.exit(0);
} catch (err) {
  logger.fatal({ err }, 'Seed failed');
  await pool.end();
  process.exit(1);
}
