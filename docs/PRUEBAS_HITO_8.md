# Pruebas del Hito 8 — Booking + Reconciliador + Comprobantes

## Pre-requisitos

- Hitos 1-7 completados y validados.
- Stack docker corriendo: `docker compose up -d`.
- Migración `009_receipts.sql` aplicada (corre automáticamente con `npm run migrate`).
- Para tests automatizados: `DEV_MOCK_EXTERNAL_SERVICES=true` y `DEV_MOCK_WOMPI=true`.

---

## Resumen

El Hito 8 añade:

- **Booking de nuevas citas:** 4 endpoints + flujo lineal de 5 pasos en el kiosco
  (sucursal → dentista → fecha → hora → confirmar). Reagendar = crear cita nueva
  independiente (decisión de UX del paciente).
- **Reconciliador de pagos:** worker en-proceso que cada minuto:
  - Reintenta `registerPaymentInDentalink` para pagos approved no reconciliados
    (backoff exponencial, hasta 10 intentos)
  - Pollea Wompi para transactions pending sin webhook >2 min (recupera webhooks perdidos)
  - Marca como `expired` transactions pending >24 horas
- **Comprobantes de pago:** email HTML + SMS al paciente cuando un pago se aprueba.
  Best-effort, idempotente.

---

## P1 — Tests automatizados con vitest

### P1.1 — Suite del Hito 8

```bash
docker compose exec api npx vitest run tests/booking.test.ts
```

**Validar (28 tests deben pasar):**

#### GET /me/booking/branches (2 tests)
- [ ] Sin auth retorna 401
- [ ] Lista sucursales

#### GET /me/booking/dentists (4 tests)
- [ ] Sin branch_id retorna 400
- [ ] branch_id inválido retorna 400
- [ ] Lista dentistas de una sucursal específica
- [ ] Sucursal sin dentistas retorna array vacío

#### GET /me/booking/slots (6 tests)
- [ ] Sin params retorna 400
- [ ] Formato de fecha inválido retorna 400
- [ ] Rango > 30 días retorna 400
- [ ] Rango más allá de 90 días futuro retorna 400
- [ ] from > to retorna 400
- [ ] Devuelve slots dentro del rango
- [ ] Respeta el parámetro duration

#### POST /me/booking/appointments (11 tests)
- [ ] Sin auth retorna 401
- [ ] Crea una cita exitosamente
- [ ] Rechaza fecha en el pasado
- [ ] Rechaza hora_fin <= hora_inicio
- [ ] Rechaza fecha más allá de 90 días
- [ ] Rechaza slot duplicado (CONFLICT)
- [ ] Rate limiting: 6ta cita en una hora es bloqueada
- [ ] Audit_log registra la creación
- [ ] Después de crear, la cita aparece en /me/appointments
- [ ] Citas creadas por paciente A NO son visibles para paciente B

#### Reconciler (5 tests)
- [ ] reconcileApproved: pago no registrado se intenta reconciliar
- [ ] reconcileApproved: ya reconciliados NO son tocados
- [ ] Audit log registra eventos de reconciliación
- [ ] runCycle es idempotente
- [ ] expireOldPending: marca como expired transactions pending viejas

### P1.2 — Suite completa Hitos 3-8

```bash
docker compose exec api npm test
```

**Validar:** 131 tests pasan en total
(17 admin + 29 patient-auth + 23 patient-me + 34 payments + **28 booking**).

---

## P2 — Tests manuales: Booking flow

Asume que tienes un `PATIENT_TOKEN` válido (ver `PRUEBAS_HITO_4.md` P2.6).

### P2.1 — Listar sucursales

```bash
curl http://localhost/api/me/booking/branches \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .
```

**Validar:**
- [ ] Status 200
- [ ] `data: [...]` con al menos una sucursal
- [ ] Cada sucursal tiene: `id`, `nombre`, `direccion?`, `telefono?`, `horario?`

### P2.2 — Listar dentistas de la sucursal 1

```bash
curl "http://localhost/api/me/booking/dentists?branch_id=1" \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .
```

**Validar:**
- [ ] Lista de dentistas con `id`, `nombre`, `apellido`, `especialidad`
- [ ] Todos tienen `id_sucursal: 1`

### P2.3 — Buscar slots disponibles

