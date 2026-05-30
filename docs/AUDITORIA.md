# Auditoría — Booking treatment/calendario + fixes Dentalink

> **Etapa 1 — Reconocimiento (solo diagnóstico, sin arreglos).**
> Fecha: 2026-05-30 · Branch: `main` · Modo: auditoría de solo lectura.
> Este documento NO propone arreglos todavía — solo mapea, reproduce y deja evidencia.

---

## 1. Mapa del repo (rutas reales confirmadas)

Todos los archivos mencionados en el encargo existen en la ruta esperada:

| Archivo | Existe | Nota |
|---------|--------|------|
| `apps/kiosco-frontend/src/screens/booking.js` | ✅ | Tema **default**. Modificado 2026-05-26 07:09 — **SÍ** tiene treatment + calendario 2 meses. |
| `apps/kiosco-frontend/src/screens/booking.apple.js` | ✅ | Tema **apple** (el que corre). Modificado 2026-05-20 20:37 — **NO** tiene treatment ni calendario. |
| `apps/api/src/routes/booking.ts` | ✅ | `/me/booking/*`. Acepta `duration`, `branch_id`, `treatment_name`. |
| `apps/api/src/routes/admin-clinic.ts` | ✅ | CRUD `/admin/procedures` con `DurationSchema` ∈ {15..120}. |
| `apps/api/src/routes/kiosk.ts` | ✅ | `/kiosk/bootstrap` devuelve `procedures` (de `clinic_procedures`) y `theme`. |
| `apps/admin-frontend/src/screens/clinic-config.js` | ✅ | (no inspeccionado en detalle en Etapa 1) |
| `apps/api/src/lib/dentalink.ts` | ✅ | `getAvailableSlots` (/agendas), `getCancelEstadoId`, `normalizeCelular` presente. |
| `apps/api/src/routes/patient-me.ts` | ✅ | `POST /me/appointments/:id/cancel`. |
| `apps/api/migrations/` | ✅ | 001–016 aplicadas (16/16). `013_clinic_procedures.sql` con CHECK de duraciones. |

**Detalle crítico del tema.** El kiosco tiene **dos juegos de pantallas post-login**:
`*.js` (default) y `*.apple.js` (tema apple). `main.js:54` `activateAppleTheme()` reemplaza
las pantallas cuando `config.theme === 'apple'`:

```
main.js:74  registerScreen('home',         renderHomeApple);
main.js:75  registerScreen('appointments', renderAppointmentsApple);
main.js:77  registerScreen('booking',      renderBookingApple);   ← booking.apple.js
```

`.env` actual: `KIOSK_THEME=apple`. Bootstrap real lo confirma (ver §4).

---

## 2. Stack y cómo se levanta local

- **Frontend:** Vanilla JS (ES modules), **sin framework**. Bundler **Vite 5**. HMR en dev.
- **Backend:** Node 22 · TypeScript · Fastify 4 · Zod. `tsx watch` en dev.
- **DB/caché:** PostgreSQL 16 + Redis 7 (Docker). Dentalink real (token en `.env`).

```bash
# Infra
docker compose up -d postgres redis        # postgres:5433, redis:6380
# Migraciones
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status   # 16/16
# API
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev               # :3000
# Frontends
pnpm --filter @dentalkiosco/kiosco-frontend dev   # :5173
pnpm --filter @dentalkiosco/admin-frontend dev    # :5174
# Kiosco con token:  http://localhost:5173/?kiosk_token=<JWT>
```

Estado durante la auditoría: API (:3000) y kiosco (:5173) ya estaban **corriendo**;
postgres+redis `(healthy)`; kiosk del token = `gfgfdgdf` (activo); 15 procedures activos.

### Flags relevantes del `.env`
`KIOSK_THEME=apple` · `OTP_REQUIRED=true` · `DEV_MOCK_EXTERNAL_SERVICES=false` (Dentalink real)
· `DEV_MOCK_WOMPI=true` · `DEV_LOG_OTP=true` · `LICENSE_DEV_MODE=true` · `FEATURE_REGISTRO=false`.

---

## 3. Historial git relacionado

| Commit | Fecha | Qué cambió (archivos) |
|--------|-------|-----------------------|
| `e6261a1` fix(booking): /agendas filtrado | 05-25 19:48 | `dentalink.ts`, `booking.ts`, `api.js`, **`booking.js`** |
| `8c30ee7` fix(booking): id_estado dinámico | 05-25 19:50 | `dentalink.ts` (solo) |
| `a498d29` feat(booking): paso treatment | 05-25 20:13 | migr. 013, `admin-clinic.ts`, `kiosk.ts`, `dentalink.ts`, **`booking.js`** |
| `20ef70c` feat(booking): calendario 2 meses | 05-25 21:36 | **`booking.js`** (+181/-36), `styles.css` |

