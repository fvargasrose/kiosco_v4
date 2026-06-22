# Plan de mejoras — 17 de junio 2026

> Documento de **planificación**. NO incluye código todavía: define alcance,
> causa raíz, archivos afectados, riesgo y decisiones para cada mejora.
> Origen: `docs/lista de aspectos a mejorar.pdf`.
> Rama base: `para_produccion` (desplegada en Hetzner). Tema activo: **`apple`**.

---

## Contexto verificado (para no romper nada)

- El frontend en producción usa el **tema `apple`** → pantallas `apps/kiosco-frontend/src/screens/*.apple.js`.
  Existe un tema "clásico" (`*.js`) que **no está en uso**; los cambios visuales van **solo en las `.apple.js`** / `styles-apple.css`.
- Hoy el sistema opera en **"modelo web (Opción A)"**: **no hay `kiosk_token`** en el flujo del paciente,
  idle de 30 min, control de acceso por rate-limit + OTP + Turnstile (ver `main.js`).
- El backend **sí** conserva la infraestructura de kiosco:
  `POST /admin/kiosks` crea un kiosco y devuelve un `kiosk_token` (JWT) **una sola vez**
  (almacena solo el hash). El **frontend actualmente lo ignora**.

---

## Modelo de operación deseado (decisión de producto, 2026-06-17)

Dos modos de acceso, decididos por la **presencia del token de kiosco en el link**:

| | **Modo kiosco** | **Modo web** |
|---|---|---|
| Cómo se entra | Link **generado en el admin** con token, ej. `https://sistema.2ways.us/?k=<token>` | `https://sistema.2ways.us/` **sin token** |
| Dispositivo | Kiosco físico de la clínica (pantalla táctil) | PC o **celular** del paciente |
| Teclado en pantalla | **Sí** (componente `keyboard.js`) | No (teclado nativo del dispositivo) |
| Inactividad / auto-cierre | Agresivo (estilo kiosco, ~90 s) | Relajado (30 min, actual) |
| Restricciones de intentos | Más permisivo (uso compartido, varios pacientes) | Personal; mensaje y límites suavizados |
| Responsive | Pantalla fija de kiosco | **Requiere ajustes para celular** |

**Regla técnica:** el frontend lee el token del link (query param), lo guarda en
sesión y entra en **modo kiosco**; si no hay token, se queda en **modo web** (comportamiento actual).

---

## Mejoras (de la lista del PDF)

### ① Falta el icono en "Mis tratamientos" — causa confirmada
- **Causa:** `home.apple.js` usa `<i class="ti ti-tooth">`, pero en **Tabler Icons webfont v3.44.0 ese icono no existe** (se llama `ti-dental`). Por eso el recuadro naranja sale vacío; los otros dos (`ti-calendar-plus`, `ti-calendar`) sí existen.
- **Cambio:** `ti-tooth` → `ti-dental` en `home.apple.js` (1 línea).
- **Archivos:** `apps/kiosco-frontend/src/screens/home.apple.js`.
- **Riesgo:** nulo (solo visual, tema apple).

### ④ Resumen de cita agendada con texto muy separado — causa confirmada
- **Causa:** `.ak-summary-row` en `styles-apple.css` usa `justify-content: space-between`,
  que separa etiqueta (izq) y valor (extremo der) → hueco grande en pantalla ancha
  (lo marcado con flechas en la captura).
- **Cambio (CSS):** pasar cada fila a **columna** (etiqueta arriba, valor debajo, alineado a la izquierda),
  o grilla de 2 columnas con etiqueta de ancho fijo. Recomendado: columna (compacto y legible en pantalla y celular).
- **Archivos:** `apps/kiosco-frontend/src/styles-apple.css` (reglas `.ak-summary-*`).
- **Riesgo:** bajo (solo el resumen de confirmación de agendamiento).

### ② Mensaje "demasiados intentos / espera unos minutos"
- **Dónde:** `login-cedula.js:160` y `login-otp.js:145`. El 429 lo dispara el backend:
  cooldown 60 s por teléfono, **3 OTP/hora/teléfono** (`RATE_LIMIT_OTP_PER_PHONE_PER_HOUR=3`),
  5/día, topes por IP y global.
- **Cambio según modo:**
  - **Modo web:** suavizar el texto y **relajar límites** a valores razonables para uso personal.
    *Trade-off:* subir límites aumenta gasto de SMS y reduce anti-abuso → hay que fijar los números.
  - **Modo kiosco:** límites más permisivos (uso compartido) usando los buckets ya existentes por kiosco
    (`RATE_LIMIT_OTP_PER_KIOSK_PER_HOUR=30`).
