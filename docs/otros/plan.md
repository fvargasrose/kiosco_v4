# DentalKiosco — Plan de implementación risk-first para Claude Code

> **Estrategia:** Walking Skeleton + Risk-First (Cockburn). Validamos primero los
> supuestos técnicos arriesgados con un spike, luego atacamos la ruta crítica
> (auth + booking), y dejamos el pulido visual para el final.
>
> **Flujo recomendado:** una tarea por sesión de Claude Code. Después de cada
> tarea: commit, push, y `/clear` antes de la siguiente. Usa este archivo como
> referencia permanente — pégale a Claude Code la sección que toque.

---

## Orden de ejecución

| # | Tarea | Original | Riesgo | Tiempo estimado |
|---|-------|----------|--------|-----------------|
| 0 | **Spike técnico** (NUEVO) | — | Validación | 2–4 h |
| 1 | Login solo teléfono + OTP dual + CLI | C3 | ★★★★★ | 2–3 días |
| 2 | Booking con tratamiento | C2 | ★★★★☆ | 2 días |
| 3 | Logo clínica en header global | B1 | ★★★☆☆ | 1 día |
| 4 | Comprobante a correo del admin | C1 | ★★★☆☆ | 1 día |
| 5 | Calendario 2 meses | B3 | ★★★☆☆ | 1.5 días |
| 6 | Pestaña pagos rediseñada + acuerdos | B2 | ★★☆☆☆ | 1 día |
| 7 | Video con sonido configurable | A3 | ★★☆☆☆ | 4 h |
| 8 | Foto dentista más grande | A2 | ★☆☆☆☆ | 1 h |
| 9 | Ocultar registro | A1 | ★☆☆☆☆ | 30 min |

**Justificación del reordenamiento vs tu plan original:**
- C3 sube al primer puesto: es la ruta crítica de autenticación; si rompe,
  rompe todo. Cuanto antes se valide, antes se aísla.
- B1 (logo global) sube a posición 3: modifica `router.js` y todas las
  pantallas. Hacerlo después de B3/B2 implicaría retocar pantallas ya
  rediseñadas.
- A1, A2, A3 quedan al final: son cosméticos sin riesgo; sirven de "victorias
  rápidas" para cerrar el sprint con momentum.

---

## Reglas para Claude Code en TODAS las sesiones

Pegar esto al inicio de cada sesión (o ponerlo en `CLAUDE.md` en la raíz):

```
Reglas del proyecto DentalKiosco:

1. NUNCA tocar estos archivos sin autorización explícita:
   - apps/api/src/routes/payments.ts (webhook Wompi)
   - apps/api/src/lib/reconciler.ts
   - apps/api/src/lib/license/* (middleware de licencias)
   - apps/api/migrations/001-011_*.sql (migraciones ya aplicadas)

2. Antes de modificar cualquier archivo, leerlo COMPLETO primero con view.
   No editar a ciegas basado en suposiciones.

3. Stack confirmado: Node 22, TypeScript, Fastify 4, Zod, Postgres 16, Redis 7,
   pnpm workspaces, Vite 5, Vanilla JS (no React/Vue) en frontends.

4. Migraciones: SIEMPRE nueva versión (012, 013...). NUNCA modificar previas.
   Terminar cada migración con:
   INSERT INTO schema_migrations (version, name)
   VALUES ('NNN', 'nombre') ON CONFLICT DO NOTHING;

5. Comandos de verificación obligatorios al terminar cada tarea:
   - pnpm --filter @dentalkiosco/api typecheck
   - pnpm --filter @dentalkiosco/api test
   - pnpm --filter @dentalkiosco/api lint
   - (frontend) pnpm --filter kiosco-frontend build
   - (frontend) pnpm --filter admin-frontend build

6. Commits: uno por tarea completada, con mensaje convencional:
   feat(scope): descripción / fix(scope): descripción / chore: descripción

7. Si algo es ambiguo, PREGUNTAR antes de asumir. No inventar endpoints,
   nombres de campos o estructuras de tablas.
```

---

# TAREA 0 — SPIKE TÉCNICO (hacer primero, antes de cualquier código de producción)

**Tiempo:** 2–4 horas · **Output:** un archivo `docs/spike-resultados.md` con
hallazgos. NO se mergea código de producción aquí.