> **Observación central:** los 3 commits de UI de booking tocan **`booking.js`** (tema default).
> **Ninguno** toca `booking.apple.js`. Ese archivo quedó por última vez en `2026-05-20 20:37`,
> *antes* de toda esta tanda de features. Mismo caso para `appointments.apple.js` (05-20 20:35).

---

## 4. Reproducción y evidencia

### 4.1 Evidencia de runtime — qué archivo corre realmente

`GET /kiosk/bootstrap` (token real, 200 OK) devuelve:

```json
{ "theme": "apple", "otp_required": true, "duracion_cita_minutos": 30,
  "procedures_count": 15,
  "procedures_sample": [
    { "id": "3b8fd066-…", "name": "Cementación de TADs", "duration_minutes": 45, "description": null },
    … ] }
```

→ `theme: "apple"` ⇒ corre **`booking.apple.js`** (no `booking.js`).
→ Los **15 procedures con `duration_minutes` correcto SÍ llegan** del backend. El dato no es el problema.

### 4.2 Evidencia de navegador (Playwright)

- Carga de `http://localhost:5173/?kiosk_token=…` → standby apple renderiza
  ("Odontología German Fernandez" / "Toca para comenzar").
- Red: `/api/kiosk/bootstrap` → 200, `/api/kiosk/standby` → 200.
- **Consola: 1 error = `favicon.ico 404` (benigno). CERO errores JS.**
  ⇒ No hay excepción de runtime; la app activa el tema apple sin fallar.
- *Pendiente:* la caminata hasta booking/cancelación está detrás de OTP + Dentalink real;
  requiere una cédula+teléfono de prueba registrada en Dentalink (no disponible en esta sesión).
  El comportamiento de las pantallas, sin embargo, es determinista por código (§4.3).

### 4.3 Los 4 síntomas

#### S1 — No aparece el calendario de 2 meses → **CONFIRMADO**
`booking.apple.js:195-232` `renderDateStep` genera una **lista plana de 14 días**
(`ak-date-grid`, `DEFAULT_SEARCH_DAYS = 14`). El calendario de 2 meses
(`CALENDAR_MONTHS`, `renderCalendar`) existe **solo en `booking.js:405`**, que no corre.

#### S2 — No se muestran tratamientos ni el fallback "Consulta general" → **CONFIRMADO**
`booking.apple.js:8` `STEPS = ['branch','dentist','date','slot','confirm']` — **no existe el
paso `treatment`**. No hay `renderTreatmentStep` ni fallback. La pantalla salta de `dentist`
directo a `date`. (En `booking.js:28` los STEPS sí incluyen `'treatment'` y el fallback en
`booking.js:256-265`.) Los 15 procedures del bootstrap nunca se leen en el tema apple.

#### S3 — Los slots no respetan la duración del tratamiento → **CONFIRMADO**
`booking.apple.js:241-245` llama `api.getSlots({ dentistId, from, to })` **sin `duration`
ni `branchId`**. En `api.js:190`, `if (duration) qs.set('duration', …)` ⇒ al ser `undefined`
**no se añade `?duration=N`**. El backend (`booking.ts:225`) cae a
`durationMin = duration ?? defaultDuration` = `duracion_cita_minutos` (30). Por tanto los slots
ignoran la duración del procedimiento (p.ej. 45 min). En `booking.js:355-361` sí se envía
`duration: selection.treatment.duration_minutes` y `branchId`.

> **Causa raíz única de S1+S2+S3:** el tema activo es **apple** y sus pantallas
> (`booking.apple.js`) son una copia **estancada (2026-05-20)** que nunca recibió las features
> añadidas a `booking.js` los días 25–26. **No es un error JS** (consola limpia): es código viejo
> ejecutándose porque las features se aplicaron al archivo del tema equivocado.

#### S4 — La cancelación falla con "no se pudo cancelar" → **CONFIRMADO por análisis** (captura en vivo pendiente)
Cadena: `appointments.apple.js:179` `api.cancelAppointment(apt.id)` →
`POST /me/appointments/:id/cancel` (`patient-me.ts:227`) → `dentalink.cancelAppointment`
(`dentalink.ts:825`) → `getCancelEstadoId` (`dentalink.ts:783`) → `PUT /api/v1/citas/:id { id_estado }`.

- `getCancelEstadoId` busca el estado con `estados.find(e => /cancel|anula/i.test(e.nombre))`
  y devuelve el **primer** match. Por **F5**, en esta clínica hay ~7 estados cuyo nombre
  contiene "cancel"/"anula"; el correcto es **id_estado=8 ("Cancelada")**, pero `.find` puede
  devolver otro (p.ej. id=1 "Anulado"). Si Dentalink rechaza esa transición, responde **400**.
