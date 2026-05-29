# Apoyo — Módulo de Booking

Guía de referencia para modificar o ampliar el flujo de agendamiento de citas.
Resume decisiones, "gotchas" de la API de Dentalink y cómo extender cada parte
sin romper las demás.

> Última actualización: 2026-05-25 — commits `e6261a1`, `8c30ee7`, `a498d29`.

---

## 1. Flujo end-to-end

```
┌────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│  branch    │→ │   dentist   │→ │  treatment  │→ │   date   │→ │   slot   │→ │ confirm  │
└────────────┘  └─────────────┘  └─────────────┘  └──────────┘  └──────────┘  └──────────┘
       │              │                 │               │             │            │
       ▼              ▼                 ▼               ▼             ▼            ▼
 /me/booking/   /me/booking/      /kiosk/bootstrap  (cliente only) /me/booking/  POST
 branches       dentists           (state.config.    14 días gen.   slots        /me/booking/
 → Dentalink    →branch_id         procedures)                     →Dentalink    appointments
   sucursales    Dentalink                                          /agendas      →Dentalink
                                                                                  /citas
```

Cada paso vive en `apps/kiosco-frontend/src/screens/booking.js` como una función
`render<Paso>Step`. Al cambiar de paso se llama `clearForwardSelections()` para
invalidar las elecciones posteriores y mantener el estado coherente.

**Volver atrás** desde cualquier paso retrocede uno solo (no salta al inicio) y
limpia las selecciones de los pasos siguientes — incluido `slot` cuando se
cambia `treatment`, porque la duración nueva puede generar slots distintos.

---

## 2. Estructuras de datos clave

### 2.1 Selection en el kiosco (memoria del paciente)

`booking.js:38` — vive solo mientras la pantalla esté montada. Si el paciente
sale (logout o idle), se pierde todo. Eso es deseado en un kiosco compartido.

```js
const selection = {
  branch:    null, // { id, nombre, direccion?, telefono? }
  dentist:   null, // { id, nombre, apellido?, especialidad? }
  treatment: null, // { id, name, duration_minutes, description? } | { id: '__default__', ... }
  date:      null, // 'YYYY-MM-DD'
  slot:      null, // { hora_inicio, hora_fin, duracion_minutos, ... }
  notas:     '',
};
```

### 2.2 Tabla `clinic_procedures` (migración 013)

Catálogo local — el admin lo gestiona; el kiosco lo expone.

```sql
id UUID PRIMARY KEY
clinic_id INTEGER → clinic(id) ON DELETE CASCADE
name TEXT (1–100 chars)
duration_minutes INTEGER CHECK IN (15,30,45,60,75,90,105,120)  -- 🔒 enforce
description TEXT NULL
active BOOLEAN DEFAULT TRUE
created_at/updated_at TIMESTAMPTZ
```

> ⚠️ El campo `clinic.procedures JSONB` de la migración 002 quedó como **legacy**
> y no se usa. No lo borres por seguridad (existen instalaciones con datos ahí),
> pero tampoco lo leas. Todo va por la tabla nueva.

### 2.3 Endpoints del backend

| Método | Path | Auth | Responsable |
|---|---|---|---|
| GET    | `/me/booking/branches` | patient | `apps/api/src/routes/booking.ts` |
| GET    | `/me/booking/dentists?branch_id=N` | patient | idem |
| GET    | `/me/booking/slots?dentist_id&branch_id&from&to&duration` | patient | idem |
| POST   | `/me/booking/appointments` | patient | idem (incluye `treatment_name`) |
| GET    | `/admin/procedures` | admin | `routes/admin-clinic.ts` |
| POST   | `/admin/procedures` | admin | idem |
| PUT    | `/admin/procedures/:id` | admin | idem |
| DELETE | `/admin/procedures/:id` | admin (soft delete: `active=false`) | idem |
| GET    | `/kiosk/bootstrap` | kiosk | `routes/kiosk.ts` (devuelve `procedures` activos) |

---

## 3. Hechos verificados de la API de Dentalink

Estos comportamientos fueron validados empíricamente. **No son suposiciones.**
Antes de tocar el cliente Dentalink lee esta sección.

### 3.1 Slots disponibles → usar `/api/v1/agendas`, NUNCA `/api/v1/horarios`

`/api/v1/horarios` devuelve el horario semanal teórico del dentista — sin
considerar citas ya agendadas. Si lo usas, los slots ocupados aparecen como
libres y el `POST /citas` falla en runtime.

