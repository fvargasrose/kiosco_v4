# Plan de corrección — DentalKiosco (S1–S4)

> **ESTADO DE EJECUCIÓN (2026-05-30):** Prompts **1–9 → HECHOS** (enfoque (A) aprobado).
> Suite: API 239/239, frontend 4/4 (vitest), builds OK. El **Prompt 8** (fast-follow P1)
> se completó: el flujo de booking vive ahora en `shared/booking-flow.js`, consumido por
> `booking.js` y `booking.apple.js`; cada tema solo aporta markup/clases/estilos.
> Ver `docs/REPORTE-CIERRE.md` para el cierre completo.

> **Fuente de verdad:** `docs/AUDITORIA.md` (Etapas 1–5). Este archivo NO re-deriva hallazgos:
> los condensa y los convierte en **prompts correctivos copiables** para sesiones futuras que SÍ
> implementarán. Cada prompt es autocontenido.
>
> **Contexto que no se debe perder:**
> - S1+S2+S3 **no** son bugs del código implementado. `booking.js` (tema default) implementa bien
>   treatment+fallback, calendario de 2 meses y paso de `duration`. El tema activo es `apple` y corre
>   `booking.apple.js`, copia estancada (baseline `3764d37`, 25-may) que nunca recibió esas features.
>   ⇒ El trabajo de S1-S3 es **PORTAR desde `booking.js`** (referencia funcional), no reimplementar.
> - S4: `getCancelEstadoId` usa substring `/cancel|anula/i` + `.find()` y elige **id=21** (estado
>   interno; Dentalink responde 400). El correcto es **id=8 "Cancelada"** (verificado en vivo).
>   Además **id=21 quedó cacheado en Redis 24h** (`dl:estados:cancel_id`).
> - Aterrizajes reales (no las hipótesis del encargo): migración es **013** (no 012);
>   **`dentalink-tester/` NO existe**; la firma de `renderCalendar` es
>   `renderCalendar(monthOffset, today, minSelectable, maxSelectable, selectedIso)`; la clase CSS
>   **`--available` nunca existió** (se usa selector `[data-date]`); `booking.js` **no** limpia
>   date/slot en el handler de treatment (solo en `goBack`).

---

## SECCIÓN 0 — Decisión de arquitectura (REQUIERE APROBACIÓN HUMANA)

Antes de ejecutar cualquier prompt, un humano debe elegir el enfoque para S1–S3.

### Enfoque (A) — Portar feature por feature `booking.js` → `booking.apple.js`
- **Pros:** rápido; `booking.js` es referencia conocida y funcional; cambio acotado a un archivo +
  CSS; bajo riesgo para un sistema cercano a producción (Hito 10 en progreso).
- **Contras:** mantiene **dos flujos duplicados** de booking; si en el futuro se añade otra feature
  al booking default, el drift **reaparece**.

### Enfoque (B) — Extraer la lógica de flujo a un módulo compartido
- **Pros:** elimina la causa raíz del drift de forma permanente; los temas solo aportan
  markup/estilos.
- **Contras:** más trabajo y más superficie de regresión; refactoriza código que hoy funciona
  (`booking.js`); mayor riesgo cerca de producción.

### Recomendación

**Adoptar (A) para el fix inmediato de S1–S3 (P0), y un fast-follow (P1) que aplique (B) SOLO a
booking** (extraer el flujo de pasos de booking a un módulo compartido que ambos temas consuman).

**Justificación basada en el inventario (Etapa 5 de AUDITORIA.md):** el drift **funcional está
aislado a `booking.apple.js`** — `treatments` es solo cosmético y el resto está al día. Por tanto
un refactor multi-pantalla (B en todo) sería **sobre-ingeniería** hoy. Pero `booking` es la pantalla
más compleja y la única que YA drifteó; aplicarle (B) a ella específicamente, como paso posterior,
evita la recurrencia donde realmente importa, sin tocar pantallas de bajo riesgo.