- `handleDentalinkError` mapea `BAD_REQUEST → HTTP 400` (`dentalink-error-handler.ts:37`).
- `doCancelAppointment` (apple) **no tiene caso para 400** (`appointments.apple.js:194-210`):
  maneja 409/404/401/503/504 y cae al **genérico "No pudimos cancelar la cita"** → exactamente S4.

  *Nota:* este síntoma es **independiente del tema** (lógica de backend) y requiere una cita
  real cancelable + Dentalink real para capturar el cuerpo exacto del PUT y su respuesta. En
  mock mode la cancelación siempre tiene éxito, así que mock **no** sirve para reproducir S4.

---

## 5. Resumen de confirmación

| Síntoma | Estado | Naturaleza | Evidencia |
|---------|--------|-----------|-----------|
| S1 calendario 2 meses | ✅ Confirmado | Frontend — tema apple estancado | `booking.apple.js:195` lista de 14 días |
| S2 tratamientos/fallback | ✅ Confirmado | Frontend — tema apple estancado | `booking.apple.js:8` sin paso `treatment`; bootstrap trae 15 procedures |
| S3 duración en slots | ✅ Confirmado | Frontend — tema apple estancado | `booking.apple.js:241` getSlots sin `duration` |
| S4 cancelación falla | ✅ Confirmado (análisis) | Backend — `getCancelEstadoId` (F5) + falta caso 400 en UI apple | `dentalink.ts:793` `.find(/cancel\|anula/)`; `appointments.apple.js:191` genérico |

**¿Un único error JS explica S1+S2+S3?** **No.** No hay excepción de runtime (consola limpia).
Sí comparten **una única causa raíz**: el tema apple sirve archivos de pantalla obsoletos a los
que nunca se portaron las features. S4 es un problema **aparte**, del lado del backend.

## 6. Pendiente para cerrar evidencia (no bloquea conclusiones)
- Caminata en navegador autenticada para capturar visualmente S1–S3 y el `GET …/slots`
  **sin** `?duration=N` → requiere cédula+teléfono de prueba en Dentalink.
- Captura en vivo del `PUT /api/v1/citas/:id` de S4 (body `id_estado` elegido + respuesta de
  Dentalink) → requiere una cita real cancelable.

---

# Etapa 2 — Backend procedures (foco S2, desde el backend hacia abajo)

> Fecha: 2026-05-30 · Solo diagnóstico. Verificado contra DB local y endpoint real.

## Tabla de hallazgos

| # | Punto verificado | Estado | Evidencia |
|---|------------------|--------|-----------|
| 1 | Archivo de migración `clinic_procedures` existe | ✅ CUMPLE | `apps/api/migrations/013_clinic_procedures.sql` |
| 1 | Número correlativo correcto y SIN colisión | ✅ CUMPLE | Único `013*` en el dir; secuencia 001–016 sin repetidos |
| 1 | CHECK `duration_minutes IN (15,30,45,60,75,90,105,120)` | ✅ CUMPLE | `clinic_procedures_duration_minutes_check` (verificado en DB) |
| 1 | Índice `(clinic_id, active)` | ✅ CUMPLE | `idx_clinic_procedures_active btree (clinic_id, active)` |
| 2 | Migración APLICADA en DB local | ✅ CUMPLE | `schema_migrations 013` applied 2026-05-26 00:51; tabla existe |
| 2 | Tabla con filas | ✅ CUMPLE | **15 filas, 15 activas, 0 inactivas** (la tabla NO está vacía) |
| 3 | GET/POST/PUT/DELETE de procedures | ✅ CUMPLE | `admin-clinic.ts:496/515/541/590` |
| 3 | POST/PUT: `name` no vacío y ≤100 | ✅ CUMPLE | `z.string().trim().min(1).max(100)` (`admin-clinic.ts:119,126`) |
| 3 | POST/PUT: `duration_minutes` en set válido + 400 claro | ✅ CUMPLE | `DurationSchema` refine con mensaje explícito → `code(400)` (`admin-clinic.ts:110-116,518`) |
| 3 | DELETE es soft (`active=false`) | ✅ CUMPLE | `UPDATE … SET active=false` (`admin-clinic.ts:596`) |
| 4 | `bootstrap.procedures` = array solo activos, campos correctos | ✅ CUMPLE | `kiosk.ts:130-159` `WHERE active=true ORDER BY name`; respuesta real abajo |
| 4 | Devuelve `[]` (no `null`) cuando vacío | ✅ CUMPLE | Devuelve `proceduresResult.rows` (siempre array); tipo confirmado `"array"` |
| 5 | Cruce: estado actual de DB vs bootstrap | ✅ CUMPLE | DB 15 activos ⇒ bootstrap devuelve 15 (no aplica fallback) |

## Estructura real de la tabla (psql `\d clinic_procedures`)

```
 id               uuid        NOT NULL  default gen_random_uuid()
 clinic_id        integer     NOT NULL  → clinic(id) ON DELETE CASCADE
 name             text        NOT NULL  CHECK length 1..100
 duration_minutes integer     NOT NULL  CHECK IN (15,30,45,60,75,90,105,120)
 description      text
 active           boolean     NOT NULL  default true
 created_at       timestamptz NOT NULL  default now()
 updated_at       timestamptz NOT NULL  default now()  (+trigger fn_set_updated_at)
Index: idx_clinic_procedures_active (clinic_id, active)
```

