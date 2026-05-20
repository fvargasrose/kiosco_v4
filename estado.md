# DentalKiosco — Estado del proyecto
**Fecha:** 2026-05-19 · **Rama activa:** `hito9` (en sync con `main`)

---

## Historial de commits (recientes)

```
0f2bc16  feat: dashboard con métricas en panel admin (Hito 9 - Bloque C)
04a5097  feat: vista de transacciones en panel admin (Hito 9 - Bloque B)
57a6004  feat: gestión de kioscos desde panel admin (Hito 9 - Bloque A)
d5373a4  chore: ignorar uploads de usuarios, preservar estructura de directorios
2e495a8  docs: guía de despliegue a producción (Hetzner / VPS)
d1b83e7  docs: guía de acceso y administración del panel admin
f27749f  feat: fotos de odontólogos en panel admin y kiosco
aea2c3e  hito9: registro de paciente nuevo desde el kiosco
77dccea  hito9: standby multimodal (mensaje/gif/video) — backend + admin + kiosk
1872adc  Fix: booking real Dentalink — dentistas filter, slots desde horario
```

---

## Bloques de hitos

| Hito | Contenido | Tests | Estado |
|------|-----------|-------|--------|
| 1-4 | Servidor Fastify, auth admin (TOTP), DB, Redis, kiosk pairing | — | ✅ |
| 5-6 | Auth paciente OTP (SMS mock + email Resend), perfil, citas, tratamientos | 82 | ✅ |
| 7 | Cancelación de citas, pagos Wompi, pantalla QR | 103 | ✅ |
| 8 | Booking 5 pasos, reconciliador, comprobantes email/SMS, migración 009 | 131 | ✅ |
| 9 | Standby multimodal, registro paciente, fotos dentistas, panel admin completo | 195 | ✅ |
| 10 | License server, monitoreo, métricas, deploy producción | — | 🔲 Pendiente |

**Tests actuales: 195 / 195 pasando (10 archivos).**
**Migraciones: 11/11 aplicadas (001 → 011).**

---

## Hito 9 — detalle completo

### Standby multimodal (commit `77dccea`)
- Migración `010_standby`: columnas `standby_mode`, `standby_title`, `standby_subtitle`, `standby_media_path`, `standby_media_hash`, `standby_media_mime`
- Backend: `GET/PATCH /admin/clinic` con objeto `standby` anidado; `POST/DELETE/GET /admin/clinic/standby-media`; `GET /kiosk/standby`; `GET /kiosk/standby/media` (streaming)
- Admin frontend: panel `clinic-config.js` con radio cards (mensaje/gif/video), drag-and-drop, preview
- Kiosco: `standby.js` reescrito con IndexedDB cache (`standby-cache.js`) y 3 modos de render

### Registro de paciente nuevo (commit `aea2c3e`)
- Backend: `POST /kiosk/register` — valida con Zod + `superRefine` (3 pares confirm), consulta Dentalink duplicados, crea paciente
- `dentalink.ts`: métodos `checkPatientExistsByEmailOrCelular()` y `createPatient()`
- Kiosco: pantalla `register.js` — formulario único con scroll, teclado táctil (`keyboard.js`), 3 selectores DOB, sexo radio, campos confirm con validación en blur
- Enlace "Regístrate" en pantalla `login-cedula.js`
- Tests: 13 casos (validación, duplicados, éxito)

### Fotos de odontólogos (commit `f27749f`)
- Migración `011_dentist_photos`: tabla `dentist_photos(dentalink_dentist_id PK, photo_path, photo_hash, uploaded_at)`
- Backend: `GET /admin/dentists` (lista con has_photo), `POST/DELETE /admin/dentists/:id/photo` (multipart, 5MB, JPEG/PNG/WebP), `GET /public/dentist-photo/:id` (sin auth, cache 1h)
- `dentalink.ts`: método `getAllDentists()` (sin filtro de sucursal)
- `booking.ts`: `GET /me/booking/dentists` incluye `photo_url` si existe foto
- Admin frontend: `dentists.js` — grid de tarjetas con upload/delete por odontólogo
- Kiosco: `booking.js` — paso de dentista reemplazado por grid con foto circular; fallback a avatar de iniciales con `onerror`
- Tests: 15 casos (CRUD foto, público sin auth, booking con photo_url)