```bash
TOMORROW=$(date -d "+1 day" +%Y-%m-%d)
NEXT_WEEK=$(date -d "+7 days" +%Y-%m-%d)

curl "http://localhost/api/me/booking/slots?dentist_id=dr-001&from=$TOMORROW&to=$NEXT_WEEK" \
  -H "Authorization: Bearer $PATIENT_TOKEN" | jq .
```

**Validar:**
- [ ] Status 200
- [ ] `data: [...]` con slots de 30 minutos
- [ ] Cada slot tiene `fecha`, `hora_inicio`, `hora_fin`, `id_dentista`, `id_sucursal`
- [ ] `duration_minutes: 30`

### P2.4 — Crear una cita

Toma un slot del paso anterior y úsalo:

```bash
curl -X POST http://localhost/api/me/booking/appointments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dentist_id": "dr-001",
    "branch_id": 1,
    "fecha": "'$TOMORROW'",
    "hora_inicio": "10:00",
    "hora_fin": "10:30",
    "notas": "Limpieza"
  }' | jq .
```

**Validar:**
- [ ] Status 201
- [ ] `ok: true`, `appointment.estado: "Reservada"`
- [ ] La cita aparece en `GET /me/appointments`

### P2.5 — Conflicto al duplicar

Crear otra cita en el mismo slot:

```bash
# (repetir el comando anterior)
```

**Validar:**
- [ ] Status 409, `error: "CONFLICT"`

### P2.6 — Validaciones de input

```bash
# Fecha en el pasado
curl -i -X POST http://localhost/api/me/booking/appointments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dentist_id":"dr-001","branch_id":1,"fecha":"2020-01-01","hora_inicio":"10:00","hora_fin":"10:30"}'

# Más allá de 90 días
curl -i -X POST http://localhost/api/me/booking/appointments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dentist_id":"dr-001","branch_id":1,"fecha":"2027-12-31","hora_inicio":"10:00","hora_fin":"10:30"}'
```

**Validar:** Ambos retornan 400 con mensaje claro.

### P2.7 — Rate limiting

Crear 5 citas válidas + intentar la 6ta:

**Validar:**
- [ ] La 6ta retorna 429 con `error: "RATE_LIMIT"` y `retry_after_seconds`

---

## P3 — Tests manuales: Reconciliador

### P3.1 — Inspeccionar el worker en logs

Después de arrancar el server:

```bash
docker compose logs api | grep -i "reconciler"
```

**Validar:**
- [ ] Aparece `Reconciler started`
- [ ] Cada minuto aparece log de cycle (silent si no hay nada que hacer)

### P3.2 — Forzar reconciliación de un pago

Crear un pago approved sin reconciliar manualmente:

```bash
docker compose exec postgres psql -U dentalkiosco -c "
INSERT INTO transactions (
  kiosk_id, dentalink_patient_id, dentalink_treatment_id,
  wompi_reference, amount_cop, status, wompi_payment_method_type,
  registered_in_dentalink, webhook_received_at, webhook_verified,
  wompi_transaction_id, approved_at
)
VALUES (
  (SELECT id FROM kiosks LIMIT 1),
  '12345', 'tx-001',
  'DK-MANUAL-001', 100000, 'approved', 'NEQUI',
  false, now() - interval '5 minutes', true,
  'wompi-tx-manual-001', now()
);"
```

Esperar 1 minuto (o ejecutar el script de runCycle manualmente).

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT wompi_reference, status, registered_in_dentalink,
       dentalink_payment_id, reconciliation_attempts
FROM transactions WHERE wompi_reference = 'DK-MANUAL-001';"
```

**Validar:**
- [ ] `registered_in_dentalink = true`
- [ ] `dentalink_payment_id` poblado
- [ ] `reconciliation_attempts = 1`

### P3.3 — Backoff exponencial en fallos

Si Dentalink está caído, los reintentos crecen exponencialmente:

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT wompi_reference, reconciliation_attempts, last_reconciliation_at,
       last_reconciliation_error
FROM transactions
WHERE status = 'approved' AND registered_in_dentalink = false
ORDER BY last_reconciliation_at DESC LIMIT 5;"
```

**Validar:**
- [ ] Los intervalos entre intentos se duplican (1min, 2min, 4min, 8min...)
- [ ] `last_reconciliation_error` muestra el motivo

### P3.4 — Expiración de pendings viejos

