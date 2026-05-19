# Pruebas del Hito 7 — Cancelación de citas + Pagos con Wompi

## Pre-requisitos

- Hitos 1-6 completados y validados.
- Stack docker corriendo: `docker compose up -d`.
- Migraciones aplicadas (8 en total, no se requiere nueva migración para el Hito 7).
- Variables Wompi configuradas en `.env`:
  - `WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_EVENTS_SECRET` (sandbox)
  - `WOMPI_INTEGRITY_SECRET`
  - `WOMPI_ENVIRONMENT=sandbox`, `WOMPI_API_URL=https://sandbox.wompi.co/v1`
- Para tests automatizados: `DEV_MOCK_WOMPI=true` (no requiere conectividad real con Wompi).
- Para tests reales con sandbox: ngrok corriendo y URL de webhook configurada en
  dashboard de Wompi.

---

## Resumen

El Hito 7 añade:

- **Cancelación de citas:** endpoint `POST /me/appointments/:id/cancel` con anti-IDOR
  doble, validación de fecha pasada, reglas de negocio (no cancelar si ya está
  cancelada/atendida o si la fecha pasó).
- **Pagos con link-to-mobile:** el paciente escanea un QR desde el kiosco y paga
  en su propio celular. No capturamos datos de tarjeta (PCI compliance es de Wompi).
- **Webhooks Wompi:** verificación de firma SHA256 estricta, anti-replay 5min,
  idempotencia, reconciliación best-effort con Dentalink.

---

## P1 — Tests automatizados con vitest

### P1.1 — Suite del Hito 7

```bash
docker compose exec api npx vitest run tests/payments.test.ts
```

**Validar (34 tests deben pasar):**

#### Cancelación de citas (8 tests)
- [ ] Sin auth retorna 401
- [ ] Cancela una cita propia exitosamente
- [ ] Después de cancelar, aparece como 'Cancelada' en /me/appointments
- [ ] Cancelar dos veces la misma cita retorna 409 CONFLICT
- [ ] Anti-IDOR: paciente B NO puede cancelar cita de paciente A
- [ ] Cita inexistente retorna 404
- [ ] Registra entrada en audit_log con result='success'
- [ ] Registra entrada en audit_log con result='denied' para anti-IDOR

#### Crear pago (9 tests)
- [ ] Sin auth retorna 401
- [ ] Valida amount_cop requerido
- [ ] Valida amount_cop negativo (rechazo)
- [ ] Valida amount_cop excesivo > 50M COP (rechazo)
- [ ] Crea pago general (sin treatment_id) exitosamente
- [ ] Crea pago vinculado a treatment_id propio
- [ ] Anti-IDOR: rechaza pago con treatment_id de otro paciente
- [ ] Rechaza monto que excede saldo del tratamiento
- [ ] Persiste transaction con status='pending'
- [ ] Email y phone se enmascaran en BD
- [ ] Registra entrada en audit_log

#### Consultar pago / polling (5 tests)
- [ ] Sin auth retorna 401
- [ ] Devuelve estado de mi propio pago
- [ ] Anti-IDOR: otro paciente NO ve mi pago
- [ ] Reference con formato inválido retorna 400
- [ ] Reference inexistente retorna 404

#### Webhook Wompi (8 tests)
- [ ] Webhook con shape inválido retorna 400
- [ ] Webhook con firma inválida retorna 401
- [ ] Webhook con timestamp viejo retorna 401 (anti-replay >5min)
- [ ] Webhook APPROVED válido actualiza transaction y dispara reconciliación
- [ ] Webhook DECLINED actualiza el status correspondiente
- [ ] Webhook con reference desconocida retorna 200 pero no-op
- [ ] Idempotencia: segundo webhook sobre transaction terminal es no-op
- [ ] Audit_log registra eventos de webhook

#### Wompi client (unit) (2 tests)
- [ ] generateReference produce valores únicos con prefijo DK-
- [ ] verifyWebhookSignature rechaza body sin signature

### P1.2 — Suite completa Hitos 3 + 4 + 5 + 7

```bash
docker compose exec api npm test
```

**Validar:** 103 tests pasan en total
(17 admin + 29 patient-auth + 23 patient-me + 34 payments).

---

## P2 — Tests manuales: Cancelación de citas

Asumimos que ya tienes un `PATIENT_TOKEN` válido (ver `PRUEBAS_HITO_4.md` P2.6).
En mock mode las citas predefinidas son:

| ID | Fecha | Paciente | Estado |
|----|-------|----------|--------|
| apt-001 | 2026-05-20 10:00 | 12345 (María) | Reservada |
| apt-002 | 2026-06-15 15:00 | 12345 (María) | Confirmada |

### P2.1 — Cancelar una cita propia

