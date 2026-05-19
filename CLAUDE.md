# DentalKiosco — Guía para Claude

## Descripción del proyecto

Kiosco de autoatención para clínicas dentales. El paciente se identifica con
cédula + OTP (SMS/email), consulta sus citas y tratamientos, agenda, cancela,
y puede pagar saldos pendientes con Wompi (QR). El administrador de la clínica
configura el sistema desde un panel web.

### Stack

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js 22 · TypeScript · Fastify 4 · Zod |
| Base de datos | PostgreSQL 16 (pgcrypto para cifrado en reposo) |
| Caché / sesiones | Redis 7 (ioredis) |
| Frontend kiosco | Vanilla JS (ES modules) · Vite 5 (sin framework) |
| Monorepo | pnpm workspaces |
| Contenedores dev | Docker Compose |
| Pagos | Wompi (Colombia) |
| SMS | Twilio (opcional, mockeable) |
| Email | Resend (opcional, mockeable) |
| Agenda | Dentalink API (`https://api.dentalink.healthatom.com`) |

### Estructura del monorepo

```
dentalkiosco/
├── apps/
│   ├── api/                   # Backend Fastify
│   │   ├── src/
│   │   │   ├── lib/           # config, crypto, db, redis, jwt, sms, email,
│   │   │   │                  # dentalink, wompi, reconciler, notifications
│   │   │   ├── routes/        # patient-auth, patient-me, payments, booking,
│   │   │   │                  # admin-auth, health
│   │   │   ├── server.ts      # Entry point
│   │   │   └── migrate.ts     # Migration runner
│   │   ├── migrations/        # 001-009 SQL versionadas
│   │   └── tests/             # Vitest integration tests
│   └── kiosco-frontend/       # Vanilla JS + Vite
│       └── src/
│           ├── screens/       # standby, login-cedula, login-otp, home,
│           │                  # appointments, treatments, profile, payment, booking
│           ├── api.js         # HTTP client
│           ├── state.js       # Estado global
│           ├── router.js      # Navegación entre pantallas
│           └── idle.js        # Detector de inactividad
├── packages/                  # (vacío por ahora, reservado para shared libs)
├── docker-compose.yml
├── docker-compose.override.yml  # Puertos locales: postgres 5433, redis 6380
└── .env                       # Variables de entorno (NUNCA commitear)
```

---

## Comandos clave

### Docker — levantar servicios locales

```bash
# Desde dentalkiosco/
docker compose up -d
# PostgreSQL escucha en :5433 (override local para no chocar con :5432)
# Redis escucha en :6380
```

### Instalar dependencias

```bash
# Desde dentalkiosco/ — instala todo el monorepo
pnpm install
```

### Migraciones

```bash
# Siempre desde dentalkiosco/ (DOTENV_CONFIG_PATH necesario porque pnpm cambia CWD)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate         # aplica pendientes
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status  # estado
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:verify  # checksums
```

### Type-check

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
```

### Tests

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
# → 131 tests al final del Hito 8 (5 archivos)
# Los tests siempre corren en mock mode (vitest.config.ts fuerza DEV_MOCK_EXTERNAL_SERVICES=true)
```

### Arrancar API (desarrollo)

```bash
# Desde dentalkiosco/
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
# Servidor en http://localhost:3000
# tsx watch — recarga automática al modificar archivos
```

### Arrancar frontend (desarrollo)

```bash
pnpm --filter @dentalkiosco/kiosco-frontend dev
# Vite dev server en http://localhost:5173
# Proxy /api → http://localhost:3000 (reescribe path: quita /api)
```

### Build de producción del frontend

```bash
pnpm --filter @dentalkiosco/kiosco-frontend build
# Output: apps/kiosco-frontend/dist/  (~25 KB gzipped al Hito 8)
```

### Conectar al kiosco (primer arranque)

