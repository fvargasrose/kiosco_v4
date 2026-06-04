# Pendientes menores — registro acumulado de auditoría
> Lista única y viva de hallazgos NO graves de las auditorías por hito. El detalle de
> cada uno vive en su auditoria_hito_X.md; aquí queda el seguimiento.
> Tipos: doc · test · chore · F/G · plan.  Estado: ⬜ abierto · 🔧 corregido sin
> commitear · ✅ commiteado · ⏸️ diferido.

## Hito A
> (Sección creada retroactivamente durante la auditoría de C, a partir de los ⚠️ de
> `auditoria_hito_a.md`; A se auditó antes de existir este archivo.)

| ID | Hallazgo | Tipo | Destino | Estado |
|----|----------|------|---------|--------|
| A-1 | Comentario de cabecera **obsoleto** en `patient-auth.ts:10` (aún menciona `Authorization: Bearer <kiosk_token>` en request-otp; ya no aplica, cfr. líneas 104–107). Archivo de seguridad/auth → NO se corrige en modo híbrido. | doc | `apps/api/src/routes/patient-auth.ts` | ⬜ |
| A-2 | Migración con reverso (`down`) **solo documentado en el `.sql`, sin runner ejecutable**; el DoD pide "aplica y revierte". Suavización del DoD declarada en la auditoría A. | chore / plan | `apps/api/migrations/` + `migrate.ts` | ⬜ |
| A-3 | Gate **lint no ejecutable** (ESLint 9 sin `eslint.config.js`, exit 2). Preexistente; gate efectivo = typecheck + suite. Resolver en F/G. | chore / F/G | raíz (`eslint.config.js`) | ⏸️ |
| A-4 | Rutas `/kiosk/*` y `admin-kiosks` "deprecadas" solo **nominalmente** (sin anotación formal de deprecación en el código). | chore | `routes/kiosk.ts`, `admin-kiosks.ts` | ⬜ |
| A-5 | Test con condicional/matiz menor en "respuesta de error" (L567); pre-existente, no introducido por el hito. | test | `apps/api/tests/` | ⬜ |

## Hito B

| ID | Hallazgo | Tipo | Destino | Estado |
|----|----------|------|---------|--------|
| B-1 | Var `RATE_LIMIT_OTP_PER_IP_PER_HOUR` (config.ts:61, default 10) **muerta**: el bucket `otp:ip` hardcodea 5. Eliminar la var o usarla (no es defecto de seguridad; 5 es más estricto y conforme al plan §7.2). | chore | `apps/api/src/lib/config.ts` / `routes/patient-auth.ts` | ⬜ |
| B-2 | `security.test.ts` no cubre **XFF forjado como ataque**; "aísla por IP" (L148-158) trata la separación por XFF como feature. Añadir test que falle ante el bypass (XFF rotatorio sin 429, `XFF=127.0.0.1`→allowList). Subordinado al hallazgo ALTO del Hito B. | test | `apps/api/tests/security.test.ts` | ⬜ |
| B-3 | Twilio geo-permissions (Colombia) + alertas de facturación: sub-tarea de B en el plan, **sin hook en código**, diferida a F/G por el reporte. | plan / F/G | `lib/sms.ts` (futuro) | ⏸️ |

## Hito C

| ID | Hallazgo | Tipo | Destino | Estado |
|----|----------|------|---------|--------|
| C-1 | `payment.js` (tema `default`, NO-apple) sigue **sin botón "Pagar ahora"** ni `visibilitychange`: solo QR. Deuda si algún despliegue usa `KIOSK_THEME=default` (el default real es `apple`, que sí lo trae). | chore / F | `apps/kiosco-frontend/src/screens/payment.js` | ⬜ |
| C-2 | **Desviación §10:** `JWT_PATIENT_SESSION_TTL_MINUTES` sigue en 10 (§10 sugería 30 para web). Configurable por env; no es bug. Decidir en prod. | plan | `apps/api/src/lib/config.ts:51` (+ `.env` prod) | ⬜ |
| C-3 | **Gap de cobertura** en `/auth/refresh`: ningún test pasa un JWT *criptográficamente expirado* y asierte el rechazo (el test de máx absoluto solo envejece `created_at`). El rechazo existe en código (`jwtVerify` + chequeo BD) pero no testeado directamente. NO se corrige (test de auth/seguridad). | test | `apps/api/tests/patient-refresh.test.ts` | ⬜ |
| C-4 | Bundle del front incluye `tabler-icons.ttf` ~2.8 MB (fallback navegadores viejos; modernos usan `.woff2` ~457 KB). Optimizable con subset de iconos. | chore | `apps/kiosco-frontend` (build de fuentes) | ⬜ |
| C-5 | Helper `escapeHtml` **duplicado en 10 archivos** del front (`home.js`, `payment.apple.js`, `modal.js`, etc.). Patrón preexistente, no introducido por C; centralizable en un util compartido. | chore | `apps/kiosco-frontend/src/` | ⬜ |
| C-6 | Comentarios JSDoc obsoletos en `idle.js:43,45` ("al alcanzar 90s/60s") corregidos a "30 min/28 min" para coincidir con el código real. Aplicado en modo híbrido, **sin commitear**. | doc | `apps/kiosco-frontend/src/idle.js` | 🔧 |