```
Vas a hacer un spike técnico de exploración (no código de producción).
Crea una rama spike/risk-validation y al terminar produce el archivo
docs/spike-resultados.md con los hallazgos. NO mergees a main.

CONTEXTO — leer antes de empezar:
- apps/api/src/lib/dentalink.ts (entender métodos actuales y formato celular)
- apps/api/src/routes/patient-auth.ts (flujo OTP actual)
- apps/api/src/lib/notifications.ts (envío SMS + email)
- apps/api/migrations/ (revisar si existe campo procedures en clinic y su tipo)
- apps/kiosco-frontend/src/screens/standby.js (lógica de video actual)
- apps/api/src/routes/kiosk.ts (qué retorna /kiosk/bootstrap)

OBJETIVO: validar 3 supuestos críticos ANTES de comprometer 1 semana de trabajo
en C3+C2. Si algún supuesto falla, el plan debe ajustarse.

SUPUESTO 1 — Búsqueda por celular en Dentalink:
- Confirmar que el endpoint GET /api/v1/pacientes?q={"celular":{"eq":"..."}}
  funciona en la versión de Dentalink del cliente.
- Investigar (vía mock o doc) qué formato espera el celular: con +57, sin +57,
  con espacios, sin espacios.
- Determinar: ¿puede haber dos pacientes con el mismo celular? Si sí,
  documentar la política recomendada (mostrar selector de nombre, pedir
  cédula como segundo factor, etc.).

SUPUESTO 2 — Autoplay con sonido en kiosco:
- Documentar qué flag de Chromium se necesita
  (--autoplay-policy=no-user-gesture-required) y cómo se lanza actualmente
  el kiosco en producción (revisar produccion.md y scripts del installer).
- Si el kiosco NO lanza Chromium con esa flag, anotarlo como bloqueador
  de la tarea A3.

SUPUESTO 3 — Estado actual de procedures:
- Revisar migraciones 001-011 y schema de clinic.
- ¿Existe ya la columna procedures JSONB? ¿Tiene datos? ¿El admin tiene UI
  para editarla o se setea solo desde seed?
- ¿GET /kiosk/bootstrap ya expone procedures al frontend?

ENTREGABLE — docs/spike-resultados.md con esta estructura:
- Supuesto 1: [VALIDADO / FALLA / REQUIERE AJUSTE] + decisión
- Supuesto 2: [igual]
- Supuesto 3: [igual]
- Ajustes al plan: [lista de cambios concretos al plan.md si aplica]

RESTRICCIONES:
- No modificar código de producción.
- No crear migraciones.
- Solo lectura + investigación + un .md de hallazgos.

CRITERIOS DE ACEPTACIÓN:
- [ ] Archivo docs/spike-resultados.md creado con los 3 supuestos resueltos
- [ ] Cada supuesto tiene veredicto explícito (VALIDADO/FALLA/AJUSTE)
- [ ] Si hay supuesto fallido, hay propuesta de mitigación documentada
- [ ] Branch spike/risk-validation creado, NO mergeado

COMANDOS DE VERIFICACIÓN: ninguno (no hay código nuevo).
Solo: git log --oneline y git status para confirmar que la rama existe.
```

---

# TAREA 1 — LOGIN SOLO TELÉFONO + OTP DUAL + CLI (C3)

**Tiempo:** 2–3 días · **Riesgo:** ★★★★★ · **Branch:** `feat/auth-phone-only`

