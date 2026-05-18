# Pruebas del Hito 5 — Integración Dentalink (lectura)

## Pre-requisitos

- Hitos 1, 2, 3, 4 completados y validados.
- Stack docker corriendo: `docker compose up -d`.
- Migraciones aplicadas (8 en total, incluida `008_otp_dentalink_patient_id.sql`).
- `DEV_MOCK_EXTERNAL_SERVICES=true` para usar mocks de Dentalink.

---

## Resumen

El Hito 5 añade:

- **Cliente Dentalink ampliado** (`lib/dentalink.ts`) con caché Redis y manejo
  de errores tipificados (`TIMEOUT`, `UNAUTHORIZED`, `NOT_FOUND`, `UPSTREAM_ERROR`).
- **Middleware de auth de paciente** (`lib/patient-middleware.ts`) que verifica
  JWT + revocación en BD.
- **3 endpoints `/me/*`** con anti-IDOR (filtran por patient_id del JWT).
- **1 endpoint `/kiosk/bootstrap`** que devuelve config dinámica al frontend.

---

## P1 — Tests automatizados con vitest

### P1.1 — Suite del Hito 5

```bash
docker compose exec api npx vitest run tests/patient-me.test.ts
```

**Validar (23 tests deben pasar):**

#### /kiosk/bootstrap (5 tests)
- [ ] Sin kiosk_token → 401
- [ ] Con kiosk_token inválido → 401
- [ ] Con kiosko inactivo (`is_active = false`) → 403
- [ ] Devuelve config completa con kiosk_token válido
- [ ] Actualiza `last_seen_at`, `last_ip`, `last_user_agent` del kiosco

#### /me/profile (4 tests)
- [ ] Sin patient session → 401
- [ ] Con patient session revocada → 401
- [ ] Con patient session válida → 200 + datos del paciente
- [ ] Filtra campos sensibles innecesarios

#### /me/appointments (5 tests)
- [ ] Sin auth → 401
- [ ] Lista citas del paciente autenticado
- [ ] Filtro `?status=upcoming` excluye pasadas y canceladas
- [ ] Filtro `?status=all` incluye todas
- [ ] Citas ordenadas por fecha+hora ascendente

#### /me/treatments (4 tests)
- [ ] Sin auth → 401
- [ ] Lista tratamientos del paciente
- [ ] Filtro `?status=active` solo trae en curso o con saldo > 0
- [ ] Devuelve `totales` agregados (total, abonado, saldo_pendiente)

#### Anti-IDOR / aislamiento (3 tests)
- [ ] Token de paciente A NO puede leer datos de paciente B
- [ ] Si Dentalink devuelve datos cruzados, server los filtra y loguea warning
- [ ] Auditoría queda con patient_id real del JWT, no del cliente

#### Manejo de errores Dentalink (2 tests)
- [ ] Timeout Dentalink → 504 con mensaje friendly
- [ ] Dentalink 401 (token expirado) → 503 "servicio no disponible"

### P1.2 — Suite completa Hitos 3 + 4 + 5

```bash
docker compose exec api npm test
```

**Validar:** 69 tests pasan en total (17 admin + 29 patient-auth + 23 patient-me).

---

## P2 — Tests manuales con curl

### P2.1 — Obtener un kiosk_token

```bash
KIOSK_TOKEN=$(docker compose exec api node -e "
import('./dist/lib/jwt.js').then(({ signKioskToken }) =>
  signKioskToken({ kioskId: '22222222-2222-2222-2222-222222222222', kioskName: 'Recepción Demo' })
).then(r => console.log(r.token));
")
echo $KIOSK_TOKEN
```

### P2.2 — /kiosk/bootstrap

```bash
curl http://localhost/api/kiosk/bootstrap \
  -H "Authorization: Bearer $KIOSK_TOKEN" | jq .
```

**Validar:**
- [ ] Status 200
- [ ] Contiene: `kiosk.id`, `kiosk.name`, `clinic.display_name`, `habeas_data.version`,
      `habeas_data.hash`, `habeas_data.text`, `procedures`, `faq`, `server_time`
- [ ] NO contiene tokens, secretos ni `dentalink_token_encrypted`

### P2.3 — Obtener sesión de paciente y consultar `/me/*`

(Requiere flujo de OTP del Hito 4 antes.)

```bash
# Asume que ya tienes un PATIENT_TOKEN del verify-otp del Hito 4

curl http://localhost/api/me/profile \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .

curl http://localhost/api/me/appointments \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .

curl http://localhost/api/me/appointments?status=upcoming \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .

curl http://localhost/api/me/treatments \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .

curl http://localhost/api/me/treatments?status=active \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .
```

**Validar:**
- [ ] Cada endpoint responde 200 con `data: [...]`
- [ ] `treatments` además trae `totales: { total, abonado, saldo_pendiente }`
- [ ] Si filtras por status, solo trae los del filtro