```bash
curl -X POST http://localhost/api/me/appointments/apt-001/cancel \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Conflicto de horario"}'
```

**Validar:**
- [ ] Status 200
- [ ] Response: `{ ok: true, appointment: { id, estado: 'Cancelada', ... } }`

### P2.2 — Intentar cancelar de nuevo (CONFLICT)

```bash
curl -i -X POST http://localhost/api/me/appointments/apt-001/cancel \
  -H "Authorization: Bearer $PATIENT_TOKEN"
```

**Validar:**
- [ ] Status 409
- [ ] Response: `{ error: 'CONFLICT', message: 'Esta cita ya está cancelada.' }`

### P2.3 — Anti-IDOR: cita de otro paciente

Obtén el token de otro paciente y intenta cancelar una cita ajena:

```bash
curl -i -X POST http://localhost/api/me/appointments/apt-001/cancel \
  -H "Authorization: Bearer $OTHER_PATIENT_TOKEN"
```

**Validar:**
- [ ] Status 404 (NO 403 — anti-enumeración)
- [ ] Response: `{ error: 'NOT_FOUND', message: 'Cita no encontrada' }`

### P2.4 — Audit log refleja la operación

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT action, result, resource_id, metadata, created_at
FROM audit_log
WHERE action = 'patient.appointment.cancel'
ORDER BY created_at DESC LIMIT 5;"
```

**Validar:**
- [ ] Hay una entry con `result='success'` y resource_id de la cita cancelada
- [ ] El intento del paciente B tiene `result='denied'` con
  `metadata.reason='not_found_or_not_owned'`

---

## P3 — Tests manuales: Pagos (con DEV_MOCK_WOMPI)

### P3.1 — Crear un pago

```bash
curl -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "treatment_id": "tx-001",
    "amount_cop": 500000,
    "description": "Abono ortodoncia"
  }'
```

**Validar:**
- [ ] Status 200
- [ ] Response contiene: `{ reference: "DK-...", url, amount_cop: 500000, status: "pending", expires_at }`
- [ ] La `url` empieza con `https://checkout.wompi.co/l/`

### P3.2 — Polling del estado

```bash
REFERENCE="<paste de P3.1>"

curl http://localhost/api/me/payments/$REFERENCE \
  -H "Authorization: Bearer $PATIENT_TOKEN"
```

**Validar:**
- [ ] Status 200
- [ ] Response: `{ reference, status: "pending", amount_cop, ... }`

### P3.3 — Anti-IDOR en consulta

```bash
curl -i http://localhost/api/me/payments/$REFERENCE \
  -H "Authorization: Bearer $OTHER_PATIENT_TOKEN"
```

**Validar:**
- [ ] Status 404

### P3.4 — Validaciones de input

```bash
# Monto negativo
curl -i -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount_cop": -100, "description": "test"}'

# Monto excesivo (>50M COP)
curl -i -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount_cop": 100000000, "description": "test"}'

# Sin descripción
curl -i -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount_cop": 50000}'
```

**Validar:** Todos retornan 400 con `error: 'BAD_REQUEST'`.

### P3.5 — Anti-IDOR en treatment_id

```bash
# Paciente A intenta pagar treatment de paciente B
curl -i -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $OTHER_PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"treatment_id":"tx-001","amount_cop":50000,"description":"IDOR"}'
```

**Validar:**
- [ ] Status 404 (treatment tx-001 pertenece al paciente A)

### P3.6 — Monto excede saldo del tratamiento

```bash
# tx-001 tiene saldo_pendiente = 1,500,000
curl -i -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"treatment_id":"tx-001","amount_cop":2000000,"description":"Sobrepago"}'
```

**Validar:**
- [ ] Status 400
- [ ] Mensaje menciona "saldo pendiente"

---

## P4 — Tests manuales: Webhook Wompi

### P4.1 — Webhook con firma válida (mock signature)

Si tu sandbox tiene un `WOMPI_EVENTS_SECRET` configurado, podemos simular un webhook
firmado correctamente:

```bash
# Crear un script para generar la firma
node -e "
const crypto = require('crypto');
const secret = process.env.WOMPI_EVENTS_SECRET;
const txId = 'wompi-tx-test-001';
const reference = 'DK-test-reference';  // usa una reference que YA exista en transactions
const amount = 50000000; // 500.000 COP en centavos
const timestamp = Math.floor(Date.now()/1000);
const props = ['transaction.id','transaction.status','transaction.amount_in_cents'];
const concat = txId + 'APPROVED' + amount + timestamp + secret;
const checksum = crypto.createHash('sha256').update(concat).digest('hex');
console.log(JSON.stringify({
  event: 'transaction.updated',
  data: { transaction: { id: txId, status: 'APPROVED', reference,
    amount_in_cents: amount, payment_method_type: 'NEQUI', created_at: new Date().toISOString() } },
  sent_at: new Date().toISOString(),
  timestamp,
  signature: { checksum, properties: props },
  environment: 'sandbox'
}));
" > /tmp/webhook.json

curl -X POST http://localhost/api/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d @/tmp/webhook.json
```