### Gestión de kioscos desde panel admin (commit `57a6004`)
- Backend: `GET/POST/PATCH/DELETE /admin/kiosks`
  - Crea kiosco con JWT firmado via `signKioskToken`, expuesto una sola vez
  - PATCH activa/desactiva con `revoked_at` y `revoked_by` automáticos
  - DELETE soft-revoke con motivo `revoked_by_admin`
- Admin frontend: `kiosks.js` — tabla con estado, última conexión, expiración; formulario inline con alerta de token único; toggle activar/desactivar; revocar con confirmación
- Tests: 14 casos (CRUD, auth, 404, token único no expuesto en listado)

### Vista de transacciones (commit `04a5097`)
- Backend: `GET /admin/transactions` — paginado (20/pág), filtros por `status` (6 valores) y rango de fechas; JOIN con `kiosks` para nombre; `amount_cop` como número
- Admin frontend: `transactions.js` — filtros por estado + fechas + limpiar; tabla con referencia, paciente enmascarado, monto COP, badge de estado, método de pago, kiosco, comprobante; resumen de aprobadas; paginación
- Tests: 12 casos (auth, filtros, paginación, formatos)

### Dashboard con métricas (commit `0f2bc16`)
- Backend: `GET /admin/dashboard` — una CTE que agrega: kioscos activos/total, transacciones del día (cantidad + monto aprobado), pagos pendientes globales, últimas 10 transacciones con kiosco
- Admin frontend: `dashboard.js` — pantalla de inicio con 4 tarjetas de métricas navegables + tabla de últimas transacciones + botón "Ver todas"
- `main.js`: Dashboard como sección por defecto al iniciar sesión; navegación inyectada a todas las secciones
- Tests: 10 casos (estructura, métricas, today filtrado por fecha)

---

## Panel admin — secciones disponibles

| Sección | Ruta frontend | Descripción |
|---------|--------------|-------------|
| Dashboard | `/` (inicio) | Métricas del día + últimas transacciones |
| Configuración clínica | Sidebar | Datos clínica, Habeas Data, standby |
| Odontólogos | Sidebar | Fotos por dentista |
| Kioscos | Sidebar | CRUD de kioscos con token JWT |
| Transacciones | Sidebar | Listado paginado con filtros |

---

## Fixes aplicados sobre los parches del proveedor

Estos fixes se pierden cuando se aplica un parche nuevo y deben re-aplicarse siempre.

### `apps/api/src/lib/config.ts`
```typescript
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  ).default(defaultVal);
// Reemplazar z.coerce.boolean().default(X) con boolEnv(X)
// Variables: LICENSE_DEV_MODE, DEV_MOCK_EXTERNAL_SERVICES, DEV_LOG_OTP, DEV_MOCK_WOMPI
```

### `apps/api/src/lib/dentalink.ts`
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

### `apps/api/vitest.config.ts`
```typescript
env: {
  DEV_MOCK_EXTERNAL_SERVICES: 'true',
  DEV_MOCK_WOMPI: 'true',
},
```

### Migraciones SQL nuevas
Cada `.sql` debe terminar con:
```sql
INSERT INTO schema_migrations (version, name)
VALUES ('NNN', 'nombre')
ON CONFLICT (version) DO NOTHING;
```

---

## Bugs corregidos en sesiones anteriores

### Booking — POST /api/v1/citas fallaba (2026-05-19)

