# DentalKiosco v3

Kiosco de autoatención para clínicas dentales. El paciente se identifica con cédula + OTP, consulta citas y tratamientos, agenda, cancela y paga saldos pendientes con Wompi. El administrador configura el sistema desde un panel web.

**Versión:** 3.0.0-alpha · **Estado:** Hitos 1-9 completos · **Hito activo:** 10 (deploy producción)

---

## Stack

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js 22 · TypeScript · Fastify 4 · Zod |
| Base de datos | PostgreSQL 16 (pgcrypto para cifrado en reposo) |
| Caché / sesiones | Redis 7 (ioredis) |
| Frontend kiosco | Vanilla JS · ES modules · Vite 5 |
| Panel admin | Vanilla JS · ES modules · Vite 5 |
| Monorepo | pnpm workspaces |
| Contenedores | Docker Compose |
| Pagos | Wompi (Colombia) |
| SMS | Twilio (mockeable) |
| Email | Resend (mockeable) |
| Agenda | Dentalink API |

---

## Estado de hitos

| Hito | Descripción | Tests | Estado |
|------|-------------|-------|--------|
| 1-4 | Servidor Fastify, auth admin TOTP, DB, Redis, kiosk pairing | — | ✅ |
| 5-6 | Auth paciente OTP, perfil, citas, tratamientos — frontend kiosco | 82 | ✅ |
| 7 | Cancelación de citas, pagos Wompi, pantalla QR | 103 | ✅ |
| 8 | Booking 5 pasos, reconciliador, comprobantes, migración 009 | 131 | ✅ |
| 9 | Standby multimodal, registro paciente, fotos dentistas, panel admin | 195 | ✅ |
| 10 | License server, monitoreo, métricas, deploy producción | — | 🔲 |

**Tests actuales:** 195 / 195 pasando (10 archivos) · **Migraciones:** 11/11 aplicadas

---

## Arranque rápido (desarrollo)

### 1. Requisitos previos
- Node.js 22, pnpm 9+, Docker + Docker Compose

### 2. Variables de entorno
```bash
cp .env.example .env   # Editar con tus valores reales
```

### 3. Infraestructura (PostgreSQL + Redis)
```bash
docker compose up -d postgres redis
docker compose ps     # Esperar "(healthy)" en ambos
```

### 4. Dependencias y migraciones
```bash
pnpm install
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
```

### 5. Arrancar servicios
```bash
# Terminal 1 — API (recarga automática)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev

# Terminal 2 — Kiosco frontend
pnpm --filter @dentalkiosco/kiosco-frontend dev

# Terminal 3 — Panel admin
pnpm --filter @dentalkiosco/admin-frontend dev
```

| Servicio | URL |
|----------|-----|
| API | http://localhost:3000 |
| Frontend kiosco | http://localhost:5173 |
| Panel admin | http://localhost:5174 |

### 6. Acceder al kiosco
El frontend requiere un `kiosk_token` JWT. Desde el panel admin → sección **Kioscos** → crear kiosco → copiar el token → abrir `http://localhost:5173/?kiosk_token=<token>`.

---

## Comandos frecuentes

```bash
# Verificar estado de migraciones
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status

# Type-check (debe dar 0 errores)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck

# Tests (siempre en mock mode)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test

# Build de producción
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build

# Simular pago aprobado (mock Wompi)
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<ref>","status":"APPROVED","amount_in_cents":100000}},"sent_at":"2026-05-19T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'
```

---

## Estructura del monorepo

```
dentalkiosco/
├── apps/
│   ├── api/                        # Backend Fastify + TypeScript
│   │   ├── src/
│   │   │   ├── lib/                # config, db, redis, jwt, sms, email,
│   │   │   │                       # dentalink, wompi, reconciler, crypto
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── admin-auth.ts
│   │   │   │   ├── admin-clinic.ts
│   │   │   │   ├── admin-dentists.ts
│   │   │   │   ├── admin-kiosks.ts       ← nuevo Hito 9
│   │   │   │   ├── admin-transactions.ts ← nuevo Hito 9
│   │   │   │   ├── admin-dashboard.ts    ← nuevo Hito 9
│   │   │   │   ├── patient-auth.ts
│   │   │   │   ├── patient-me.ts
│   │   │   │   ├── patient-register.ts
│   │   │   │   ├── kiosk.ts
│   │   │   │   ├── booking.ts
│   │   │   │   └── payments.ts
│   │   │   └── server.ts
│   │   ├── migrations/             # 001 → 011 SQL versionadas
│   │   ├── tests/                  # 10 archivos · 195 tests
│   │   └── uploads/                # Standby media + fotos dentistas
│   ├── kiosco-frontend/            # Vanilla JS + Vite
│   │   └── src/
│   │       ├── screens/            # standby, login, home, citas,
│   │       │                       # tratamientos, booking, payment, register
│   │       ├── components/         # keyboard.js (teclado táctil)
│   │       └── lib/                # standby-cache.js (IndexedDB)
│   └── admin-frontend/             # Panel admin — Vanilla JS + Vite
│       └── src/
│           ├── screens/
│           │   ├── dashboard.js    ← nuevo Hito 9
│           │   ├── clinic-config.js
│           │   ├── dentists.js
│           │   ├── kiosks.js       ← nuevo Hito 9
│           │   └── transactions.js ← nuevo Hito 9
│           ├── api.js
│           └── main.js
├── docs/
│   ├── DEPLOY_PRODUCCION.md        # Guía deploy Hetzner/VPS
│   └── ADMIN_PANEL.md              # Guía panel admin
├── infra/caddy/Caddyfile
├── docker-compose.yml
├── docker-compose.override.yml     # Puertos locales: PG:5433, Redis:6380
├── estado.md                       # Estado detallado del proyecto
├── guia.md                         # Secuencia completa de arranque
└── CLAUDE.md                       # Instrucciones para Claude Code
```