> **Qué prompts cambian según la opción:**
> - Si se elige **(A)** (recomendado): ejecutar Prompts 1–4 tal como están (portan a
>   `booking.apple.js`). El Prompt 8 (refactor a módulo compartido) es **P1 opcional**.
> - Si se elige **(B) desde el inicio**: Prompts 1–4 se **sustituyen** por el Prompt 8 ejecutado
>   primero (crear `booking-flow.js` compartido con STEPS+treatment+calendario+duration+treatment_name)
>   y luego adaptar `booking.js` y `booking.apple.js` a consumirlo. Los prompts de S4 (5–7) y de
>   tests no cambian. Cada prompt afectado lleva una nota **"si se elige (B)"**.

---

## ÍNDICE de prompts

> **Reglas de ejecución:** la Sección 0 debe aprobarse primero. Ejecutar **en orden**; no aplicar
> el siguiente prompt hasta **validar** el anterior (build/typecheck/test + criterio de "hecho").

| # | Prompt | Prioridad | Prerrequisitos |
|---|--------|-----------|----------------|
| 1 | Booking apple: `STEPS` + paso `treatment` + fallback + dispatch | **P0** | Sección 0 aprobada (A) |
| 2 | Booking apple: calendario de 2 meses + CSS en `styles-apple.css` | **P0** | Prompt 1 |
| 3 | Booking apple: `duration` + `branch_id` en `getSlots` | **P0** | Prompt 1 (treatment provee la duración) |
| 4 | Booking apple: `treatment_name` en POST + resumen en confirm | **P0** | Prompts 1, 3 |
| 5 | S4 backend: `getCancelEstadoId` → match exacto "Cancelada" + discovery robusto | **P0** | — (independiente de booking) |
| 6 | S4 UX: caso 400 en `doCancelAppointment` (apple; opcional default) | **P1** | Prompt 5 |
| 7 | S4 operativo (NO-CÓDIGO): invalidar caché Redis `dl:estados:cancel_id` | **P0** | Prompt 5 desplegado |
| 8 | (Fast-follow) Extraer flujo de booking a módulo compartido | **P1** | Prompts 1–4 validados |
| 9 | Especificación de tests (no implementación) | **P0** (diseño) | Prompts 1–7 |

**Total: 9 prompts** (P0: 1,2,3,4,5,7,9 → 7 · P1: 6,8 → 2).

---

## Tabla causa raíz → síntoma → prioridad

| Causa raíz (ver AUDITORIA.md) | Síntoma | Prompt(s) | Prioridad |
|-------------------------------|---------|-----------|-----------|
| `booking.apple.js` sin paso `treatment` ni lee `state.config.procedures` | **S2** | 1 | P0 |
| `booking.apple.js` `renderDateStep` usa lista de 14 días (no calendario) | **S1** | 2 | P0 |
| `booking.apple.js` `getSlots` sin `duration`/`branch_id` | **S3** | 3 | P0 |
| `booking.apple.js` `createBooking` sin `treatment_name` | S2 (consistencia comentario) | 4 | P0 |
| `getCancelEstadoId` substring `/cancel\|anula/` elige id=21 (interno) → Dentalink 400 | **S4** | 5, 7 | P0 |
| `doCancelAppointment` (apple) sin caso 400 → mensaje genérico | S4 (UX) | 6 | P1 |
| Drift sistémico (features solo en `*.js` default) | prevención | 8 | P1 |

### OK, sin acción (verificado correcto en AUDITORIA.md — NO genera prompt)
- `dentalink.ts` slots: usa `/api/v1/agendas`, filtra `DD/MM/YYYY`, `/horarios` eliminado (Etapa 4 A1/A2). **OK.**
- `booking.ts` contrato `?duration=N` (`z.coerce.number().int().min(15).max(180).optional()`). **No tocar.**
- Migración **013**, CHECK de duraciones, índice `(clinic_id, active)`, CRUD `/admin/procedures` con validación 400. **OK** (Etapa 2).
- `bootstrap.procedures` array de solo activos con `{id,name,duration_minutes,description}`. **OK.**
- `normalizeCelular`, F8 (no se envía `id_tratamiento`). **OK** — no romper.
- `treatments.apple.js`: drift solo cosmético — mejora opcional (no en este plan P0/P1).

