# Pruebas del Hito 3 — API base + Auth admin con TOTP

## Pre-requisitos

- Hitos 1 y 2 completados.
- Stack docker corriendo: `docker compose up -d`.
- Migraciones aplicadas: `docker compose exec api npm run migrate`.
- Seed ejecutado: `docker compose exec api npm run seed`.

---

## P1 — Tests automatizados con vitest

### P1.1 — Ejecutar suite completa

```bash
docker compose exec api npm test
```

**Validar (17 tests deben pasar):**

- [ ] POST /admin/auth/login > rechaza usuario inexistente
- [ ] POST /admin/auth/login > rechaza password incorrecto
- [ ] POST /admin/auth/login > rechaza input inválido (sin email)
- [ ] POST /admin/auth/login > rechaza email inválido
- [ ] POST /admin/auth/login > login OK exige MFA enrollment
- [ ] POST /admin/auth/login > anti-timing (tiempos similares)
- [ ] Account lockout > bloquea después de N intentos
- [ ] MFA enrollment flow > GET /me retorna info
- [ ] MFA enrollment flow > /me sin token retorna 401
- [ ] MFA enrollment flow > /me con token inválido retorna 401
- [ ] MFA enrollment flow > enroll-start genera QR + recovery
- [ ] MFA enrollment flow > enroll-confirm activa MFA
- [ ] MFA enrollment flow > Login post-enrollment exige código MFA
- [ ] MFA enrollment flow > MFA verify con código correcto
- [ ] MFA enrollment flow > MFA verify con código incorrecto retorna 401
- [ ] MFA enrollment flow > Challenge token single-use
- [ ] Audit log > Login genera entrada

---

## P2 — Tests manuales con curl

### P2.1 — Login con credenciales seed

Login del admin demo (creado por seed):

```bash
curl -X POST http://localhost/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.local","password":"Admin1234!"}'
```

**Validar:**

- [ ] Status 200
- [ ] `mfa_enrollment_required: true`
- [ ] `session_token` presente (formato JWT)
- [ ] `must_change_password: true`

Guarda el `session_token`:

```bash
TOKEN="<pega-el-token>"
```

### P2.2 — Ver info de la sesión

```bash
curl http://localhost/api/admin/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

**Validar:**

- [ ] Email = `admin@demo.local`
- [ ] `mfa_enrolled: false`
- [ ] `mfa_verified_in_session: false`

### P2.3 — Enrollment de MFA

```bash
curl -X POST http://localhost/api/admin/auth/mfa/enroll-start \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Validar:**

- [ ] `otpauth_url` presente (formato `otpauth://totp/...`)
- [ ] `qr_code_data_url` presente (formato `data:image/png;base64,...`)
- [ ] `recovery_codes` array de 10 códigos

**Acción:**

1. Abre Google Authenticator
2. Escanea el QR (puedes copiar el `qr_code_data_url` y abrirlo en navegador)
3. Apunta el código de 6 dígitos que aparece

### P2.4 — Confirmar enrollment

```bash
curl -X POST http://localhost/api/admin/auth/mfa/enroll-confirm \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"<el-código-del-app>"}'
```

**Validar:**

- [ ] Status 200
- [ ] `session_token` nuevo (con mfa_verified: true ahora)

### P2.5 — Login post-enrollment requiere MFA

```bash
curl -X POST http://localhost/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.local","password":"Admin1234!"}'
```

**Validar:**

- [ ] `mfa_required: true`
- [ ] `mfa_challenge_token` presente
- [ ] **NO** debe haber `session_token` aún

### P2.6 — Verificar MFA

```bash
CHALLENGE="<el-challenge-token>"
CODE="<código-actual-del-app>"

curl -X POST http://localhost/api/admin/auth/mfa/verify \
  -H "Content-Type: application/json" \
  -d "{\"mfa_challenge_token\":\"$CHALLENGE\",\"code\":\"$CODE\"}"
```

**Validar:**

- [ ] Status 200
- [ ] `session_token` presente

---

## P3 — Validaciones de seguridad

### P3.1 — JWT manipulado es rechazado

```bash
# Tomar un token válido, cambiar 1 carácter del payload
BADTOKEN="${TOKEN:0:50}X${TOKEN:51}"

curl -i http://localhost/api/admin/auth/me \
  -H "Authorization: Bearer $BADTOKEN"
```

**Validar:**

- [ ] Status 401
- [ ] `error: UNAUTHORIZED`

### P3.2 — Sin token retorna 401

```bash
curl -i http://localhost/api/admin/auth/me
```

**Validar:**

- [ ] Status 401

### P3.3 — Endpoint /admin/auth/me con token de challenge (no es session)

El `mfa_challenge_token` NO es un JWT válido para `/me`:

```bash
curl -i http://localhost/api/admin/auth/me \
  -H "Authorization: Bearer $CHALLENGE"
```

**Validar:**

- [ ] Status 401

### P3.4 — Audit log refleja eventos

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT action, result, created_at FROM audit_log
   WHERE actor_email = 'admin@demo.local'
   ORDER BY created_at DESC LIMIT 10;"
```

**Validar:**

- [ ] Aparecen entries con acciones: `admin.login.success`, `admin.mfa.enroll_started`, etc.
- [ ] Cada entry tiene timestamp y resultado

### P3.5 — Password en logs es redactado

```bash
docker compose logs api | grep -i "Admin1234" | head -5
```

**Validar:**

- [ ] El password NO aparece en los logs
- [ ] Si aparece la palabra "password", es como nombre de campo o REDACTED

### P3.6 — Tokens encriptados en BD

```bash
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT email, mfa_enrolled, 
          encode(totp_secret_encrypted, 'hex') AS secret_hex
   FROM admins WHERE email = 'admin@demo.local';"
```

**Validar:**

- [ ] `totp_secret_encrypted` es binary (no texto plano)
- [ ] Empieza con bytes característicos de pgp_sym_encrypt (no se ve el secret en claro)

---

## P4 — Performance

### P4.1 — Login responde en tiempo razonable

```bash
time curl -s -X POST http://localhost/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.local","password":"WrongPassword"}' > /dev/null
```

**Validar:**

- [ ] Tiempo total < 500ms (argon2 verify es ~100ms)
- [ ] Tiempo aceptable para UX

---

## Resumen aceptación

**Criterio mínimo:**

- [ ] P1.1 — Los 17 tests automatizados pasan
- [ ] P2.1 — Login con credenciales seed funciona
- [ ] P2.3, P2.4 — Enrollment de MFA completo
- [ ] P2.6 — MFA verify funciona
- [ ] P3.1 — JWT manipulado es rechazado
- [ ] P3.4 — Audit log refleja eventos
- [ ] P3.5 — Password NO aparece en logs
- [ ] P3.6 — TOTP secret cifrado en BD
