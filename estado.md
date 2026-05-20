# DentalKiosco — Estado del proyecto
**Fecha:** 2026-05-20 · **Rama activa:** `hito10`

---

## Resumen de hitos

| Hito | Contenido | Tests | Estado |
|------|-----------|-------|--------|
| 1–4 | Servidor Fastify, auth admin (TOTP), DB, Redis, kiosk pairing | — | ✅ Completado |
| 5–6 | Auth paciente OTP (SMS mock + email Resend), perfil, citas, tratamientos | 82 | ✅ Completado |
| 7 | Cancelación de citas, pagos Wompi, pantalla QR | 103 | ✅ Completado |
| 8 | Booking 5 pasos, reconciliador, comprobantes email/SMS | 131 | ✅ Completado |
| 9 | Standby multimodal, registro paciente, fotos dentistas, panel admin completo | 195 | ✅ Completado |
| 10 | License server · Update manager · Installer | 195 | 🔄 En progreso |

**Tests actuales: 195 / 195 pasando (10 archivos).**
**Migraciones: 11/11 aplicadas (001 → 011).**

---

## Hito 10 — detalle de lo implementado

### Sistema de licenciamiento (rama `hito10`, commit `95dd5dc`)

**Servidor central** (`central/license-server/`):
- `POST /licenses/validate` — valida clave de licencia, upserta instalación
- `POST /licenses/heartbeat` — actualiza `last_heartbeat_at` e métricas de salud
- `POST /licenses` · `GET /licenses` · `GET /licenses/:key` — gestión superadmin
- `POST /licenses/:key/revoke` — revocación inmediata
- Tabla `licenses` (key, clinic_name, plan, features, expires_at, status)
- Tabla `installations` (uuid, license_key FK, fingerprint, last_heartbeat_at, health_metrics JSONB)
- Tabla `license_audit` (log inmutable de eventos)

**Cliente en API** (`apps/api/src/lib/license/`):
- `cache.ts` — `LicenseState` en Redis (TTL 30 días); `computeMode()` dinámico desde `last_successful_heartbeat_at`
- `client.ts` — `validateLicense()` y `sendHeartbeat()` con timeout 15 s
- `fingerprint.ts` — huella determinista: SHA256(`/etc/machine-id` + `INSTALLATION_ID` + hostname)
- `worker.ts` — validate al arranque (bloqueante) + heartbeat cada `LICENSE_HEARTBEAT_INTERVAL_HOURS`
- `middleware.ts` — hook `onRequest`: modo `normal` → pasa; `restrictive` → bloquea escrituras (503); `shutdown` → bloquea todo (503)

**Modos de licencia:**
| Días sin heartbeat | Modo | Efecto |
|---|---|---|
| < 7 | `normal` | Sin restricciones |
| 7–14 | `restrictive` | Solo GET; escribe → 503 `LICENSE_RESTRICTED` |
| > 14 o revocada | `shutdown` | Todo → 503 `LICENSE_EXPIRED` |

**Variable de desarrollo:** `LICENSE_DEV_MODE=true` — omite todo control de licencia.

---

### Update Manager (`updater/update.sh`, commit `8695342`)

Script bash (~862 líneas) que corre vía cron cada noche:
1. Verifica licencia activa antes de actualizar
2. Descarga manifiesto firmado GPG desde `UPDATE_SERVER_URL`
3. Compara versión actual vs. disponible (semver)
4. Versiones mayores → requiere archivo `.approved-update` (aprobación manual)
5. Backup de PostgreSQL con `pg_dump` (retiene últimos 7)
6. Descarga imágenes Docker y escribe `docker-compose.images.yml`
7. Aplica migraciones nuevas
8. Reinicia servicios y hace health check (120 s)
9. Rollback automático si health check falla
10. Notifica al admin por email (Resend)

`updater/dk_update_pub.gpg` — placeholder; reemplazar con clave GPG real del proveedor.

**Testeable localmente:** firma GPG (`--generate-test-keys`), lógica de versiones, backup/restore, health check.
**Requiere VPS:** descarga de imágenes reales, manifiesto real del servidor de actualizaciones.

---

### Installer (`installer/install.sh`, commit `d624569`)

Script bash (~400 líneas) para montar el sistema en un VPS Ubuntu 22.04/24.04 limpio.

| Fase | Descripción | Testeable local |
|------|-------------|-----------------|
| 1 | Pre-flight: OS, CPU ≥ 2, RAM ≥ 4 GB, disco ≥ 20 GB, Internet | ✅ |
| 2 | Validar licencia contra license server | ❌ (necesita server) |
| 3 | Instalar Docker, Node.js 22, pnpm, fail2ban, wireguard-tools | ❌ (apt/root) |
| 4 | UFW: deny-all + permitir 22/80/443 | ❌ (kernel real) |
| 5 | Wizard interactivo: nombre, NIT, admin, dominio, integraciones | ✅ |
| 6 | Generar `.env` con secretos criptográficos (openssl) | ✅ |
| 7 | Build frontends (pnpm) + imagen API (docker build) | ❌ (Docker) |
| 8 | `docker compose up -d` + esperar healthchecks | ❌ (Docker) |
| 9 | Esperar TLS Let's Encrypt en el dominio | ❌ (dominio real) |
| 10 | Migraciones: `docker compose exec api node dist/migrate.js up` | ❌ (stack) |
| 11 | Crear admin: `docker compose exec api node dist/setup.js create-admin` | ❌ (stack) |
| 12 | Health check final + reporte de URLs y credenciales + cron | ❌ (stack) |

