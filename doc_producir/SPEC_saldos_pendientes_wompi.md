# SPEC — Saldos pendientes y pago Wompi (DentalKiosco v4)

> Documento autocontenido para ejecutar con Claude Code. No referencia documentos
> externos. Todas las decisiones de producto y los hechos empíricos de la API están
> embebidos aquí.

---

## 0. Objetivo

Extender el sistema (que ya permite a un paciente autenticarse y **crear citas**) para que
además pueda **ver sus saldos pendientes de pago** y **pagarlos por Wompi**. El foco es
**lo que el paciente YA debe pagar** (exigible ahora), no la deuda futura presupuestada.

Tareas funcionales que se agregan:

1. Sincronizar desde Dentalink hacia la BD local los conceptos financieros del paciente.
2. Mostrar al paciente sus pendientes de pago (lista clara, sin tecnicismos).
3. Permitir pagar por Wompi.
4. Al confirmarse el pago: registrar evento, guardar en BD, enviar comprobante al paciente
   y reporte a la clínica.

---

## 1. Hallazgos / observaciones (verificados)

Estos hechos ya están comprobados y deben respetarse. No los re-deduzcas: si necesitas
confirmar un nombre de campo, hazlo con un `GET` real (ver Fase 0).

1. **`deuda` ≠ "saldo por abonar".** En Dentalink un presupuesto pasa por dos estados:
   - *Presupuestado / Pendiente* → aparece como **"Saldo por abonar"**, pero el campo
     `deuda` de la API vale **0**.
   - *Realizado* (el odontólogo marca la prestación como ejecutada) → recién ahí cuenta
     como **deuda** (`deuda` = realizado − pagado).
   - Confirmado empíricamente: un paciente con tratamientos por $5.000 y $2.000 en estado
     "Pendiente / Realizado $0" reporta `deuda = 0` en la API, aunque tenga saldos por cobrar.

2. **`saldo por abonar = total − abonado`.** Este es el monto cobrable de un tratamiento,
   independientemente de si está realizado o no.

3. **⚠️ Riesgo de doble cobro.** `total − abonado` **ya contiene** la porción
   `realizado-no-pagado` (`deuda`). NUNCA sumar `saldo` + `deuda`. Modelar
   "realizado no pagado" como una *etiqueta/clasificación* de parte del saldo, no como un
   monto separado adicional.

4. **La API de pagos es SOLO LECTURA.** Los endpoints de `pagos`, `tratamientos`,
   `prestaciones`, `detalles` son `GET`. No existe forma soportada de escribir un pago, una
   deuda ni de marcar una prestación como realizada vía API. Por tanto **el pago Wompi NO se
   escribe de vuelta en Dentalink** desde el sistema. La conciliación en Dentalink es manual
   (staff), apoyada por el reporte que se envía al correo de la clínica.

5. **No se necesita crear tratamientos.** Esta tarea solo LEE de Dentalink. (Nota aparte:
   `POST /pacientes/{id}/tratamientos` devuelve **405**; el path anidado no admite escritura.
   Irrelevante para este alcance porque solo leemos.)

6. **Cuotas de financiamiento:** existen en la web ("Por cuotas de financiamiento"). El
   endpoint de API correspondiente debe **verificarse empíricamente** (ver Fase 0); no asumir
   su forma.

7. **Wompi usa firma SHA256 plana (no HMAC)** para verificar la integridad de la transacción
   / webhook.

---

## 2. Definición de "pendiente de pago"

Se muestran y se pueden cobrar, unificados como ítems pendientes:

| Concepto | Fuente Dentalink | Monto pendiente | ¿Exigible ahora? |
|---|---|---|---|
| Saldo por abonar de tratamiento activo | `tratamiento.total − tratamiento.abonado` | el saldo | Parcial (la parte realizada) |
| Prestación realizada no pagada | campo `deuda` del tratamiento | porción ya realizada y no pagada | **Sí** |
| Cuota de financiamiento vencida | plan de financiamiento (verificar endpoint) | monto de la cuota | **Sí** |

**Reglas para evitar doble conteo y deuda futura:**

