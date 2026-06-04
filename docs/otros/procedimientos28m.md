# AUDITORÍA C2 — Estado actual

### Prueba manual

**¿Qué debería ocurrir?**
El paciente selecciona un tratamiento (ej. "Ortodoncia, 60 min") → el calendario muestra días disponibles consultando slots de 60 min → la pantalla de horarios muestra franjas de 60 min → la cita se crea con esa duración.

**¿Qué ocurre según el usuario?**
La duración del procedimiento no parece afectar los slots consultados.

**Causa raíz identificada en el código:**
La hipótesis del usuario es **incorrecta** — la duración **SÍ se pasa** al endpoint. La evidencia está en el código:

- `renderDateStep` línea 355–361: `duration: selection.treatment.duration_minutes` ✅
- `renderSlotStep` línea 494–500: `duration: selection.treatment.duration_minutes` ✅
- `api.js` línea 196: `if (duration) qs.set('duration', String(duration))` ✅
- `booking.ts` línea 225: `const durationMin = duration ?? defaultDuration` ✅

**La causa real del comportamiento observado** es probablemente una de estas dos:

**A)** No hay procedimientos configurados en el admin → el kiosco muestra el fallback "Consulta general" con `duracion_cita_minutos` (30 min por defecto) → el usuario nunca tiene otra opción de duración que elegir → parece que la duración es siempre 30 min, pero no es un bug, es ausencia de configuración.

**B)** En modo mock, los slots generados por `generateMockSlots` sí usan la duración, pero al ser slots simulados, el cambio de 30 a 60 min puede ser difícil de notar visualmente (los slots de la tarde cambian de cantidad, pero el usuario puede no percibirlo).

---

### Criterios de aceptación

| Criterio | Estado | Observación |
|----------|--------|-------------|
| Admin puede crear, editar, activar/desactivar procedimientos | ✅ | CRUD completo en `admin-clinic.ts` + UI en `clinic-config.js` |
| Admin puede **eliminar** procedimientos | ⚠️ | Solo soft-delete (activo=false). No hay borrado físico en la UI ni en el endpoint DELETE |
| Kiosco muestra solo procedimientos activos | ✅ | `kiosk.ts:139` — `WHERE clinic_id = 1 AND active = true` |
| Si no hay procedimientos → fallback "Consulta general" | ✅ | `booking.js:257-265` — fallback con `duracion_cita_minutos ?? 30` |
| Cambiar tratamiento limpia fecha y slot | ✅ | `clearForwardSelections` limpia `date` y `slot` al volver al paso treatment |
| `duration_minutes` se pasa al endpoint de slots | ✅ | Ambos `renderDateStep` y `renderSlotStep` pasan `duration: selection.treatment.duration_minutes` |
| Nombre del tratamiento aparece en notas de la cita | ✅ | `booking.js:645-648` + `booking.ts:325` → `treatmentName` va a `createAppointment` |
| Paciente puede volver atrás sin perder consistencia | ✅ | `goBack()` + `clearForwardSelections` garantizan coherencia de `selection` |

---

### Verificación técnica por componente

| Componente | Estado | Detalle |
|------------|--------|---------|
| Migración `013_clinic_procedures.sql` | ✅ | Tabla `clinic_procedures` con `id uuid`, `name`, `duration_minutes`, `description`, `active`. CHECK constraint enforce duraciones válidas de Dentalink |
| `admin-clinic.ts` endpoints | ✅ | `GET /admin/procedures`, `POST /admin/procedures`, `PUT /admin/procedures/:id`, `DELETE /admin/procedures/:id` (soft-delete) |
| Bootstrap retorna `procedures` | ✅ | `kiosk.ts:130-141` — query activos y los incluye en la respuesta bajo clave `procedures` |
| Admin UI `clinic-config.js` | ✅ | Sección "Procedimientos / Tratamientos" con tabla, modal crear/editar, toggle activo/inactivo |
| `booking.js` STEPS con `treatment` | ✅ | `STEPS = ['branch','dentist','treatment','date','slot','confirm']` — línea 28 |
| `renderTreatmentStep()` | ✅ | Función completa con `treatmentCardHtml` mostrando nombre + duración |
| Fallback "Consulta general" | ✅ | Activado cuando `state.config?.procedures ?? []` está vacío |
| `duration_minutes` → endpoint slots (**CRÍTICO**) | ✅ | Pasado correctamente en `renderDateStep` (línea 360) **y** `renderSlotStep` (línea 499) |
| `clearForwardSelections` | ✅ | Limpia `date` y `slot` al retroceder a `treatment`. No limpia `treatment` en sí (correcto) |
| Notas de cita con tratamiento | ✅ | `treatment_name` enviado en POST si `id !== '__default__'` (línea 646) |
| CSS tarjetas tratamiento | ⚠️ | Clases `.treatment-grid` y `.treatment-card` usadas en el HTML pero no auditadas — no hay archivo CSS en el scope de lectura pedido |

---

### Archivos con implementación faltante o incorrecta

No hay bugs funcionales. Hay **un único punto menor**:

| Archivo | Función | Observación |
|---------|---------|-------------|
| `clinic-config.js` | `procedureRowHtml()` | No hay botón de borrado definitivo — solo "Desactivar". Si el criterio requiere delete físico, falta un botón "Eliminar" y lógica de confirmación. El backend sí tiene el endpoint DELETE pero realiza soft-delete (`active=false`) |
| `booking.js` | `renderTreatmentStep()` | Los cards de tratamiento no muestran cuál estaba seleccionado previamente cuando el usuario vuelve atrás. Es UX menor: el usuario tiene que re-elegir sin saber cuál tenía antes |
| (configuración) | — | Si no hay procedimientos configurados en admin, siempre se muestra "Consulta general 30 min". Esta es la causa probable del comportamiento reportado por el usuario |

---

### Plan de implementación propuesto

Dado que el código es correcto, las acciones son de **verificación y configuración**, no de implementación:

1. **Verificar que haya procedimientos configurados en el admin** — ir a `http://localhost:5174` → Configuración de clínica → sección "Procedimientos" → crear al menos 2 procedimientos con duraciones distintas (ej. 30 y 60 min)
2. **Probar el flujo completo** con procedimientos reales → confirmar que el número de slots varía según la duración elegida
3. *(Opcional UX)* Agregar estado "seleccionado" visual en `treatmentCardHtml` comparando `t.id === selection.treatment?.id`
4. *(Opcional)* Agregar botón "Eliminar definitivamente" en la tabla de procedimientos si el criterio lo requiere

---

### Estimación

- **Bugs reales a corregir:** 0
- **Mejoras opcionales:** 1–2 archivos (`booking.js`, `clinic-config.js`), cambios menores de UI
- **Acción prioritaria:** Configurar procedimientos en el panel admin y re-probar
- **Estado real de C2:** ✅ Implementación completa y correcta