**Endpoint correcto:**

```
GET /api/v1/agendas?q={
  "id_sucursal": {"eq": N},
  "id_dentista": {"eq": M},
  "fecha":       {"eq": "YYYY-MM-DD"},
  "duracion":    {"eq": D}
}
```

La respuesta solo trae slots **libres**. Implementación: `dentalink.ts:994`
(`getAvailableSlots`).

### 3.2 Límite de 10 items + "desborde" → filtrar por fecha en cliente

`/api/v1/agendas` devuelve **máximo 10 items por llamada**. Si el día pedido
tiene menos slots libres, completa con días siguientes. El parámetro `fecha` se
comporta como "desde esa fecha en adelante", **no como filtro exacto**.

Por eso siempre comparamos `s.fecha === DD/MM/YYYY` (formato `DD/MM/YYYY`, no
`YYYY-MM-DD` — Dentalink los devuelve invertidos). Helper: `toDDMMYYYY()` en
`dentalink.ts`.

### 3.3 Duraciones válidas: `{15, 30, 45, 60, 75, 90, 105, 120}`

Dependiendo del `intervalo` configurado por dentista en Dentalink:

- `/agendas` **redondea silenciosamente** duraciones no aceptadas
  (ej: 40 → 45). Devuelve slots, pero con otra duración. Difícil de debuggear.
- `POST /citas` **rechaza con HTTP 400** las duraciones no aceptadas.

→ Solución: enforce a nivel de BD (`CHECK (duration_minutes IN (...))`) y a
nivel de Zod en el endpoint admin. El admin nunca puede crear un procedure
fuera del conjunto válido.

Para casos como "Cementación de tads — 40 min": la UI muestra un tooltip
sugiriendo redondear hacia arriba (45 min).

### 3.4 IDs de estado de citas son **por clínica**, no universales

`id_estado=3` significa cosas distintas en clínicas distintas. En la clínica
piloto:

- `id_estado=3` → "Confirmado por teléfono" (NO cancela)
- `id_estado=8` → "Cancelada" (correcto)
- `id_estado=1` → "Anulado" (terminal alternativo)

→ Para resolver: `getCancelEstadoId(token)` en `dentalink.ts` consulta
`GET /api/v1/citas/estados`, busca por regex `cancel|anula` y cachea 24h en
Redis (key `dl:estados:cancel_id`). Si no encuentra match, lanza
`DentalinkError` antes que adivinar.

Si Dentalink agrega/renombra estados, vaciar la caché:

```bash
docker compose ... exec redis redis-cli DEL dl:estados:cancel_id
```

### 3.5 Catálogo Dentalink (`prestaciones`) NO sirve para duración

`/api/v1/prestaciones` tiene precio pero **no tiene campo de duración**
(validado en listado e individual). Por eso el catálogo de procedures **debe
ser local** — no se puede consumir directamente de Dentalink.

### 3.6 `id_sillon` viene de la BD local

`GET /api/v1/sillones?q=...` devuelve 400 — no soporta filtros. Usar
`clinic.sillon_id` configurado por el admin. No tocar.

### 3.7 No enviar `id_tratamiento` en `POST /citas`

Cuando no se especifica, Dentalink vincula automáticamente la cita al
tratamiento más reciente del paciente. Esto es lo que queremos. Nuestro paso
"treatment" es del catálogo **local** (`clinic_procedures`), NO se mapea a
`/api/v1/tratamientos` de Dentalink (son cosas distintas).

El nombre del tratamiento elegido se envía como prefijo del campo
`comentarios`: `[Nombre del procedure] notas del usuario`.

---

## 4. Distinción conceptual crítica

Hay tres cosas con nombres parecidos. **No las confundas.**

| Nombre | Origen | Qué es |
|---|---|---|
| **`procedures`** (local) | `clinic_procedures` (BD local) | Catálogo de tipos de servicio que el admin configura. Cada uno tiene `name + duration_minutes + active`. **Esto es lo que el paciente elige.** |
| **`tratamientos`** (Dentalink) | `/api/v1/pacientes/{id}/tratamientos` | Planes de tratamiento del paciente (ej: "Ortodoncia 2025"). Se crean en Dentalink **después** de la primera cita. NO se editan desde el kiosco. |
| **`prestaciones`** (Dentalink) | `/api/v1/prestaciones` | Catálogo de servicios con precio en Dentalink, sin duración. **No se usa en este módulo.** |