- El monto pendiente canónico por tratamiento **sin financiamiento** = `total − abonado`.
  Dentro de ese saldo, la parte `realizado-no-pagado` (`deuda`) se marca como
  **"exigible ahora"** y el resto como **"presupuesto / futuro"** (informativo, no se
  pre-cobra salvo que el paciente elija abonar por adelantado).
- Si el tratamiento **tiene plan de financiamiento**, el pendiente exigible se expresa por
  **cuotas vencidas**, NO por el saldo total (eso sería deuda futura). En ese caso el saldo
  total queda informativo.
- Excluir tratamientos **finalizados** y **presupuestos alternativos** (los "alternativos"
  son cotizaciones no aceptadas; verificar con qué flag los marca la API).

> Tony: si detectas ambigüedad entre estos buckets en los datos reales, **reporta y detente**.
> No inventes la clasificación.

---

## 3. Arquitectura propuesta

```
Dentalink (READ-ONLY)
   │  sync periódico / on-demand al autenticar
   ▼
BD local PostgreSQL  ──►  pagos_pendientes (snapshot clasificado)
   │
   ▼
Frontend (Vanilla JS + Vite)  ──►  el paciente ve y selecciona pendientes
   │
   ▼
Wompi checkout  ──►  webhook (verificación firma SHA256 plana)
   │
   ▼
Backend Fastify:
   - registra evento_pago en BD
   - marca pendiente como pagado/parcial
   - email comprobante  → paciente
   - email reporte      → clínica   (para conciliación manual en Dentalink)
   (NO se escribe en Dentalink)
```

### Modelo de datos (propuesto — Tony ajusta a las convenciones del repo)

Tabla `pagos_pendientes` (snapshot leído de Dentalink, por paciente):

- `id` PK
- `id_paciente_dentalink`
- `tipo` enum: `saldo_tratamiento` | `realizado_no_pagado` | `cuota_financiamiento`
- `id_referencia_dentalink` (id del tratamiento / cuota)
- `concepto` (texto legible: nombre del tratamiento / nº de cuota)
- `monto_total`
- `monto_abonado`
- `monto_pendiente`
- `exigible_ahora` boolean
- `fecha_vencimiento` nullable (para cuotas)
- `estado` enum: `pendiente` | `parcial` | `pagado`
- `sincronizado_at`

Tabla `eventos_pago` (lo que SÍ controla el sistema):

- `id` PK
- `id_paciente_dentalink`
- `id_pago_pendiente` FK (nullable si fue abono libre)
- `monto`
- `referencia_wompi` (transaction id)
- `estado_wompi` (`APPROVED` | `DECLINED` | `VOIDED` | `ERROR`)
- `firma_verificada` boolean
- `email_paciente_enviado` boolean
- `email_clinica_enviado` boolean
- `creado_at`

> Importante: la tabla `pagos_pendientes` es un **espejo** de Dentalink. La verdad financiera
> sigue viviendo en Dentalink; esta tabla es para mostrar/cobrar y caduca con cada sync.

---

## 4. Fase 0 — Auditoría READ-ONLY (obligatoria, antes de tocar código)

Tony ejecuta esta fase **sin modificar nada** y **reporta** antes de continuar.

1. **Verificar campos reales** de `GET /pacientes/4179/tratamientos`. Listar exactamente qué
   campos vienen (`total`, `abonado`, `deuda`, y los reales de realizado/finalizado/estado).
   Confirmar nombres exactos; no asumir los de Medilink.
2. **Verificar endpoint de financiamiento / cuotas.** Probar candidatos
   (`/pacientes/{id}/cuotas`, datos dentro del tratamiento, etc.) y reportar la forma real o
   "no disponible vía API".
3. **Verificar cómo se distinguen** tratamientos finalizados y presupuestos alternativos
   (flags/campos).
4. **Auditar el estado actual de v4:** ¿ya existe algún flujo financiero o de Wompi? ¿qué hay
   del lado de citas que se pueda reutilizar (auth, cliente HTTP a Dentalink, layout)?
5. **Confirmar config Wompi** disponible (llaves, URL de eventos, esquema de firma SHA256).

