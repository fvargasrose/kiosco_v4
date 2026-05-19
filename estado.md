# DentalKiosco — Estado del proyecto
**Fecha:** 2026-05-18 · **Rama activa:** `hito9`

---

## Historial de commits

```
f27749f  feat: fotos de odontólogos en panel admin y kiosco
aea2c3e  hito9: registro de paciente nuevo desde el kiosco
77dccea  hito9: standby multimodal (mensaje/gif/video) — backend + admin + kiosk
e704bdb  Docs: estado.md — snapshot del proyecto al 2026-05-19
1872adc  Fix: booking real Dentalink — dentistas filter, slots desde horario
90b627c  Docs: guia.md con secuencia de arranque y estado del proyecto
4d4ead9  Proyecto montado: Hitos 1-8 validados + CLAUDE.md
```

---

## Bloques de hitos

| Hito | Contenido | Tests | Estado |
|------|-----------|-------|--------|
| 1-4 | Servidor Fastify, auth admin (TOTP), DB, Redis, kiosk pairing | — | ✅ |
| 5-6 | Auth paciente OTP (SMS mock + email Resend), perfil, citas, tratamientos | 82 | ✅ |
| 7 | Cancelación de citas, pagos Wompi, pantalla QR | 103 | ✅ |
| 8 | Booking 5 pasos, reconciliador, comprobantes email/SMS, migración 009 | 131 | ✅ |
| 9 | Standby multimodal, registro paciente, fotos dentistas, panel admin | 159 | 🔄 En progreso |
| 10 | License server, monitoreo, métricas, deploy producción | — | 🔲 Pendiente |

**Tests actuales: 159 / 159 pasando (7 archivos).**
**Migraciones: 11/11 aplicadas (001 → 011).**

---

## Hito 9 — detalle de lo implementado

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

---

## Fixes aplicados sobre los parches del proveedor

Estos fixes se pierden cuando se aplica un parche nuevo y deben re-aplicarse siempre.

### `apps/api/src/lib/config.ts`
```typescript
// Reemplazar z.coerce.boolean().default(X) con boolEnv(X)
const boolEnv = (defaultVal: boolean) =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean(),
  ).default(defaultVal);
// Variables: LICENSE_DEV_MODE, DEV_MOCK_EXTERNAL_SERVICES, DEV_LOG_OTP, DEV_MOCK_WOMPI
```

### `apps/api/src/lib/dentalink.ts`
```typescript
// 1. Normalizar celular (después de REQUEST_TIMEOUT_MS):
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

## Próximo paso — Hito 9 (pendiente)

Las siguientes funcionalidades del Hito 9 aún no están implementadas:
- Gestión de kiosks (crear, activar/desactivar) desde el panel admin
- Vista de pagos pendientes en el panel admin
- Dashboard con métricas básicas (citas del día, últimas transacciones)