---

## SECUENCIA DE PROMPTS

### Prompt 1 — Booking apple: `STEPS` + paso `treatment` + fallback + dispatch  · **P0** · (S2)

```text
Tarea: Portar el paso "treatment" desde apps/kiosco-frontend/src/screens/booking.js (tema default,
referencia funcional) a apps/kiosco-frontend/src/screens/booking.apple.js (tema activo). NO
reimplementar desde cero: copiar la lógica de booking.js adaptando solo el markup al estilo apple
(clases ak-*). NO modificar booking.js.

Contexto: el tema activo es 'apple' (KIOSK_THEME=apple). booking.apple.js NO tiene paso treatment,
por eso no se ven los tratamientos (S2). El backend YA entrega bootstrap.procedures (15 activos) en
state.config.procedures; solo falta consumirlo.

Sub-pasos (verificar cada uno):
1. En booking.apple.js:8, cambiar STEPS a ['branch','dentist','treatment','date','slot','confirm']
   (treatment en 3ª posición). Ajustar también el labels/subtitle maps de renderStepBar/renderStep
   (líneas 69 y 80) para incluir 'treatment': 'Tratamiento'.
2. En el dispatcher renderStep (booking.apple.js:88-94) añadir el case 'treatment'.
3. En renderDentistStep, cambiar next('date') → next('treatment') (booking.apple.js:185).
4. Crear renderTreatmentStep + treatmentCardHtml portando de booking.js:249-295. Incluye el
   FALLBACK: si (state.config?.procedures ?? []).length === 0, mostrar UNA tarjeta "Consulta general"
   con duration_minutes = state.config?.duracion_cita_minutos ?? 30, SIN mensaje de error y SIN
   bloquear (booking.js:256-265). La tarjeta muestra nombre + badge de duración + descripción
   opcional, SIN foto.
5. Al tocar una tarjeta: selection.treatment = treatments.find(t => String(t.id) === id) y
   next('date'). Añadir selection.treatment al objeto selection inicial (booking.apple.js:17-23) y a
   clearForwardSelections (booking.apple.js:427-433), análogo a booking.js:111-118.

DECISIÓN A MARCAR (resolver en este prompt): booking.js NO limpia date/slot en el handler de
treatment (solo en goBack). RECOMENDACIÓN: corregir durante el port — en el handler de selección de
treatment, fijar selection.date=null y selection.slot=null antes de next('date'), para que cambiar
de tratamiento invalide la fecha/hora previa. (Es una mejora sobre booking.js; documentarla.)

Restricciones: no inventar campos; description es opcional; no romper el fallback; no tocar el
backend.

Verificación: pnpm --filter @dentalkiosco/kiosco-frontend build  (sin errores).
Hecho cuando: con KIOSK_THEME=apple, tras elegir dentista aparece el paso "Tratamiento" con las 15
tarjetas (o "Consulta general" si procedures vacío), y al tocar una avanza a 'date'.
```
> **Si se elige (B):** este prompt no porta a `booking.apple.js`; en su lugar el paso treatment +
> fallback se implementan UNA vez en el módulo compartido `booking-flow.js` (ver Prompt 8) y ambos
> temas lo consumen.

---

### Prompt 2 — Booking apple: calendario de 2 meses + CSS  · **P0** · (S1)