---

## P3 — Validaciones de seguridad

### P3.1 — Anti-IDOR (paciente A no puede ver datos de paciente B)

El JWT del paciente A no puede leer datos del paciente B aunque manipule la URL.
**Esto se valida por código:** `/me/*` SIEMPRE filtra usando `patient.sub` del JWT,
nunca acepta `patient_id` desde query string o body.

```bash
# Ver el código defensivo
grep -A2 "filter((a) => a.id_paciente === patient.sub)" \
  /home/claude/work/dentalkiosco/apps/api/src/routes/patient-me.ts
```

**Validar:**
- [ ] El filtro doble está presente en `/me/appointments` y `/me/treatments`
- [ ] Si Dentalink devuelve datos cruzados, el server los filtra y loguea warning

### P3.2 — Caché Redis funciona

```bash
# Hacer 2 calls consecutivas
time curl -s http://localhost/api/me/profile -H "Authorization: Bearer $PATIENT_TOKEN" > /dev/null
time curl -s http://localhost/api/me/profile -H "Authorization: Bearer $PATIENT_TOKEN" > /dev/null
```

**Validar:**
- [ ] Primera call: ~50-200ms (descifrado token + lookup Dentalink)
- [ ] Segunda call: <50ms (cache hit en Redis)

```bash
# Confirmar entradas en Redis
docker compose exec redis redis-cli -a "$REDIS_PASSWORD" KEYS "dl:patient:*"
```

### P3.3 — Sesión revocada es rechazada

```bash
# Logout (revoca la sesión)
curl -X POST http://localhost/api/auth/logout -H "Authorization: Bearer $PATIENT_TOKEN"

# Inmediatamente intenta usar el mismo token
curl -i http://localhost/api/me/profile -H "Authorization: Bearer $PATIENT_TOKEN"
```

**Validar:**
- [ ] Status 401 con `error: UNAUTHORIZED, message: 'Sesión revocada'`
- [ ] Audit log registra `patient.session.revoked`

### P3.4 — Manejo de errores Dentalink

Sin Dentalink real (mock mode), no se puede probar directamente. Pero el
código maneja:

- `TIMEOUT` → HTTP 504 con mensaje friendly
- `UNAUTHORIZED` (Dentalink 401) → HTTP 503 con mensaje genérico (no expone fallo upstream)
- `NOT_FOUND` → HTTP 404
- Otros → HTTP 503

**Verificar en código:**

```bash
grep -A4 "handleDentalinkError" \
  /home/claude/work/dentalkiosco/apps/api/src/routes/patient-me.ts | head -20
```

### P3.5 — Caché del token Dentalink (30s)

El descifrado del `dentalink_token_encrypted` es costoso. Por eso se cachea
en memoria del proceso por 30s. Verificar en código:

```bash
grep -B1 -A2 "cachedToken" \
  /home/claude/work/dentalkiosco/apps/api/src/routes/patient-me.ts | head -10
```

### P3.6 — Audit log de accesos a /me/*

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT action, result, metadata, created_at
FROM audit_log
WHERE action LIKE 'patient.%.read'
ORDER BY created_at DESC LIMIT 10;"
```

**Validar:**
- [ ] Aparecen entries: `patient.profile.read`, `patient.appointments.read`,
      `patient.treatments.read`
- [ ] Cada entry tiene `actor_id` con el jti de la sesión
- [ ] Resource_id es el patient_id

---

## P4 — Performance

### P4.1 — Bootstrap responde rápido

```bash
time curl -s http://localhost/api/kiosk/bootstrap \
  -H "Authorization: Bearer $KIOSK_TOKEN" > /dev/null
```

**Validar:**
- [ ] Primer call: <100ms
- [ ] Subsecuentes: <30ms (sin lookup Dentalink)

### P4.2 — /me/profile con cache

```bash
for i in 1 2 3; do
  time curl -s http://localhost/api/me/profile -H "Authorization: Bearer $PATIENT_TOKEN" > /dev/null
done
```

**Validar:**
- [ ] Llamadas 2 y 3 son significativamente más rápidas que la 1
      (típicamente <20ms con cache)

---

## Resumen aceptación

**Criterio mínimo:**

- [ ] P1.1 — Los 23 tests del Hito 5 pasan
- [ ] P1.2 — Los 69 tests totales (Hitos 3+4+5) pasan
- [ ] P2.2 — `/kiosk/bootstrap` devuelve config completa
- [ ] P2.3 — `/me/profile`, `/me/appointments`, `/me/treatments` funcionan
- [ ] P3.1 — Anti-IDOR en código (doble filtro por patient_id del JWT)
- [ ] P3.3 — Sesión revocada es rechazada en defensa en profundidad
- [ ] P3.6 — Audit log refleja accesos a /me/*
