#Reglas del proyecto DentalKiosco:

1. NUNCA tocar estos archivos sin autorización explícita:
   - apps/api/src/routes/payments.ts (webhook Wompi)
   - apps/api/src/lib/reconciler.ts
   - apps/api/src/lib/license/* (middleware de licencias)
   - apps/api/migrations/001-017_*.sql (migraciones ya aplicadas)

2. Antes de modificar cualquier archivo, leerlo COMPLETO primero con view.
   No editar a ciegas basado en suposiciones.

3. Stack confirmado: Node 22, TypeScript, Fastify 4, Zod, Postgres 16, Redis 7,
   pnpm workspaces, Vite 5, Vanilla JS (no React/Vue) en frontends.

4. Migraciones: SIEMPRE nueva versión (012, 013...). NUNCA modificar previas.
   Terminar cada migración con:
   INSERT INTO schema_migrations (version, name)
   VALUES ('NNN', 'nombre') ON CONFLICT DO NOTHING;

5. Comandos de verificación obligatorios al terminar cada tarea:
   - pnpm --filter @dentalkiosco/api typecheck
   - pnpm --filter @dentalkiosco/api test
   - pnpm lint   (script de RAÍZ, no del paquete api; ver nota abajo)
   - (frontend) pnpm --filter @dentalkiosco/kiosco-frontend build
   - (frontend) pnpm --filter @dentalkiosco/admin-frontend build

   ⚠️ `pnpm lint` está ROTO desde el repo (preexistente): el script raíz es
   `eslint .` pero NO existe `eslint.config.js` y ESLint v9 exige flat config.
   Falla con "couldn't find an eslint.config file". Hasta crear esa config,
   las puertas reales de verificación son typecheck + test + builds.

6. Commits: uno por tarea completada, con mensaje convencional:
   feat(scope): descripción / fix(scope): descripción / chore: descripción

7. Si algo es ambiguo, PREGUNTAR antes de asumir. No inventar endpoints,
   nombres de campos o estructuras de tablas.
   

# DentalKiosco — Guía para Claude

## Descripción del proyecto

Kiosco de autoatención para clínicas dentales. El paciente se identifica con
cédula + OTP (SMS/email) o solo cédula + teléfono (según `OTP_REQUIRED`),
consulta sus citas y tratamientos, agenda, cancela, y puede pagar saldos
pendientes con Wompi (QR). El administrador configura el sistema desde un
panel web. El sistema incluye servidor de licencias, update manager e installer.

### Stack

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js 22 · TypeScript · Fastify 4 · Zod |
| Base de datos | PostgreSQL 16 (pgcrypto para cifrado en reposo) |
| Caché / sesiones | Redis 7 (ioredis) |
| Frontend kiosco | Vanilla JS (ES modules) · Vite 5 (sin framework) |
| Frontend admin | Vanilla JS · Vite 5 |
| Monorepo | pnpm workspaces |
| Proxy / TLS | Caddy 2 (Let's Encrypt automático) |
| Contenedores prod | Docker Compose + Dockerfile multi-stage |
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
│   │   │   │                  # dentalink, wompi, reconciler, notifications,
│   │   │   │                  # license/{cache,client,fingerprint,middleware,worker}
│   │   │   ├── routes/        # patient-auth, patient-me, payments, booking,
│   │   │   │                  # admin-auth, admin-clinic, admin-dentists,
│   │   │   │                  # admin-kiosks, admin-transactions, admin-dashboard,
│   │   │   │                  # patient-register, kiosk, health
│   │   │   ├── server.ts      # Entry point
│   │   │   ├── migrate.ts     # Migration runner
│   │   │   └── setup.ts       # CLI: create-admin (usado por el installer)
│   │   ├── migrations/        # 001-017 SQL versionadas
│   │   ├── uploads/           # Archivos subidos (standby media, fotos dentistas)
│   │   └── tests/             # 20 archivos · 287 tests (Vitest)
│   ├── kiosco-frontend/       # Vanilla JS + Vite → dist/
│   │   └── src/
│   │       ├── screens/       # standby, login-cedula, login-otp, home,
│   │       │                  # appointments, treatments, profile, payment,
│   │       │                  # booking, register, habeas-data
│   │       ├── components/    # keyboard.js (teclado táctil)
│   │       ├── lib/           # standby-cache.js (IndexedDB)
│   │       ├── api.js         # HTTP client (incluye loginDirect para sin-OTP)
│   │       ├── state.js       # Estado global
│   │       ├── router.js      # Navegación entre pantallas
│   │       └── idle.js        # Detector de inactividad
│   └── admin-frontend/        # Panel admin — Vanilla JS + Vite → dist/
│       └── src/
│           ├── screens/       # login, dashboard, clinic-config, dentists,
│           │                  # kiosks, transactions
│           ├── api.js         # HTTP client (token en localStorage)
│           └── main.js        # Bootstrap + enrutador lateral
├── central/
│   └── license-server/        # Servidor central de licencias (Node + Fastify + pg)
├── installer/
│   └── install.sh             # Script de instalación en Ubuntu 22.04/24.04
├── updater/
│   ├── update.sh              # Update manager con rollback y firma GPG
│   └── dk_update_pub.gpg      # Placeholder — reemplazar con clave GPG real
├── infra/
│   ├── caddy/
│   │   ├── Caddyfile          # Dev (local_certs)
│   │   └── Caddyfile.prod     # Producción (Let's Encrypt)
│   └── wireguard/
├── docker-compose.yml         # Stack completo (Caddy + API + Postgres + Redis)
├── docker-compose.override.yml  # Dev: expone postgres:5434 y redis:6381 al host
├── docker-compose.prod.yml    # Prod: usa Caddyfile.prod
├── guia.md                    # Guía de desarrollo local detallada
├── produccion.md              # Guía de deploy en Hetzner + mantenimiento
├── estado.md                  # Estado de hitos + bugs + API endpoints
└── .env                       # Variables de entorno (NUNCA commitear)
```

---

## Comandos clave

### Docker — servicios locales

```bash
# Solo infraestructura (forma correcta en dev — API corre fuera de Docker)
docker compose up -d postgres redis

# Ver estado
docker compose ps
```

### Instalar dependencias

```bash
pnpm install
```

### Migraciones

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate         # aplica pendientes
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status  # estado
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:verify  # checksums
```

### Type-check y tests

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
# → 287 tests · 20 archivos · siempre en mock mode
```

### Arrancar API (desarrollo)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
# http://localhost:3000 · tsx watch (no recarga .env — reiniciar manualmente si cambia)
```

### Arrancar frontends (desarrollo)

```bash
pnpm --filter @dentalkiosco/kiosco-frontend dev   # http://localhost:5173
pnpm --filter @dentalkiosco/admin-frontend dev    # http://localhost:5174
```

### Build de producción

```bash
pnpm --filter @dentalkiosco/kiosco-frontend build  # → apps/kiosco-frontend/dist/
pnpm --filter @dentalkiosco/admin-frontend build   # → apps/admin-frontend/dist/
```

### Crear primer admin

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"
```

Idempotente (ON CONFLICT DO NOTHING). En producción, el installer lo llama automáticamente.

---

## Variables de entorno críticas

```bash
# ── Desarrollo ──
POSTGRES_HOST=localhost        # (en dev, fuera de Docker)
POSTGRES_PORT=5434             # override del docker-compose.override.yml (antes 5433)
REDIS_HOST=localhost
REDIS_PORT=6381                # override del docker-compose.override.yml (antes 6380)
JWT_SECRET=...                 # ≥ 32 chars
ENCRYPTION_KEY=...             # ≥ 32 chars

# ── Licencia ──
LICENSE_DEV_MODE=true          # true = sin verificación (desarrollo)
LICENSE_KEY=DEV-LOCAL-...      # ignorado si LICENSE_DEV_MODE=true

# ── Funcionalidades ──
OTP_REQUIRED=true              # false = login sin código (solo cédula + teléfono)
DEV_MOCK_EXTERNAL_SERVICES=false  # POLÍTICA: SIEMPRE false → todo real (Dentalink, SMS, email)
DEV_MOCK_WOMPI=false           # POLÍTICA: SIEMPRE false → Wompi real (producción)
DEV_LOG_OTP=true               # muestra OTP en logs (además del envío real)
```

> **Bug resuelto:** `z.coerce.boolean()` interpreta `"false"` como `true`.
> Usar siempre `boolEnv()` para vars booleanas (ver sección Fixes).

---

## OTP_REQUIRED — autenticación sin código

Cuando `OTP_REQUIRED=false`:
- El backend expone `POST /auth/login-direct` (valida cédula + teléfono, sin OTP)
- El frontend (`login-cedula.js`) bifurca el flujo y salta `login-otp`
- Habeas Data sigue apareciendo siempre
- El flag se expone en `GET /kiosk/bootstrap` → `{ otp_required: bool }`

**Cambiar en producción:**
```bash
sed -i 's/^OTP_REQUIRED=.*/OTP_REQUIRED=false/' /opt/dentalkiosco/.env
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
```

---

## Modo licencia

El middleware `licenseMiddleware` se aplica como `onRequest` hook a todas las rutas.

| Variable | Efecto |
|----------|--------|
| `LICENSE_DEV_MODE=true` | Omite todo control de licencia |
| Sin heartbeat < 7 días | Modo `normal` — sin restricciones |
| Sin heartbeat 7–14 días | Modo `restrictive` — GETs pasan, escrituras → 503 |
| Sin heartbeat > 14 días o revocada | Modo `shutdown` — todo → 503 |

El modo se computa dinámicamente en `computeMode()` (cache.ts) — nunca se baja al estado en caché.

---

## Modo desarrollo — TODO REAL (decisión 2026-06-16)

**Política del proyecto:** local y producción operan SIEMPRE contra servicios
**reales**. Local sirve para probar contra lo real ANTES de commitear a git.
NO volver a poner mocks en el `.env` de dev.

| Variable | Valor | Efecto |
|----------|-------|--------|
| `DEV_MOCK_EXTERNAL_SERVICES` | `false` | Dentalink, **SMS (LabsMobile)** y email REALES |
| `DEV_MOCK_WOMPI` | `false` | Wompi REAL (`production`) |
| `DEV_LOG_OTP` | `true` | OTP visible en log, **además** del SMS real |

Implicaciones de "todo real" en local:
- Un login con OTP **envía un SMS real** vía LabsMobile (gasta saldo de la cuenta).
- Las credenciales Wompi de local == producción (`WOMPI_ENVIRONMENT=production`,
  api_url, public/private/integrity/events). Un pago en local es **real**. El
  webhook de Wompi llega al dominio de prod, no a localhost; el reconciliador en
  local igual consulta el estado por API.
- Selección de proveedor SMS en `apps/api/src/lib/sms.ts`: mock si
  `DEV_MOCK_EXTERNAL_SERVICES`; si no, LabsMobile (si configurado); luego Twilio; luego mock.
- Los **tests** siguen en mock siempre (lo fuerza `vitest.config.ts`), así que
  `pnpm test` nunca gasta servicios reales.

---

## Normalización de teléfono

Dentalink devuelve el celular sin prefijo país (`"3206505239"`).
El frontend siempre envía `"+57XXXXXXXXXX"`.
La función `normalizeCelular()` en `apps/api/src/lib/dentalink.ts` añade `+57`
a números colombianos de 10 dígitos que empiecen en 3.

**Esta función se pierde en cada parche incremental.** Siempre re-aplicarla.

---

## Estado de los hitos

| Hito | Descripción | Estado |
|------|-------------|--------|
| 1–4 | Servidor, auth admin, DB, Redis, kiosk pairing | ✅ |
| 5–6 | Auth paciente OTP, perfil, citas, tratamientos | ✅ |
| 7 | Cancelación de citas + pagos Wompi + QR | ✅ |
| 8 | Booking, reconciliador, comprobantes | ✅ |
| 9 | Panel admin completo, standby, registro, fotos | ✅ |
| 10 | License server + Update manager + Installer | 🔄 En progreso |

---

## Fixes locales a re-aplicar en cada parche

### 1. `apps/api/src/lib/config.ts`
```typescript
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  ).default(defaultVal);
// Afecta: LICENSE_DEV_MODE, OTP_REQUIRED, DEV_MOCK_EXTERNAL_SERVICES,
//         DEV_LOG_OTP, DEV_MOCK_WOMPI
```

### 2. `apps/api/src/lib/dentalink.ts`
```typescript
function normalizeCelular(celular: string): string {
  if (!celular) return celular;
  if (celular.startsWith('+')) return celular;
  if (/^3\d{9}$/.test(celular)) return `+57${celular}`;
  return celular;
}
// En lookupPatientByCedula:
const raw = data.data?.[0] ?? null;
const patient = raw ? { ...raw, celular: normalizeCelular(raw.celular) } : null;
```

### 3. `apps/api/vitest.config.ts`
```typescript
env: {
  DEV_MOCK_EXTERNAL_SERVICES: 'true',
  DEV_MOCK_WOMPI: 'true',
},
```

### 4. Migraciones SQL nuevas
```sql
INSERT INTO schema_migrations (version, name)
VALUES ('NNN', 'nombre_sin_numero')
ON CONFLICT (version) DO NOTHING;
```

---

## Base de datos — tablas principales

| Tabla | Propósito |
|-------|-----------|
| `clinic` | Singleton (id=1): config clínica, tokens cifrados, Habeas Data, standby |
| `admins` | Administradores con hash argon2id + MFA TOTP opcional |
| `kiosks` | Dispositivos pareados (token_hash, is_active) |
| `otp_codes` | Códigos OTP con TTL, intentos y consumed_at |
| `patient_sessions` | Sesiones de paciente (jti, revoked_at) |
| `habeas_data_consents` | Consentimientos por cédula_hash + versión política |
| `transactions` | Pagos Wompi (reference, status, receipt_sent_at) |
| `audit_log` | Auditoría inmutable de todas las acciones |
| `rate_limits` | Contadores de rate limiting (sobreviven reinicios) |
| `dentist_photos` | Fotos de odontólogos (dentalink_dentist_id, path, hash) |
| `schema_migrations` | Migraciones aplicadas (version, name, checksum) |

---

## Reconciliador

Corre cada minuto como `setInterval` dentro del proceso del API.
Detecta transacciones en estado `PENDING` cuyo estado real en Wompi es `APPROVED` o `DECLINED`.
```
[INFO] Reconciler started
[INFO] Reconciler cycle end  { processed: N, errors: N, expired: N }
```

---

## Acceso SSH a producción (Hetzner)

- **Servidor:** `root@5.78.110.152` (`https://sistema.2ways.us`), hostname `dentalkiosco-prod`.
- **Autenticación:** llave SSH `id_ed25519` (sin contraseña). La llave está
  respaldada en el repo en `backup2/ssh/` (`id_ed25519`, `id_ed25519.pub`, `known_hosts`)
  y normalmente ya está instalada en `~/.ssh/id_ed25519`. La misma llave abre Hetzner
  Cloud y está autorizada en el servidor.
