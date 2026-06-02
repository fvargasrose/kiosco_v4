# Auditoría — Notificaciones de pago + Rediseño pestaña pagos

Rama: `pagos` · Fecha: 2026-06-02 · Modo: auditoría (sin implementar).
Método: lectura del código real, no suposiciones.

---

## 1. Resumen ejecutivo

| Tarea | Estado | Una línea |
|-------|--------|-----------|
| **#1 Email al admin en pago aprobado** | ✅ **Ya implementado y commiteado** | Backend (notifications.ts + migración 015 + admin-clinic.ts) y frontend (clinic-config.js) completos; solo detalles menores de formato. |
| **#2 Rediseño pestaña pagos (estado de cuenta)** | ✅ **Ya implementado y commiteado** (8e9a0e7) | treatments.js + CSS con paleta del diseño; saldo fluye bien desde Dentalink. Riesgo: colisión de clase `.treatment-card`. |
| **#3 Script de prueba Wompi en Node/JS** | ❌ **No existe** (solo el Python `docs/wompi_qr_pago.py`) | Falta portar la lógica a Node reusando las vars `WOMPI_*` que ya están en `.env`. |

**Conclusión:** Las tareas #1 y #2 están hechas; esta auditoría es de verificación
y encuentra solo brechas menores. La #3 sí requiere trabajo nuevo.

Restricciones respetadas en lo existente:
- `payments.ts` NO modificado (último commit Hito 8, anterior a esta feature). ✅
- `payment.js` NO modificado (último commit Hito 7; el rediseño no lo tocó). ✅
- Idempotencia de `receipt_sent_at` preservada (ver Riesgos). ✅ (con 1 caveat)

---

## 2. Tabla de criterios

### Tarea #1 — Email al administrador

| Criterio | Estado | Evidencia |
|----------|--------|-----------|
| Migración agrega columna + INSERT en schema_migrations | ✅ | `migrations/015_notification_email.sql` (CITEXT, no TEXT — ver nota) + INSERT '015' |
| admin-clinic expone `notification_email` GET y PUT con validación | ✅ | GET `admin-clinic.ts:196`; PUT `:215,:230`; validación `z.string().email().max(254)` `:100` |
| sendPaymentReceipt lee `clinic.notification_email` tras envío al paciente | ✅ | `notifications.ts:272-286` llama `sendAdminPaymentNotification`; lee email en `:316-319` |
| Envío al admin en try/catch INDEPENDIENTE, falla silenciosa con logger.error | ✅ | `notifications.ts:272-286` (try/catch propio + `logger.error`) |
| No rompe idempotencia (`receipt_sent_at`) | ✅ | `receipt_sent_at` se persiste en `:244-254` ANTES del bloque admin (`:272`) |
| Si `notification_email` es null → no se intenta envío, sin error | ✅ | `notifications.ts:320` `if (!adminEmail) return;` |
| Template HTML inline; asunto "Comprobante de pago — [Clínica] — $[monto]" | ✅ | Asunto `:345`; HTML inline `renderAdminNotificationHtml` `:399-461` |
| Datos: paciente (email enmascarado), pago (ref, monto, método, fecha), tratamiento (nombre, saldo antes/después) | ⚠️ | Todo presente `:345-375`; máscara `ju***@dominio` (2 chars), NO `juan****@` del ejemplo — `logger.ts:110-116` |
| clinic-config.js input "Email para notificaciones de pago" con validación | ✅ | `clinic-config.js:173-175` input; validación regex `:300-301`; envío `:310` |
| payments.ts NO modificado | ✅ | `git log` payments.ts → último Hito 8 (previo a la feature) |

**Tests:** `tests/notifications.test.ts` referencia `notification_email`. ⚠️ No hay
cobertura del GET/PUT de `notification_email` en `admin-clinic.test.ts`.

### Tarea #2 — Rediseño pestaña pagos