```
TAREA: Refactorizar el login del paciente para usar SOLO teléfono (sin cédula),
enviar OTP simultáneamente a SMS + email, y agregar un comando CLI para
inspeccionar OTPs activos en desarrollo.

PRERREQUISITO: tarea 0 (spike) completada y supuesto 1 resuelto. Si el spike
detectó política de duplicados, aplicarla aquí.

CONTEXTO — leer COMPLETO antes de tocar nada:
- apps/api/src/routes/patient-auth.ts
- apps/api/src/lib/dentalink.ts
- apps/api/src/lib/notifications.ts
- apps/api/src/lib/sms.ts y apps/api/src/lib/email.ts
- apps/api/tests/patient-auth.test.ts
- apps/kiosco-frontend/src/screens/login-cedula.js
- apps/kiosco-frontend/src/screens/login-otp.js
- apps/kiosco-frontend/src/api.js (función loginDirect)
- apps/api/package.json (scripts actuales)
- docs/spike-resultados.md (decisiones del spike)

OBJETIVO: el paciente solo escribe su celular; el sistema lo busca en
Dentalink, le envía OTP por SMS Y email en paralelo, y el equipo de soporte
puede ver el OTP activo en dev con: pnpm --filter @dentalkiosco/api dk:otp +573001234567

RESTRICCIONES INVIOLABLES:
- NO modificar la lógica de verify-otp (validación del código y creación de
  sesión). Solo cambia quién lo invoca y con qué datos.
- NO romper los tests existentes sin actualizar también el test
  correspondientemente.
- El script dk:otp DEBE rechazar ejecución si NODE_ENV === 'production'.
- Respuesta del request-otp NO debe revelar si el teléfono existe (anti-
  enumeración): responder siempre "Si el número está registrado, recibirás
  un código".
- Rate limit: máx 3 intentos por teléfono por hora.

PASOS:
1. dentalink.ts: agregar lookupPatientByCelular(celular, token). Normalizar
   el celular según lo que dictó el spike. Manejar duplicados según política
   del spike (loguear warning + tomar primero, O lo que se haya decidido).
2. notifications.ts: si sendOtp no soporta envío dual, extenderla. Usar
   Promise.allSettled para que falla de un canal no bloquee al otro.
   Si paciente sin email → solo SMS. Sin teléfono válido → solo email.
3. patient-auth.ts: modificar POST /auth/request-otp para aceptar { phone }
   en lugar de { cedula }. Aplicar anti-enumeración y rate limit.
4. patient-auth.ts: adaptar POST /auth/login-direct (caso OTP_REQUIRED=false)
   para aceptar solo phone.
5. Crear apps/api/src/scripts/get-otp.ts con shebang #!/usr/bin/env tsx.
   Lee de Redis las keys otp:<phone>:* y muestra el código activo.
   Verificar NODE_ENV !== 'production' al inicio.
6. apps/api/package.json: agregar "dk:otp": "tsx src/scripts/get-otp.ts"
7. Kiosco frontend:
   - login-cedula.js: eliminar campo cédula, dejar solo celular (+57 fijo,
     10 dígitos). Renombrar archivo a login-phone.js si tiene sentido, o
     mantener nombre para minimizar cambios en router.
   - login-otp.js: mensaje "Enviamos tu código al correo y al celular
     registrados".
   - api.js: actualizar payload de requestOtp y loginDirect.
8. Actualizar apps/api/tests/patient-auth.test.ts:
   - tests existentes que asumen cédula → ajustar a phone
   - nuevos tests: duplicados, anti-enumeración, rate limit, OTP dual,
     CLI rechaza producción.

CRITERIOS DE ACEPTACIÓN:
- [ ] Paciente puede loguearse con solo celular en flujo OTP_REQUIRED=true
- [ ] Paciente puede loguearse con solo celular en flujo OTP_REQUIRED=false
- [ ] OTP llega a ambos canales cuando paciente tiene email y celular
- [ ] OTP llega a un solo canal cuando falta uno (sin error)
- [ ] Respuesta de request-otp NO distingue entre teléfono existente vs no
- [ ] Cuarto intento en 1h con mismo teléfono → 429 Too Many Requests
- [ ] pnpm --filter @dentalkiosco/api dk:otp +573001234567 muestra OTP activo
- [ ] Mismo comando en NODE_ENV=production → error y exit 1
- [ ] Todos los tests pasan

COMANDOS DE VERIFICACIÓN:
- pnpm --filter @dentalkiosco/api typecheck
- pnpm --filter @dentalkiosco/api test patient-auth
- pnpm --filter @dentalkiosco/api test
- pnpm --filter @dentalkiosco/api lint
- pnpm --filter kiosco-frontend build
- (manual) levantar dev, intentar login real con teléfono mock

COMMIT: feat(auth): login solo con teléfono + OTP dual + CLI dk:otp
```

---

# TAREA 2 — BOOKING CON SELECCIÓN DE TRATAMIENTO (C2)

**Tiempo:** 2 días · **Riesgo:** ★★★★☆ · **Branch:** `feat/booking-treatment-step`