- **Si `~/.ssh/id_ed25519` no existe**, restaurarla:
  ```bash
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  cp backup2/ssh/id_ed25519 ~/.ssh/ && chmod 600 ~/.ssh/id_ed25519
  cp backup2/ssh/id_ed25519.pub ~/.ssh/ && chmod 644 ~/.ssh/id_ed25519.pub
  cat backup2/ssh/known_hosts >> ~/.ssh/known_hosts
  ```
- **Probar / desplegar:**
  ```bash
  ssh root@5.78.110.152 'hostname'                 # → dentalkiosco-prod
  ssh root@5.78.110.152 'cd /opt/dentalkiosco && git pull && \
    docker compose -f docker-compose.yml -f docker-compose.prod.yml build api && \
    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api'
  ```
- Credenciales completas (token gh-cli, `.env` de prod, etc.) en `docs/credenciales.md`.
- ⚠️ El `Bash` tool corre en **sandbox sin red**: para `ssh`/`git push`/`git pull`
  usar `dangerouslyDisableSandbox: true`. Aun así, si la WiFi local no tiene uplink
  a internet, nada externo será alcanzable (verificar con `ping 8.8.8.8`).

---

## Producción — resumen Docker

```bash
# Levantar stack completo
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Reconstruir API y reiniciar
docker compose -f docker-compose.yml -f docker-compose.prod.yml build api
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api

# Aplicar migraciones
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api node dist/migrate.js up

# Health check (la salud JSON del API vive bajo /api/* en el dominio público;
# /health/ready "pelado" en el dominio devuelve el HTML del SPA)
curl https://<dominio>/api/health/ready | jq .
```

Ver `produccion.md` para la guía completa de deploy en Hetzner.

**Producción actual (2026-06-22):** Hetzner `5.78.110.152` → `https://sistema.2ways.us`,
rama desplegada `main` @ `c072eca` (local, prod y origin alineados). El contenedor `dk-caddy` puede
aparecer `unhealthy`: es FALSO (su healthcheck interno hace `wget` a `localhost:80`
que redirige 308→https y a veces falla por `fork: Resource temporarily unavailable`);
Caddy sirve tráfico 200 normal.

---

## Entorno local (post-reinstalación SO, 2026-06-16)

- **Node 22 vive en nvm**, no en apt. Cargar antes de cualquier `node`/`pnpm`:
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` (default ya es 22).
- pnpm 9.4.0 vía corepack. `argon2` es nativo → recompila contra Node 22 con `pnpm install`.
- Puertos dev reales: Postgres `localhost:5434`, Redis `localhost:6381`.
- Respaldos y pasos de reinstalación en `backup2/` (`iniciar.md`, `README.md`,
  `RESPALDO_EXTERNO.md`).
