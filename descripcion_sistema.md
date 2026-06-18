# Descripción del sistema — DentalKiosco (estado local, rama `mejora_17jun`)

> Esquema jerárquico del sistema tal como está en **local** (commit `f984073`).
> Objetivo: entender de un vistazo qué piezas existen y qué hace cada una.
> Para diagramas visuales, correr `scripts/gen_diagramas.sh` (genera Mermaid + SVG).

---

## 0. Qué es

Kiosco de autoatención para clínicas dentales. El paciente se identifica con
**cédula + OTP** (SMS/email) o solo **cédula + teléfono** (si `OTP_REQUIRED=false`),
consulta citas y tratamientos, agenda/cancela, y paga saldos pendientes con
**Wompi (QR)**. Un **administrador** configura todo desde un panel web. Incluye
servidor de licencias, update manager e installer.

**Stack:** Node 22 · TypeScript · Fastify 4 · Zod · PostgreSQL 16 (pgcrypto) ·
Redis 7 · Vanilla JS + Vite 5 (frontends) · Caddy 2 (TLS) · Docker Compose ·
pnpm workspaces.

---

## 1. Monorepo (raíz)

```
dentalkiosco/
├── apps/                  → aplicaciones (API + 2 frontends)
├── central/               → servidor central de licencias
├── installer/             → install.sh (Ubuntu 22/24)
├── updater/               → update.sh (rollback + firma GPG)
├── infra/                 → Caddy (TLS) + WireGuard
├── scripts/               → utilidades (secrets, diagramas)
├── docs/                  → documentación y estado
└── docker-compose*.yml    → stack (Caddy + API + Postgres + Redis)
```

---

## 2. `apps/api` — Backend Fastify

Punto de entrada `src/server.ts`. Aplica, en orden: helmet → CORS → multipart →
**rate-limit global (Redis)** → **licenseMiddleware (onRequest)** → rutas.

### 2.1 `src/routes/` — Endpoints HTTP
| Ruta | Responsabilidad |
|------|-----------------|
| `health.ts` | Liveness/readiness (DB + Redis); excluida de rate-limit |
| `kiosk.ts` | Pairing de kioscos, `/kiosk/bootstrap` (expone `otp_required`) |
| `patient-auth.ts` | `request-otp`, `verify-otp`, `login-direct` (sin OTP); genera/valida OTP |
| `patient-me.ts` | Perfil, citas, tratamientos, cancelación (requiere sesión paciente) |
| `patient-register.ts` | Alta de paciente nuevo en Dentalink |
| `booking.ts` | Agendamiento de citas |
| `payments.ts` | ⚠️ Pagos Wompi + **webhook firmado** (NO TOCAR sin autorización) |
| `admin-auth.ts` | Login admin (argon2id + MFA TOTP), revocación de sesión |
| `admin-clinic.ts` | Config de la clínica (tokens cifrados, Habeas Data, standby, logo) |
| `admin-dentists.ts` | CRUD de fotos de odontólogos |
| `admin-kiosks.ts` | Alta/revocación de kioscos |
| `admin-transactions.ts` | Listado/consulta de pagos |
| `admin-dashboard.ts` | Métricas |
| `public.ts` | Recursos públicos (p.ej. logo de clínica) |

### 2.2 `src/lib/` — Lógica de soporte
| Módulo | Responsabilidad |
|--------|-----------------|
| `config.ts` | Carga/valida env con Zod; `boolEnv()` para booleanos |
| `db.ts` / `redis.ts` | Pools de Postgres / cliente ioredis |
| `crypto.ts` | Cifrado en reposo vía `fn_encrypt/fn_decrypt` (pgcrypto) |
| `passwords.ts` | Hash **argon2id** (64 MB, timeCost 3) |
| `jwt.ts` | Firma/verifica JWT HS256: admin (8h), kiosco (90d), paciente (10min) |
| `otp.ts` | Genera OTP, hash SHA256(salt:code), hash de cédula |
| `totp.ts` | MFA TOTP (QR, verificación, recovery codes) |
| `auth-middleware.ts` | Guard de admin (Bearer + blocklist Redis + rol + MFA) |
| `patient-middleware.ts` | Guard de paciente (Bearer + revocación en DB) |
| `turnstile.ts` | Verificación server-side de Cloudflare Turnstile |
| `sms.ts` / `email.ts` | Envío real (LabsMobile/Twilio · Resend/SMTP) o mock |
| `notifications.ts` | Orquesta OTP/comprobantes por SMS+email |
| `dentalink.ts` | Cliente API Dentalink + `normalizeCelular()` (+57) |
| `wompi.ts` | Cliente Wompi + `verifyWebhookSignature()` (HMAC SHA256) |
| `reconciler.ts` | ⚠️ Cron interno (1 min): concilia pagos PENDING (NO TOCAR) |
| `audit.ts` | Escribe en `audit_log` (auditoría inmutable) |
| `logger.ts` | Pino con **redacción** de secretos/PII + helpers de máscara |
| `license/` | `{cache,client,fingerprint,middleware,worker}` — control de licencia |