```
TAREA: Agregar un paso "tratamiento" al flujo de agendar cita, gestionable
desde el admin, que define la duración del slot.

PRERREQUISITO: tarea 0 (spike) — supuesto 3 sobre procedures resuelto.

CONTEXTO — leer COMPLETO:
- apps/kiosco-frontend/src/screens/booking.js (todo el flujo de pasos)
- apps/api/src/routes/booking.ts
- apps/api/src/routes/admin-clinic.ts
- apps/api/src/routes/kiosk.ts (qué expone bootstrap)
- apps/admin-frontend/src/screens/clinic-config.js
- migraciones de clinic (entender estructura de procedures)
- docs/spike-resultados.md

OBJETIVO: nuevo flujo branch → dentist → TREATMENT → date → slot → confirm.
El admin gestiona el catálogo de tratamientos. El frontend pasa la duración
del tratamiento al endpoint de slots.

RESTRICCIONES:
- NO confundir "procedures" (catálogo de la clínica, JSONB en clinic) con
  "tratamientos" del paciente (vienen de /api/v1/tratamientos de Dentalink).
  Son cosas DIFERENTES.
- NO romper el flujo actual de booking si procedures está vacío.
- NO cambiar el contrato del backend de slots (?duration=N ya existe).

PASOS:
1. Si el spike encontró que falta migración para procedures, crearla como
   012_*.sql (revisar número exacto según migraciones existentes).
   Cada procedure: { id: uuid, name, duration_minutes, description, active }
2. admin-clinic.ts: endpoints GET/PUT para procedures (si no existen ya
   como parte del PUT /admin/clinic general).
3. kiosk.ts: verificar/agregar que bootstrap retorna procedures activos.
4. Admin frontend clinic-config.js: sección "Procedimientos / Tratamientos"
   con CRUD básico (agregar / editar nombre+duración / activar-desactivar /
   eliminar).
5. Kiosco frontend booking.js:
   - const STEPS = ['branch','dentist','treatment','date','slot','confirm']
   - renderTreatmentStep(): muestra procedures activos como tarjetas
   - Si procedures vacío: mostrar UN tarjeta "Consulta general" con
     duración por defecto = clinic.duracion_cita_minutos. NO BLOQUEAR.
   - selection.treatment = { id, name, duration_minutes }
   - renderDateStep y renderSlotStep: pasar duration_minutes al endpoint
   - confirm: mostrar el tratamiento en el resumen
   - clearForwardSelections: limpiar date+slot si cambia tratamiento
   - POST /me/booking/appointments: incluir nombre del tratamiento en notas
6. CSS: tarjetas de tratamiento (similares a las de dentista pero sin foto).

CRITERIOS DE ACEPTACIÓN:
- [ ] Admin puede crear, editar, eliminar y activar/desactivar procedimientos
- [ ] Kiosco muestra solo procedimientos activos
- [ ] Si no hay procedimientos, kiosco ofrece "Consulta general" automática
- [ ] Cambiar tratamiento limpia la selección de fecha/slot
- [ ] El slot consultado respeta la duración del tratamiento elegido
- [ ] El nombre del tratamiento aparece en las notas de la cita creada
- [ ] El paciente puede volver atrás en cualquier paso sin perder consistencia

COMANDOS DE VERIFICACIÓN:
- pnpm --filter @dentalkiosco/api typecheck
- pnpm --filter @dentalkiosco/api test booking
- pnpm --filter @dentalkiosco/api test
- pnpm --filter kiosco-frontend build
- pnpm --filter admin-frontend build
- (manual) flujo completo de booking con y sin procedures

COMMIT: feat(booking): paso de selección de tratamiento con duración variable
```

---

# TAREA 3 — LOGO CLÍNICA EN HEADER GLOBAL (B1)

**Tiempo:** 1 día · **Riesgo:** ★★★☆☆ · **Branch:** `feat/clinic-logo-header`

> **Decisión:** se hace ANTES que el resto de UI porque modifica `router.js`
> y todas las pantallas. Hacerlo después implicaría retocar B3 y B2.

