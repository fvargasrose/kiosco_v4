# Guion de pruebas E2E manuales — Booking apple + Cancelación (S1–S4)

> Estas pruebas requieren **Dentalink real + OTP** y NO se automatizan (el modo mock
> no reproduce S4 ni la caminata autenticada). Ejecutar a mano contra el entorno con
> `KIOSK_THEME=apple` y `DEV_MOCK_EXTERNAL_SERVICES=false`.
>
> **Paciente de prueba conocido:** id Dentalink `4179` / celular `3206505239`
> (ver `docs/AUDITORIA.md` Etapa 4).
>
> **Regla de limpieza:** etiquetar toda cita de prueba con `[PRUEBA]` en las notas y,
> al terminar, dejarla **Cancelada** (id_estado=8). No dejar IDs sin limpiar.

## Preparación

1. Infra arriba: `docker compose up -d postgres redis`.
2. API: `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev` (:3000).
3. Kiosco: `pnpm --filter @dentalkiosco/kiosco-frontend dev` (:5173).
4. Abrir `http://localhost:5173/?kiosk_token=<JWT>` y autenticarse con cédula+OTP del paciente de prueba.
5. Tener la consola de red del navegador (DevTools → Network) abierta.

---

## Casos

### e2e.calendar_two_months (S1)
- **Pasos:** Agendar → elegir sede → profesional → tratamiento → llegar al paso "Fecha".
- **Esperado:** se muestran DOS calendarios mensuales (mes actual + siguiente), no una lista de 14 días.

### e2e.calendar_disabled_days (S1)
- **Pasos:** en el paso "Fecha", intentar tocar días pasados, el día de "hoy" y cualquier domingo.
- **Esperado:** esos días no son clicables (deshabilitados); el primer día seleccionable es **mañana**;
  no se pueden seleccionar fechas a más de 90 días.

### e2e.treatments_visible (S2)
- **Pasos:** tras elegir profesional, observar el paso "Tratamiento".
- **Esperado:** aparecen las tarjetas de los procedimientos activos (nombre + badge de duración +
  descripción opcional). Si la clínica no tiene procedimientos, aparece UNA tarjeta
  "Consulta general" (sin error, sin bloqueo).

### e2e.slots_duration_travels (S3)
- **Pasos:** elegir un tratamiento de **45 min**, avanzar a "Fecha", tocar un día disponible.
  Inspeccionar en Network la request `GET /api/me/booking/slots`.
- **Esperado:** la URL incluye `&duration=45` (y `&branch_id=<id>`). Antes del fix, no llevaba `duration`.

### e2e.back_keeps_selection
- **Pasos:** avanzar varios pasos y volver con "← Volver".
- **Esperado:** no se pierde la selección previa. **Además** (mejora del Prompt 1): al **cambiar de
  tratamiento**, la fecha/hora previas se limpian (hay que volver a elegir día/hora).

### e2e.booking_comment_has_treatment (S2 consistencia)
- **Pasos:** agendar una cita `[PRUEBA]` eligiendo un tratamiento concreto. Releer la cita creada en
  Dentalink (panel o API `GET /api/v1/citas/:id`).
- **Esperado:** el campo de comentarios/observaciones empieza con `[<nombre del tratamiento>]`.
  **NO** se envía `id_tratamiento` (F8). Para el fallback "Consulta general" NO se antepone nombre.

### e2e.cancel_ends_cancelada (S4) — PRINCIPAL
- **Pre-requisito de despliegue:** haber invalidado el caché Redis
  (`DEL dl:estados:cancel_id`, ver `docs/DEPLOY-NOTES.md`).
- **Pasos:**
  1. Crear una cita de prueba `[PRUEBA]` futura para el paciente 4179.
  2. Desde el kiosco (tema apple), en "Mis citas", cancelarla.
  3. Observar los logs del API: debe aparecer `Dentalink cancel estado resolved` con `id: 8`
     (o `Dentalink cancel estado (override)` si se configuró `DENTALINK_CANCEL_ESTADO_ID`).
  4. **Releer la cita** en Dentalink (`GET /api/v1/citas/:id`).
- **Esperado:** la respuesta del kiosco es OK ("Cita cancelada"); al releer, la cita queda en
  **`id_estado = 8` ("Cancelada")**. NUNCA debe usarse id_estado=21 (Dentalink lo rechaza con 400).
- **Limpieza:** la cita ya quedó Cancelada (id_estado=8) — no requiere acción extra.

### e2e.cancel_400_message (S4 UX)
- **Cómo provocarlo (artificial):** forzar un rechazo de Dentalink (p. ej. configurar temporalmente
  `DENTALINK_CANCEL_ESTADO_ID=21` para reproducir el 400) e intentar cancelar.
- **Esperado:** el kiosco muestra el mensaje específico **"No se pudo cancelar — El sistema de gestión
  rechazó la operación. Por favor acude a recepción."**, no el genérico "No pudimos cancelar la cita".
- **Limpieza:** quitar el override `DENTALINK_CANCEL_ESTADO_ID` y reiniciar el API.

---

## Cobertura automatizada equivalente (ya implementada, Vitest)

Estos casos SÍ están cubiertos por unit/integración (mock mode) y no requieren guion manual:

| Test | Archivo |
|------|---------|
| `cancel.resolve_estado_exact_8` / `cancel.no_substring_match` / override | `apps/api/tests/dentalink-cancel.test.ts` |
| `slots.filter_ddmmyyyy` | `apps/api/tests/dentalink-cancel.test.ts` |
| `bootstrap.procedures_only_active` / `_empty_is_array` | `apps/api/tests/kiosk-bootstrap-procedures.test.ts` |
| `procedures.reject_invalid_duration` / `accept_valid_duration` | `apps/api/tests/admin-clinic.test.ts` (pre-existentes) |
| `treatment.fallback_when_empty` | `apps/kiosco-frontend/src/screens/shared/treatment-list.test.js` |