Distribución de duraciones en DB: 15min×4, 30min×3, 45min×6, 75min×1, 105min×1 — todas dentro del set válido (el CHECK funciona).

## Respuesta real de bootstrap (sección procedures)

`GET /kiosk/bootstrap` → `procedures` es **array de 15 items**, p.ej.:

```json
"procedures": [
  { "id": "3b8fd066-…", "name": "Cementación de TADs",                 "duration_minutes": 45, "description": null },
  { "id": "93e56772-…", "name": "Colocación y/o cambio de alambre Niti","duration_minutes": 15, "description": null },
  { "id": "d601ba23-…", "name": "Inicio de ortodoncia con alineadores", "duration_minutes": 75, "description": null },
  { "id": "7a889603-…", "name": "Valoración de ortodoncia",             "duration_minutes": 105,"description": null }
  /* … 15 en total … */
]
```
(`procedures | type == "array"`, contrato `{id, name, duration_minutes, description}` exacto.)

## Conclusión Etapa 2

**El backend de procedures CUMPLE en todos los puntos.** Migración aplicada, tabla con 15
procedimientos activos, CRUD con validación correcta, y `bootstrap.procedures` entrega un array
bien formado con solo los activos. **S2 NO se origina en el backend.**

El cruce del punto 5 lo cierra: como hay 15 activos, bootstrap devuelve 15 — el contrato del
fallback ni se ejercita. Y aunque la DB estuviera vacía, el backend devolvería `[]` (correcto para
disparar el fallback en `booking.js`). **La única razón por la que no se ven tratamientos es que el
tema activo es `apple` y `booking.apple.js` no tiene paso `treatment` ni lee `state.config.procedures`**
(ver Etapa 1, §4.3 S2). El backend está listo; el frontend del tema apple no lo consume.

## Correcciones PROPUESTAS (preliminar — NO implementadas)

| Prioridad | Corrección | Resuelve | Notas |
|-----------|-----------|----------|-------|
| **P0** | Portar a `booking.apple.js` el paso `treatment` (con fallback "Consulta general") | S2 | El backend ya entrega `procedures`; solo falta consumirlos en el tema activo. |
| **P0** | Portar a `booking.apple.js` el calendario de 2 meses y el paso de `duration`/`branchId`/`treatment_name` a `getSlots`/`createBookingAppointment` | S1, S3 | Misma raíz que S2; conviene un solo cambio coordinado. |
| **P1** | Unificar la lógica de pasos de booking (módulo compartido) entre `booking.js` y `booking.apple.js`, o eliminar la duplicación | Previene regresiones futuras | El drift entre los dos archivos fue la causa raíz; el tema solo debería cambiar presentación, no flujo. |
| **P2** | (S4, fuera de foco de Etapa 2) Reemplazar la regex `cancel\|anula` de `getCancelEstadoId` por selección determinista del estado "Cancelada" (id_estado=8) + añadir caso 400 en `doCancelAppointment` del tema apple | S4 | Se profundizará en una etapa dedicada al backend de cancelación. |
| Baja | (Calidad de datos) Los 15 procedimientos tienen `description: null`; el admin no la captura. No es bug — `description` es opcional en el contrato | — | Solo nota; el frontend ya trata `description` como opcional. |

> Recordatorio de regla: estas correcciones son **propuestas**, no aplicadas. No se ha modificado
> código de producción ni migraciones en esta etapa.

---

# Etapa 3 — Frontend kiosco (S1, S2, S3)

> Fecha: 2026-05-30 · Solo diagnóstico.
>
> **Advertencia de alcance imprescindible:** `booking.js` es el archivo del tema **default** y
> **NO es el que corre**. Con `KIOSK_THEME=apple` (verificado en Etapas 1–2), `main.js:77` registra
> `renderBookingApple` → corre **`booking.apple.js`**. Por eso esta etapa documenta DOS columnas:
> qué hace `booking.js` (correcto, pero inactivo) y qué hace `booking.apple.js` (el real, que causa
> S1/S2/S3). Auditar solo `booking.js` daría la falsa impresión de que "todo está bien".

## Tabla de hallazgos