---

## 5. Cómo extender / modificar

### 5.1 Agregar un campo a `clinic_procedures`

1. Crear migración `014_<nombre>.sql` con `ALTER TABLE clinic_procedures ADD COLUMN ...`.
2. Actualizar Zod schemas en `routes/admin-clinic.ts` (`ProcedureCreateBody`,
   `ProcedureUpdateBody`) y los SQL de inserción/update.
3. Si el campo va al kiosco, agregar al `SELECT` de `routes/kiosk.ts` bootstrap.
4. Renderizar en `screens/booking.js` `treatmentCardHtml()`.
5. Ampliar `clinic-config.js` (tabla + modal) para que el admin lo edite.
6. Tests: agregar en `admin-clinic.test.ts`.

### 5.2 Aceptar una duración nueva (ej: 20 min)

**No lo hagas a menos que la clínica use un `intervalo` distinto en Dentalink
que sí acepte 20 min.** Si lo hace:

1. Confirmar con la clínica que `POST /citas` con `duracion=20` no devuelve
   400. Si responde 400, no se puede agregar.
2. Migración nueva: `ALTER TABLE clinic_procedures DROP CONSTRAINT ...;` y
   crear el CHECK actualizado.
3. Actualizar `VALID_DURATIONS` en:
   - `apps/api/src/routes/admin-clinic.ts`
   - `apps/admin-frontend/src/screens/clinic-config.js`
   - El comentario explicativo en la migración 013

> Ojo: la lista `{15,30,45,60,75,90,105,120}` fue verificada con un dentista
> específico (id=1). Otros dentistas en la misma clínica pueden tener un
> `intervalo` distinto. Si necesitas duraciones por dentista, el modelo cambia
> a `clinic_procedures` × `dentists` (muchos-a-muchos).

### 5.3 Cambiar el comportamiento del fallback "Consulta general"

`booking.js` línea ~245 (`renderTreatmentStep`):

```js
const treatments = procedures.length > 0
  ? procedures
  : [{ id: '__default__', name: 'Consulta general',
       duration_minutes: state.config?.duracion_cita_minutos ?? 30 }];
```

El sentinel `__default__` se chequea al construir el `treatment_name` del POST
para **no** enviarlo cuando es el fallback (`booking.js` cerca del
`createBookingAppointment`). Si cambias el sentinel, ajusta ambos lugares.

### 5.4 Reagendar (modificar una cita existente)

**No existe** todavía. La decisión actual (documentada en `routes/booking.ts:14`)
es: reagendar = cancelar + crear cita nueva. El cliente decide cuál hacer.

Si en el futuro se requiere `PUT /api/v1/citas/{id}` para mover una cita:
1. Verificar primero con scripts manuales contra Dentalink que el endpoint lo
   acepta sin tener que recrear (validar contra la API real).
2. Agregar `updateAppointment` en `dentalink.ts` siguiendo el patrón de
   `cancelAppointment`.
3. Aplicar mismas validaciones de seguridad (anti-IDOR, ventana de 2h, etc.)
   que están en `patient-me.ts:260+`.

### 5.5 Mostrar slots de varios días a la vez

Hoy el frontend pide un solo día (`from === to`). El backend ya soporta rangos
hasta 30 días (`MAX_SEARCH_WINDOW_DAYS`). Cambios:

1. En `booking.js`, en `renderSlotStep`, pedir un rango y agrupar por día.
2. **No subas el rango más allá de ~7 días** porque cada día = 1 llamada
   HTTP a Dentalink (ver `getAvailableSlots`). Con rangos grandes el flujo se
   hace lento.
3. Alternativa: pre-cargar la próxima semana en background al elegir dentista
   y cachear en Redis (TTL 60s ya está).

---

## 6. Cómo verificar después de un cambio

```bash
# 1. Migraciones aplicadas
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status

# 2. Tipos y tests
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test

# 3. Frontends
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build
```

### 6.1 Verificación end-to-end manual (no automatizada)

1. **Sin procedures configurados:** completar booking — debe usar "Consulta
   general" automáticamente sin mostrar error.
2. **Con 3 procedures (15, 30, 60 min):** completar booking con cada uno y
   verificar en panel Dentalink que la `duración` guardada es correcta.
3. **Duración 40 desde admin:** la UI rechaza (no aparece en el select), y un
   POST manual al endpoint devuelve 400.