| Criterio | Estado | Evidencia |
|----------|--------|-----------|
| Paleta del diseño (#003c96, #001d5c) y estructura de tarjeta | ✅ | `styles.css:1954` gradiente `#003c96,#001d5c`; coincide con `docs/pestaña_pagos.html:32` |
| Header tarjeta azul con nombre + avatar | ✅ | `treatments.js:99-117` (`account-header`, `account-avatar`, inicial) |
| Tarjeta por tratamiento con saldo>0: nombre, total, abonado, saldo, barra, "Pagar ahora" | ✅ | `treatments.js:164-210` (`activeTreatmentCardHtml`) |
| Tratamientos con saldo===0: tarjeta gris con ✓ | ✅ | `treatments.js:212-226` (`paidTreatmentCardHtml`, `treatment-card--paid`, ✓) |
| Con saldo PRIMERO, finalizados al final | ✅ | `treatments.js:67-68` filtra; `:153-160` ordena pending→paid |
| Estado vacío amable sin error JS | ✅ | `treatments.js:142-149` (`empty-state`) |
| Botón "Pagar" navega a payment con treatmentId, amountCop, description | ✅ | `treatments.js:85-90` (pasa esos 3 + `returnTo`) |
| payment.js NO modificado | ✅ | `git log` payment.js → último Hito 7 |
| Clases `.treatment-card`, `.treatment-progress-bar`, `.treatment-card--paid` | ✅ | `styles.css:2104`, `:2200`, `:2227` |
| Saldo correcto desde Dentalink | ✅ | `dentalink.ts:650` mapea `deuda→saldo_pendiente`; `patient-me.ts:181-204` totales; `treatments.js:60-61` consume |

---

## 3. Brechas detectadas

1. **(Menor) Máscara de email del paciente** — el ejemplo pedía `juan****@gmail.com`
   (4 chars + `****`). `maskEmail` (`logger.ts:110-116`) produce `ju***@gmail.com`
   (2 chars + `***`). Difiere del ejemplo, pero cumple la intención de enmascarar.
   Cambiarlo afectaría TODOS los logs/usos de `maskEmail` (decisión transversal).
2. **(Menor) Tipo de columna** — la migración usa `CITEXT` en vez de `TEXT`.
   Es mejor para emails (case-insensitive); solo difiere de la letra del criterio.
3. **(Menor) Sin tests del endpoint** — `notification_email` no está cubierto en
   `admin-clinic.test.ts` (GET/PUT). Sí hay `notifications.test.ts`.
4. **(Tarea #3) No existe equivalente Node** del script Python — hay que crearlo.

---

## 4. Riesgos

1. **Idempotencia `receipt_sent_at` (BAJO, con 1 caveat).**
   - Flujo normal: si el paciente recibió (email o sms), `receipt_sent_at` se setea
     (`notifications.ts:244-254`) y un reintento sale temprano en `:148-150` →
     el admin NO recibe duplicados. ✅
   - **Caveat:** si el paciente NO tiene email ni celular, ambos envíos se omiten,
     `receipt_sent_at` queda NULL, pero el bloque admin (`:272`) igual se ejecuta.
     En un reintento del webhook, al seguir NULL, **el admin podría recibir el email
     dos veces**. Caso borde (paciente sin contacto + admin configurado). No rompe
     idempotencia del paciente, pero conviene anotarlo.
2. **Colisión CSS `.treatment-card` (MEDIO).** Hay DOS definiciones: `styles.css:1378`
   (selección de tratamiento en *booking*, usa `-duration`/`-desc`) y `:2104` (estado
   de cuenta, usa `-head`/`-period`/`-badge`). Comparten el selector base; la segunda
   gana en cascada. Riesgo de afectar visualmente la pantalla de booking. Verificar
   que el rediseño no degradó la tarjeta de selección de tratamiento.
3. **`payments.ts` / webhook Wompi:** intacto. El nuevo código vive solo en
   `notifications.ts`, invocado desde donde ya se llamaba `sendPaymentReceipt`. ✅
4. **`payment.js` (Wompi/QR/navegación):** intacto. El contrato de navegación
   (treatmentId, amountCop, description, returnTo) lo respeta `treatments.js`. ✅

---

## 5. Plan de implementación propuesto

Dado que #1 y #2 ya están hechas, el plan es de **cierre/refinamiento**, no de
construcción. Cada punto es OPCIONAL y se hará solo si lo autorizas.

### Bloque A — Verificación (sin tocar código)
1. `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status`
   → confirmar 015 aplicada.
2. `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck`
3. `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test notifications`
4. `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test payments`
   → confirmar que NADA cambió en el webhook.
5. `pnpm --filter @dentalkiosco/admin-frontend build`
6. `pnpm --filter @dentalkiosco/kiosco-frontend build`

### Bloque B — Refinamientos menores (solo si los apruebas)
- **B1 (Riesgo 1 caveat):** en `notifications.ts`, mover/guardar el envío al admin
  bajo su propia marca de idempotencia (p.ej. setear `receipt_sent_at` o un flag
  aunque el paciente no tenga contacto) para evitar duplicados al admin.
  Archivo: `apps/api/src/lib/notifications.ts`. NO tocar `payments.ts`.
- **B2 (Riesgo 2):** renombrar las clases del estado de cuenta o aislar la colisión
  `.treatment-card` (p.ej. prefijar con `.account-screen .treatment-card`).
  Archivo: `apps/kiosco-frontend/src/styles.css` (+ `treatments.js` si cambian clases).
- **B3 (Brecha 1):** si quieres exactamente `juan****@`, NO tocar `maskEmail` global;
  crear un helper local de máscara en `notifications.ts` solo para el email del
  admin. Evita efectos colaterales en logs.
- **B4 (Brecha 3):** agregar tests de `notification_email` en `admin-clinic.test.ts`
  (GET devuelve el campo; PUT valida email inválido → 400; PUT null → ok).

### Qué NO se debe modificar (inviolable)
- `apps/api/src/routes/payments.ts` ni la lógica del webhook Wompi.
- `apps/kiosco-frontend/src/screens/payment.js` (Wompi/QR/navegación).
- Migraciones 001-015 ya aplicadas (cualquier ajuste sería migración 016+).
- `apps/api/src/lib/reconciler.ts`, `license/*`.

---

## 6. Plan del script Wompi en Node/JS (Tarea #3)

### Lógica del Python que YA funciona (`docs/wompi_qr_pago.py`)
- `create_payment_link()` (`:78-92`): POST `{BASE_URL}/payment_links` con `Bearer prv_`,
  body `{name, description, single_use, collect_shipping, currency:COP, amount_in_cents}`.
- QR: `show_qr_terminal` ASCII (`:143`) + `save_qr_png` (`:152`).
- `poll_link()` (`:178-235`): loop cada `POLL_INTERVAL` hasta `POLL_TIMEOUT`; en cada
  vuelta GET del link, `extract_transactions()` con fallbacks
  (`transactions` → `payment_transactions` → `meta.transactions`, `:121-137`); por cada
  tx sin status hace GET `/transactions/{id}` con `Bearer pub_`; reporta cambios de
  estado; corta en `FINAL_STATES = {APPROVED, DECLINED, VOIDED, ERROR}`.
- `--check <TX_ID>` (`:238-249`): consulta puntual de una transacción.
- Manejo de errores que NO tumba el loop: cada GET en try/except devuelve `{}`
  (`:95-118`) y el `while` atrapa excepciones y reintenta (`:226-229`).

### ¿Existe equivalente en Node? — NO
- Solo está `apps/api/src/lib/wompi.ts` (lib de PRODUCCIÓN): ya tiene
  `createPaymentLink` (POST `/payment_links`, `:251`) y consulta de transacción
  (GET `/transactions/:id`, `:293`). **No se debe reusar para una prueba** (es la
  ruta productiva). El test debe ser independiente.

### Credenciales del `.env` a REUSAR (ya existen, no inventar)
El `.env` del proyecto ya trae exactamente las vars del script Python:
`WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_BASE_URL`, `WOMPI_CHECKOUT_BASE`,
`WOMPI_AMOUNT_IN_CENTS`, `WOMPI_POLL_INTERVAL`, `WOMPI_POLL_TIMEOUT`, `WOMPI_QR_PATH`.
(Ojo: `config.ts` usa `WOMPI_API_URL`/`WOMPI_ENVIRONMENT` para producción; el script
de prueba debe leer `WOMPI_BASE_URL` directo de `process.env`, NO pasar por `config.ts`.)

### Propuesta concreta
- **Ubicación:** `apps/api/scripts/wompi-qr-pago.mjs` (script standalone, ESM,
  ejecutable con `node` o `tsx`, fuera de `src/` para no entrar al build).
- **Deps:** `qrcode` para PNG/terminal. (`qrcode-svg` ya está en el árbol; si no se
  quiere dep nueva, generar solo la URL + QR SVG. A confirmar.) Sin deps de red extra:
  usar `fetch` nativo de Node 22.
- **Qué se porta:** create_payment_link, extract_transactions (con sus 3 fallbacks),
  poll loop con FINAL_STATES, modo `--check <TX_ID>`, errores que no tumban el loop.
- **Qué NO toca:** `wompi.ts`, `payments.ts`, el webhook ni la BD. Es 100% aislado.
- **Uso previsto:**
  `node apps/api/scripts/wompi-qr-pago.mjs` (crea link + QR + polling)
  `node apps/api/scripts/wompi-qr-pago.mjs --check <TX_ID>` (consulta puntual)

---

## 7. Decisiones que necesito de ti

1. ¿Implemento algún refinamiento del Bloque B (B1 idempotencia admin, B2 colisión
   CSS, B3 máscara, B4 tests) o lo dejo como está (ya funciona)?
2. Tarea #3: ¿creo el script Node en `apps/api/scripts/wompi-qr-pago.mjs`?
   ¿Acepto la dependencia `qrcode` o lo hago sin dep nueva?
3. ¿Corro primero el Bloque A de verificación para confirmar el estado en verde?

---

## 8. Prueba flujo correos (sandbox)

Objetivo: que un pago de prueba en **Wompi SANDBOX** dispare la cadena completa
—"pago recibido" + correo al paciente + correo a la clínica— originando el pago
**desde el kiosco** (única vía que crea la fila en `transactions` de la que
cuelgan los correos). El script standalone de $5.000 NO se usa (bypassa el backend).

Estado: PLAN. No se toca `.env` ni se levanta el túnel hasta OK del usuario.
NO se modifica `payments.ts`.

### Por qué sandbox y no el script
- El backend aprende del `APPROVED` por **webhook entrante** `POST /webhooks/wompi`
  (`payments.ts:308`), y SOLO ahí se disparan los correos (`payments.ts:465`).
- El reconciler consulta Wompi (saliente) pero **no** envía correos.
- El pago debe nacer en `POST /me/payments` (kiosco) para tener fila en `transactions`.

### Prerequisitos para que salgan AMBOS correos (revisar antes)
1. **Email del paciente**: el paciente de Dentalink debe tener email → recibo
   paciente vía Resend (real). (`notifications.ts:191`). Dentalink es real
   (`DEV_MOCK_EXTERNAL_SERVICES=false`); SMS está mockeado (no es bloqueante).
2. **`notification_email` configurado** en el panel admin (Configuración de
   clínica) → sin él, el correo a la clínica NO se intenta (`notifications.ts:320`).
3. Postgres + Redis arriba (ya están).

### 1. Config `.env` para SANDBOX (valores exactos; los secretos los pones tú)
Cuatro cambios. Tras editar, **reiniciar el backend** (tsx no recarga `.env`).

| Variable | Valor | De dónde sale (panel sandbox.wompi.co) |
|----------|-------|----------------------------------------|
| `DEV_MOCK_WOMPI` | `false` | — (que hable con Wompi real-sandbox) |
| `WOMPI_API_URL` | `https://sandbox.wompi.co/v1` | URL fija de sandbox |
| `WOMPI_PUBLIC_KEY` | `pub_test_…` | Desarrolladores → Llaves → Llave pública |
| `WOMPI_PRIVATE_KEY` | `prv_test_…` | Desarrolladores → Llaves → Llave privada |
| `WOMPI_EVENTS_SECRET` | `(secreto)` | Desarrolladores → Eventos → "Secreto de eventos" (descomentar la línea 57) |

Notas:
- `WOMPI_API_URL` hoy NO está en `.env` → cae al default sandbox de `config.ts:75`,
  pero conviene ponerla explícita para que quede claro.
- `WOMPI_BASE_URL` (usado solo por el viejo script) NO afecta al backend; se puede ignorar.
- `WOMPI_INTEGRITY_SECRET` NO es necesario (es para el Widget; el webhook usa el
  secreto de Eventos). Dejar comentado.
- `isMockMode()` apaga el mock solo si `DEV_MOCK_WOMPI=false` Y hay `WOMPI_PRIVATE_KEY`
  (`wompi.ts:108-110`). Con las llaves `prv_test_` queda OK.

### 2. Túnel para exponer el webhook
- Herramientas: **cloudflared 2025.11.1 y ngrok 3.34.1 ya están instalados**.
  Recomendado cloudflared (túnel rápido, sin cuenta):
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
  Imprime una URL `https://<algo>.trycloudflare.com`.
- Ruta exacta del webhook: **`/webhooks/wompi`** (registrado sin prefijo,
  `server.ts:139`). Registrar en el panel:
  Desarrolladores → Eventos → **URL de eventos** =
  `https://<algo>.trycloudflare.com/webhooks/wompi`
- Anti-replay de 5 min en la firma (`wompi.ts:326-329`): el reloj de la máquina
  debe estar en hora.

### 3. Backend con log a archivo (pino → stdout, solo redirección)
```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev > backend-prueba.log 2>&1
```
(Arrancar DESPUÉS de editar `.env`. `backend-prueba.log` lo cubre `*.log` del .gitignore.)

### 4. Originar el pago en sandbox (desde el kiosco)
1. Kiosco (`:5173` con `?kiosk_token=…`) y admin (`:5174`) arriba.
2. Login del paciente: cédula real de Dentalink + OTP (`OTP_REQUIRED=true`;
   con `DEV_LOG_OTP=true` el OTP sale en `backend-prueba.log`).
3. Estado de cuenta → tratamiento con saldo → **Pagar** → se genera el QR del
   link **sandbox** ligado a una fila `transactions`.
4. **Paciente/saldo**: el paciente es de **Dentalink real** (no hay "paciente
   sandbox" de Wompi; Wompi sandbox solo cubre el pago con tarjeta de prueba).
   Hace falta una cédula con un tratamiento con saldo pendiente. El kiosco paga
   el saldo del tratamiento; para un monto chico, usar un tratamiento de saldo bajo.
5. **Tarjetas de prueba Wompi sandbox** (confirmar en panel → Pruebas, por si cambian):
   - APROBADA: `4242 4242 4242 4242`
   - DECLINADA: `4111 1111 1111 1111`
   - CVV: cualquiera de 3 dígitos · Vencimiento: cualquiera futuro · Cuotas: 1
   - Si pide 3DS/OTP en sandbox: cualquier valor.

### 5. Punto de espera y verificación
Tras entregar instrucciones, DETENERSE. NO leer logs hasta que el usuario diga
"listo/ya pagué". Entonces leer `backend-prueba.log` y validar eslabón por eslabón
(✅/❌ con archivo:línea + línea del log):
- Pago detectado → `"Webhook Wompi procesado"` (`payments.ts:449`)
- Recibo paciente → `"Payment receipt email sent"` (`notifications.ts:217`)
- Correo clínica → `"Admin payment notification sent"` (`notifications.ts:378`)
- Errores si los hay → `"firma inválida"` (`payments.ts:325`),
  `"reference desconocida"` (`payments.ts:380`),
  `"Envío de comprobante falló"` (`payments.ts:466`).

### 6. Camino a PRODUCCIÓN (solo documentado, no ejecutar)
Para correr esta MISMA prueba con pago real, cambian en `.env`:
| Variable | Sandbox | Producción |
|----------|---------|------------|
| `WOMPI_API_URL` | `https://sandbox.wompi.co/v1` | `https://production.wompi.co/v1` |
| `WOMPI_PUBLIC_KEY` | `pub_test_…` | `pub_prod_…` |
| `WOMPI_PRIVATE_KEY` | `prv_test_…` | `prv_prod_…` |
| `WOMPI_EVENTS_SECRET` | secreto de eventos sandbox | secreto de eventos **producción** |
| `DEV_MOCK_WOMPI` | `false` | `false` |

Y el **túnel se reemplaza por el dominio público** del servidor: la URL de
eventos en el panel de producción pasa a `https://<dominio>/webhooks/wompi`
(Caddy ya enruta; en prod el front va bajo `/api` pero el webhook es público y
directo). El resto del flujo (kiosco → `POST /me/payments` → webhook → 2 correos)
es idéntico. Recordar: en producción el cobro es REAL.

---

## 9. HALLAZGO CRÍTICO — el webhook de payment-link no casa con la transacción

Detectado en la prueba sandbox del flujo de correos (2026-06-02). **Afectaría
producción**: con payment links, el recibo al paciente y el correo a la clínica
**nunca se envían**.

### Síntoma
Pago sandbox aprobado real, pero 0 correos. La transacción quedó `pending` para
siempre.

### Causa raíz
- Creamos el link pasando nuestra referencia como `sku` (`wompi.ts:236-239`) y
  guardamos `transactions.wompi_reference = DK-…`, `wompi_payment_link_id = test_TrazgW`.
- Wompi **genera su propia `reference`** para la transacción del payment link:
  patrón `<link_id>_<timestamp>_<random>` (ej. observado:
  `test_TrazgW_1780439968_21oOytyGd`). **No** devuelve nuestro `sku`.
- El handler busca `WHERE wompi_reference = <reference del webhook>`
  (`payments.ts:361-375`) → no hay match → `"Webhook con reference desconocida"`
  (`payments.ts:380`) → responde 200 y **no procesa ni envía correos**.
- El reconciler tampoco rescata: `pollStalePending` usa `wompi_transaction_id`,
  que solo lo setea el webhook que nunca casó.

### Evidencia (prueba sandbox)
- `backend-prueba.log`: `POST /webhooks/wompi` desde IP de Wompi → 200; firma OK
  (no hubo "firma inválida"); `"Webhook con reference desconocida"` con
  `reference: test_TrazgW_1780439968_21oOytyGd`.
- BD: fila `wompi_reference=DK-mpx7xpv9-6d13a0`, `wompi_payment_link_id=test_TrazgW`,
  `status=pending`, `webhook_received_at=NULL`.
- Lo que SÍ funcionó: túnel, entrega del webhook y verificación de firma
  (`WOMPI_EVENTS_SECRET`).

### Por qué los tests no lo detectaban
`payments.test.ts` construía el webhook con la referencia **ya coincidente** con
la fila, por lo que el match siempre acertaba. Además, los tests de webhook se
**saltaban** silenciosamente porque `WOMPI_EVENTS_SECRET` no estaba en el entorno
de test (`if (!secret) return`). Se corrigieron ambas cosas (ver abajo).

### Dato confirmado del payload (DEBUG temporal, ya retirado)
El webhook de un payment link SÍ trae el campo:
`data.transaction.payment_link_id` (ej. `test_HfORDQ`) == `transactions.wompi_payment_link_id`,
mientras que `data.transaction.reference` es la auto-generada
(`test_HfORDQ_1780441258_GPAChNMZg`). → Se eligió **Opción A**.

### Fix APLICADO (2026-06-02)
- **`payments.ts` (lookup):** casar por `wompi_payment_link_id` (preferente, vía
  `ORDER BY CASE`) con **fallback** a `wompi_reference` (pagos no-link / compat).
- **`payments.ts` (UPDATE):** actualizar por `id` de la fila encontrada
  (`WHERE id = $7`, `txRow.id`) en vez de `WHERE wompi_reference = tx.reference`
  (que tampoco casaba). Este era un segundo punto del bug.
- **`payments.ts` (llamadas posteriores — Punto 6, mismo bug propagado):** tras
  procesar el webhook, `reconcileWithDentalink(...)` y `sendPaymentReceipt(...)`
  recibían `tx.reference` (la autogenerada del webhook). `sendPaymentReceipt`
  busca por `wompi_reference` → "transaction not found" → **sin correos**, aunque
  el `status` ya quedaba `approved`. Fix: añadir `wompi_reference` al `SELECT
  existing` y pasar `txRow.wompi_reference` (la nuestra) a ambas llamadas.
  Detectado en la revalidación sandbox v3 (webhook procesado ✓ pero correo ✗).
- **`wompi.ts` (tipo):** se añadió `payment_link_id?: string` a la interfaz del
  webhook (type-only, sin cast).
- **`payments.test.ts` (regresión):** nuevo test que usa el patrón real
  (`<link_id>_<ts>_<rand>` ≠ `wompi_reference` + `payment_link_id` presente).
  Asserta `status='approved'`, `webhook_verified` y **`receipt_sent_at`** (este
  último cubre el Punto 6). Falla con el código viejo y pasa con el fix.
- **`vitest.config.ts`:** se añadió `WOMPI_EVENTS_SECRET` de test para que los
  webhook tests realmente se ejecuten (antes se saltaban).
- Se retiró el log `[TEMP-DEBUG]` temporal de `payments.ts`.

Verificación: `typecheck` OK · suite payments 35/35 · suite completa 242/242.

---

## 10. ESTADO ACTUAL / DÓNDE QUEDAMOS (cierre 2026-06-02)

### 1. Qué se logró
Prueba **end-to-end en sandbox** del flujo de pago → webhook → correos, con el
fix de referencia aplicado:
- Pago $5.000 (sandbox, tarjeta 4242) → webhook entrante por túnel cloudflared.
- **`Webhook Wompi procesado`** ✓ (casó por `payment_link_id`).
- **Recibo al paciente: ENVIADO y CONFIRMADO** → `fabiavargas@gmail.com`
  (`Payment receipt email sent`; `receipt_sent_at` seteado; `channels=email,sms`).
- ⚠️ **Correo a la clínica (`notificaciones@2ways.us`): NO confirmado.** El log
  **no registra** `Admin payment notification sent` ni un `Email sent via SMTP`
  a `no***@2ways.us`. `sendAdminPaymentNotification` quedó **colgada en el envío
  SMTP** (sin throw, sin timeout). **Causa probable:** auto-envío `from == to`
  (el `SENDER_EMAIL` y el `notification_email` son ambos `notificaciones@2ways.us`;
  `mail.2ways.us` parece colgarse con el correo a sí mismo). El recibo al paciente
  (dominio gmail) sí salió. → **Issue abierto** (ver §10.3).

### 2. Bugs encontrados y corregidos (bug de referencia, 2 puntos)
Commit del fix: **`8fd4264`** en rama `pagos`
(`fix(payments): casar webhook de payment-link por payment_link_id`).
- **Matching del webhook:** ahora por `wompi_payment_link_id` (Wompi genera su
  propia `reference` en payment links) con fallback a `wompi_reference`; UPDATE
  por `id` de la fila.
- **`reconcile` + `sendPaymentReceipt`:** usaban `tx.reference` (la del webhook)
  en vez de `txRow.wompi_reference` (la nuestra) → el recibo no encontraba la
  transacción. Corregido.
- **Tests de regresión:** caso con patrón real (`reference != wompi_reference`,
  `payment_link_id` presente) que asserta `status='approved'` + **`receipt_sent_at`**.
  `vitest.config` ahora define `WOMPI_EVENTS_SECRET` (los webhook tests ya no se
  saltan). Suite: payments 35/35, completa 242/242.
- Estado: **corregido y commiteado** (`8fd4264`).

### 3. Lo que falta / próximos pasos (próxima sesión)
- **Issue abierto — correo a la clínica colgado (from == to).** Decidir: usar un
  `notification_email` distinto del `SENDER_EMAIL` (ej. `recepcion@2ways.us`), o
  dar **timeout** al envío del admin para que no quede colgado, o revisar el
  servidor SMTP con auto-envío. Revalidar.
- **Integrar la rama `pagos` a `main`:** decisión pendiente — PR o merge directo.
- **Revertir `.env` de sandbox a producción** (ver `DEPLOY_PRODUCCION.md`):
  llaves `test_`→`prod_`, `WOMPI_API_URL`/`WOMPI_BASE_URL` a `production.wompi.co`,
  `WOMPI_EVENTS_SECRET` de producción, y **registrar la URL de Eventos de
  producción** (`https://<dominio>/webhooks/wompi`), no el túnel cloudflared.
- **Cerrar el túnel cloudflared y el backend de prueba** que siguen arriba.

### 4. Estado del `.env` y del entorno
- **`.env` quedó en SANDBOX** (`DEV_MOCK_WOMPI=false`, llaves `*_test_`,
  `WOMPI_EVENTS_SECRET` sandbox descomentado). **No commiteado** (gitignored).
- **Procesos vivos** que conviene cerrar al terminar:
  - Backend de prueba (`pnpm --filter @dentalkiosco/api dev`, escribe a
    `backend-prueba.log`).
  - Túnel `cloudflared tunnel --url http://localhost:3000`
    (URL efímera `*.trycloudflare.com`, ya registrada en el panel sandbox).
  - Frontends kiosco (5173) y admin (5174), si no se usan.
- **Para volver a desarrollo normal:** revertir `.env` (sandbox→dev/mock según
  corresponda: típicamente `DEV_MOCK_WOMPI=true` y re-comentar el secreto), o a
  producción si toca deploy (ver `DEPLOY_PRODUCCION.md`). Reiniciar el backend
  tras cualquier cambio de `.env` (tsx no recarga `.env`).
- Artefactos ignorados por git: `.env`, `backend-prueba.log`, `wompi-prueba.log`,
  `wompi_qr.png`.