## Hito D

| ID | Hallazgo | Tipo | Destino | Estado |
|----|----------|------|---------|--------|
| D-1 | **Desviación de método del DoD:** el plan §6.1-D pide "Snapshots por breakpoint"; se implementó una **assertion de overflow** (`scrollWidth-clientWidth ≤ 1`), no snapshots visuales. Cumple el espíritu; cambia el método. | test / plan | `e2e/responsive-routing.spec.ts:49-68` | ⬜ |
| D-2 | **Cobertura parcial del test de overflow:** corre **solo en Desktop chromium** (`test.skip(project.name !== 'Desktop')`) con viewports forzados → no ejercita `pointer:coarse` (regla `≥44px`) ni motor móvil real; mide solo ancho de viewport. | test | `e2e/responsive-routing.spec.ts:50` | ⬜ |
| D-3 | El test de overflow no cubre `/pagar` ni `/perfil` (los 6 paths probados son `/ /aviso-privacidad /inicio /citas /tratamientos /agendar`). Menor; `/pagar` requiere params. | test | `e2e/responsive-routing.spec.ts:55` | ⬜ |
| D-4 | **Dependencia de F:** el deep-link en prod depende del `try_files … index.html` de Caddy (`Caddyfile.prod`); en dev funciona por el fallback de Vite. Confirmar en Hito F que el front del paciente sirve `index.html` para rutas como `/citas`. | F/G | `infra/caddy/Caddyfile.prod` | ⏸️ |
| D-5 | Las adiciones CSS responsive de D (columna <400px, targets ≥44px) están **solo en `styles-apple.css`** (tema web por defecto); el tema `default` (`styles.css`) no las recibe. Consistente con la deuda del tema default (cfr. C-1). | chore | `apps/kiosco-frontend/src/styles.css` | ⬜ |

## Hito E

| ID | Hallazgo | Tipo | Destino | Estado |
|----|----------|------|---------|--------|
| E-1 | 🔴 **ALTA — Credencial de admin commiteada.** `admin@e2e.local`/`E2e@Admin2026` hardcodeada en `e2e/helpers.ts:53-54` (en git desde `6153995`). **Sin guard** en `setup.ts` que impida crearla en prod (`seed.ts` sí protege pero crea otro admin). Mitigada por requerir acción manual (no hay seed automático a prod). Se agrava por `mfa_required=false` + `must_change_password` no gateado. Rotar/eliminar antes de desplegar; mover creds E2E a env; añadir guard de entorno a `setup.ts`. **Reportado, no corregido (credencial/config de test).** | **seguridad** | `e2e/helpers.ts`, `apps/api/src/setup.ts` | ⬜ |
| E-2 | **`must_change_password` no se enforza.** Solo se devuelve como flag en el login (`admin-auth.ts:272,302`); el Caso 3 emite sesión `mfaVerified:true` completa sin bloquear. El "cambio obligatorio en el primer login" (`setup.ts:74`) es letra muerta. Preexistente; afecta también al admin de prod del installer. NO se corrige (auth). | **seguridad** | `apps/api/src/routes/admin-auth.ts` | ⬜ |
| E-3 | Token admin en **`localStorage`** (`admin-frontend/src/api.js:18,23`) — riesgo XSS persistente (§1.4). El admin escapa datos vía `esc()` (sin sink hallado); CSP de prod mitiga (Hito F). Trade-off conocido. | F/G | `apps/admin-frontend/src/api.js` + `Caddyfile.prod` (CSP) | ⏸️ |
| E-4 | Breakpoint off-canvas en **768px** → iPad (810px) usa layout de escritorio (sidebar fijo, sin drawer). Usable; subir el breakpoint si se quiere drawer en tablet. Menor. | chore | `apps/admin-frontend/index.html` | ⬜ |
| E-5 | DoD del E2E admin **parcial**: el plan §6.1-E pide "login + MFA"; el E2E usa admin sin MFA → el camino TOTP no se ejercita end-to-end. Compensado con `admin-auth.test.ts` (17 unitarios). | test | `e2e/admin-responsive.spec.ts` | ⬜ |
| E-6 | Helper `esc()` **duplicado en 5 pantallas** del admin (`transactions.js:229`, `kiosks.js:284`, `dashboard.js:161`, `clinic-config.js:685`, `dentists.js:158`). Patrón preexistente (Hito 9), no de E; centralizable (paralelo a C-5). | chore | `apps/admin-frontend/src/` | ⬜ |