```
TAREA: subir el logo de la clínica desde el admin y mostrarlo en el header
de TODAS las pantallas del kiosco.

CONTEXTO — leer COMPLETO:
- apps/api/src/routes/admin-clinic.ts
- apps/api/src/routes/kiosk.ts (bootstrap retorna logo_path)
- apps/api/src/server.ts (cómo se sirven archivos estáticos actualmente)
- apps/kiosco-frontend/src/router.js
- apps/kiosco-frontend/src/screens/standby.js (uso actual del logo)
- apps/kiosco-frontend/src/styles.css (clases .screen-header)
- apps/admin-frontend/src/screens/clinic-config.js
- migraciones: confirmar que clinic.logo_path ya existe

OBJETIVO: el logo se sube una vez, se sirve como estático, y aparece en el
header arriba del título de cada pantalla del kiosco.

RESTRICCIONES:
- Validar MIME (PNG/JPG/WEBP) y tamaño (max 2MB) en backend.
- No subir logo al bundle del frontend; se sirve como /public/clinic-logo.
- El logo en header debe ser más pequeño (max-height 60px) que en standby.

PASOS:
1. admin-clinic.ts: nuevo endpoint PUT /admin/clinic/logo (multipart).
   Guarda en apps/api/uploads/clinic-logo.<ext>, actualiza clinic.logo_path.
   Validar MIME por magic bytes, no solo por extensión declarada.
2. server.ts: ruta estática GET /public/clinic-logo que sirve el archivo.
3. Verificar que bootstrap ya expone logo_path como URL pública relativa.
4. Crear apps/kiosco-frontend/src/components/clinic-header.js:
   export function renderClinicHeader(logoUrl, clinicName, screenTitle).
   Si hay logo → <img>; si no → texto con nombre de clínica.
5. router.js: envolver el render de cada screen con el header global.
   Asegurar que pantallas que ya tienen header propio no dupliquen.
6. CSS: .clinic-header-logo { max-height: 60px; max-width: 200px }
7. Admin clinic-config.js: sección "Logo" con preview + input file +
   upload. Mostrar peso/dimensiones después de subir.

CRITERIOS DE ACEPTACIÓN:
- [ ] Admin puede subir PNG, JPG y WEBP
- [ ] Admin recibe error claro si sube PDF, .exe o archivo >2MB
- [ ] Logo aparece arriba del título en TODAS las pantallas del kiosco
- [ ] Si no hay logo subido, header muestra el nombre de la clínica
- [ ] Standby sigue mostrando el logo más grande (no se afecta su tamaño)
- [ ] Refrescar el kiosco después de subir logo nuevo → aparece el nuevo

COMANDOS DE VERIFICACIÓN:
- pnpm --filter @dentalkiosco/api typecheck
- pnpm --filter @dentalkiosco/api test admin-clinic
- pnpm --filter @dentalkiosco/api lint
- pnpm --filter kiosco-frontend build
- pnpm --filter admin-frontend build
- (manual) subir logo desde admin, recorrer todas las pantallas del kiosco

COMMIT: feat(branding): logo de clínica en header global del kiosco
```

---

# TAREA 4 — COMPROBANTE DE PAGO A CORREO DEL ADMIN (C1)

**Tiempo:** 1 día · **Riesgo:** ★★★☆☆ · **Branch:** `feat/admin-payment-receipt`

```
TAREA: cuando Wompi confirma un pago aprobado, además del recibo al paciente,
enviar un email al administrador con todos los datos relevantes.

CONTEXTO — leer COMPLETO:
- apps/api/src/lib/notifications.ts (sendPaymentReceipt actual)
- apps/api/src/routes/payments.ts (NO MODIFICAR — solo leer para entender)
- apps/api/src/routes/admin-clinic.ts
- apps/admin-frontend/src/screens/clinic-config.js
- migraciones de clinic

OBJETIVO: el admin recibe un correo HTML enriquecido por cada pago aprobado,
con datos del paciente, pago y tratamiento. NUNCA bloquea el flujo principal.

RESTRICCIONES INVIOLABLES:
- NO modificar payments.ts ni la lógica del webhook Wompi.
- El envío al admin va en try/catch independiente. Falla silenciosa con
  logger.error(). Bajo ninguna circunstancia debe lanzar excepción que
  rompa la idempotencia de sendPaymentReceipt (campo receipt_sent_at).
- No generar PDF en esta iteración (Puppeteer/pdfkit añade complejidad).
  Solo HTML bien formateado.
- Email del paciente debe ir parcialmente enmascarado en el correo al admin
  (privacidad: ej. juan****@gmail.com).

PASOS:
1. Migración 013_notification_email.sql:
   ALTER TABLE clinic ADD COLUMN notification_email TEXT;
   + INSERT en schema_migrations
2. admin-clinic.ts: exponer notification_email en GET y PUT de la clínica.
   Validar formato email si no es null.
3. notifications.ts: en sendPaymentReceipt, después del envío al paciente,
   leer clinic.notification_email. Si tiene valor, componer y enviar email
   al admin con resend.sendEmail() dentro de try/catch propio.
4. Template HTML: usar template literal con estilos inline (los clientes
   de email no soportan CSS externo). Asunto: "Comprobante de pago — [Clínica]
   — $[monto]". Datos: paciente (enmascarado), pago (referencia, monto,
   método, fecha), tratamiento (nombre, saldo antes, saldo después).
5. clinic-config.js: input "Email para notificaciones de pago" con validación.

CRITERIOS DE ACEPTACIÓN:
- [ ] Admin puede configurar notification_email desde el panel
- [ ] Si notification_email es null, NO se intenta envío (no error en logs)
- [ ] Pago aprobado → paciente recibe su recibo Y admin recibe el suyo
- [ ] Si el envío al admin falla, el paciente IGUAL recibe el suyo
- [ ] receipt_sent_at se actualiza correctamente (idempotencia intacta)
- [ ] Email al admin muestra datos del paciente enmascarados

COMANDOS DE VERIFICACIÓN:
- pnpm --filter @dentalkiosco/api migrate (aplica 013)
- pnpm --filter @dentalkiosco/api typecheck
- pnpm --filter @dentalkiosco/api test notifications
- pnpm --filter @dentalkiosco/api test payments (asegurar que no cambió nada)
- pnpm --filter admin-frontend build
- (manual) simular pago aprobado en sandbox Wompi

COMMIT: feat(notifications): comprobante de pago al administrador por email
```

