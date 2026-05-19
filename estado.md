# DentalKiosco — Estado del proyecto
**Fecha:** 2026-05-19 · **Rama activa:** `hito9`

---

## Historial de commits

```
1872adc  Fix: booking real Dentalink — dentistas filter, slots desde horario
90b627c  Docs: guia.md con secuencia de arranque y estado del proyecto
4d4ead9  Proyecto montado: Hitos 1-8 validados + CLAUDE.md
99d0cd1  Hito 8: aplicado y validado en local
4c28fce  Hito 7: cancelación de citas + pagos Wompi (validado)
cefed87  Hitos 5-6: aplicado y validado en local
5387485  Fix: proxy Vite rewrite /api → / para desarrollo local
712ccd5  Hitos 1-4: montado y validado en local
```

---

## Bloques de hitos

| Hito | Contenido | Tests | Estado |
|------|-----------|-------|--------|
| 1-4 | Servidor Fastify, auth admin (TOTP), DB, Redis, kiosk pairing | — | ✅ |
| 5-6 | Auth paciente OTP (SMS mock + email Resend), perfil, citas, tratamientos | 82 | ✅ |
| 7 | Cancelación de citas, pagos Wompi, pantalla QR | 103 | ✅ |
| 8 | Booking 5 pasos, reconciliador, comprobantes email/SMS, migración 009 | 131 | ✅ |
| 9 | Panel admin (clínica, kiosks, pagos pendientes, dashboard) | — | 🔲 En progreso |
| 10 | License server, monitoreo, métricas, deploy producción | — | 🔲 Pendiente |

**Tests actuales: 131 / 131 pasando.**
**Migraciones: 9/9 aplicadas (001 → 009).**

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

## Bugs corregidos en esta sesión (rama hito9)

### Booking — "No pudimos cargar esta información" (commit `1872adc`)

El flujo de agendar cita fallaba al consultar la API real de Dentalink.

| Endpoint | Bug | Fix |
|----------|-----|-----|
| `GET /me/booking/dentists` | Usaba `?sucursal_id=1` — Dentalink requiere `q={"id_sucursal":{"eq":1}}` | Corregido formato de filtro |
| `GET /me/booking/slots` | Llamaba `/api/v1/citas/horarios-disponibles` (no existe en Dentalink → 404) | Reemplazado por `/api/v1/horarios` del dentista + cálculo de slots del horario real |
| `GET /me/booking/branches` | Devolvía campos extra de Dentalink (`links`, `ciudad`, etc.) | Mapeo explícito a `{id, nombre, direccion, telefono}` |
| Campos dentistas | `apellidos` (plural) vs `apellido` (singular); `habilitado` no filtrado | Mapeo + filtro |
| `POST /me/booking/appointments` | IDs de paciente/dentista como string; campo `comentario` incorrecto | Corregido a numéricos + campo `comentarios` |

**Nota importante:** `getAvailableSlots` en modo real no consulta citas ocupadas (Dentalink no expone ese endpoint de forma filtrable). Los slots teóricos se generan del horario del dentista; si el slot ya está tomado, Dentalink rechaza el `POST /citas` con 409.

---

## API real Dentalink — endpoints confirmados

| Endpoint | Método | Funciona | Notas |
|----------|--------|----------|-------|
| `/api/v1/sucursales` | GET | ✅ | Sin parámetros |
| `/api/v1/dentistas` | GET | ✅ | Requiere `q={"id_sucursal":{"eq":N}}` |
| `/api/v1/dentistas/{id}/horarios` | GET | ✅ | Devuelve horario semanal con intervalo |
| `/api/v1/pacientes?q={"rut":{"eq":"..."}}` | GET | ✅ | Lookup por cédula |
| `/api/v1/pacientes/{id}/citas` | GET | ✅ | Sin query params (con params → 400) |
| `/api/v1/pacientes/{id}/tratamientos` | GET | ✅ | Sin query params |
| `/api/v1/citas/{id}` | PUT | ✅ | Cancelar con `id_estado: 3` |
| `/api/v1/citas` | POST | ⚠️ | No probado en producción |
| `/api/v1/citas?q=...` | GET | ❌ | Siempre 400 con cualquier filtro |
| `/api/v1/citas/horarios-disponibles` | GET | ❌ | No existe (404) |
| `/api/v1/sucursales/{id}/citas` | GET | ❌ | 400 con o sin params |

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
| Frontend Vite | 5173 | ✅ vite dev |

---

## Flujo de OTP (validado con usuario real)

1. Paciente ingresa cédula (`10697021`) y teléfono (`+573206505239`)
2. API busca en Dentalink → paciente encontrado (ID Dentalink: `4179`)
3. OTP generado → SMS mock (log) + email real a `fabiavargas@gmail.com` vía Resend
4. Paciente ingresa código → sesión de 10 minutos

---

## Próximo paso — Hito 9

Panel de administración web:
- Configuración de la clínica (nombre, Dentalink token, duración de citas)
- Gestión de kiosks (crear, activar/desactivar)
- Vista de pagos pendientes
- Dashboard con métricas básicas

Para continuar: aplicar `previos/dentalkiosco_hito_9.zip` siguiendo el protocolo de hitos.