---

## API — endpoints disponibles

### Health
```
GET  /health
```

### Kiosco (requiere kiosk_token)
```
GET  /kiosk/bootstrap
GET  /kiosk/standby
GET  /kiosk/standby/media
POST /kiosk/register
```

### Auth paciente (requiere kiosk_token)
```
POST /auth/request-otp
POST /auth/verify-otp
POST /auth/logout
```

### Paciente autenticado (requiere patient_token)
```
GET  /me/profile
GET  /me/appointments
GET  /me/treatments
POST /me/payments
GET  /me/payments/:reference
GET  /me/booking/branches
GET  /me/booking/dentists
GET  /me/booking/slots
POST /me/booking/appointments
DELETE /me/booking/appointments/:id
```

### Admin (requiere admin_token + MFA)
```
POST /admin/auth/login
POST /admin/auth/mfa/verify
POST /admin/auth/mfa/enroll-start
POST /admin/auth/mfa/enroll-confirm
GET  /admin/auth/me
POST /admin/auth/logout

GET    /admin/clinic
PATCH  /admin/clinic
POST   /admin/clinic/standby-media
GET    /admin/clinic/standby-media
DELETE /admin/clinic/standby-media

GET    /admin/dentists
POST   /admin/dentists/:id/photo
DELETE /admin/dentists/:id/photo

GET    /admin/kiosks
POST   /admin/kiosks
PATCH  /admin/kiosks/:id
DELETE /admin/kiosks/:id

GET    /admin/transactions

GET    /admin/dashboard
```

### Público (sin auth)
```
GET  /public/dentist-photo/:id
POST /webhooks/wompi
```

---

## Panel admin — secciones

| Sección | Descripción |
|---------|-------------|
| **Dashboard** | Métricas del día: kioscos activos, transacciones, monto aprobado, pagos pendientes + tabla de últimas 10 |
| **Configuración clínica** | Datos de la clínica, Habeas Data, modo standby (mensaje/gif/video) |
| **Odontólogos** | Subir y eliminar fotos por dentista |
| **Kioscos** | Crear kioscos (genera token JWT), activar/desactivar, revocar |
| **Transacciones** | Listado paginado con filtros por estado y fechas |

---

## Variables de entorno clave

```bash
# Base de datos
POSTGRES_HOST=localhost
POSTGRES_PORT=5433
POSTGRES_DB=dentalkiosco
POSTGRES_USER=dentalkiosco
POSTGRES_PASSWORD=...
REDIS_HOST=localhost
REDIS_PORT=6380
REDIS_PASSWORD=...

# Seguridad
JWT_SECRET=...            # ≥32 chars
ENCRYPTION_KEY=...        # Base64 — pgcrypto

# Servicios externos
DENTALINK_TOKEN=...
RESEND_API_KEY=re_...
WOMPI_PUBLIC_KEY=...
WOMPI_PRIVATE_KEY=...
WOMPI_EVENTS_SECRET=...
WOMPI_INTEGRITY_SECRET=...

# Modo desarrollo
DEV_MOCK_EXTERNAL_SERVICES=false  # true → mockea todo
DEV_MOCK_WOMPI=true               # true → mockea solo Wompi
DEV_LOG_OTP=true                  # Muestra OTP en logs
```

---

## Documentación adicional

- `estado.md` — estado detallado, historial de commits, bugs corregidos
- `guia.md` — secuencia completa de arranque y comandos de diagnóstico
- `docs/DEPLOY_PRODUCCION.md` — guía de deploy a Hetzner/VPS con Caddy
- `docs/ADMIN_PANEL.md` — guía de uso del panel admin
- `CLAUDE.md` — instrucciones y contexto para Claude Code