```text
Tarea: Portar el calendario de 2 meses desde booking.js a booking.apple.js (renderDateStep), y sus
estilos a apps/kiosco-frontend/src/styles-apple.css. NO reimplementar; portar de booking.js. NO
tocar booking.js ni styles.css.

Contexto: booking.apple.js:195-232 usa una lista plana de 14 días (ak-date-grid). Debe reemplazarse
por DOS calendarios mensuales (mes actual + siguiente) como en booking.js (S1).

Sub-pasos:
1. Portar las constantes MAX_FUTURE_DAYS=90, CALENDAR_MONTHS=2, WEEKDAY_LABELS, MONTH_LABELS
   (booking.js:29-35).
2. Portar renderCalendar y isoFromLocal (booking.js:405-474). OJO: la firma real es
   renderCalendar(monthOffset, today, minSelectable, maxSelectable, selectedIso) — NO recibe
   dentistId ni onSelectDate. El onSelectDate se cablea fuera, en repaint(), vía addEventListener
   sobre '.calendar-day[data-date]' (booking.js:389-391).
3. Reescribir renderDateStep de booking.apple.js para construir today/minSelectable/maxSelectable y
   un repaint() que pinte CALENDAR_MONTHS calendarios y cablee los clicks (portar booking.js:323-395).
   Mantener el patrón apple: si al tocar un día getSlots devuelve 0, toast "Sin disponibilidad este
   día, elige otro" y revertir (booking.js:346-381).
4. Portar a styles-apple.css las clases .calendar-month, .calendar-month-header, .calendar-weekdays,
   .calendar-weekday, .calendar-grid, .calendar-day, .calendar-day--past, .calendar-day--other-month,
   .calendar-day--sunday, .calendar-day--today, .calendar-day--selected, .calendar-day-num y el
   selector .calendar-day[data-date]:hover/:active (origen styles.css:1485-1599). Adaptar colores a
   las variables apple (var(--accent), etc.).

DECISIÓN A MARCAR: el encargo original mencionaba una clase .calendar-day--available / punto verde
que NO EXISTE en el repo (se usa el selector [data-date] para marcar clicabilidad). RECOMENDACIÓN:
NO inventar --available; replicar el enfoque [data-date] de booking.js para consistencia. Si se
desea el indicador "verde de disponible", tratarlo como mejora separada (no parte de S1).

Restricciones: días pasados, "hoy" y domingos deshabilitados (no clicables); primer día seleccionable
= mañana; no exceder MAX_FUTURE_DAYS=90.

Verificación: pnpm --filter @dentalkiosco/kiosco-frontend build.
Hecho cuando: el paso 'date' del tema apple muestra mes actual + siguiente; domingos/pasados/hoy
deshabilitados; al tocar un día con disponibilidad avanza a 'slot'.
```
> **Si se elige (B):** el calendario vive en `booking-flow.js`; el CSS sigue por tema
> (`styles-apple.css`).

---

### Prompt 3 — Booking apple: `duration` + `branch_id` en `getSlots`  · **P0** · (S3)

```text
Tarea: En booking.apple.js, pasar la duración del tratamiento y el branch_id a api.getSlots, portando
el contrato de booking.js. NO tocar api.js ni el backend (el contrato ?duration=N ya existe y es
correcto: booking.ts:183).

Contexto: booking.apple.js:241-245 llama api.getSlots({ dentistId, from, to }) SIN duration ni
branchId, por lo que el backend cae a duracion_cita_minutos=30 y los slots ignoran la duración del
tratamiento (S3).

Cambios:
1. En la(s) llamada(s) a api.getSlots de booking.apple.js (renderSlotStep y, si el calendario del
   Prompt 2 consulta disponibilidad al tocar el día, también ahí), pasar:
     duration: selection.treatment.duration_minutes,
     branchId: selection.branch.id
   tal como booking.js:355-361 y booking.js:494-500.
2. Añadir el guard 'if (!selection.treatment) return next('treatment')' en renderSlotStep/renderDateStep
   (análogo a booking.js:325,480) para no llegar sin duración.

Restricciones: solo duraciones {15,30,45,60,75,90,105,120}; NO cambiar el contrato ?duration=N; no
usar /api/v1/horarios.

Verificación: pnpm --filter @dentalkiosco/kiosco-frontend build. En navegador (manual, ver Prompt 9):
la request GET /api/me/booking/slots debe incluir &duration=N con la duración del tratamiento elegido.
Hecho cuando: al elegir un tratamiento de 45 min, la llamada de slots viaja con duration=45.
```
> **Si se elige (B):** la construcción de la llamada a slots (con duration/branchId) vive en
> `booking-flow.js`.