El frontend necesita un `kiosk_token` JWT en `sessionStorage`. Para desarrollo:
1. Obtener el `id` del kiosco desde la tabla `kiosks` en PostgreSQL
2. Generar el JWT con el `JWT_SECRET` del `.env` (audience: `"kiosk"`, issuer: `"dentalkiosco"`)
3. Pasarlo en la URL: `http://localhost:5173/?kiosk_token=<token>`

---

## Variables de entorno críticas

El archivo `.env` vive en la raíz del monorepo (`dentalkiosco/.env`).
**Nunca se commitea.** Las variables más importantes:

```bash
# Bases de datos
POSTGRES_HOST=localhost
POSTGRES_PORT=5433        # Override local
REDIS_HOST=localhost
REDIS_PORT=6380           # Override local

# Cifrado y JWT
JWT_SECRET=...            # ≥32 chars
ENCRYPTION_KEY=...        # Base64, usado por pgcrypto via fn_encrypt/fn_decrypt

# Dentalink
DENTALINK_TOKEN=...       # Token API de Dentalink (también se guarda cifrado en clinic.dentalink_token_encrypted)
DENTALINK_API_URL=https://api.dentalink.healthatom.com

# Resend (email OTP y comprobantes)
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=onboarding@resend.dev   # dominio verificado o sandbox de Resend

# Wompi (pagos)
WOMPI_PUBLIC_KEY=...
WOMPI_PRIVATE_KEY=...
WOMPI_EVENTS_SECRET=...
WOMPI_INTEGRITY_SECRET=...

# Modo mock (desarrollo)
DEV_MOCK_EXTERNAL_SERVICES=false   # true = mock Dentalink, Twilio, Resend, Wompi
DEV_MOCK_WOMPI=true                # true = mock solo Wompi (sin afectar Dentalink)
DEV_LOG_OTP=true                   # Muestra el código OTP en los logs del servidor
```

> **Bug conocido resuelto:** `z.coerce.boolean()` de Zod interpreta el string
> `"false"` como `true` (JavaScript coercion). Se usa el helper `boolEnv()` en
> `config.ts` para todas las variables booleanas. Si se añaden nuevas vars
> booleanas, usar `boolEnv(false)` en lugar de `z.coerce.boolean().default(false)`.

---

## Modo desarrollo con mocks

Con `DEV_MOCK_EXTERNAL_SERVICES=false` y `DEV_MOCK_WOMPI=true` (configuración actual):

- **Dentalink**: llama a la API real. El token se descifra de `clinic.dentalink_token_encrypted`.
- **SMS (Twilio)**: mock — el código OTP aparece en el log del servidor (`[MOCK SMS]`).
- **Email (Resend)**: real — el OTP y los comprobantes se envían a `fabiavargas@gmail.com`
  (el email registrado del paciente en Dentalink).
- **Wompi**: mock — genera payment links falsos; el polling queda en `PENDING` hasta
  que se simule un webhook manualmente.

Para simular un pago aprobado en mock:
```bash
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<ref>","status":"APPROVED","amount_in_cents":100000}},"sent_at":"2026-05-19T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'
```

---

## Normalización de teléfono

Dentalink devuelve el celular sin prefijo país (`"3206505239"`).
El frontend siempre envía `"+57XXXXXXXXXX"`.
La función `normalizeCelular()` en `apps/api/src/lib/dentalink.ts` añade `+57`
a números colombianos de 10 dígitos que empiecen en 3.

**Esta función se pierde en cada parche incremental** (los hitos la omiten).
Siempre re-aplicarla después de sobrescribir `dentalink.ts`.

---

## Estado de los hitos

