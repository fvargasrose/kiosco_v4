# Plan — Sistema de recordatorios de citas (SMS + correo)

> Documento de **planificación**. NO incluye código todavía: define alcance,
> arquitectura, modelo de datos, decisiones e hitos para implementar el envío
> automático de recordatorios de cita.
> Fecha: **2026-06-15** · Rama base de trabajo: `para_produccion`.

---

## 1. Objetivo

Cada día, a una hora configurable (p. ej. **06:00 hora Colombia**), el sistema
consulta automáticamente en Dentalink **quién tiene cita al día siguiente** y le
envía un **recordatorio por correo y por SMS** (este último ya operativo vía
LabsMobile). El proceso debe ser **idempotente** (no reenviar al mismo paciente
para la misma cita), **auditable** y **operable desde el panel admin**.

### Fuera de alcance (primera entrega)
- Recordatorios multi-ventana (p. ej. también 2 h antes). Se deja la puerta
  abierta en el modelo de datos, pero la v1 envía **una sola ventana: T-1 día**.
- Confirmación/cancelación de la cita respondiendo al SMS/correo (two-way).
- WhatsApp u otros canales.

---

## 2. Piezas que YA existen y se reutilizan

| Pieza | Ubicación | Uso en este plan |
|-------|-----------|------------------|
| Cliente Dentalink + `dentalinkRequest` | `apps/api/src/lib/dentalink.ts` | Consultar citas por fecha |
| Filtro JSON Dentalink (`q={"campo":{"op":val}}`) | mismo | `GET /api/v1/citas?q={"fecha":{"eq":"YYYY-MM-DD"}}` |
| Token Dentalink cifrado en `clinic` | tabla `clinic` (id=1) | Auth `Authorization: Token <token>` |
| `normalizeCelular()` | `dentalink.ts` | Asegurar `+57…` antes de enviar SMS |
| `getSmsSender()` → **LabsMobile** | `apps/api/src/lib/sms.ts` | Canal SMS |
| `getEmailSender()` (SMTP 587) | `apps/api/src/lib/email.ts` | Canal correo |
| Patrón scheduler (`startReconciler`/`runCycle`/guard `running`) | `apps/api/src/lib/reconciler.ts` + `server.ts:218` | Molde del worker de recordatorios |
| `audit()` (auditoría inmutable) | `audit_log` | Registrar cada envío |
| Migraciones versionadas | `apps/api/migrations/` | Nueva tabla `appointment_reminders` |

**Decisión:** se imita el reconciliador (no se agrega `node-cron` ni un
cron del sistema operativo). Un `setInterval` ligero dentro del proceso del API,
con guard de "ya corrió hoy" en base de datos, encaja con la arquitectura actual
(un solo contenedor `api` en prod) y no añade dependencias.

---

## 3. Arquitectura propuesta

```
server.ts
  └─ startReminderScheduler()          ← arranca junto al reconciliador
        └─ setInterval (cada ~5 min)   ← "tick" barato
              └─ ¿es la hora objetivo en TZ clínica y NO se ha corrido hoy?
                    └─ runReminderCycle()        ← idempotente, expuesto para admin
                          1. fecha_objetivo = mañana (TZ clínica)
                          2. citas = Dentalink GET /api/v1/citas?q=fecha=mañana
                          3. filtrar canceladas / estados no recordables
                          4. para cada cita NO recordada aún:
                                a. resolver contacto (celular/email)
                                b. sendAppointmentReminder()  (SMS + correo)
                                c. registrar en appointment_reminders + audit
                          5. log resumen { encontradas, enviadas, saltadas, errores }
```

### ¿Por qué un "tick" cada 5 min y no un `setInterval` de 24 h?
- Sobrevive a reinicios del contenedor sin perder la ventana: si el API se
  reinicia a las 05:58, igual detecta la hora a las 06:00.
- El guard `last_run_date` en BD garantiza **exactamente un disparo por día**
  aunque el tick evalúe muchas veces.