---

### Prompt 4 — Booking apple: `treatment_name` en POST + resumen en confirm  · **P0** · (S2 consistencia)

```text
Tarea: En booking.apple.js, mostrar el tratamiento elegido en el resumen de confirmación y enviar
treatment_name en el POST, portando de booking.js. NO enviar id_tratamiento (F8). NO tocar el backend.

Contexto: booking.apple.js renderConfirmStep (296-) no muestra el tratamiento, y
createBookingAppointment (374-381) no envía treatment_name. El backend ya prepone "[nombre]" a
comentarios (dentalink.ts:1115-1117) y NO envía id_tratamiento.

Cambios:
1. En renderConfirmStep, añadir una fila de resumen "Tratamiento: <name> (<duration_minutes> min)"
   usando selection.treatment (portar de booking.js:585-590). Usar duracion =
   selection.treatment?.duration_minutes ?? selection.slot.duracion_minutos ?? 30.
2. En la llamada api.createBookingAppointment, añadir:
     treatmentName: (selection.treatment && selection.treatment.id !== '__default__')
       ? selection.treatment.name : undefined
   (portar de booking.js:638-649). Para el fallback "Consulta general" (id '__default__') NO se envía
   treatment_name.

Restricciones: NO enviar id_tratamiento (F8). No cambiar el formato del comentario del backend.

Verificación: pnpm --filter @dentalkiosco/kiosco-frontend build.
Hecho cuando: el resumen muestra el tratamiento; la cita creada en Dentalink lleva "[<tratamiento>]"
al inicio de comentarios (verificación manual, Prompt 9).
```
> **Si se elige (B):** confirm/POST con treatment_name viven en `booking-flow.js`.

---

### Prompt 5 — S4 backend: `getCancelEstadoId` → match exacto "Cancelada" + discovery robusto · **P0** · (S4)

```text
Tarea: Corregir getCancelEstadoId en apps/api/src/lib/dentalink.ts (líneas ~783-808) para que NUNCA
use el substring /cancel|anula/i. El id correcto en esta clínica es 8 "Cancelada" (verificado en vivo:
PUT id_estado=8 → 200 "Cancelada"; PUT id_estado=21 → 400 "estado reservado para uso interno").

Contexto (AUDITORIA.md Etapa 4): /api/v1/citas/estados devuelve los estados en orden descendente; el
.find(/cancel|anula/i) toma el PRIMERO = id=21 "Anulado vía validación" (interno), que Dentalink
rechaza con 400 → el usuario ve "No pudimos cancelar".

Discovery robusto (en este orden de prioridad):
1. Override configurable por clínica: si existe un id de estado de cancelación configurado
   (p. ej. columna clinic.cancel_estado_id o variable de entorno DENTALINK_CANCEL_ESTADO_ID), usarlo.
   [Si se opta por columna nueva, requiere migración 017 — ver nota abajo.]
2. Si no hay override: buscar match EXACTO de nombre normalizado === 'cancelada'
   (trim + toLowerCase + sin acentos), NO substring.
3. EXCLUIR explícitamente los estados cuyo nombre empiece por "anulado" o marcados como internos.
4. Loguear el id elegido y el nombre (logger.info) para trazabilidad.
5. Si no se encuentra "Cancelada", lanzar DentalinkError claro (no degradar a un id arbitrario).

Restricciones: NUNCA substring cancel|anula; mantener el cacheo en Redis (dl:estados:cancel_id) pero
con TTL razonable; no cambiar la firma pública de cancelAppointment.

Nota de alcance: si se introduce clinic.cancel_estado_id, crear migración 017 (siguiente correlativo;
terminar con INSERT INTO schema_migrations (version,name) VALUES ('017', ...) ON CONFLICT DO NOTHING)
y exponerla en el admin si aplica. Si se usa variable de entorno o solo match exacto, NO se necesita
migración.

Verificación:
  pnpm --filter @dentalkiosco/api typecheck && pnpm --filter @dentalkiosco/api test
  (+ test nuevo: dado el set real de estados, getCancelEstadoId devuelve 8 — ver Prompt 9)
Hecho cuando: getCancelEstadoId devuelve 8 con el set real de estados, y una cancelación e2e deja la
cita en "Cancelada" (id_estado=8) verificado releyéndola.
```