- **Archivos:** frontend (textos), `apps/api/src/routes/patient-auth.ts` (selección de buckets por modo), `.env`.
- **Riesgo:** bajo en texto; medio si se ramifican límites por modo (no tocar payments/licencias/migraciones).

### ③ Teclado en pantalla (solo en modo kiosco)
- **Estado:** `apps/kiosco-frontend/src/components/keyboard.js` **existe pero no está cableado** a ninguna pantalla.
- **Plan:** montar el teclado en pantalla en los inputs **solo cuando `modo === kiosco`**; en web no se toca (teclado nativo).
- **Archivos:** `main.js`/`router.js` (detección de modo), pantallas con inputs (login-cédula, OTP, registro, notas de booking), `keyboard.js`.
- **Riesgo:** medio. Aislado al modo kiosco; el modo web no cambia.

### ⑥ Recordatorio desde Dentalink
- **Estado:** ya existe el plan detallado en `plan_recordatorios.md` (raíz): worker diario estilo reconciliador,
  recordatorio **T-1 día** por SMS (LabsMobile) + correo, tabla nueva `appointment_reminders`, idempotente,
  auditable, operable desde el panel.
- **Plan:** implementar según ese documento. Ítem más grande (migración nueva + worker + panel) pero **aislado**:
  no modifica el flujo existente.
- **Riesgo:** bajo-medio (código nuevo aislado; migración nueva siguiendo la regla de versionado).

### ⑦ — vacío en el documento original (sin contenido).

---

## Trabajo transversal: modo kiosco vs web (habilitador de ②③ y del modelo deseado)

1. **Admin:** mostrar/generar el **link completo** del kiosco (`…/?k=<token>`) en la pantalla de kioscos
   (hoy `POST /admin/kiosks` devuelve solo el JWT crudo una vez).
2. **Frontend:** leer el token del link → guardarlo en sesión → activar **modo kiosco**
   (teclado en pantalla, idle ~90 s, límites de kiosco). Sin token → **modo web** (actual).
3. **Modo web responsive:** revisar y ajustar las pantallas `*.apple.js` para que se vean bien en **celular**
   (la grilla de acciones, el resumen de booking ya cubierto en ④, headers, anchos, bottom-nav existente).

---

## Propuesta de entrega por fases

| Fase | Incluye | Riesgo | Bloqueo |
|---|---|---|---|
| **1 — Visual rápido** | ① icono `ti-dental` + ④ resumen en columna | Muy bajo | Ninguno — listo para arrancar |
| **2 — Modo kiosco/web** | Habilitador (token en link, admin muestra link) + ② mensaje/límites + ③ teclado | Medio | Definir esquema del link y números de rate-limit por modo |
| **3 — Responsive web móvil** | Ajustes de las `.apple.js` para celular | Bajo | Lista de pantallas con problemas en celular |
| **4 — Check-in** | ⑤ botón "ya estoy aquí" | Medio | `id_estado` de "en recepción" en Dentalink |
| **5 — Recordatorios** | ⑥ según `plan_recordatorios.md` | Bajo-medio | Confirmar hora de envío y datos del panel |

---

## Decisiones pendientes

1. **Esquema del link de kiosco:** ¿`?k=<token>` (query param) está bien, o se prefiere otro formato?
2. **Rate-limit por modo:** números para modo web (cooldown, OTP/hora) y para modo kiosco.
3. **Check-in (⑤):** `id_estado` de Dentalink que significa "el paciente llegó / está en recepción".
4. **Responsive (③ web móvil):** ¿qué pantallas se ven mal en celular hoy? (para priorizar).
5. **Recordatorios (⑥):** hora de envío (p. ej. 06:00 COT) y confirmación del alcance de `plan_recordatorios.md`.

---

## Reglas a respetar (de CLAUDE.md)
- No tocar sin autorización: `payments.ts`, `reconciler.ts`, `license/*`, migraciones `001-017`.
- Migraciones nuevas siempre con versión nueva (018, 019…) y `INSERT … ON CONFLICT DO NOTHING`.
- Verificación obligatoria al terminar cada tarea: typecheck + test (287) + builds de frontend.
- Cada cambio en su commit convencional; probar en local contra servicios reales antes de subir a git.
