# Estado — Pagos Wompi + diagnóstico del QR (sesión 2026-06-13)

> Handoff para retomar. Resume qué quedó funcionando, qué falta y la pista
> abierta del QR. Producción (Hetzner) sigue normal: **el pago por botón funciona**.

---

## ✅ Lo que quedó FUNCIONANDO y desplegado en producción

Rama de prod: **`para_produccion`** = `main` = commit **`f627af3`** (pusheado a GitHub).
Hetzner (`5.78.110.152`, `https://sistema.2ways.us`) corre `para_produccion`, API healthy,
sirviendo el bundle `index-CzZuuWDw.js`.

Bugs corregidos esta sesión (todos en archivos NO protegidos):

1. **No aparecía el valor a pagar** (`dentalink.ts` `getPatientTreatments`): mapeaba
   `saldo_pendiente = deuda` (=0 en tratamientos no realizados). Fix:
   `saldo_pendiente = max(0, total − abonado)`. → Ahora el kiosco muestra el saldo y el botón Pagar.
   Commit `61c53d9`.

2. **404 "Tratamiento no encontrado" al pagar** (`dentalink.ts`): `id_paciente` salía como
   número y `payments.ts` lo compara con `=== patient.sub` (string del JWT). Fix:
   `String(t.id_paciente)`. Commit `c768ac1`.

3. **La pantalla no se actualizaba tras pagar / no llegaba nuestro comprobante**: el
   **webhook de Wompi no estaba configurado** en el panel. El usuario configuró la URL de
   eventos → `https://sistema.2ways.us/webhooks/wompi`. Ahora el webhook llega (verificado:
   hay transacciones `approved`/`declined` en BD) y la pantalla pasa a "¡Pago recibido!".

4. **Aviso de 4 horas**: como Dentalink NO tiene API de abonos (todos los `/abonos` → 404),
   el saldo no baja solo; lo concilia el staff en la web de Dentalink. El modal "¡Pago
   recibido!" avisa que el saldo puede tardar ~4 h en actualizarse. Sin ajuste local del
   monto (evita doble conteo). Commit `105e6a3`. Variantes `payment.apple.js` y `payment.js`.

5. **QR más escaneable** (commit `f627af3`): la variante apple generaba el QR con
   `padding:2` (la norma QR pide 4), `220px` y `join:true`. Se cambió a `padding:4`, `280px`,
   sin `join`. **Resultado: ahora el QR SÍ se escanea** (el celular ya llega a Wompi).
   ⚠️ El **botón "Pagar ahora" NO se tocó** (es un `<a href>`); debe seguir intacto.

**Pago por BOTÓN: funciona de punta a punta** (link → pago → webhook → comprobante paciente +
reporte clínica). Confirmado por el usuario.

---

## 🔶 PENDIENTE / pista abierta: el QR escanea pero el link "no carga" en el teléfono

Síntoma actual: al escanear el QR (o abrir el link directo en el teléfono), Wompi muestra
mensajes como **"este código dejó de funcionar"** o **"no se puede cargar info de pago"**,
aunque el botón (mismo link, abierto en el navegador del kiosco) sí funciona.

### Hechos verificados (no re-deducir)
- El QR **codifica la URL correcta** (decodificado con OpenCV → match exacto con la del botón).
- El QR **ya es escaneable** tras el fix #5 (el teléfono llega a Wompi).
- Botón y QR usan **exactamente la misma URL** (`https://checkout.wompi.co/l/{id}`).
- Los links de Wompi son **`single_use`** (un solo uso) y **expiran en 30 min**
  (`PAYMENT_LINK_TTL_MINUTES` en `apps/api/src/lib/wompi.ts`). Un link ya usado/expirado da
  "dejó de funcionar".
- **Un link que la API de Wompi reporta `active:true` y sin expirar (`tyOkSE`) igual dio "no
  se puede cargar info de pago" en el teléfono del usuario** — pero el botón abre el mismo
  tipo de link en el kiosco y sí carga. → Apunta a que el problema es **cómo/ dónde abre el
  teléfono** el link, no el QR ni el link en sí.

### Hipótesis principal (a confirmar al retomar)
El lector de QR del teléfono abre el enlace en un **navegador interno limitado** (in-app
webview de la cámara / Facebook / etc.) donde el checkout de Wompi no carga bien. En el
navegador normal (Chrome/Safari) o en escritorio (botón) sí carga.

### Prueba que quedó pendiente de respuesta
Se le pidió al usuario abrir, en el **navegador NORMAL del teléfono** (no in-app), un link
fresco y activo creado para comparar:
- A) igual que la app (con `customer_data.email`): se creó `O03rDq`
- B) control sin email: se creó `ocutiG`
Si en el navegador normal SÍ carga → el problema es el webview del lector de QR (no el QR).
Si NO carga → problema del teléfono/red con Wompi; probar en otro dispositivo.

### Posibles caminos de solución (según resultado de la prueba)
- Si es el in-app webview: no sirve agrandar/cambiar el QR. Opciones: texto/instrucción
  ("ábrelo en tu navegador"), o aceptar que en kiosco el QR lo escanee la cámara nativa
  (que abre Chrome/Safari, no un webview).
- Revisar diferencia entre link creado por la app (con `customer_data`) vs sin él
  (`wompi.ts` `createPaymentLink`) — descartar que `customer_data` rompa el checkout.
- Considerar subir el TTL del link y/o regenerar QR al expirar.

---

## ⚠️ Restricciones / notas
- **NO romper el botón "Pagar ahora"** (`<a href>` en `payment.apple.js` / `payment.js`).
  Solo se debe ajustar el QR.
- Archivos protegidos (CLAUDE.md), NO tocar sin permiso: `payments.ts`, `reconciler.ts`,
  `lib/license/*`, migraciones aplicadas.
- Dentalink es **solo lectura** para pagos (no hay API de abonos). Conciliación manual del staff.
- El reconciler NO rescata payment-links sin webhook (`reconciler.ts` ~L264
  `if(!wompi_transaction_id) continue`) → se depende del webhook (ya configurado).

## 📌 Datos para retomar
- Acceso prod: `ssh root@5.78.110.152` · repo `/opt/dentalkiosco` · rama `para_produccion`.
- Prefijo: `CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"`.
- Paciente de prueba real: **id=4179** (fabian vargas, cédula 10697021). RADIOLOGIA $2.000 +
  Cargo administrativo $5.000 = $7.000. Script read-only: `docs/script_test/consultar_deuda1.py`.
- Crear link de prueba (read-only, no cobra hasta pagar): `POST {WOMPI_API_URL}/payment_links`
  con `Authorization: Bearer $WOMPI_PRIVATE_KEY` (llave en `.env` del server).
- Consultar estado de un link: `GET {WOMPI_API_URL}/payment_links/{id}`.