4. **Volver atrás cambiando tratamiento:** fecha y slot deben limpiarse.
5. **Cancelar una cita creada desde el kiosco:** verificar en Dentalink que el
   estado real es "Cancelada" (no "Confirmado por teléfono").

### 6.2 Limpiar caché Dentalink en dev

```bash
docker compose exec redis redis-cli --scan --pattern 'dl:*' | xargs docker compose exec -T redis redis-cli DEL
```

---

## 7. Cosas que NO debes hacer (lecciones aprendidas)

- ❌ **No uses `/api/v1/horarios` para slots** — causa el bug de "slots
  ocupados visibles". Solo `/api/v1/agendas`.
- ❌ **No confundas `procedures` con `tratamientos`** — son cosas diferentes
  (sección 4).
- ❌ **No hardcodees `id_estado=3`** para cancelar — usa `getCancelEstadoId`.
- ❌ **No permitas duraciones libres en el admin** — solo las 8 validadas.
- ❌ **No envíes `id_tratamiento` en `POST /citas`** — Dentalink vincula
  automáticamente al más reciente del paciente.
- ❌ **No bloquees el flujo si `procedures` está vacío** — fallback
  obligatorio.
- ❌ **No cambies el contrato de `?duration=N` en `/me/booking/slots`** —
  el frontend depende de él.
- ❌ **No consultes `/api/v1/sillones`** — devuelve 400 con filtros. Usa
  `clinic.sillon_id` local.
- ❌ **No reactivar el campo `clinic.procedures` JSONB** — está abandonado.
  Todo va por `clinic_procedures`.
- ❌ **No omitas el filtrado por fecha en cliente** después de llamar
  `/agendas` — el límite de 10 items con desborde es real.

---

## 8. Archivos clave (cheat sheet)

```
apps/api/src/lib/dentalink.ts              Cliente Dentalink (TODO el ámbito Dentalink)
                                           - getAvailableSlots() → /agendas con filtrado
                                           - getCancelEstadoId() → cache Redis 24h
                                           - createAppointment(...treatmentName)
                                           - cancelAppointment() → id_estado dinámico

apps/api/src/routes/booking.ts             Endpoints /me/booking/*
apps/api/src/routes/admin-clinic.ts        CRUD /admin/procedures + clinic settings
apps/api/src/routes/kiosk.ts               /kiosk/bootstrap (lee clinic_procedures)
apps/api/src/routes/patient-me.ts          Cancelar cita (DELETE /me/appointments/:id/cancel)

apps/api/migrations/013_clinic_procedures.sql   Tabla nueva con CHECK constraint

apps/kiosco-frontend/src/screens/booking.js     Flujo de 6 pasos
apps/kiosco-frontend/src/api.js                 getSlots(...duration), createBookingAppointment(...treatmentName)
apps/kiosco-frontend/src/styles.css             .treatment-card, .treatment-grid

apps/admin-frontend/src/screens/clinic-config.js   Sección "Procedimientos/Tratamientos"
apps/admin-frontend/src/api.js                     getProcedures, create/update/delete

apps/api/tests/admin-clinic.test.ts        13 tests del CRUD de procedures
apps/api/tests/booking.test.ts             28 tests del flujo de booking
apps/api/tests/patient-me.test.ts          Incluye test del bootstrap con procedures
```

---

## 9. Decisiones de diseño que conviene preservar

- **Tabla nueva en vez de JSONB:** permite CHECK constraint, soft delete,
  índices y migraciones futuras. El JSONB original quedó como legacy.
- **Procedure local, no vinculado a `id_tratamiento` Dentalink:** evita
  acoplar el catálogo del kiosco al modelo de Dentalink (que cambia por
  clínica y no tiene duración).
- **3 commits separados (fix + fix + feat) en vez de 1:** los dos fixes
  previos (`/horarios→/agendas` e `id_estado` dinámico) son independientes y
  podrían revertirse aislados si algo se rompe en producción sin afectar la
  feature.
- **Caché Redis 24h para estados de citas:** equilibrio entre frescura y carga.
  Los estados de citas en Dentalink cambian raramente (cuando un admin de la
  clínica edita los workflows). Si cambian, el reinicio del API o un
  `DEL dl:estados:cancel_id` los refresca.
- **Mock reescrito para parecerse a `/agendas`:** evita falsos positivos en
  los tests por divergencia entre mock y prod.