### Concurrencia / un solo disparo
- Hoy prod corre **una sola instancia** de `api`, así que el guard en memoria +
  fila de control en BD basta.
- Para blindar ante futuros multi-instancia: tomar un **advisory lock** de
  Postgres (`pg_try_advisory_lock`) al inicio de `runReminderCycle()`.

---

## 4. Modelo de datos (nueva migración `012`)

Tabla de control de envíos — fuente de verdad de la idempotencia:

```
appointment_reminders
─────────────────────────────────────────────────────────────
id                   uuid / bigserial   PK
dentalink_cita_id    text               id de la cita en Dentalink (único por ventana)
appointment_date     date               fecha de la cita (para reportes/limpieza)
reminder_window      text               'T-1d' (reservado para futuras ventanas)
patient_cedula_hash  text               sin PII en claro (igual que otp_codes)
channel_sms          text               'sent' | 'failed' | 'skipped' | null
channel_email        text               'sent' | 'failed' | 'skipped' | null
sms_provider_sid     text               id de LabsMobile (subid) si aplicó
sent_at              timestamptz        cuándo se procesó
created_at           timestamptz        default now()

UNIQUE (dentalink_cita_id, reminder_window)   ← evita doble envío
```

Tabla de control diario (o reutilizar Redis con TTL):

```
reminder_runs
─────────────────────────────────────────────────────────────
run_date     date          PK   (fecha en TZ clínica)
started_at   timestamptz
finished_at  timestamptz
found        int
sent         int
skipped      int
errors       int
```

> La migración termina con el `INSERT INTO schema_migrations … ON CONFLICT` de
> rigor (regla del proyecto).

---

## 5. Configuración

### Variables de entorno (`.env` local y prod)
```bash
REMINDERS_ENABLED=true            # master switch del worker
REMINDER_TZ=America/Bogota        # zona horaria para "mañana" y la hora objetivo
REMINDER_HOUR=6                   # hora local de disparo (0–23)
REMINDER_LEAD_DAYS=1              # T-1: avisar de citas de "mañana"
REMINDER_CHANNELS=sms,email       # canales activos
REMINDER_TICK_MS=300000           # frecuencia del tick (5 min)
REMINDER_DRY_RUN=false            # true = calcula y registra pero NO envía
```

### Configurable desde el panel admin (opcional, Hito 4)
Mover `enabled / hora / canales / plantilla de texto` a la fila `clinic` para
que la clínica los ajuste sin tocar el `.env`. La v1 puede arrancar solo con
env vars y promover a panel después.

### Plantillas de mensaje (borrador)
- **SMS** (≤ ~160 chars, remitente `dentalcode`):
  `Hola {nombre}, te recordamos tu cita en {clínica} el {fecha} a las {hora} con {dentista}. Si no puedes asistir, avísanos.`
- **Correo:** asunto `Recordatorio de tu cita — {clínica}` + cuerpo HTML con
  fecha, hora, dentista, sucursal y datos de contacto de la clínica.

---

## 6. Riesgos y decisiones abiertas (resolver en Hito 1)

1. **¿`GET /api/v1/citas` trae contacto del paciente?**
   Las citas por-paciente devuelven nombres (dentista/sucursal) pero **no
   necesariamente celular/email**. Si el listado por fecha no trae contacto,
   habrá que hacer un **lookup por `id_paciente`** (1 request por paciente) o por
   lote. → **Spike obligatorio** contra la API real antes de codificar el ciclo.
2. **Paginación de Dentalink:** el listado puede paginar (>N citas/día). El
   ciclo debe iterar páginas.
3. **Estados a excluir:** no recordar citas **canceladas/anuladas/no-asistió**.
   Reutilizar la lógica de `getCancelEstadoId()` y definir la lista blanca de
   estados recordables.
4. **Zona horaria:** el contenedor corre en UTC; "mañana" y "06:00" deben
   calcularse en `America/Bogota` (UTC-5, sin DST). Cuidado con el corte de día.