### 2.3 Otros
- `migrations/` — 001→017 SQL versionadas + `schema_migrations`.
- `migrate.ts` — runner de migraciones. `setup.ts` — CLI `create-admin`.
- `tests/` — 20 archivos · 287 tests (Vitest, siempre en mock).
- `uploads/` — archivos subidos (standby, fotos de dentistas).

---

## 3. `apps/kiosco-frontend` — Frontend del paciente (Vanilla JS + Vite)

| Sub-rama | Contenido |
|----------|-----------|
| `src/screens/` | standby · login-cedula · login-otp · home · appointments · treatments · profile · payment · booking · register · habeas-data · faq (variantes `.apple` = UI nueva) |
| `src/components/` | keyboard (teclado táctil) · modal · toast · spinner · clinic-header |
| `src/lib/` | `mode.js` (kiosco vs web por token `?k=`) · `standby-cache.js` (IndexedDB) · `turnstile.js` |
| `src/api.js` | Cliente HTTP (incluye `loginDirect` para flujo sin OTP) |
| `src/state.js` · `router.js` · `idle.js` | Estado global · navegación · detector de inactividad |

---

## 4. `apps/admin-frontend` — Panel admin (Vanilla JS + Vite)

| Sub-rama | Contenido |
|----------|-----------|
| `src/screens/` | login · change-password · dashboard · clinic-config · dentists · kiosks · transactions |
| `src/api.js` | Cliente HTTP (token en localStorage) |
| `src/main.js` | Bootstrap + enrutador lateral |

---

## 5. Infra y operación

| Sub-rama | Contenido |
|----------|-----------|
| `central/license-server/` | Servidor central de licencias (Node + Fastify + pg) |
| `installer/install.sh` | Instalación en Ubuntu 22.04/24.04 |
| `updater/update.sh` | Update manager con rollback y firma GPG |
| `infra/caddy/` | `Caddyfile` (dev, certs locales) · `Caddyfile.prod` (Let's Encrypt) |
| `infra/wireguard/` | VPN para acceso de administración |
| `docker-compose.yml` | Stack base (Caddy + API + Postgres + Redis) |
| `docker-compose.override.yml` | Dev: expone Postgres 5434 / Redis 6381 |
| `docker-compose.prod.yml` | Prod: Caddyfile.prod + monta `dist/` de frontends |

---

## 6. Datos (tablas principales)

`clinic` (singleton, config + tokens cifrados) · `admins` (argon2id + MFA) ·
`kiosks` · `otp_codes` · `patient_sessions` · `habeas_data_consents` ·
`transactions` (pagos Wompi) · `audit_log` (inmutable) · `rate_limits` ·
`dentist_photos` · `schema_migrations`.

---

## 7. Flujos clave (resumen)

1. **Login paciente (OTP):** cédula → API valida en Dentalink → genera OTP →
   SMS/email real → paciente ingresa código → verify → JWT de sesión (10 min).
2. **Login sin OTP (`OTP_REQUIRED=false`):** cédula + teléfono → `login-direct` → JWT.
3. **Pago:** paciente elige saldo → API crea transacción Wompi → QR → paciente
   paga → **webhook firmado** o **reconciliador** confirma → comprobante por email.
4. **Admin:** login (argon2id + MFA) → JWT 8h → configura clínica, kioscos, etc.
5. **Licencia:** worker hace heartbeat al license-server; `licenseMiddleware`
   degrada el sistema (normal → restrictivo → shutdown) según días sin heartbeat.

> Diagramas detallados de estos flujos: `scripts/gen_diagramas.sh` → `docs/diagramas/`.
