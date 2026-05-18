# Pruebas del Hito 4 — Auth de pacientes con OTP

## Pre-requisitos

- Hitos 1, 2, 3 completados.
- Stack docker corriendo (incluye migración 008 para `dentalink_patient_id` en `otp_codes`).
- `DEV_MOCK_EXTERNAL_SERVICES=true` para usar mocks SMS/Email.

---

## P1 — Tests automatizados con vitest

### P1.1 — Ejecutar suite del Hito 4

```bash
docker compose exec api npx vitest run tests/patient-auth.test.ts
```

**Validar (29 tests deben pasar):**

#### Validación de input (5 tests)
- [ ] Rechaza body sin cedula
- [ ] Rechaza cédula con formato inválido
- [ ] Rechaza teléfono sin código país Colombia
- [ ] Rechaza consent = false (Habeas Data no aceptado)
- [ ] Rechaza policy_hash con formato inválido

#### Kiosk token (3 tests)
- [ ] Sin Authorization header → 401
- [ ] Token inválido → 401
- [ ] Kiosco revocado/inactivo → 403

#### Anti-enumeración (3 tests)
- [ ] Paciente que NO existe recibe la MISMA respuesta que uno que existe
- [ ] Cedula correcta pero phone no coincide → NO se envía OTP
- [ ] Paciente válido → envía SMS y Email

#### Habeas Data (2 tests)
- [ ] Registra consentimiento en habeas_data_consents con IP
- [ ] Registra consentimiento incluso si el paciente no existe (auditoría legal)

#### Rate limiting (1 test)
- [ ] 4to intento desde mismo phone es bloqueado (limit=3 por hora)

#### Verify-otp happy path (1 test)
- [ ] Flujo completo: request → SMS captura OTP → verify → session_token válido

#### Verify-otp errores (7 tests)
- [ ] Rechaza request_id inexistente
- [ ] Rechaza código incorrecto
- [ ] Rechaza código con formato inválido
- [ ] OTP es single-use (segundo verify falla)
- [ ] Después de 5 intentos fallidos, bloquea con 429
- [ ] OTP expirado es rechazado
- [ ] OTP del rechazo silencioso no se puede verificar

#### OTP nunca expuesto (2 tests)
- [ ] Respuesta de request-otp NO contiene el código
- [ ] Respuesta de verify-otp con éxito NO contiene el código original

#### Logout (3 tests)
- [ ] Logout con token válido revoca la sesión
- [ ] Logout sin token retorna 401
- [ ] Logout con token inválido retorna 401

#### Audit log (2 tests)
- [ ] OTP request genera entrada en audit
- [ ] Audit log NO contiene el OTP en metadata

### P1.2 — Suite completa de Hitos 3 + 4

```bash
docker compose exec api npm test
```

**Validar:** 46 tests pasan (17 admin + 29 patient).

---

## P2 — Tests manuales con curl

### P2.1 — Obtener un kiosk_token

Necesitas un kiosk_token válido. En Hito 9 se generará automáticamente,
por ahora puedes generarlo manualmente:

```bash
docker compose exec api node -e "
const { signKioskToken } = require('./dist/lib/jwt.js');
signKioskToken({ kioskId: '22222222-2222-2222-2222-222222222222', kioskName: 'Recepción Demo' })
  .then(r => console.log(r.token));
"
```

Guarda el token:
```bash
KIOSK_TOKEN="<paste>"
```

### P2.2 — Verificar paciente seed (debe existir en mock data)

El paciente mock predefinido en `dentalink.ts`:

| Cédula     | Phone           | Nombre        |
|------------|-----------------|---------------|
| 1061700000 | +573001234567   | María Pérez   |
| 1061700001 | +573009876543   | Juan Gómez    |

### P2.3 — Aviso de Habeas Data: hash del texto

Para el campo `policy_hash`, calcular SHA256 del texto exacto:

```bash
echo -n "Aviso de Privacidad - Smile Center Demo
Versión seed-v1.0
Sus datos serán tratados según Ley 1581 de 2012 de Colombia." | sha256sum
```

(O usa cualquier hash válido si solo pruebas la API, el server solo valida formato hex de 64 chars.)

### P2.4 — Request OTP — paciente real

```bash
POLICY_HASH=$(echo -n "Aviso de Privacidad - Smile Center Demo
Versión seed-v1.0
Sus datos serán tratados según Ley 1581 de 2012 de Colombia." | sha256sum | awk '{print $1}')

curl -X POST http://localhost/api/auth/request-otp \
  -H "Authorization: Bearer $KIOSK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"cedula\": \"1061700000\",
    \"phone\": \"+573001234567\",
    \"consent\": true,
    \"policy_version\": \"seed-v1.0\",
    \"policy_hash\": \"$POLICY_HASH\"
  }"
```