| Hito | Descripción | Estado |
|------|-------------|--------|
| 1-4 | Base: servidor, auth admin, DB, Redis, kiosk pairing | ✅ Completado y validado |
| 5-6 | Auth paciente OTP, perfil, citas, tratamientos (frontend kiosco) | ✅ Completado y validado |
| 7 | Cancelación de citas + pagos Wompi + pantalla QR | ✅ Completado y validado |
| 8 | Booking (agendar cita), reconciliador, comprobantes, migración 009 | ✅ Completado y validado |
| 9 | Panel admin (clínica, kiosks, pagos pendientes, dashboard) | 🔲 Pendiente |
| 10 | License server, monitoreo, métricas, deploy producción | 🔲 Pendiente |

**Regla de trabajo:** cada hito nuevo se extrae, aplica, type-check, tests y
valida **antes** de pedir el siguiente. Nunca se reconstruyen hitos previos ni
se mezclan cambios de hitos distintos en el mismo commit.

---

## Fixes locales a re-aplicar en cada parche

Los archivos de parche vienen del proveedor sin estos fixes. Aplicarlos siempre
después de sobrescribir los archivos indicados:

### 1. `apps/api/src/lib/config.ts`
Añadir el helper `boolEnv` al inicio y usarlo en todas las vars booleanas:
```typescript
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  ).default(defaultVal);
// Reemplazar z.coerce.boolean().default(X) → boolEnv(X)
// Variables afectadas: LICENSE_DEV_MODE, DEV_MOCK_EXTERNAL_SERVICES,
//                      DEV_LOG_OTP, DEV_MOCK_WOMPI
```

### 2. `apps/api/src/lib/dentalink.ts`
Añadir después de `const REQUEST_TIMEOUT_MS`:
```typescript
function normalizeCelular(celular: string): string {
  if (!celular) return celular;
  if (celular.startsWith('+')) return celular;
  if (/^3\d{9}$/.test(celular)) return `+57${celular}`;
  return celular;
}
```
Y en `lookupPatientByCedula`, reemplazar:
```typescript
const patient = data.data?.[0] ?? null;
```
por:
```typescript
const raw = data.data?.[0] ?? null;
const patient = raw ? { ...raw, celular: normalizeCelular(raw.celular) } : null;
```

### 3. `apps/api/vitest.config.ts`
Añadir `env` al bloque `test` para que los tests nunca llamen APIs reales:
```typescript
env: {
  DEV_MOCK_EXTERNAL_SERVICES: 'true',
  DEV_MOCK_WOMPI: 'true',
},
```

### 4. Migraciones SQL nuevas
Cada archivo `.sql` nuevo debe terminar con:
```sql
INSERT INTO schema_migrations (version, name)
VALUES ('NNN', 'nombre_sin_numero')
ON CONFLICT (version) DO NOTHING;
```
Si falta, el migrador aplica el DDL pero no lo registra (queda como pendiente
siempre). Verificar con `migrate:status` después de cada hito.

---

## Base de datos — tablas principales

| Tabla | Propósito |
|-------|-----------|
| `clinic` | Singleton (id=1): config clínica, tokens cifrados, Habeas Data |
| `admins` | Administradores con MFA TOTP |
| `kiosks` | Dispositivos pareados (token_hash, is_active) |
| `otp_codes` | Códigos OTP con TTL, intentos y consumed_at |
| `patient_sessions` | Sesiones de paciente (jti, revoked_at) |
| `habeas_data_consents` | Consentimientos por cédula_hash + versión política |
| `transactions` | Pagos Wompi (reference, status, receipt_sent_at) |
| `audit_log` | Auditoría de todas las acciones |
| `rate_limits` | Contadores de rate limiting (sobreviven reinicios) |
| `schema_migrations` | Migraciones aplicadas (version, name, checksum) |

---

## Reconciliador

Corre cada minuto como un `setInterval` dentro del proceso del API.
Se ve en los logs como:
```
[INFO] Reconciler started
[INFO] Reconciler cycle start
[INFO] Reconciler cycle end  { processed: N, errors: N, expired: N }
```
No requiere configuración adicional. Se detiene limpiamente en el shutdown del servidor.