**Idempotente:** detecta `.dk-installed` y preserva secretos en re-ejecución.

**Archivos relacionados creados en este commit:**
- `apps/api/src/setup.ts` — CLI `create-admin` con argon2id (idempotente)
- `infra/caddy/Caddyfile.prod` — sin `local_certs` → Let's Encrypt real
- `docker-compose.prod.yml` — override: usa `Caddyfile.prod`
- Fix `apps/api/src/lib/db.ts`: SSL desactivado en red interna Docker
- Fix `docker-compose.yml`: `admin-frontend/out` → `admin-frontend/dist`

---

## Hito 9 — detalle completo

### Standby multimodal
- Migración `010`: columnas standby en `clinic`
- Backend: `GET/PATCH /admin/clinic` · `POST/DELETE/GET /admin/clinic/standby-media` · `GET /kiosk/standby` · `GET /kiosk/standby/media`
- Admin: radio cards (mensaje/gif/video), drag-and-drop, preview
- Kiosco: `standby.js` con IndexedDB cache y 3 modos de render

### Registro de paciente
- Backend: `POST /kiosk/register` con validación completa + duplicados en Dentalink
- Kiosco: pantalla `register.js` con teclado táctil, DOB, confirmaciones

### Fotos de odontólogos
- Migración `011`: tabla `dentist_photos`
- Backend: `GET/POST/DELETE /admin/dentists/:id/photo` · `GET /public/dentist-photo/:id`
- Booking: `photo_url` incluido si existe foto

### Auth sin OTP (`OTP_REQUIRED=false`)
- Backend: `POST /auth/login-direct` — valida cédula + teléfono sin OTP
- Frontend: `login-cedula.js` bifurca flujo según flag de bootstrap
- `.env`: `OTP_REQUIRED=false` deshabilita la pantalla de código

### Fix cancelación de citas
- Eliminado campo `comentario_cancelacion` del PUT (Dentalink lo rechazaba)

---

## Panel admin — secciones disponibles

| Sección | URL | Descripción |
|---------|-----|-------------|
| Dashboard | `/admin` | Métricas del día + últimas transacciones |
| Configuración clínica | Sidebar | Datos, Habeas Data, standby multimodal |
| Odontólogos | Sidebar | Subir/borrar foto por dentista |
| Kioscos | Sidebar | CRUD de kioscos con token JWT |
| Transacciones | Sidebar | Listado paginado con filtros |

---

## Fixes permanentes (re-aplicar en cada parche del proveedor)

### `config.ts` — boolEnv
```typescript
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  ).default(defaultVal);
// Afecta: LICENSE_DEV_MODE, OTP_REQUIRED, DEV_MOCK_EXTERNAL_SERVICES, DEV_LOG_OTP, DEV_MOCK_WOMPI
```

### `dentalink.ts` — normalizeCelular
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

### `vitest.config.ts` — env block
```typescript
env: { DEV_MOCK_EXTERNAL_SERVICES: 'true', DEV_MOCK_WOMPI: 'true' }
```

### Migraciones SQL nuevas
```sql
INSERT INTO schema_migrations (version, name)
VALUES ('NNN', 'nombre') ON CONFLICT (version) DO NOTHING;
```

---

## API Dentalink — endpoints confirmados

| Endpoint | Método | Estado | Notas |
|----------|--------|--------|-------|
| `/api/v1/sucursales` | GET | ✅ | Sin parámetros |
| `/api/v1/dentistas` | GET | ✅ | Sin filtro o con `q={"id_sucursal":{"eq":N}}` |
| `/api/v1/dentistas/{id}/horarios` | GET | ✅ | Horario semanal con intervalo |
| `/api/v1/pacientes?q={"rut":{"eq":"..."}}` | GET | ✅ | Lookup por cédula |
| `/api/v1/pacientes` | POST | ✅ | celular sin prefijo +57 |
| `/api/v1/pacientes/{id}/citas` | GET | ✅ | Sin query params |
| `/api/v1/pacientes/{id}/tratamientos` | GET | ✅ | Sin query params |
| `/api/v1/citas/{id}` | PUT | ✅ | Cancelar con `id_estado: 3` únicamente |
| `/api/v1/citas` | POST | ✅ | Requiere id_sillon, duracion, id_dentista |
| `/api/v1/citas?q=...` | GET | ❌ | Siempre 400 |
| `/api/v1/citas/horarios-disponibles` | GET | ❌ | No existe (404) |

---

## Próximos pasos — Hito 10 pendiente

- [ ] Monitoreo y alertas (uptime, errores críticos, pagos atascados)
- [ ] Métricas Prometheus / dashboard Grafana
- [ ] Validación end-to-end del installer en VPS Hetzner real
- [ ] Hardening final: rate limits globales, auditoría de seguridad