**Validar:**
- [ ] Status 200, `{ ok: true }`
- [ ] La transaction en BD pasa a `status='approved'`, `webhook_verified=true`

### P4.2 — Webhook con firma INválida

Mismo curl con checksum aleatorio:

**Validar:**
- [ ] Status 401, `{ error: 'INVALID_SIGNATURE' }`
- [ ] La transaction NO cambia de estado

### P4.3 — Webhook con timestamp viejo

```bash
# Timestamp de hace 10 minutos
TS_OLD=$(($(date +%s) - 600))
```

Modifica `timestamp` en el JSON al valor viejo y vuelve a calcular el checksum.

**Validar:**
- [ ] Status 401, `{ error: 'STALE_EVENT' }`

### P4.4 — Webhook con reference desconocida

```bash
# Cambia reference a "DK-no-existe"
```

**Validar:**
- [ ] Status 200 (NO 404 — para evitar reintentos infinitos de Wompi)
- [ ] Audit log tiene entry con `result='denied'`, `metadata.reason='unknown_reference'`

### P4.5 — Idempotencia

Envía 2 veces el mismo webhook APPROVED:

**Validar:**
- [ ] Ambos retornan 200
- [ ] El segundo no sobreescribe el `wompi_transaction_id` del primero
- [ ] La reconciliación con Dentalink no se duplica

---

## P5 — Test end-to-end con Wompi sandbox real

Este es el test más completo: requiere ngrok y dashboard de Wompi configurado.

### Pre-requisitos
1. Cuenta en https://comercios.wompi.co/ con keys de sandbox
2. ngrok corriendo: `ngrok http 80`
3. URL https del ngrok configurada en Wompi dashboard como webhook URL
4. `.env` con `DEV_MOCK_WOMPI=false` (real mode) y las keys del sandbox

### P5.1 — Pago aprobado con test card

```bash
# Crear payment
curl -X POST http://localhost/api/me/payments \
  -H "Authorization: Bearer $PATIENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount_cop":1000,"description":"Test sandbox"}' \
  | jq -r '.url' > /tmp/wompi_url.txt

# Abre la URL en el navegador (también el QR del kiosco apuntaría aquí)
cat /tmp/wompi_url.txt
```

Usa la tarjeta de prueba de Wompi:
- Número: `4242 4242 4242 4242`
- CVC: `123`
- Vencimiento: cualquier fecha futura

**Validar:**
- [ ] El pago se procesa en Wompi y aparece como APPROVED en el dashboard
- [ ] Wompi envía webhook a tu ngrok URL
- [ ] La transaction en BD pasa a `approved`
- [ ] El `dentalink_payment_id` está poblado (reconciliación OK)

### P5.2 — Pago rechazado

Tarjeta de prueba que se rechaza:
- Número: `4111 1111 1111 1111` (a veces rechazado en sandbox)

**Validar:**
- [ ] Webhook llega con `status: 'DECLINED'`
- [ ] Transaction en BD pasa a `declined`
- [ ] NO se intenta reconciliar con Dentalink

---

## P6 — Frontend (build manual)

### P6.1 — Build limpio

```bash
cd apps/kiosco-frontend
npm install
npm run build
```

**Validar:**
- [ ] Vite imprime `✓ built in XXXms` sin errores
- [ ] Bundle ≈ 58 KB JS + 15 KB CSS (gzipped ~22 KB total)
- [ ] Hay un warning sobre `fs` siendo externalizado por qrcode-svg — esto es
  esperado y no afecta el funcionamiento (qrcode-svg solo usa fs en su método
  `save()` que nunca llamamos; usamos `svg()` que es puro JS).

### P6.2 — Modal de confirmación al cancelar

En el navegador, navegando a `/?kiosk_token=...`:
1. Inicia sesión como paciente
2. Ve a Mis Citas → Próximas
3. Toca "Cancelar" en una cita

**Validar:**
- [ ] Aparece modal "¿Cancelar esta cita?" con dos botones
- [ ] Botón "No, mantener cita" cierra el modal sin hacer nada
- [ ] Botón "Sí, cancelar" (rojo/danger) ejecuta la cancelación
- [ ] Aparece modal "⏳ Cancelando cita…" mientras procesa
- [ ] Al éxito: modal "✅ Cita cancelada" y la lista se refresca
- [ ] Al error 409: modal "Esta cita ya no se puede cancelar"