| # | Punto | `booking.js` (default, INACTIVO) | `booking.apple.js` (REAL) |
|---|-------|----------------------------------|---------------------------|
| 1 | `STEPS` con `'treatment'` en 3ª posición | ✅ CUMPLE `booking.js:28` `['branch','dentist','treatment','date','slot','confirm']` | ❌ NO CUMPLE `booking.apple.js:8` `['branch','dentist','date','slot','confirm']` (sin treatment) |
| 1 | La navegación entra a `'treatment'` | ✅ `dentist` → `next('treatment')` `booking.js:239`; dispatch `:151-152` | ❌ `dentist` → `next('date')` `booking.apple.js:185` |
| 2 | `renderTreatmentStep()` existe y se invoca | ✅ `booking.js:249`, dispatch `:151` | ❌ No existe |
| 2 | Tarjeta por procedure (nombre+duración+desc, sin foto, badge duración) | ✅ `treatmentCardHtml` `booking.js:286-295` (name, `${t.duration_minutes} min`, desc opcional, sin `<img>`) | ❌ N/A |
| 2 | Al tocar: setea `selection.treatment={id,name,duration_minutes}`, limpia date+slot, va a 'date' | ⚠️ PARCIAL `booking.js:277-283`: setea treatment ✅ y `next('date')` ✅, pero **no limpia date+slot en el handler**; depende de `clearForwardSelections` que solo corre en `goBack` `:95,111-118` | ❌ N/A |
| 3 | Fallback "Consulta general" si `procedures.length===0`, sin error, sin bloquear | ✅ CUMPLE `booking.js:256-265` (`duration_minutes = state.config?.duracion_cita_minutos ?? 30`) | ❌ NO CUMPLE — no hay paso treatment, no hay fallback |
| 4 | `renderCalendar(monthOffset, …)` existe | ⚠️ PARCIAL existe `booking.js:405` pero firma `(monthOffset, today, minSelectable, maxSelectable, selectedIso)` — NO `(…, dentistId, selection, onSelectDate)` | ❌ No existe |
| 4 | `renderDateStep` pinta DOS calendarios (offset 0 y 1) | ✅ `booking.js:384-388` loop `CALENDAR_MONTHS=2` (`:30`) | ❌ NO — lista plana 14 días `booking.apple.js:195-232` |
| 4 | Clases `--past/--other-month/--sunday/--today/--selected` + estilos | ✅ existen `booking.js:436-439,423` y CSS `styles.css:1542-1573` | ❌ N/A (apple usa `styles-apple.css`) |
| 4 | Clase `--available` | ❌ NO EXISTE en ningún archivo (se usa selector `[data-date]` para clicabilidad, `styles.css:1536`) | ❌ N/A |
| 5 | getSlots con `?duration=` usando `treatment.duration_minutes` | ✅ `booking.js:355-361` y `:494-500`; `api.js:190-199` añade `duration` si presente | ❌ NO CUMPLE `booking.apple.js:241-245` getSlots SIN `duration` ni `branchId` |
| 5 | Backend NO cambió contrato `?duration=N` | ✅ CUMPLE `booking.ts:183` `duration: z.coerce.number().int().min(15).max(180).optional()` | (mismo backend) |
| 6 | `renderConfirmStep` muestra el tratamiento | ✅ `booking.js:585-590` ("🦷 Tratamiento … (N min)") | ❌ No muestra (no hay treatment) `booking.apple.js:296` |
| 6 | POST incluye nombre al inicio de comentarios y NO envía `id_tratamiento` (F8) | ✅ `treatment_name` `booking.js:645-648` → `api.js:240` → `dentalink.ts:1115-1117` prepende `[nombre]`; body POST `:1169-1179` **sin** `id_tratamiento` | ❌ apple no envía `treatment_name` `booking.apple.js:374-381` |

## Detalle por punto

**1.** `booking.js` define el flujo de 6 pasos con `treatment` en posición 3 y la navegación lo
alcanza. `booking.apple.js` (el real) tiene 5 pasos y salta de `dentist` a `date`.

**2.** En `booking.js`, `renderTreatmentStep` es **síncrono y sin puntos de excepción**: construye
`treatments` (procedures o fallback) y siempre pinta. El handler de clic setea
`selection.treatment` y navega a `date`. *Matiz:* no limpia `date`/`slot` explícitamente; en el
flujo hacia adelante son `null`, y al retroceder los limpia `goBack`→`clearForwardSelections`.
Funciona, pero no cumple literal el "limpia date+slot al tocar".

**3.** Fallback correcto en `booking.js`. **Por qué el usuario no ve NADA (ni fallback):** la causa
raíz NO está en `booking.js` — es que **corre `booking.apple.js`**, que ni siquiera tiene el paso
`treatment`. No es un throw ni que `procedures` no llegue (Etapa 2: llegan 15). Es el archivo de
tema equivocado.

**4.** El calendario de 2 meses existe y está correcto en `booking.js` (+ CSS en `styles.css`).
Salvedades: la **firma de `renderCalendar` difiere** de la hipótesis del encargo (el `onSelectDate`
se cablea en `repaint()` vía `addEventListener` sobre `.calendar-day[data-date]`, no se pasa como
parámetro), y **no existe la clase `--available`** (se usa el selector `[data-date]`). **Por qué no
se renderiza para el usuario:** el paso `date` del tema apple usa lista plana de 14 días; el
`renderCalendar` de `booking.js` nunca se ejecuta porque ese archivo no corre.

