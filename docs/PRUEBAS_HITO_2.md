# Pruebas del Hito 2 — Base de datos + migraciones

## Pre-requisitos

- Hito 1 completado y validado.
- Stack docker corriendo: `docker compose up -d`.

---

## P1 — Sistema de migraciones

### P1.1 — Aplicar migraciones

```bash
docker compose exec api npm run migrate
```

**Validar:**

- [ ] Se aplican 7 migraciones (001 a 007)
- [ ] Cada una imprime `✓ Aplicada: NNN_nombre durationMs: ...`
- [ ] Mensaje final `✓ 7 migración(es) aplicada(s) exitosamente`
- [ ] No hay errores SQL

### P1.2 — Verificar estado

```bash
docker compose exec api npm run migrate:status
```

**Salida esperada:**

```
=== Estado de migraciones ===

  ✓ aplicada  001_extensions_and_base       <fecha>  XXms
  ✓ aplicada  002_clinic                    <fecha>  XXms
  ✓ aplicada  003_admins_and_kiosks         <fecha>  XXms
  ✓ aplicada  004_otp_sessions_consents     <fecha>  XXms
  ✓ aplicada  005_transactions              <fecha>  XXms
  ✓ aplicada  006_audit_log                 <fecha>  XXms
  ✓ aplicada  007_rate_limits               <fecha>  XXms

Total: 7, Aplicadas: 7, Pendientes: 0
```

### P1.3 — Re-aplicar es idempotente

```bash
docker compose exec api npm run migrate
```

**Validar:**

- [ ] Mensaje: `No hay migraciones pendientes`
- [ ] No falla, no duplica

### P1.4 — Verificación de checksums

```bash
docker compose exec api npm run migrate:verify
```

**Validar:**

- [ ] Las 7 migraciones muestran ✓
- [ ] Mensaje: `✓ Todas las migraciones aplicadas tienen checksum válido`

### P1.5 — Modificar migración aplicada falla

Editar `migrations/001_extensions_and_base.sql` agregando un comentario `-- modificado`:

```bash
echo "-- modificación post-aplicación" >> apps/api/migrations/001_extensions_and_base.sql
docker compose exec api npm run migrate
```

**Validar:**

- [ ] Falla con mensaje claro: `Migración 001_extensions_and_base fue modificada después de aplicarse`
- [ ] Muestra ambos checksums (BD vs disco)

Revertir cambio:
```bash
# Restaurar contenido original (revertir el cambio agregado)
```

---

## P2 — Esquema y tablas

### P2.1 — Tablas creadas

```bash
docker compose exec postgres psql -U dentalkiosco -c "\dt"
```

**Validar (las 8 tablas presentes):**

- [ ] `audit_log`
- [ ] `admins`
- [ ] `clinic`
- [ ] `habeas_data_consents`
- [ ] `kiosks`
- [ ] `otp_codes`
- [ ] `patient_sessions`
- [ ] `rate_limits`
- [ ] `schema_migrations`
- [ ] `transactions`

### P2.2 — Extensiones instaladas

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','citext','uuid-ossp');"
```

**Validar:**

- [ ] Las 3 extensiones presentes

---

## P3 — Constraints y triggers críticos

### P3.1 — Singleton de `clinic`

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "INSERT INTO clinic (id, legal_name, display_name, nit, license_key) VALUES (1, 'A', 'A', '111', 'x');"
```

Primera inserción debería pasar. Segunda:

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "INSERT INTO clinic (id, legal_name, display_name, nit, license_key) VALUES (1, 'B', 'B', '222', 'x');"
```

**Validar:**

- [ ] Segunda inserción **falla** con: `Solo puede existir una clínica`

### P3.2 — `clinic.id` solo puede ser 1

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "INSERT INTO clinic (id, legal_name, display_name, nit, license_key) VALUES (2, 'X', 'X', '999', 'x');"
```

**Validar:**

- [ ] Falla con: `check_violation` o `Solo puede existir una clínica`

### P3.3 — `audit_log` es inmutable

```bash
docker compose exec postgres psql -U dentalkiosco -c "UPDATE audit_log SET action = 'x';"
docker compose exec postgres psql -U dentalkiosco -c "DELETE FROM audit_log;"
```

**Validar (ambos comandos):**

- [ ] Fallan con: `Tabla audit_log es inmutable: operación X no permitida`

### P3.4 — `habeas_data_consents` no permite DELETE

```bash
docker compose exec postgres psql -U dentalkiosco -c "DELETE FROM habeas_data_consents;"
```

**Validar:**

- [ ] Falla con: `habeas_data_consents no permite DELETE (auditoría legal)`

### P3.5 — `habeas_data_consents` permite UPDATE solo de revoked

```bash
# Test completo en un solo bloque
docker compose exec postgres psql -U dentalkiosco << 'EOF'
BEGIN;
INSERT INTO habeas_data_consents 
  (id, patient_cedula_hash, patient_phone, policy_version, policy_text_hash, ip_address)
VALUES 
  ('aaaaaaaa-1111-1111-1111-111111111111', 'h1', '+57300', 'v1', 'hash1', '127.0.0.1');

-- DEBE pasar (solo revoked_at):
UPDATE habeas_data_consents SET revoked_at = now() 
WHERE id = 'aaaaaaaa-1111-1111-1111-111111111111';

-- DEBE FALLAR (modifica otro campo):
UPDATE habeas_data_consents SET patient_phone = '+57XXX' 
WHERE id = 'aaaaaaaa-1111-1111-1111-111111111111';

ROLLBACK;
EOF
```

**Validar:**