---

# TAREA 5 — CALENDARIO 2 MESES (B3)

**Tiempo:** 1.5 días · **Riesgo:** ★★★☆☆ · **Branch:** `feat/booking-calendar`

```
TAREA: reemplazar el paso 'date' del booking (lista plana de 14 días) por una
cuadrícula de calendario mensual con 2 meses simultáneos.

PRERREQUISITO: tarea 2 completada (booking.js ya tiene paso treatment).

CONTEXTO — leer COMPLETO:
- apps/kiosco-frontend/src/screens/booking.js (renderDateStep actual)
- apps/api/src/routes/booking.ts (límites del backend: MAX_FUTURE_DAYS,
  MAX_SEARCH_WINDOW_DAYS)
- apps/kiosco-frontend/src/styles.css

OBJETIVO: dos cuadrículas mes-actual + mes-siguiente. El paciente toca un
día y se piden slots solo de ese día (consulta puntual, no pre-cargar todo).

RESTRICCIONES:
- NO cambiar MAX_SEARCH_WINDOW_DAYS=30 en el backend.
- NO pre-cargar disponibilidad de los 60 días (costoso e innecesario).
- Los pasos 'branch','dentist','treatment','slot','confirm' NO se tocan.

PASOS:
1. Crear función renderCalendar(monthOffset, dentistId, selection, onSelectDate)
   en booking.js. Genera cuadrícula 7 cols (L M M J V S D).
2. renderDateStep: pintar dos calendarios (monthOffset=0 y 1), navegación
   ← → si quieres permitir scroll por más meses (max 2).
3. Estilos de celdas:
   - .calendar-day--past: gris, no clickable, pointer-events:none
   - .calendar-day--other-month: gris muy claro, no clickable
   - .calendar-day--sunday: gris (configurable si la clínica abre domingos)
   - .calendar-day--today: borde azul punteado
   - .calendar-day--selected: fondo azul primario, texto blanco
   - .calendar-day--available: con punto verde después de la consulta
4. Al click en día hábil:
   - Marcar como seleccionado
   - GET /me/booking/slots?dentist_id=X&from=fecha&to=fecha&duration=N
   - Si retorna [] → toast "Sin disponibilidad este día, elige otro"
   - Si retorna slots → avanzar al paso 'slot'
5. CSS responsive: dos meses en fila si caben, apilados si no.

CRITERIOS DE ACEPTACIÓN:
- [ ] Se ven mes actual y mes siguiente al entrar al paso fecha
- [ ] Días pasados aparecen deshabilitados visualmente
- [ ] Domingos deshabilitados (configurable por clínica si aplica)
- [ ] Click en día disponible avanza al paso slot
- [ ] Click en día sin slots muestra toast y no avanza
- [ ] Botón "atrás" vuelve al paso treatment sin perder selección
- [ ] El backend recibe la duración correcta del tratamiento

COMANDOS DE VERIFICACIÓN:
- pnpm --filter kiosco-frontend build
- pnpm --filter @dentalkiosco/api test booking (no debe romperse nada)
- (manual) recorrer flujo completo, probar días pasados y futuros

COMMIT: feat(booking): calendario mensual de 2 meses para selección de fecha
```

---

# TAREA 6 — PESTAÑA DE PAGOS REDISEÑADA + ACUERDOS (B2)

**Tiempo:** 1 día · **Riesgo:** ★★☆☆☆ · **Branch:** `feat/payments-redesign`