---

### Prompt 6 — S4 UX: caso 400 en `doCancelAppointment`  · **P1** · (S4 UX)

```text
Tarea: En apps/kiosco-frontend/src/screens/appointments.apple.js, en doCancelAppointment (~194-210),
añadir un caso para err.status === 400 con un mensaje claro (p. ej. "No se pudo cancelar: el sistema
de gestión rechazó la operación. Acude a recepción."). Hoy 400 cae al genérico. Aplicar el mismo caso
en appointments.js (~220-236) por paridad (opcional pero recomendado).

Contexto: tras el fix del Prompt 5 el 400 ya no debería ocurrir por el id de estado, pero el caso 400
explícito mejora el diagnóstico ante futuros rechazos de Dentalink. NO sustituye al Prompt 5.

Verificación: pnpm --filter @dentalkiosco/kiosco-frontend build.
Hecho cuando: un 400 del backend muestra el mensaje específico, no el genérico.
```

---

### Prompt 7 — S4 operativo (NO-CÓDIGO): invalidar caché Redis  · **P0** · (S4)

```text
Tarea (OPERATIVA, sin código): tras desplegar el Prompt 5, invalidar la clave de caché que retiene el
id de estado erróneo (21), porque tiene TTL de 24h y, sin borrarla, las cancelaciones seguirían
fallando aunque el código ya esté corregido.

Comando (ajustar credenciales/red según entorno):
  # Dev local:
  docker exec dk-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL dl:estados:cancel_id
  # Producción: ejecutar el DEL equivalente contra el Redis del stack prod.

Verificación: redis-cli GET dl:estados:cancel_id → (nil). En la siguiente cancelación, los logs deben
mostrar el id elegido = 8 ("Dentalink cancel estado resolved").
Hecho cuando: la clave ya no contiene {"id":21} y la próxima resolución cachea {"id":8}.
```

---

### Prompt 8 — (Fast-follow) Extraer flujo de booking a módulo compartido  · **P1** · (prevención de drift)

```text
Tarea: Extraer la lógica de FLUJO de booking (STEPS, navegación, renderTreatmentStep+fallback,
renderCalendar, construcción de la llamada a getSlots con duration/branchId, treatment_name en el
POST, validaciones de fecha) a un módulo compartido (p. ej.
apps/kiosco-frontend/src/screens/shared/booking-flow.js) que tanto booking.js como booking.apple.js
consuman. Cada tema aporta SOLO el markup/clases y el shell (header global vs ak-shell) y los estilos.

Objetivo: eliminar la causa raíz del drift (features que solo aterrizan en booking.js). Es un
fast-follow DESPUÉS de validar S1-S3 con los Prompts 1-4 (no bloquear el fix con el refactor).

Restricciones: comportamiento idéntico al ya validado; no cambiar contratos de API; cobertura de
tests antes y después.

Verificación: build de kiosco-frontend; caminata manual idéntica en ambos temas.
Hecho cuando: añadir una feature de flujo en un solo lugar se refleja en ambos temas.
```
> **Si se elige (B) desde el inicio:** este prompt se ejecuta PRIMERO y reemplaza a los Prompts 1–4
> (que dejan de portar a `booking.apple.js` y pasan a adaptar ambos temas al módulo compartido).