**Validar:**
- [ ] Status 200
- [ ] `request_id` presente (UUID)
- [ ] `expires_in_seconds: 300` (= 5 min)

### P2.5 — Ver OTP en logs (modo dev)

Con `DEV_LOG_OTP=true`, el código se imprime en logs:

```bash
docker compose logs api --tail=20 | grep "MOCK SMS"
```

**Validar:**
- [ ] Aparece `[MOCK SMS]` con el body completo (incluyendo el código)

### P2.6 — Verify OTP

```bash
REQ_ID="<paste-request_id-de-P2.4>"
CODE="<paste-código-de-P2.5>"

curl -X POST http://localhost/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d "{\"request_id\":\"$REQ_ID\",\"code\":\"$CODE\"}"
```

**Validar:**
- [ ] Status 200
- [ ] `session_token` presente (JWT)
- [ ] `patient.name` = "María Pérez"

### P2.7 — Request OTP — paciente inexistente (anti-enumeración)

```bash
curl -X POST http://localhost/api/auth/request-otp \
  -H "Authorization: Bearer $KIOSK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"cedula\": \"9999999999\",
    \"phone\": \"+573009999999\",
    \"consent\": true,
    \"policy_version\": \"v1\",
    \"policy_hash\": \"0000000000000000000000000000000000000000000000000000000000000000\"
  }"
```

**Validar:**
- [ ] Status 200 (NO 404, anti-enumeración)
- [ ] Mismo shape de respuesta que paciente real
- [ ] NO aparece SMS en los logs

### P2.8 — Rate limit del phone

Ejecuta 4 veces seguidas P2.4 (con mismo phone):

**Validar:**
- [ ] Los primeros 3 retornan 200
- [ ] El 4to retorna 429 con `error: RATE_LIMIT`

---

## P3 — Validaciones de seguridad

### P3.1 — Habeas Data se registra en BD

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT policy_version, patient_phone, ip_address, consented_at
FROM habeas_data_consents
ORDER BY consented_at DESC
LIMIT 5;"
```

**Validar:**
- [ ] Aparecen entries recientes con IP, user_agent, policy_version, hash

### P3.2 — OTP en BD está hasheado, no en claro

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT id, code_hash, patient_phone, attempts, consumed_at
FROM otp_codes
ORDER BY created_at DESC LIMIT 5;"
```

**Validar:**
- [ ] `code_hash` tiene formato `<salt>:<hash>` (no se ve el código de 6 dígitos)
- [ ] La cédula NO aparece en plano (solo hash en otra columna)

### P3.3 — Cédula nunca en logs en claro

```bash
docker compose logs api | grep "1061700000"
```

**Validar:**
- [ ] No aparece la cédula completa (debería aparecer enmascarada: `10****00`)

### P3.4 — Audit log refleja eventos

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT action, result, created_at
FROM audit_log
WHERE action LIKE 'patient.%'
ORDER BY created_at DESC LIMIT 10;"
```

**Validar:**
- [ ] Aparecen acciones: `patient.otp.requested`, `patient.otp.verified`, etc.
- [ ] Acciones de denegación (rate_limit, wrong_code) se registran como `denied`

### P3.5 — Inmutabilidad del consent

```bash
docker compose exec postgres psql -U dentalkiosco -c "
DELETE FROM habeas_data_consents WHERE patient_phone = '+573001234567';"
```

**Validar:**
- [ ] Falla con: `habeas_data_consents no permite DELETE (auditoría legal)`

---

## P4 — Performance

### P4.1 — Latencia del request-otp

```bash
time curl -X POST http://localhost/api/auth/request-otp \
  -H "Authorization: Bearer $KIOSK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"cedula\": \"1061700000\",
    \"phone\": \"+573001234567\",
    \"consent\": true,
    \"policy_version\": \"v1\",
    \"policy_hash\": \"0000000000000000000000000000000000000000000000000000000000000000\"
  }" > /dev/null
```

**Validar:**
- [ ] Tiempo total < 1 segundo (incluye sleep de 200ms anti-timing)

---

## Resumen aceptación

**Criterio mínimo:**

- [ ] P1.1 — Los 29 tests del Hito 4 pasan
- [ ] P1.2 — Los 46 tests totales (Hitos 3+4) pasan
- [ ] P2.4, P2.6 — Flujo end-to-end manual funciona
- [ ] P2.7 — Anti-enumeración (mismo shape para no-existente)
- [ ] P2.8 — Rate limit funciona
- [ ] P3.1, P3.4 — Habeas Data + audit registrados
- [ ] P3.2 — OTP en BD hasheado (no claro)
- [ ] P3.3 — Cédula enmascarada en logs
- [ ] P3.5 — Consents inmutables