```
TAREA: rediseñar la pantalla de tratamientos/estado de cuenta según
docs/pestaña_pagos.html. Verificar que el saldo viene correcto de Dentalink.

CONTEXTO — leer COMPLETO:
- apps/kiosco-frontend/src/screens/treatments.js
- apps/kiosco-frontend/src/screens/payment.js (NO MODIFICAR — solo leer)
- docs/pestaña_pagos.html (diseño de referencia)
- apps/api/src/routes/patient-me.ts (endpoint de tratamientos)
- apps/api/src/lib/dentalink.ts (cómo se trae el saldo)

OBJETIVO: vista de "estado de cuenta" con tarjetas estilo azul oscuro,
barra de progreso (abonado/total) y botón "Pagar" por cada tratamiento
con saldo pendiente.

RESTRICCIONES:
- NO modificar payment.js (lógica Wompi/QR intacta).
- NO cambiar el contrato de navegación: treatments → payment sigue
  pasando (treatmentId, amountCop, description).
- NO consumir /api/v1/acuerdos de Dentalink en esta iteración (queda
  como pendiente P1 hasta confirmar que existe en la versión del cliente).

PASOS:
1. Estudiar docs/pestaña_pagos.html: extraer paleta (#003c96, #001d5c),
   tipografía, estructura de tarjeta.
2. Reescribir treatments.js:
   - Header tipo tarjeta azul oscuro con nombre+avatar del paciente
   - Por cada tratamiento con saldo_pendiente > 0:
     tarjeta con nombre, total, abonado, saldo, barra de progreso,
     botón "Pagar ahora"
   - Tratamientos con saldo_pendiente === 0: tarjeta gris con ✓
   - Si no hay tratamientos: estado vacío amable
3. CSS: .treatment-card, .treatment-progress-bar, .treatment-card--paid
4. Verificar visualmente con datos reales del mock Dentalink.

CRITERIOS DE ACEPTACIÓN:
- [ ] Vista coincide visualmente con el HTML de referencia (paleta, layout)
- [ ] Tratamientos con saldo aparecen primero, finalizados al final
- [ ] Botón "Pagar" navega correctamente a payment con los 3 parámetros
- [ ] Sin tratamientos → estado vacío sin error de JS
- [ ] No se rompió ningún flujo de pago existente

COMANDOS DE VERIFICACIÓN:
- pnpm --filter kiosco-frontend build
- pnpm --filter @dentalkiosco/api test (asegurar que no rompió nada)
- (manual) comparar lado a lado con docs/pestaña_pagos.html

COMMIT: feat(treatments): rediseño de pestaña pagos con estado de cuenta
```

---

# TAREA 7 — VIDEO STANDBY CON SONIDO CONFIGURABLE (A3)

**Tiempo:** 4 horas · **Riesgo:** ★★☆☆☆ · **Branch:** `feat/standby-video-sound`

```
TAREA: agregar toggle "video con sonido" en admin que controla si el video
del standby se reproduce con audio.

PRERREQUISITO: tarea 0 (spike) — supuesto 2 sobre autoplay resuelto.

CONTEXTO — leer COMPLETO:
- apps/kiosco-frontend/src/screens/standby.js
- apps/api/src/routes/kiosk.ts (bootstrap)
- apps/api/src/routes/admin-clinic.ts
- apps/admin-frontend/src/screens/clinic-config.js
- migraciones de clinic (estructura standby_config)
- docs/spike-resultados.md (¿el kiosco se lanza con la flag correcta?)

OBJETIVO: admin marca un checkbox, kiosco reproduce con sonido. Si la flag
de Chromium no está presente, documentar el requisito en produccion.md.

RESTRICCIONES:
- Default debe ser false (sin sonido). Audio sorpresa en kiosco = mala UX.
- Solo visible en admin cuando modo standby = 'video'.

PASOS:
1. Migración 014_standby_video_sound.sql:
   ALTER TABLE clinic ADD COLUMN standby_video_sound BOOLEAN NOT NULL DEFAULT false;
   + INSERT en schema_migrations
2. kiosk.ts: incluir video_sound en el objeto standby del bootstrap.
3. admin-clinic.ts: leer/escribir standby_video_sound en GET y PUT.
4. clinic-config.js (admin): toggle "Video con sonido", visible solo si
   modo = 'video'.
5. standby.js: reemplazar vid.muted = true por
   vid.muted = !(state.config?.standby?.video_sound ?? false);
   y vid.volume = 1.0 si no muted.
6. Si el spike concluyó que falta la flag de Chromium, agregar nota en
   produccion.md sección "kiosco" con el flag exacto.

CRITERIOS DE ACEPTACIÓN:
- [ ] Toggle aparece solo en modo video
- [ ] Default es false en BD para clínicas existentes
- [ ] Cambiar el toggle y recargar standby refleja el cambio
- [ ] Si autoplay falla por política del navegador, no rompe la pantalla

COMANDOS DE VERIFICACIÓN:
- pnpm --filter @dentalkiosco/api migrate
- pnpm --filter @dentalkiosco/api typecheck
- pnpm --filter @dentalkiosco/api test admin-clinic
- pnpm --filter admin-frontend build
- pnpm --filter kiosco-frontend build
- (manual) probar con flag y sin flag de Chromium

COMMIT: feat(standby): video con sonido configurable desde admin
```