```bash
docker compose exec postgres psql -U dentalkiosco -c "
INSERT INTO transactions (
  kiosk_id, dentalink_patient_id, wompi_reference, amount_cop, status,
  created_at
)
VALUES (
  (SELECT id FROM kiosks LIMIT 1),
  '12345', 'DK-OLD-001', 50000, 'pending',
  now() - interval '25 hours'
);"
```

Esperar al siguiente cycle (o ejecutar manualmente).

**Validar:**
- [ ] La transaction pasa a `status='expired'`
- [ ] Audit log tiene entry `payment.expired` con `reason: 'pending > 24h'`

---

## P4 — Tests manuales: Comprobantes

### P4.1 — Comprobante después de webhook approved

1. Crear un pago via `POST /me/payments`
2. Simular webhook APPROVED (ver `PRUEBAS_HITO_7.md` P4.1)
3. Esperar 1-2 segundos

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT wompi_reference, receipt_sent_at, receipt_channels
FROM transactions WHERE wompi_reference = '<paste>';"
```

**Validar:**
- [ ] `receipt_sent_at` poblado
- [ ] `receipt_channels = 'email,sms'` (o el subset que envió)

### P4.2 — Idempotencia: no se reenvía

Disparar manualmente `sendPaymentReceipt` dos veces con la misma reference:

**Validar:**
- [ ] La segunda llamada retorna `{ skipped: true }`
- [ ] El email/SMS NO se envía dos veces

### P4.3 — Best-effort: no falla la operación principal

Configura el mock email para que falle (o usa un email inválido en mock data):

**Validar:**
- [ ] El webhook approved sigue retornando 200
- [ ] El log muestra `Failed to send receipt email` pero no aborta
- [ ] El SMS sí se envía
- [ ] `receipt_channels = 'sms'` solamente

### P4.4 — Email contiene los datos correctos

En logs (mock mode):

```bash
docker compose logs api | grep "MOCK Email" | tail -5
```

**Validar:**
- [ ] `to` enmascarado
- [ ] `subject` contiene "Comprobante de pago"
- [ ] El body HTML contiene: monto formateado en COP, referencia,
      método de pago amigable (Nequi/PSE/Tarjeta), fecha local Bogotá

### P4.5 — SMS texto plano <160 chars

```bash
docker compose logs api | grep "MOCK SMS" | grep "pago de"
```

**Validar:**
- [ ] Body bajo 160 caracteres
- [ ] Menciona nombre de clínica, monto, referencia, método

---

## P5 — Frontend (build + UX)

### P5.1 — Build limpio

```bash
cd apps/kiosco-frontend
npm install
npm run build
```

**Validar:**
- [ ] `✓ built in XXXms`
- [ ] 27 módulos, ~70 KB JS + 20 KB CSS (~25 KB gzipped)
- [ ] Warning sobre `fs` de qrcode-svg sigue siendo esperado

### P5.2 — Flujo de booking desde home

1. Inicia sesión como paciente
2. En home, toca la tarjeta destacada "Agendar nueva cita"

**Validar:**
- [ ] Tarjeta destacada con gradiente azul, icono ➕
- [ ] Navega a pantalla booking, step 1 (sucursal)

### P5.3 — Step 1: Sucursal

**Validar:**
- [ ] Progress indicator muestra paso 1/5 activo
- [ ] Lista de sucursales con icono 🏥, nombre, dirección, teléfono+horario
- [ ] Tocar una avanza al step 2

### P5.4 — Step 2: Dentista

**Validar:**
- [ ] Progress muestra paso 2/5
- [ ] Subtítulo confirma sede escogida
- [ ] Solo dentistas de esa sede aparecen
- [ ] Cada uno con nombre completo y especialidad

### P5.5 — Step 3: Fecha

**Validar:**
- [ ] Grid de 14 días al frente (saltando domingos)
- [ ] Cada tarjeta muestra día de semana abreviado, número grande, mes abreviado
- [ ] Tocar uno avanza al step 4

### P5.6 — Step 4: Slots

**Validar:**
- [ ] Slots agrupados en "Mañana" y "Tarde"
- [ ] Solo horarios disponibles (mock filtra ~40% como ocupados)
- [ ] Si no hay slots, muestra empty state con sugerencia de cambiar día
- [ ] Tocar un slot avanza al step 5

### P5.7 — Step 5: Confirmar

**Validar:**
- [ ] Resumen con: sede, dirección, profesional, especialidad, fecha completa,
      hora, duración
- [ ] Campo opcional de notas (máx 200 chars)
- [ ] Botón "Confirmar y agendar"
- [ ] Al éxito: modal "✅ ¡Cita agendada!" y vuelve a home

### P5.8 — Botón "← Volver" retrocede paso por paso

**Validar:**
- [ ] En step 1, vuelve a home
- [ ] En step 2, vuelve a sucursal (con selección de sucursal limpia)
- [ ] En step 3, vuelve a dentista (manteniendo sede)
- [ ] etc.

### P5.9 — Reagendar desde Mis citas

1. Ve a "Mis citas" → toca "Reagendar" en una cita upcoming

**Validar:**
- [ ] Modal explica que reagendar = crear cita nueva + opcionalmente cancelar la actual
- [ ] Botón "Agendar nueva" navega al flujo booking
- [ ] El paciente puede luego volver a Mis citas y cancelar la anterior

### P5.10 — Conflict al confirmar

Si entre la consulta de slots y el confirm otro paciente toma el slot:

**Validar:**
- [ ] El backend retorna 409
- [ ] El frontend muestra "Este horario ya no está disponible. Por favor escoge otro."

---

## P6 — Validaciones de seguridad

### P6.1 — Anti-IDOR en creación

```bash
grep "patient.sub" apps/api/src/routes/booking.ts
```

**Validar:**
- [ ] La creación usa SIEMPRE `patient.sub` del JWT como `patientId`
- [ ] El paciente NO puede crear citas para otro patient_id

### P6.2 — Rate limiting persistido

```bash
grep "fn_rate_limit_check" apps/api/src/routes/booking.ts
```

**Validar:**
- [ ] Usa `fn_rate_limit_check` (Postgres) para que el límite sobreviva a reinicio
- [ ] Bucket key incluye `patient.sub` → cada paciente tiene su propio cubo
- [ ] 5 citas/hora por paciente

### P6.3 — Reconciliador no procesa transactions ajenas

```bash
grep "WHERE status = 'approved'" apps/api/src/lib/reconciler.ts
```

**Validar:**
- [ ] El query SELECT no filtra por paciente (es un proceso de sistema)
- [ ] Pero solo procesa transactions ya validadas por webhook firmado

### P6.4 — Comprobantes: email enmascarado en logs

```bash
docker compose logs api | grep "Payment receipt email sent" | head -5
```

**Validar:**
- [ ] Los logs muestran `to: ma***@dominio.com`, NO el email completo

### P6.5 — Backoff exponencial limita carga

```bash
grep "power(2, reconciliation_attempts)" apps/api/src/lib/reconciler.ts
```

**Validar:**
- [ ] El SQL usa `interval '1 minute' * power(2, attempts)` para espaciar reintentos
- [ ] Máximo 10 intentos antes de abandonar

---

## Resumen aceptación

**Criterio mínimo:**

- [ ] P1.1 — Los 28 tests del Hito 8 pasan
- [ ] P1.2 — Los 131 tests totales pasan
- [ ] P2.1-P2.4 — Flujo completo de booking end-to-end por curl
- [ ] P2.5 — Conflicto al duplicar slot
- [ ] P2.7 — Rate limiting funciona
- [ ] P3.2 — Reconciliador procesa pagos pending
- [ ] P3.4 — Expiración de pendings >24h
- [ ] P4.1 — Comprobante enviado tras webhook approved
- [ ] P4.2 — Idempotencia (no se reenvía)
- [ ] P5.1 — Build limpio del frontend
- [ ] P5.2-P5.9 — Flujo de booking en el UI
- [ ] P6 — Validaciones de seguridad

**Conociendo limitaciones del Hito 8 (intencionales):**

- **Slots mock determinista:** en mock mode los slots son pseudoaleatorios (~40%
  ocupados). En real Dentalink, los slots vienen del servicio real.
- **Reconciliador in-process:** corre dentro del API. En producción a escala,
  conviene separar a un worker dedicado (queda para Hito 10).
- **Email/SMS adapters:** usan los mocks por defecto. Para producción configurar
  Resend (email) y Twilio (SMS) con las API keys correspondientes.
- **No hay backoff jitter:** los reintentos del reconciler son determinísticos.
  Para alta carga conviene añadir jitter aleatorio.
