# Implementar — Recordatorios de citas (SMS + correo)

> **Documento de contexto para implementación.** Consolida y **actualiza** el
> plan original `plan_recordatorios.md` (raíz, 2026-06-15) con el estado **real
> y verificado** del código a **2026-06-18** (rama `mejora_17jun`).
> Al retomar: leer este doc + `plan_recordatorios.md` para el detalle de alcance.

---

## 0. TL;DR — qué hay que construir

Un worker dentro del proceso del API que, una vez al día a una hora configurable
(hora Colombia), consulta en Dentalink las citas del día siguiente y envía **un
recordatorio por SMS y correo** a cada paciente. Idempotente, auditable y con
`DRY_RUN`. Se modela como el **reconciliador** (ya existente), sin añadir cron del
SO ni dependencias nuevas.

Estado: **NO implementado todavía.** No existe ningún archivo, var ni tabla de
recordatorios en el repo (verificado: `grep -ri reminder apps/api/src` → vacío).

---

## 1. Diferencias clave vs. `plan_recordatorios.md` (¡leer esto!)

El plan del 15-jun quedó algo desfasado. Correcciones confirmadas hoy:

| Tema | Plan decía | Realidad hoy (verificado) |
|------|-----------|---------------------------|
| **N° de migración** | `012` | La última aplicada es **`017`** → la nueva es **`018`** |
| **Consulta de citas por fecha** | "reutilizar `getAppointmentsByDate`" | **NO existe.** Solo hay `getPatientAppointments(patientId)` (path `/api/v1/pacientes/:id/citas`). Hay que **crear** `getAppointmentsByDate(fecha)` que pegue a `/api/v1/citas?q=...` |
| **Contacto en el listado de citas** | duda abierta | **Confirmado problema:** `DentalinkAppointment` (interface) **no trae celular ni email** (ver §3). Casi seguro hace falta un lookup de contacto por paciente |
| Rama base | `para_produccion` | Hoy se trabaja en `mejora_17jun` (parte de `ef0dd59`) |

Todo lo demás del plan (objetivo, fuera de alcance, plantillas, criterios de
aceptación, hitos) sigue válido.

---

## 2. Piezas existentes que se reutilizan (rutas y firmas verificadas)

| Pieza | Archivo / símbolo | Notas |
|-------|-------------------|-------|
| **Molde del worker** | `apps/api/src/lib/reconciler.ts` | `startReconciler(intervalMs)`, `stopReconciler()`, `runCycle()`, guard `let running = false` + `setInterval` con `if (running) return` |
| **Arranque/parada** | `apps/api/src/server.ts:218` (`startReconciler()`) y `:238` (`stopReconciler()`) | Cablear ahí mismo `startReminderScheduler()` / `stopReminderScheduler()` |
| **Cliente Dentalink** | `apps/api/src/lib/dentalink.ts` → `dentalinkRequest<T>()` (priv.), `getPatientAppointments()`, `getCancelEstadoId()`, `normalizeCelular()` | El token Dentalink (cifrado en `clinic` id=1) se pasa como arg a estos métodos |
| **SMS** | `apps/api/src/lib/sms.ts` → `getSmsSender()` | Devuelve `LabsMobileSmsSender` si está configurado. Espera número **sin `+`** (lo quita internamente). Remitente `dentalcode` |
| **Email** | `apps/api/src/lib/email.ts` → `getEmailSender()` | SMTP 587 |
| **Envío dual (molde)** | `apps/api/src/lib/notifications.ts` → `sendOtpDual()`, `sendPaymentReceipt()`, `sendWithTimeout()` | `sendOtpDual` ya manda SMS+correo con `Promise.allSettled` → copiar patrón para `sendAppointmentReminder()` |
| **Auditoría** | `audit()` → tabla `audit_log` | Registrar cada envío |
| **Estados no recordables** | `getCancelEstadoId()` en `dentalink.ts:809` | Modelo para resolver el `id_estado` de "cancelada"; ampliar a lista blanca de estados recordables |

---

## 3. El problema del contacto (resolver en el spike, ANTES de codificar)

La interface real (`dentalink.ts:21`) es:

```ts
export interface DentalinkAppointment {
  id, fecha, hora_inicio, hora_fin, estado,
  id_paciente, paciente, id_dentista, dentista,
  id_sucursal, sucursal, id_sillon?, tratamiento?, observaciones?
}
// ⚠️ NO incluye celular ni email
```

**Spike obligatorio contra Dentalink real** (Hito 1) — confirmar:
1. ¿`GET /api/v1/citas?q={"fecha":{"eq":"YYYY-MM-DD"}}` devuelve contacto? (probablemente no).
2. Si no → lookup por paciente: ¿`GET /api/v1/pacientes/:id` trae `celular`/`email`? (1 request por paciente → ojo rate-limit/costo).
3. **Paginación** del listado por fecha (¿cuántas citas por página?).
4. Formato exacto de `fecha`/`hora_inicio` que devuelve.
5. Lista blanca de estados **recordables** (excluir canceladas/anuladas/no-asistió/atendida).

Recordar aplicar `normalizeCelular()` (→ `+57…`) antes de pasar el número a `getSmsSender()`.

---

## 4. Arquitectura (resumen — detalle completo en `plan_recordatorios.md` §3)