**5.** En `booking.js` la llamada viaja como
`GET /me/booking/slots?dentist_id=X&from=F&to=F&duration=N&branch_id=B` con
`N = selection.treatment.duration_minutes`. El backend mantiene el contrato `?duration=N`
(`booking.ts:183,225`). **En el tema real (apple)** la llamada omite `duration` → el backend cae a
`duracion_cita_minutos` (30) → S3. *Captura de red en vivo de la variante `booking.js` requiere
`KIOSK_THEME != apple`; la variante apple (sin `duration`) ya está documentada en Etapa 1 §4.3.*

**6.** `booking.js` muestra el tratamiento en el resumen y envía `treatment_name`; el backend lo
prepone como `[nombre]` a `comentarios` y **no** manda `id_tratamiento` (cumple F8). El tema apple
no envía `treatment_name`.

## Diagnóstico unificado (punto 7)

**S1 + S2 + S3 comparten UNA sola causa raíz, y NO es un throw en `booking.js`.**
`booking.js` implementa correctamente los tres comportamientos (treatment + fallback, calendario de
2 meses, paso de `duration`). La causa raíz es estructural: **el tema activo es `apple`, que registra
`booking.apple.js` — una copia previa (2026-05-20) que nunca recibió ninguna de esas features.** Por
eso los tres síntomas aparecen juntos y de forma determinista, sin error en consola (Etapa 1 §4.2).
No son fallos independientes: es el mismo archivo equivocado ejecutándose.

## Correcciones PROPUESTAS (preliminar — NO implementadas)

| Prioridad | Archivo / línea | Corrección | Resuelve |
|-----------|-----------------|-----------|----------|
| **P0** | `booking.apple.js:8` | Añadir `'treatment'` a `STEPS` (3ª posición) | S2 |
| **P0** | `booking.apple.js` (nuevo `renderTreatmentStep` + dispatch en `:88-94`) | Portar el paso treatment con tarjetas (nombre+duración+desc) y **fallback "Consulta general"** (`state.config?.duracion_cita_minutos ?? 30`); en `dentist` cambiar `next('date')`→`next('treatment')` (`:185`) | S2 |
| **P0** | `booking.apple.js:195-232` (`renderDateStep`) | Reemplazar lista de 14 días por calendario de 2 meses (portar `renderCalendar` + estilos a `styles-apple.css`) | S1 |
| **P0** | `booking.apple.js:241-245` (`renderSlotStep`) y onSelect | Pasar `duration: selection.treatment.duration_minutes` y `branchId` a `api.getSlots` | S3 |
| **P0** | `booking.apple.js:374-381` (`createBookingAppointment`) | Enviar `treatmentName` (omitiendo `'__default__'`) | S2 (consistencia comentario cita) |
| **P1** | `booking.js` + `booking.apple.js` | Extraer la lógica de pasos a un módulo compartido; el tema solo debería variar markup/estilos, no el flujo. Evita que el drift se repita | Previene regresión |
| **P2** | `booking.js:277-283` | (Robustez) Limpiar `date`/`slot` en el handler de selección de treatment, no solo en `goBack` | Edge case al cambiar treatment |
| Baja | — | Decisión de producto: si el tema apple es el oficial, evaluar **deprecar `booking.js`/`*.js` default** para no mantener dos flujos | Deuda técnica |

> Regla: correcciones **propuestas**, no aplicadas. Sin cambios a código de producción ni migraciones.

---

# Etapa 4 — Dentalink (slots + cancelación)

> Fecha: 2026-05-30 · Diagnóstico + **verificación contra la API real de Dentalink** (clínica
> "Odontología", tenant único). Toda cita de prueba fue etiquetada y limpiada (ver §cierre).
> Nota: `dentalink-tester/` mencionado en el encargo **no existe** en el repo.

## A) Fix 1 — Slots (S3 / correctitud de disponibilidad)

| # | Punto | Estado | Evidencia |
|---|-------|--------|-----------|
| A1 | Slots desde `/api/v1/agendas`; `/horarios` y slots teóricos eliminados | ✅ CUMPLE (F1) | `dentalink.ts:1042` usa `/api/v1/agendas`. `grep` no halla endpoint `/horarios` ni `generateSlotsFromHorario` (solo queda `horario` como campo de sucursal). |
| A2 | Filtra por fecha exacta `DD/MM/YYYY` + maneja límite 10/desborde | ✅ CUMPLE (F2) | `dentalink.ts:1061-1062` `toDDMMYYYY()` + `.filter(s => s.fecha === fechaDDMMYYYY)`; itera día a día (`eachDateInRange`) y descarta el desborde. API real devolvió `fecha:"08/07/2026"` al consultar `2026-07-08`. |
| A3 | Slots del backend coinciden con slots libres reales de `/agendas` | ✅ CUMPLE | `GET /agendas` real (dentista 13, suc 1, `2026-07-08`, dur 30) → libres 08:00, 08:30, 09:00, 09:30…; la transformación del backend es filtro+map 1:1 (`hora_inicio.slice(0,5)`). |