---

# TAREA 8 — FOTO DEL ODONTÓLOGO MÁS GRANDE (A2)

**Tiempo:** 1 hora · **Riesgo:** ★☆☆☆☆ · **Branch:** `chore/dentist-card-size`

```
TAREA: ampliar tamaño visual de tarjetas y fotos de dentistas en el booking.

CONTEXTO — leer:
- apps/kiosco-frontend/src/screens/booking.js (verificar generación, no cambiar)
- apps/kiosco-frontend/src/styles.css
- apps/kiosco-frontend/src/styles-apple.css (si existe)

OBJETIVO: foto de 100px → 160px; grid de 180px → 220px; tipografía
proporcional.

RESTRICCIONES: NO tocar el HTML generado en booking.js. Solo CSS.

PASOS:
1. styles.css:
   .dentist-card-photo-wrap { width: 160px; height: 160px; }
   .dentist-card { padding: 1.5rem; gap: 1rem; }
   .dentist-card-name { font-size: 1.2rem; }
   .dentist-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
2. Replicar en styles-apple.css si existe.

CRITERIOS DE ACEPTACIÓN:
- [ ] Fotos visiblemente más grandes
- [ ] Layout no se rompe en pantallas chicas
- [ ] Sin regresión en otras pantallas que usen las mismas clases

COMANDOS DE VERIFICACIÓN:
- pnpm --filter kiosco-frontend build
- (manual) recorrer paso 'dentist' del booking

COMMIT: chore(ui): aumentar tamaño de tarjetas y fotos de dentistas
```

---

# TAREA 9 — OCULTAR REGISTRO DE PACIENTE (A1)

**Tiempo:** 30 minutos · **Riesgo:** ★☆☆☆☆ · **Branch:** `chore/hide-register`

```
TAREA: ocultar UI de registro de paciente sin eliminar el backend ni el archivo
(puede reactivarse en el futuro).

CONTEXTO — leer:
- apps/kiosco-frontend/src/main.js
- apps/kiosco-frontend/src/router.js
- apps/kiosco-frontend/src/screens/home.js
- apps/kiosco-frontend/src/screens/register.js (NO eliminar)

OBJETIVO: ningún path lleva al register desde el flujo del usuario.

RESTRICCIONES:
- NO eliminar register.js
- NO eliminar la ruta del backend
- Agregar feature flag FEATURE_REGISTRO=false en .env (opcional pero
  ordenado) para controlar sin redeploy futuro.

PASOS:
1. router.js: confirmar que la ruta 'register' no se enruta o ponerla
   detrás de la feature flag.
2. home.js: confirmar que no hay botón visible al registro. Comentar con
   // DESHABILITADO cualquier link residual.
3. .env y .env.example: agregar FEATURE_REGISTRO=false documentado.

CRITERIOS DE ACEPTACIÓN:
- [ ] No hay forma de llegar a registro desde el flujo normal del kiosco
- [ ] register.js sigue existiendo en el repo
- [ ] La ruta del backend sigue respondiendo (no se rompió)

COMANDOS DE VERIFICACIÓN:
- pnpm --filter kiosco-frontend build
- pnpm --filter @dentalkiosco/api test (ninguna ruptura)
- (manual) recorrer todo el kiosco buscando enlaces residuales

COMMIT: chore(ui): ocultar flujo de registro de paciente (backend intacto)
```

---

# Pendientes documentados (no se hacen en este sprint)

- **P1** — Acuerdos de pago Dentalink: investigar `/api/v1/acuerdos` en
  versión del cliente.
- **P2** — PDF del comprobante admin: implementar con `pdfkit` si el cliente
  lo prioriza sobre HTML.
- **P3** — Política definitiva para teléfonos duplicados: el spike define
  una temporal, refinar con datos de producción.
- **P4** — Porcentaje exacto del video vertical en standby: pedir
  confirmación al cliente.

---

# Checklist de cierre del sprint

- [ ] Todas las ramas mergeadas a main vía PR (no push directo a main)
- [ ] Tag de versión: `v1.X.0`
- [ ] `estado.md` actualizado con hitos completados
- [ ] `produccion.md` actualizado si hay nuevos requisitos (flag de Chromium,
      nueva variable de entorno, etc.)
- [ ] Backup de BD de producción antes de desplegar migraciones 012/013/014
- [ ] Smoke test post-deploy: login, booking completo, pago de prueba