5. **Rate / costos SMS:** un día con muchas citas = muchos SMS (costo real
   LabsMobile). Métrica + tope diario opcional + `REMINDER_DRY_RUN` para ensayo.
6. **Privacidad:** guardar solo `cedula_hash`, nunca teléfono/correo en claro en
   la tabla de control (coherente con `otp_codes`/`habeas_data_consents`).
7. **Reintentos:** si falla el envío, ¿se reintenta en el siguiente tick del
   mismo día o se marca `failed` y se deja? v1 sugerida: marcar `failed` y
   permitir **re-disparo manual** desde el panel; no auto-reintento agresivo.

---

## 7. Plan por hitos

### Hito 1 — Spike + diseño cerrado (sin features de envío)
- Probar contra Dentalink real: `GET /api/v1/citas?q={"fecha":{"eq":"<mañana>"}}`.
- Confirmar campos devueltos (¿contacto incluido?), paginación y estados.
- Cerrar la lista de estados recordables y el formato exacto de fecha/hora.
- **Entregable:** notas del spike + ajuste de este plan si algo cambia.

### Hito 2 — Capa de datos y consulta
- Migración `012_appointment_reminders` + `reminder_runs`.
- `dentalink.ts`: `getAppointmentsByDate(fecha)` (con paginación + filtro estado)
  y, si hace falta, `getPatientContact(idPaciente)`.
- Tests con el mock de Dentalink (citas de prueba por fecha).

### Hito 3 — Worker + envío (núcleo)
- `lib/reminders.ts`: `startReminderScheduler()`, `runReminderCycle()`,
  `stopReminderScheduler()` (molde del reconciliador).
- `notifications.ts`: `sendAppointmentReminder({ phone, email, ... })`
  (reutiliza `getSmsSender`/`getEmailSender`, `Promise.allSettled`).
- Idempotencia vía `UNIQUE(dentalink_cita_id, reminder_window)` + guard diario.
- Soporte `REMINDER_DRY_RUN`. Cableado en `server.ts` (junto a `startReconciler`).
- Tests: ciclo idempotente, dry-run, exclusión de canceladas, TZ.

### Hito 4 — Operación y panel admin
- Endpoint admin `POST /admin/reminders/run` (disparo manual / dry-run) y
  `GET /admin/reminders/runs` (historial — lee `reminder_runs`).
- (Opcional) Config en el panel: activar/desactivar, hora, canales, plantilla.
- Métricas en log + (opcional) un correo-resumen diario a la clínica.

### Hito 5 — Despliegue
- Vars en `.env` local y `/opt/dentalkiosco/.env` (Hetzner).
- `build api` + `up -d api`, migración `012`, verificación con `REMINDER_DRY_RUN=true`
  un día, revisión del log/`reminder_runs`, luego `false`.
- Actualizar `estado_produccion.md` y `CLAUDE.md` (nuevo worker + vars).

---

## 8. Verificación (criterios de aceptación)
- A las `REMINDER_HOUR` (TZ clínica) corre **una sola vez** por día.
- Cada cita de "mañana" no cancelada recibe **a lo sumo un** recordatorio por
  canal (idempotencia comprobable reejecutando el ciclo: 0 reenvíos).
- SMS llega con remitente `dentalcode`; correo llega con los datos correctos.
- `reminder_runs` refleja `found/sent/skipped/errors`; `audit_log` registra envíos.
- `REMINDER_DRY_RUN=true` calcula y registra **sin** enviar.
- Reinicio del `api` cerca de la hora objetivo no duplica ni se salta el envío.

---

## 9. Estimación gruesa
| Hito | Esfuerzo aprox. |
|------|-----------------|
| 1 — Spike/diseño | 0.5 día |
| 2 — Datos + consulta | 1 día |
| 3 — Worker + envío | 1.5 días |
| 4 — Panel/operación | 1 día |
| 5 — Despliegue | 0.5 día |

> Sujeto a lo que revele el Hito 1 (sobre todo si Dentalink obliga a un lookup
> de contacto por paciente, que añade requests y manejo de rate-limit).
</content>
</invoke>