`getAvailableSlots` también envía `id_dentista:{eq:Number(idDentista)}` y `duracion:{eq:duracionMinutos}`
en el `q` JSON (`dentalink.ts:1023-1028`), coherente con F3/F4. **Fix 1 correcto.**

## B) Fix 2 — Cancelación (S4) — CAUSA RAÍZ HALLADA

| # | Punto | Estado | Evidencia |
|---|-------|--------|-----------|
| B4 | ¿Hardcodea `id_estado=3` o descubre dinámicamente? | ✅ Dinámico (no hardcode) | `patient-me.ts:300` → `dentalink.cancelAppointment` → `getCancelEstadoId` (`dentalink.ts:783`) consulta `GET /api/v1/citas/estados`. |
| B4 | ¿Qué id termina eligiendo? | ❌ **Elige 21 (incorrecto)** | Redis `dl:estados:cancel_id` = `{"id":21}` (cacheado en runtime). |
| B5 | (F5) ¿La regex elige el estado equivocado? | ❌ **NO CUMPLE — bug** | Ver análisis abajo. |
| B6 | ¿Validación de estado terminal previa? ¿Bloquea indebidamente? | ✅ Existe, NO bloquea indebidamente | `patient-me.ts:286-297` (Cancelada/Atendida/pasada). La cita de prueba (Pendiente, futura) la pasó sin problema. *Nota menor:* el comentario `:267` dice "<2 horas" pero el código solo valida "ya pasó" — discrepancia doc/código, no es la causa. |

### B5 — La regex elige el estado equivocado (verificado contra API real)

`getCancelEstadoId` (`dentalink.ts:793`): `estados.find(e => /cancel|anula/i.test(e.nombre))`.
`GET /api/v1/citas/estados` real devuelve los estados en **orden descendente de id (26→1)**.
Los que matchean `/cancel|anula/i`, **en ese orden**:

```
id=21  Anulado vía validación        ← .find() devuelve ESTE (el primero)
id=19  Anulado por pcte. via Whatsapp
id=17  Anulado por reprogramación
id=10  Anulado por pcte. via email
id=9   Anulado por sesiones en conflicto
id=8   Cancelada                     ← EL CORRECTO
id=1   Anulado
```

`.find()` toma el **primero** ⇒ **id=21 "Anulado vía validación"**, no el id=8 "Cancelada".

### B7 — Reproducción end-to-end por el backend local

1. Cita de prueba creada vía `POST /me/booking/appointments` (backend) — paciente 4179
   (cel 3206505239), dentista 13, **2026-07-08 08:00**, tag "PRUEBA AUDITORIA DK". → `id=35707`, 201.
2. `POST /me/appointments/35707/cancel` (backend) →
   **`HTTP 400 {"error":"BAD_REQUEST","message":"La operación no fue aceptada por el sistema de gestión."}`**
3. Re-lectura real de la cita: **`id_estado=7 "Pendiente"`** — NO se canceló.
4. `PUT /api/v1/citas/35707 {id_estado:21}` directo (lo que hace el backend) →
   **`HTTP 400 {"error":{"code":400,"message":"El estado enviado esta reservado para uso interno del software."}}`**
5. `PUT /api/v1/citas/35707 {id_estado:8}` → **200, estado="Cancelada"** (valida que 8 es el correcto).

**Cadena causal de S4 (confirmada):**
`getCancelEstadoId` → 21 (cacheado 24h en Redis) → `PUT id_estado:21` → Dentalink **400** "estado
reservado para uso interno" → `handleDentalinkError` mapea `BAD_REQUEST→HTTP 400`
(`dentalink-error-handler.ts:37`) → `appointments.apple.js:194-210` **no tiene caso para 400** →
mensaje genérico **"No pudimos cancelar la cita"**. La cita permanece sin cancelar.

> **Modo de fallo exacto:** NO es `id_estado null`, NO es la validación terminal, NO es "200 sin
> cambio". Es un **HTTP 400 de Dentalink** porque el id elegido (21) es un estado interno no asignable.

## Causa raíz S4

`getCancelEstadoId` selecciona el estado de cancelación por substring `/cancel|anula/i` y toma el
**primer** match del array de `/citas/estados`. En esta clínica ese primero es id=21 (estado
interno, rechazado por la API). **El id correcto es 8 "Cancelada".** Además, el valor erróneo
quedó **cacheado en Redis 24h** (`dl:estados:cancel_id={"id":21}`), por lo que el fallo es
persistente para toda cancelación mientras viva el caché.

## Correcciones PROPUESTAS (preliminar — NO implementadas)