---

## Prompt 9 (ÚLTIMO) — Especificación de tests (NO implementación)

> Diseño de pruebas. **`dentalink-tester/` NO existe** (el encargo lo asumía): el e2e contra Dentalink
> hay que diseñarlo de cero o como guion manual. `mock` NO reproduce S4 ni la caminata autenticada.

### Automatizable (unit / integración — Vitest, mock mode)

| Nombre | Tipo | Entradas | Resultado esperado |
|--------|------|----------|--------------------|
| `procedures.reject_invalid_duration` | Integración (admin) | POST /admin/procedures `{name:"X", duration_minutes:40}` | HTTP **400** con mensaje sobre el set {15,30,45,60,75,90,105,120} |
| `procedures.accept_valid_duration` | Integración (admin) | POST con `duration_minutes:45` | HTTP 201 |
| `bootstrap.procedures_only_active` | Integración (kiosk) | DB con N activos + M inactivos | `procedures` = **array** de solo los N activos, `{id,name,duration_minutes,description}` |
| `bootstrap.procedures_empty_is_array` | Integración | DB sin procedures | `procedures === []` (no null) |
| `treatment.fallback_when_empty` | Unit (frontend) | `state.config.procedures = []` | renderTreatmentStep muestra 1 tarjeta "Consulta general" con `duracion_cita_minutos ?? 30`, sin error |
| `cancel.resolve_estado_exact_8` | Unit (dentalink) | set REAL de estados (incl. 21 "Anulado vía validación", 8 "Cancelada", varios "Anulado*") | `getCancelEstadoId` devuelve **8**, nunca 21 |
| `cancel.no_substring_match` | Unit | estados sin "Cancelada" exacto | lanza DentalinkError (no elige un "Anulado*") |
| `slots.filter_ddmmyyyy` | Unit (dentalink) | respuesta /agendas con items de varias fechas (DD/MM/YYYY) + desborde | solo se devuelven los de la fecha pedida; respeta límite 10 |

### Manual e2e (Dentalink real + OTP — diseñar guion; mock NO sirve)

| Nombre | Tipo | Entradas | Resultado esperado |
|--------|------|----------|--------------------|
| `e2e.calendar_two_months` | Manual | Tema apple, login OTP real | El paso fecha muestra mes actual + siguiente |
| `e2e.calendar_disabled_days` | Manual | — | Días pasados, "hoy" y domingos no clicables |
| `e2e.slots_duration_travels` | Manual (inspección de red) | Elegir tratamiento de 45 min | GET …/slots viaja con `duration=45` |
| `e2e.back_keeps_selection` | Manual | Avanzar y volver con "← Volver" | No se pierde la selección previa (y al cambiar treatment se limpia date/slot — ver decisión Prompt 1) |
| `e2e.cancel_ends_cancelada` | Manual | Crear cita de prueba (tag) y cancelar por el kiosco | Respuesta OK y, releyendo la cita en Dentalink, **id_estado=8 "Cancelada"**. Limpiar la cita. |
| `e2e.booking_comment_has_treatment` | Manual | Agendar con un tratamiento | La cita creada lleva "[<tratamiento>]" al inicio de comentarios; **sin** id_tratamiento (F8) |

> Cada e2e debe etiquetar las citas de prueba (p. ej. "[PRUEBA]") y limpiarlas al terminar (cancelar
> vía id_estado=8). Paciente de prueba conocido: id 4179 / cel 3206505239 (ver AUDITORIA.md Etapa 4).

---

> **Recordatorio:** este documento es solo especificación. No se ha aplicado ningún cambio de
> producción, migración ni test ejecutable.