| Bug | Fix |
|-----|-----|
| `id_sillon` no se enviaba | Se lee de `clinic.sillon_id` y se pasa a `createAppointment` |
| `duracion` no se enviaba (campo requerido por Dentalink) | Se calcula como `hora_fin - hora_inicio` en minutos |
| `id_estado: 1` = "Anulado" en esta instalación | Se eliminó — Dentalink asigna estado inicial por defecto |
| Slot seleccionado = slot incorrecto en confirmación | Bug en `booking.js`: `data-idx` indexaba el sub-grupo (mañana/tarde) pero el handler usaba el array completo. Fix: `data-hora` + `slots.find()` |
| Logging de errores Dentalink era vacío | `handleDentalinkError` y ruta booking ahora logean `upstreamBody` completo |

**Resultado:** `POST /api/v1/citas` funcionando — probado con cedula 10697021, German Fernandez, 2026-06-01 17:00 → HTTP 201.

---

### Booking — "No pudimos cargar esta información" (commit `1872adc`)

| Endpoint | Bug | Fix |
|----------|-----|-----|
| `GET /me/booking/dentists` | Usaba `?sucursal_id=1` — Dentalink requiere `q={"id_sucursal":{"eq":1}}` | Corregido formato de filtro |
| `GET /me/booking/slots` | Llamaba `/api/v1/citas/horarios-disponibles` (no existe → 404) | Reemplazado por `/api/v1/horarios` del dentista + cálculo de slots |
| `GET /me/booking/branches` | Devolvía campos extra de Dentalink | Mapeo explícito |
| Campos dentistas | `apellidos` (plural) vs `apellido` (singular); `habilitado` no filtrado | Mapeo + filtro |
| `POST /me/booking/appointments` | IDs como string; campo `comentario` incorrecto | Numéricos + `comentarios` |

---

## API real Dentalink — endpoints confirmados

| Endpoint | Método | Funciona | Notas |
|----------|--------|----------|-------|
| `/api/v1/sucursales` | GET | ✅ | Sin parámetros |
| `/api/v1/dentistas` | GET | ✅ | Requiere `q={"id_sucursal":{"eq":N}}` o sin filtro |
| `/api/v1/dentistas/{id}/horarios` | GET | ✅ | Horario semanal con intervalo |
| `/api/v1/pacientes?q={"rut":{"eq":"..."}}` | GET | ✅ | Lookup por cédula |
| `/api/v1/pacientes?q={"email":{"eq":"..."}}` | GET | ✅ | Lookup por email |
| `/api/v1/pacientes?q={"celular":{"eq":"..."}}` | GET | ✅ | Sin prefijo +57 |
| `/api/v1/pacientes` | POST | ✅ | Crear paciente; celular sin +57 |
| `/api/v1/pacientes/{id}/citas` | GET | ✅ | Sin query params |
| `/api/v1/pacientes/{id}/tratamientos` | GET | ✅ | Sin query params |
| `/api/v1/citas/{id}` | PUT | ✅ | Cancelar con `id_estado: 3` |
| `/api/v1/citas` | POST | ⚠️ | No probado en producción |
| `/api/v1/citas?q=...` | GET | ❌ | Siempre 400 |
| `/api/v1/citas/horarios-disponibles` | GET | ❌ | No existe (404) |

---

## Configuración actual (`.env`)

```
DEV_MOCK_EXTERNAL_SERVICES=false   → Dentalink real
DEV_MOCK_WOMPI=true                → Wompi simulado
DEV_LOG_OTP=true                   → OTP visible en logs
RESEND_API_KEY=re_DuPMPdxi_...     → Email OTP real a fabiavargas@gmail.com
```

---

## Infraestructura activa

| Servicio | Puerto | Estado |
|----------|--------|--------|
| PostgreSQL 16 | 5433 | ✅ docker |
| Redis 7 | 6380 | ✅ docker |
| API Fastify | 3000 | ✅ tsx watch |
| Frontend kiosco (Vite) | 5173 | ✅ vite dev |
| Panel admin (Vite) | 5174 | ✅ vite dev |

---

## Próximo paso — Hito 10

- License server (validación de licencias por clínica)
- Monitoreo y alertas (uptime, errores, pagos)
- Métricas agregadas (Prometheus / dashboards)
- Deploy a producción en Hetzner (Caddy + Docker Compose)
- Hardening: rate limits globales, CSP, auditoría de seguridad