### P6.3 — Flujo de pago

1. Ve a Mis Tratamientos
2. Tocar botón "💳 Pagar $X" de un tratamiento con saldo

**Validar:**
- [ ] Navega a la pantalla `payment` con QR
- [ ] El QR aparece en blanco/negro, escaneable
- [ ] Muestra el monto destacado
- [ ] Indicador "Esperando pago..." con dot animado
- [ ] Countdown del tiempo de expiración
- [ ] Botón "Cancelar y volver" sigue accesible
- [ ] (Con DEV_MOCK_WOMPI=true): el QR apunta a una URL mock pero el polling funciona
- [ ] (Con Wompi real): escanear con el celular abre el checkout de Wompi

### P6.4 — Polling actualiza el estado

Mientras la pantalla del QR está visible, manualmente cambia el estado de la
transaction:

```bash
docker compose exec postgres psql -U dentalkiosco -c "
UPDATE transactions SET status='approved', approved_at=now()
WHERE wompi_reference='<paste>';"
```

**Validar:**
- [ ] Dentro de 3-5 segundos el kiosco detecta el cambio
- [ ] Aparece modal "✅ ¡Pago recibido!"
- [ ] Al tocar "Entendido", vuelve a home

---

## P7 — Validaciones de seguridad

### P7.1 — Firma SHA256 plana (no HMAC)

```bash
grep -A2 "createHash('sha256')" apps/api/src/lib/wompi.ts
```

**Validar:**
- [ ] Usa `createHash('sha256')`, NO `createHmac`
- [ ] La concatenación es: valores + timestamp + secret

### P7.2 — Timing-safe compare

```bash
grep -A4 "function timingSafeEqual" apps/api/src/lib/wompi.ts
```

**Validar:**
- [ ] No usa `a === b` directo
- [ ] XOR acumulativo en tiempo constante

### P7.3 — Anti-replay 5 minutos

```bash
grep -B1 -A3 "fiveMinutesMs" apps/api/src/lib/wompi.ts
```

**Validar:**
- [ ] Webhooks con timestamp > 5min de antigüedad son rechazados
- [ ] También rechaza timestamps del futuro > 5min (clock skew)

### P7.4 — Anti-IDOR en cancel y payments

```bash
grep -B1 "Anti-IDOR" apps/api/src/routes/patient-me.ts apps/api/src/routes/payments.ts | head -20
```

**Validar:**
- [ ] Cancel verifica que la cita pertenezca al paciente del JWT (no del path)
- [ ] Create payment verifica que el treatment_id (si se pasa) sea del paciente
- [ ] Get payment status filtra por `dentalink_patient_id` del JWT en SQL

### P7.5 — patient_email_masked y patient_phone_masked

```bash
docker compose exec postgres psql -U dentalkiosco -c "
SELECT patient_phone_masked, patient_email_masked
FROM transactions
ORDER BY created_at DESC LIMIT 3;"
```

**Validar:**
- [ ] El phone tiene formato `+57***34` (3 primeros + 2 últimos)
- [ ] El email tiene formato `ma***@dominio.com`
- [ ] NO hay datos completos en claro

### P7.6 — PCI: no se capturan datos de tarjeta

```bash
grep -i "card_number\|cvv\|tarjeta" apps/api/src/routes/payments.ts apps/kiosco-frontend/src/screens/payment.js
```

**Validar:**
- [ ] No hay capturas de datos de tarjeta
- [ ] El paciente paga en su celular vía QR → Wompi maneja PCI compliance

---

## Resumen aceptación

**Criterio mínimo:**

- [ ] P1.1 — Los 34 tests del Hito 7 pasan
- [ ] P1.2 — Los 103 tests totales pasan
- [ ] P2.1, P2.2, P2.3 — Cancelación funciona con happy path + conflict + anti-IDOR
- [ ] P3.1, P3.5 — Crear pago + anti-IDOR
- [ ] P4.1, P4.2, P4.3 — Webhooks: firma válida ✅, inválida ❌, vieja ❌
- [ ] P6.1 — Build limpio del frontend
- [ ] P6.2 — Modal de cancelación con doble paso
- [ ] P6.3 — Pantalla de pago con QR funciona
- [ ] P7 — Validaciones de seguridad (anti-IDOR, anti-replay, timing-safe, PCI)

**Conociendo limitaciones del Hito 7 (intencionales):**

- **Reagendar** sigue siendo informativo (Hito 8 con selector de disponibilidad)
- **Reconciliador periódico** existe en el código pero no hay job cron aún
  (Hito 9 lo arranca como worker dedicado)
- **Wompi link expiration** está en 30 min — si el paciente excede ese tiempo,
  debe iniciar un pago nuevo