```
server.ts
 └─ startReminderScheduler()         (junto a startReconciler, server.ts:218)
      └─ setInterval(REMINDER_TICK_MS ~5min)
           └─ ¿hora objetivo en TZ clínica && no corrió hoy?  → runReminderCycle()
                1. fecha = mañana (America/Bogota, UTC-5 sin DST)
                2. citas = getAppointmentsByDate(fecha)  [paginar]
                3. filtrar estados no recordables
                4. por cita no recordada aún (UNIQUE dentalink_cita_id+ventana):
                     - resolver contacto (lookup paciente si hace falta)
                     - sendAppointmentReminder({phone,email,...})  SMS+correo
                     - registrar en appointment_reminders + audit
                5. log {found, sent, skipped, errors} + fila reminder_runs
```

- **Tick cada ~5 min + guard `last_run_date` en BD** → sobrevive reinicios y dispara **exactamente 1 vez/día**.
- Prod = **1 sola instancia** de `api`. Para blindar multi-instancia futuro: `pg_try_advisory_lock` al inicio del ciclo.

---

## 5. Datos — nueva migración **`018`** (no 012)

Misma forma que propone el plan, con número corregido. Terminar con el
`INSERT INTO schema_migrations (version, name) VALUES ('018', '...') ON CONFLICT (version) DO NOTHING;`.

```
appointment_reminders
  id                  bigserial PK
  dentalink_cita_id   text
  appointment_date    date
  reminder_window     text          -- 'T-1d'
  patient_cedula_hash text          -- sin PII en claro (como otp_codes)
  channel_sms         text          -- 'sent'|'failed'|'skipped'|null
  channel_email       text
  sms_provider_sid    text          -- subid LabsMobile si aplicó
  sent_at             timestamptz
  created_at          timestamptz default now()
  UNIQUE (dentalink_cita_id, reminder_window)   -- ← idempotencia

reminder_runs
  run_date    date PK     -- en TZ clínica (guard "ya corrió hoy")
  started_at  timestamptz
  finished_at timestamptz
  found int, sent int, skipped int, errors int
```

> Privacidad: **solo `cedula_hash`**, nunca teléfono/correo en claro (coherente
> con `otp_codes`/`habeas_data_consents`).

---

## 6. Variables de entorno (nuevas — añadir a `config.ts` con `boolEnv()`)

```bash
REMINDERS_ENABLED=true            # master switch (boolEnv)
REMINDER_TZ=America/Bogota
REMINDER_HOUR=6                   # hora local de disparo (0–23)
REMINDER_LEAD_DAYS=1              # T-1
REMINDER_CHANNELS=sms,email
REMINDER_TICK_MS=300000           # 5 min
REMINDER_DRY_RUN=false            # boolEnv — true = calcula/registra, NO envía
```

⚠️ Las booleanas (`REMINDERS_ENABLED`, `REMINDER_DRY_RUN`) **deben** usar el
helper `boolEnv()` de `config.ts` (`z.coerce.boolean()` interpreta `"false"` como `true`).

---

## 7. Plan de implementación (hitos)

1. **Spike + diseño cerrado** — resolver las 5 dudas de §3 contra Dentalink real. Entregable: notas + ajuste de este doc.
2. **Datos + consulta** — migración `018`; en `dentalink.ts`: `getAppointmentsByDate(fecha)` (paginación + filtro estado) y, si hace falta, `getPatientContact(idPaciente)`. Tests con mock Dentalink.
3. **Worker + envío** — `lib/reminders.ts` (`startReminderScheduler`/`runReminderCycle`/`stopReminderScheduler`, molde reconciler) + `notifications.ts:sendAppointmentReminder()` (molde `sendOtpDual`). Idempotencia + `DRY_RUN`. Cablear en `server.ts`. Tests: idempotencia, dry-run, exclusión de canceladas, TZ.
4. **Panel admin / operación** — `POST /admin/reminders/run` (disparo manual/dry-run) + `GET /admin/reminders/runs` (lee `reminder_runs`). Opcional: config en `clinic`.
5. **Despliegue** — vars en `.env` local y `/opt/dentalkiosco/.env`; migración `018`; ensayo con `REMINDER_DRY_RUN=true` un día; revisar log/`reminder_runs`; luego `false`. Actualizar `CLAUDE.md` (nuevo worker + vars).

---

## 8. Criterios de aceptación
- Corre **una sola vez/día** a `REMINDER_HOUR` (TZ clínica).
- Cada cita de "mañana" no cancelada → **≤ 1** recordatorio por canal (reejecutar ciclo = 0 reenvíos).
- SMS con remitente `dentalcode`; correo con fecha/hora/dentista/sucursal correctos.
- `reminder_runs` refleja `found/sent/skipped/errors`; `audit_log` registra envíos.
- `REMINDER_DRY_RUN=true` calcula y registra **sin** enviar.
- Reinicio del `api` cerca de la hora objetivo no duplica ni omite.

---

## 9. Decisiones pendientes del usuario
1. **Hora exacta** de envío (sugerido 06:00 COT) y **alcance** (¿todas las sucursales?).
2. Lista blanca de **estados recordables** (depende del spike).
3. ¿**Tope diario** de SMS / manejo de costos LabsMobile?
4. ¿Config por **panel admin** en v1 o solo `.env` y promover después?

---

## 10. Reglas del proyecto a respetar (recordatorio)
- **No tocar sin autorización:** `payments.ts`, `reconciler.ts`, `license/*`, migraciones `001-017`.
- Migración nueva = versión nueva (`018`) + `INSERT … ON CONFLICT DO NOTHING`.
- Verificación obligatoria al terminar: `typecheck` + `test` (287) + builds frontend. (`pnpm lint` raíz está roto, preexistente.)
- Probar en local contra servicios **reales** antes de subir a git (pero los tests siguen en mock — vitest lo fuerza).
- Re-aplicar siempre `normalizeCelular()` y `boolEnv()` (se pierden en parches).
</content>
</invoke>