**Salida esperada de Fase 0:** un informe breve que contraste (a) lo que el código actual
hace, (b) lo que la API realmente devuelve, (c) qué de esta spec es factible tal cual y qué
requiere ajuste. **Detente y espera aprobación.**

---

## 5. Fases de implementación (tras aprobar Fase 0)

Ejecutar una a una, con gate de validación entre cada una. Un commit por cambio lógico.
TDD donde aplique (rojo antes de verde).

- **F1 — Migración + modelo.** Crear tablas `pagos_pendientes` y `eventos_pago` con `up` y
  `down` ejecutables por el runner.
- **F2 — Servicio de sync.** Leer tratamientos (+ cuotas si existen) del paciente, clasificar
  según §2 (sin doble conteo), poblar `pagos_pendientes`. Tests con fixtures de la respuesta
  real capturada en Fase 0.
- **F3 — Endpoint backend** `GET /pacientes/:id/pendientes` que devuelve los ítems
  exigibles + informativos, ya clasificados.
- **F4 — Frontend.** Vista de pendientes en español: lista, monto exigible destacado,
  selección, total a pagar. Sin jerga ("Saldo por abonar", no "deuda realizada").
- **F5 — Integración Wompi.** Checkout + endpoint de webhook con **verificación de firma
  SHA256 plana**. Idempotencia por `referencia_wompi`.
- **F6 — Post-pago.** Al recibir `APPROVED` verificado: crear `evento_pago`, marcar pendiente,
  enviar email comprobante (paciente) y reporte (clínica). Reintentos/logs si falla el correo.

---

## 6. Especificaciones técnicas embebidas

**API Dentalink**
- Base: `https://api.dentalink.healthatom.com/api/v1`
- Auth header: `Authorization: Token <TOKEN>` (token desde variable de entorno, NUNCA en
  texto plano en el código).
- Tratamientos del paciente: `GET /pacientes/{id}/tratamientos`
- Fórmulas: `saldo_por_abonar = total − abonado`; `realizado_no_pagado = deuda`
  (campo); regla anti-doble-conteo de §1.3.

**Wompi**
- Verificación con **firma SHA256 plana** (concatenación de propiedades + secreto de eventos,
  hash SHA256 — NO HMAC).
- Estados a manejar: `APPROVED`, `DECLINED`, `VOIDED`, `ERROR`.
- Idempotencia obligatoria (un mismo evento puede llegar más de una vez).

**Correos**
- Comprobante al paciente: monto, concepto pagado, referencia Wompi, fecha.
- Reporte a la clínica: paciente, id Dentalink, concepto/tratamiento, monto, referencia
  Wompi — pensado para que el staff registre el pago manualmente en Dentalink.

**Seguridad / convenciones**
- Sin credenciales en texto plano (variables de entorno).
- Respetar patrones existentes del repo para auth y cliente HTTP.

---

## 7. Criterios de validación (gates)

- F2: los montos clasificados de un paciente real **no se solapan** (saldo total =
  exigible_ahora + presupuesto_futuro; sin sumar `deuda` por separado).
- F3: el endpoint nunca expone deuda futura como "exigible ahora".
- F5: una firma inválida es rechazada; un evento duplicado no genera doble `evento_pago`.
- F6: tras un `APPROVED`, existen exactamente un `evento_pago`, un correo a paciente y uno a
  clínica; el pendiente queda `pagado`/`parcial`.

---

## 8. Fuera de alcance / requiere intervención humana

- **No** se escribe nada en Dentalink (API de pagos read-only). La conciliación del pago en
  Dentalink la hace el staff manualmente con el reporte por correo.
- **No** se marcan prestaciones como realizadas vía API.
- Despliegue a producción (Hetzner/Caddy/Cloudflare), llaves productivas de Wompi y PII real
  quedan para revisión humana, no los toca Tony en este alcance.

---

## 9. Modo de trabajo para Tony

1. Ejecuta **solo Fase 0** y entrega el informe. **No implementes nada todavía.**
2. Espera aprobación explícita.
3. Tras aprobar, presenta el plan de F1–F6 y vuelve a esperar OK antes de codificar.
4. Auto-fix permitido solo en trivialidades (typos, imports muertos). Cualquier cosa de
   seguridad, dinero o que requiera criterio → reporta y detente.