- [ ] El UPDATE de `revoked_at` pasa
- [ ] El UPDATE de `patient_phone` falla con: `Solo se permite modificar revoked_at y revoked_reason`

### P3.6 — State machine de transactions

```bash
docker compose exec postgres psql -U dentalkiosco << 'EOF'
BEGIN;
INSERT INTO transactions (wompi_reference, dentalink_patient_id, amount_cop, status)
VALUES ('TEST-SM', '12345', 50000, 'pending');

-- DEBE pasar:
UPDATE transactions SET status = 'approved' WHERE wompi_reference = 'TEST-SM';

-- DEBE establecer approved_at automáticamente:
SELECT status, approved_at IS NOT NULL FROM transactions WHERE wompi_reference = 'TEST-SM';

-- DEBE FALLAR (transición terminal → no-terminal):
UPDATE transactions SET status = 'pending' WHERE wompi_reference = 'TEST-SM';

ROLLBACK;
EOF
```

**Validar:**

- [ ] pending → approved OK
- [ ] approved_at se setea automáticamente
- [ ] approved → pending falla con: `No se permite cambiar transacción de estado terminal`

---

## P4 — Cifrado de tokens

### P4.1 — Round-trip básico

```bash
docker compose exec postgres psql -U dentalkiosco << 'EOF'
BEGIN;
SET LOCAL app.encryption_key = 'test_key_at_least_32_chars_xxxxxxxxxx';
SELECT fn_decrypt(fn_encrypt('mi_secreto_dentalink_123')) AS decrypted;
ROLLBACK;
EOF
```

**Validar:**

- [ ] El campo `decrypted` muestra `mi_secreto_dentalink_123`

### P4.2 — Cifrado sin key falla

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT fn_encrypt('test');"
```

**Validar:**

- [ ] Falla con: `app.encryption_key no está configurada en la sesión`

### P4.3 — NULL es respetado

```bash
docker compose exec postgres psql -U dentalkiosco << 'EOF'
BEGIN;
SET LOCAL app.encryption_key = 'test_key_xxxxxxxxxxxxxxxxxxxxxxx';
SELECT fn_encrypt(NULL) IS NULL AS null_in_null_out;
SELECT fn_decrypt(NULL) IS NULL AS null_in_null_out_2;
ROLLBACK;
EOF
```

**Validar:**

- [ ] Ambos retornan `t` (true)

---

## P5 — Rate limiting

### P5.1 — Conteo correcto

```bash
docker compose exec postgres psql -U dentalkiosco << 'EOF'
SELECT 'attempt 1:', * FROM fn_rate_limit_check('test:rl', 3, 60);
SELECT 'attempt 2:', * FROM fn_rate_limit_check('test:rl', 3, 60);
SELECT 'attempt 3:', * FROM fn_rate_limit_check('test:rl', 3, 60);
SELECT 'attempt 4:', * FROM fn_rate_limit_check('test:rl', 3, 60);
DELETE FROM rate_limits WHERE bucket_key = 'test:rl';
EOF
```

**Validar:**

- [ ] Intentos 1-3: `allowed = t`, `current_count` incrementa
- [ ] Intento 4: `allowed = f`, `retry_after_secs ≈ 60`

---

## P6 — Seed de datos

### P6.1 — Ejecutar seed

```bash
docker compose exec api npm run seed
```

**Validar:**

- [ ] Mensaje `✓ Seed completado`
- [ ] Imprime resumen con clínica, admin, kiosco

### P6.2 — Datos creados

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT display_name, nit FROM clinic;"
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT email, role, full_name FROM admins;"
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT name, device_type FROM kiosks;"
```

**Validar:**

- [ ] 1 clínica: Smile Center
- [ ] 1 admin: admin@demo.local
- [ ] 1 kiosco: Recepción Demo

### P6.3 — Seed es idempotente (limpia y recrea)

```bash
docker compose exec api npm run seed
docker compose exec postgres psql -U dentalkiosco -c "SELECT COUNT(*) FROM clinic;"
```

**Validar:**

- [ ] No falla
- [ ] Sigue habiendo solo 1 clínica

### P6.4 — Seed NUNCA corre en producción

```bash
docker compose exec api sh -c "NODE_ENV=production npm run seed"
```

**Validar:**

- [ ] Falla inmediatamente con: `NO ejecutar seed en producción`

---

## P7 — Persistencia y reinicio

### P7.1 — Datos persisten tras reinicio

```bash
docker compose restart postgres
sleep 10
docker compose exec postgres psql -U dentalkiosco -c "SELECT display_name FROM clinic;"
```

**Validar:**

- [ ] Smile Center sigue presente

### P7.2 — Migraciones tras restart no se re-aplican

```bash
docker compose exec api npm run migrate:status
```

**Validar:**

- [ ] Todas marcadas como aplicadas
- [ ] Pendientes: 0

---

## Resumen de aceptación

Si todas las pruebas anteriores pasan, el Hito 2 está completo.

**Criterio mínimo (must-pass):**

- [ ] P1.1, P1.2 — Migraciones se aplican y registran
- [ ] P1.3 — Idempotente
- [ ] P1.5 — Detecta migraciones modificadas
- [ ] P3.1 — Singleton de clinic
- [ ] P3.3 — audit_log inmutable (UPDATE y DELETE)
- [ ] P3.4 — habeas_data_consents no permite DELETE
- [ ] P3.6 — State machine de transactions
- [ ] P4.1, P4.2 — Cifrado funciona y falla sin key
- [ ] P5.1 — Rate limiting cuenta correctamente
- [ ] P6.1, P6.2 — Seed funciona
- [ ] P6.4 — Seed bloqueado en producción