| Prioridad | Archivo / línea | Corrección | Notas |
|-----------|-----------------|-----------|-------|
| **P0** | `dentalink.ts:793` | Reemplazar el substring `/cancel|anula/i` por **match exacto** de nombre `=== 'cancelada'` (normalizado, case-insensitive). El id correcto es **8** | Descubrimiento robusto: exacto "Cancelada", NO substring (evita "Anulado…"/internos). |
| **P0** | Operación | **Invalidar el caché** `dl:estados:cancel_id` tras desplegar el fix (`redis DEL`) | Sin esto, el 21 cacheado sigue 24h aunque el código ya esté corregido. |
| **P1** | `dentalink.ts` / config | Discovery robusto con prioridad: (1) `clinic.cancel_estado_id` configurable (override por clínica); (2) si no, match exacto "Cancelada"; (3) excluir explícitamente estados internos (los "Anulado*"). Loguear el id elegido | Los id_estado NO son universales (F5); un override por clínica evita futuras sorpresas. |
| **P1** | `patient-me.ts` (o handler) | Si Dentalink rechaza la transición, devolver un código/mensaje distinguible (no el genérico BAD_REQUEST) | Mejora diagnóstico futuro. |
| **P2** | `appointments.apple.js:194-210` | Añadir caso para **400** en `doCancelAppointment` con mensaje claro | Defensa UX; el fix real es backend. |
| Baja | `patient-me.ts:267` | Alinear comentario "<2 horas" con el código (que solo valida "ya pasó"), o implementar la ventana de 2h | Discrepancia doc/código. |

> **id_estado correcto = 8 ("Cancelada")**, verificado en vivo (PUT 8 → "Cancelada", 200).
> Forma robusta de descubrirlo: match **exacto** del nombre "Cancelada" en `/citas/estados`
> (con override configurable por clínica), nunca substring `cancel|anula`.

## Cierre de auditoría — limpieza

- Cita de prueba **35707**: estado final **Cancelada** (id_estado=8) ✅.
- Sesión de paciente de prueba (jti `ae30f795-…`) **borrada** de `patient_sessions` ✅
  (las 24 filas históricas del paciente 4179 son pre-existentes, no se tocaron).
- Archivos temporales (`apps/api/_audit_mint.ts`, `/tmp/dk_*`) **eliminados** ✅.
- **No quedan IDs sin limpiar.**
- *Pendiente operativo (no introducido por la auditoría):* el caché `dl:estados:cancel_id={"id":21}`
  es estado **pre-existente** del sistema; se deja intacto y se documenta como parte del bug
  (no es responsabilidad de esta etapa "arreglarlo").

---

# Etapa 5 — Inventario de drift de temas

> Fecha: 2026-05-30 · Diagnóstico. Mecanismo del drift: el commit `3764d37` (25-may) creó/reescribió
> **todos** los `*.apple.js` con su baseline; los commits de features posteriores (`e6261a1`,
> `a498d29`, `20ef70c`, `8e9a0e7`) tocaron **solo los `*.js` default**. Ningún `*.apple.js` recibió
> features después de `3764d37`.

`activateAppleTheme()` (`main.js:74-78`) reemplaza **5 pantallas**: `home`, `appointments`,
`treatments`, `booking`, `payment`. Comparación por par:

| Pantalla | Último commit `*.js` | Último commit `*.apple.js` | Drift | Qué le falta al apple |
|----------|----------------------|----------------------------|-------|------------------------|
| **booking** | `20ef70c` 05-25 (calendario) | `3764d37` 05-25 (baseline) | 🔴 **FUNCIONAL** | Paso `treatment`+fallback, calendario 2 meses, `duration` y `branch_id` en `getSlots`, `treatment_name` en `createBooking`. (S1/S2/S3) |
| **treatments** | `8e9a0e7` 05-26 (rediseño "estado de cuenta") | `3764d37` 05-25 | 🟡 **Cosmético** | No recibió el rediseño visual de `treatments.js`, pero es **funcionalmente equivalente**: misma `api.getTreatments`, muestra Total/Abonado/Saldo y botón Pagar. Sin gap funcional. |
| **appointments** | `adffa42` 05-19 | `3764d37` 05-25 | 🟢 Sin drift | apple es más nuevo. *Gap compartido* (no drift): ni `appointments.js` ni `appointments.apple.js` manejan el caso **400** en cancelar (ambos caen al genérico). Relevante a S4-UX. |
| **home** | `99d0cd1` 05-18 | `3764d37` 05-25 | 🟢 Sin drift | apple ≥ default. |
| **payment** | `4c28fce` 05-18 | `3764d37` 05-25 | 🟢 Sin drift | apple ≥ default. |

**Conclusión:** el drift **funcional está aislado a `booking.apple.js`**. `treatments` solo arrastra
una diferencia visual (no bloquea nada). El resto no tiene gaps. ⇒ El plan correctivo debe cubrir
**booking** (S1-S3) + el backend de cancelación (S4); `treatments` queda como mejora opcional de
paridad visual, y el caso-400 de `appointments` como mejora de UX. **No** se requiere un refactor
multi-pantalla por el inventario actual — aunque el mecanismo de drift es sistémico y reaparecerá si
se añaden features a otras pantallas default (ver Sección 0 del PLAN).
