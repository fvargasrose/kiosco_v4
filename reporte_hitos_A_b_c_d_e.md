# Reporte de Hitos A · B · C · D · E — DentalKiosco → web pública

> Migración del kiosco físico a **aplicación web pública** (móvil/tablet/PC).
> Documento de reporte: qué se implementó, cómo, qué quedó pendiente, ramas
> creadas y estado de fusión a `main`.
> Fecha: 2026-06-04. Repo: `/home2/kiosko_v4` (clon `kiosko_v4`).
>
> Documentos relacionados: `plan_abierto.md` (análisis/referencia),
> `plan_abierto_v2.md` (plan de ejecución), `estados_hitos.md` (bitácora detallada
> de C/D/E con la sección **⚠️ REVISAR EN AUDITORÍA**), `hito_A.md`, `hito_b.md`.

---

## 0. Resumen ejecutivo

| Hito | Nombre | Estado | En `main` |
|------|--------|--------|-----------|
| **A** | Backend web-ready | ✅ Completo | ✅ Sí (merge `3826f6f`) |
| **B** | Seguridad de perímetro | ✅ Completo | ✅ Sí (merge `569e25c`) |
| **C** | Front web del paciente (núcleo) | ✅ Completo | ❌ No (rama `hito-c-front-web`) |
| **D** | Responsive + routing | ✅ Completo | ❌ No (rama `hito-d-responsive-routing`) |
| **E** | Admin responsive | ✅ Completo | ❌ No (rama `hito-e-admin-responsive`) |
| **F** | Producción Hetzner | ⏸️ **No iniciado** (revisión manual del usuario) | — |
| **G** | Hardening y pruebas finales | ⏸️ No iniciado | — |

**Estado de calidad al cierre (C/D/E):**
- Backend: **280 tests / 20 archivos** verdes (274 base + 6 de `/auth/refresh`).
- `typecheck` API: OK. Builds kiosco-frontend y admin-frontend: OK.
- **E2E Playwright**: 23 verdes + 7 skipped (skips por gating de viewport), en
  perfiles Pixel 7 / iPad / Desktop.

**Remoto:** `main` está **17 commits por delante de `origin/main`** — **nada se ha
empujado (`push`) al remoto**. Todas las fusiones a `main` son locales.

---

## 1. Hito A — Backend web-ready ✅ (en `main`)

**Objetivo:** quitar la dependencia del `kiosk_token` del flujo del paciente y
exponer la config de clínica y el arranque de auth como rutas públicas (clínica
única `id=1`), forzando OTP.

**Qué se implementó / cómo:**
- Nuevas rutas **`/public/*`** (`bootstrap`, `standby`, `standby/media`) reusando
  la lógica de `kiosk.ts` **sin `requireKiosk`** ni telemetría de kiosco.
- `request-otp` y registro pasan a **públicos** (sin `kiosk_token`); el
  consentimiento Habeas Data se inserta con `kiosk_id = NULL`.
- **`/auth/login-direct` eliminado** (Opción A fuerza OTP).
- `signPatientSession` con `kioskId` **opcional** (NULL en sesiones web).
- `/kiosk/register` **público**, gobernado por `FEATURE_REGISTRO`.
- **Migración 017** (idempotente, reversible): `kiosk_id` nullable en
  `otp_codes`, `patient_sessions`, `transactions`, `habeas_data_consents`.
- `config.ts`: claves `TURNSTILE_SECRET`/`TURNSTILE_SITEKEY` (hook).

**Verificación:** suite 262 verde + typecheck. Auditado: ninguna lectura
downstream asume `kiosk_id` no-nulo (el reconciliador no lo lee).

**Pendiente:** limpieza opcional de rutas `/kiosk/*` y `admin-kiosks` (quedaron
deprecadas, no se borraron para minimizar churn).

---

## 2. Hito B — Seguridad de perímetro ✅ (en `main`)

**Objetivo:** sustituir el muro perdido (`kiosk_token`) por defensa real antes de
exponer a internet.

**Qué se implementó / cómo:**
- **Rate-limit global por IP** (`@fastify/rate-limit`, store Redis, `nameSpace
  dk-rl:`) en `server.ts`. Techos por ruta (request-otp 10, verify-otp 20,
  admin/login 10, me/payments 15; resto 300/min). **`allowList` excluye loopback
  y `/health`.**
- **Turnstile enforced** en `request-otp` (`lib/turnstile.ts`, `siteverify`,
  *fail-closed*) antes de lookup/envío; `TURNSTILE_SECRET` obligatorio en prod.
- **Buckets anti-abuso OTP §7.2**: cooldown 60 s, 3/h y 5/día por teléfono,
  5/h y 20/día por IP, 100/h global con alerta (log + audit).
- **Blocklist de sesión admin en Redis** (`admin:blocklist:<jti>`): el logout
  revoca de verdad; `requireAdmin` la consulta.
- Suite de seguridad `tests/security.test.ts`.

**Verificación:** 274 tests verdes (19 archivos), typecheck OK. Confirmado que el
rate-limit NO afecta `/health`.

**Pendiente (se cierra en F/G):** Geo-permissions Twilio a Colombia + alertas de
facturación; cablear la alerta del cap global de OTP a email/Sentry.

---

## 3. Hito C — Front web del paciente (núcleo) ✅ (rama, NO en `main`)

**Objetivo:** la app arranca sin token, login OTP web, home/citas/pago en móvil.

**Qué se implementó / cómo:**
- **Backend `/auth/refresh`** (sesión deslizante §10): `refreshPatientSession()`
  reemite el access token conservando el `jti`; extiende
  `patient_sessions.expires_at` acotado por el máximo absoluto
  (`created_at + JWT_PATIENT_SESSION_ABSOLUTE_MAX_HOURS`, default 8 h). **Sin
  migración** (usa `created_at`). +6 tests (`patient-refresh.test.ts`).
- **`api.js`**: arranca contra `/public/bootstrap` y `/public/standby` (sin
  token); elimina `kioskToken`/`loginDirect`; **sesión en `sessionStorage`**;
  `refreshSession()`; adjunta `turnstile_token`. **Fix:** no enviar
  `Content-Type: application/json` en POST sin body (Fastify devolvía 400 a
  `/auth/refresh` y `/auth/logout`).
- **`main.js`**: sin gate de `kiosk_token` ni pantalla "no pareado"; restaura la
  sesión persistida vía `/auth/refresh`; renovación deslizante en
  `visibilitychange`/`pageshow`.
- **Landing pública** (`standby.js`) con marca de la clínica.
- **`idle.js`**: 28 min aviso / 30 min cierre (en vez del idle agresivo 60/90 s).
- **Turnstile** en `login-cedula.js` (`lib/turnstile.js`); OTP forzado.
- **`register.js`**: teclado nativo (se retira el teclado táctil del kiosco).
- **`payment.apple.js`**: botón **"Pagar ahora"** (abre Wompi) + **QR como
  fallback de escritorio** + reanudación del polling al volver a la app.
- **Fuentes self-host** (`@fontsource/inter` + `@tabler/icons-webfont`), sin CDN
  (compatible con CSP estricta).
- **E2E** `playwright.config.ts` (Pixel 7 / iPad / Desktop) + `patient-flow.spec.ts`.

**Verificación:** 280 backend, typecheck, builds; E2E (arranque sin token →
login OTP → home → citas; sesión sobrevive a refresh; pago "Pagar ahora").

**Pendiente / a revisar (ver `estados_hitos.md`):** el TTL del access sigue en 10
min (§10 sugería 30); `payment.js` del tema *no-apple* no recibió el botón
"Pagar ahora"; la CSP de prod debe permitir `challenges.cloudflare.com` (F).

---

## 4. Hito D — Responsive + routing ✅ (rama, NO en `main`)

**Objetivo:** URLs reales (deep-link, atrás, refresh) y responsive total.

**Qué se implementó / cómo:**
- **Routing con History API** (`router.js`): tabla de rutas nombre↔path
  (`/inicio`, `/citas`, `/tratamientos`, `/agendar`, `/pagar`, `/perfil`,
  `/ingresar`, `/ingresar/codigo`, `/registro`, `/aviso-privacidad`);
  `pushState/replaceState` con params en `history.state`; `popstate`
  (atrás/adelante). `main.js` resuelve la pantalla inicial por URL + sesión.
- **`index.html`**: se quita `user-scalable=no, maximum-scale=1` (zoom/a11y);
  `viewport-fit=cover`.
- **Responsive**: el front del paciente **ya era responsive** (sidebar colapsable
  @900px, bottom-nav @600px en el tema apple). Se **verificó** con E2E de overflow
  horizontal en 360/768/1280 (0 scroll) y se añadió columna única <400px +
  objetivos táctiles ≥44px en `pointer:coarse`.
- **E2E** `responsive-routing.spec.ts`: la URL refleja la ruta; atrás/adelante y
  refresh mantienen ruta + sesión; deep-link directo; sin teclado táctil; sin
  overflow en 360/768/1280.

**Pendiente / a revisar:** los params de pantalla viajan en `history.state` pero
no sobreviven a un deep-link "en frío" de `/ingresar/codigo` o `/pagar` (esas
pantallas se autoredirigen, intencional); el deep-link en prod depende del
`try_files … index.html` de Caddy (confirmar en F).

---

## 5. Hito E — Admin responsive ✅ (rama, NO en `main`)

**Objetivo:** panel admin usable en móvil/tablet (antes: 0 media queries, sidebar
fijo de 220px).

**Qué se implementó / cómo:**
- **`index.html`** (estilos inline): media queries (≤768/≤480); **topbar con
  hamburguesa** + **sidebar off-canvas** con backdrop en móvil; `.main {
  min-width:0 }` para que las tablas (`overflow-x:auto`) no desborden;
  modal/cards a ancho completo en móvil.
- **`main.js`**: topbar + toggle de navegación; el menú se cierra al navegar.
- Las tablas (`kiosks`, `transactions`) ya traían `overflow-x:auto` y `dentists`
  ya usaba grid `auto-fill` → solo se tocó el shell.
- **E2E** `admin-responsive.spec.ts`: login + dashboard; sidebar colapsable en
  móvil; sidebar fijo en tablet/escritorio; tabla sin overflow.

**Pendiente / a revisar (ver `estados_hitos.md`):**
- **Admin de prueba creado en la BD de DESARROLLO** (`admin@e2e.local`,
  credenciales en `e2e/helpers.ts`) — **no debe propagarse a producción**.
- El **E2E del admin NO ejercita el flujo MFA** (usa un admin sin MFA); el backend
  MFA tiene cobertura unitaria.
- Breakpoint off-canvas en 768px → iPad (810) usa layout de escritorio (usable).

---

## 6. Ramas creadas y estado de fusión a `main`

```
main ──● A (merge 3826f6f) ──● B (merge 569e25c)
          └── sistema_abierto (= tip de main: A+B)
                 └── hito-c-front-web        (Hito C)   ── NO fusionada
                        └── hito-d-responsive-routing (Hito D) ── NO fusionada
                               └── hito-e-admin-responsive (Hito E) ── NO fusionada
```

| Rama | Contenido | ¿Fusionada a `main`? |
|------|-----------|----------------------|
| `hito-a-backend-web-ready` | Hito A | ✅ Sí (merge `3826f6f`) |
| `hito-b-seguridad-perimetro` | Hito B | ✅ Sí (merge `569e25c`) |
| `sistema_abierto` | Base de trabajo (= `main` con A+B) | ✅ Es `main` |
| `hito-c-front-web` | Hito C (6 commits) | ❌ No |
| `hito-d-responsive-routing` | Hito D (4 commits, sobre C) | ❌ No |
| `hito-e-admin-responsive` | Hito E (2 commits, sobre D) | ❌ No |

> Las ramas C → D → E están **apiladas**: D parte de C y E parte de D (E se
> ramificó desde D para heredar la toolchain de Playwright, aunque es
> funcionalmente independiente). La bitácora completa `estados_hitos.md` vive en
> la rama `hito-e-admin-responsive`.

### Estado de commits a `main` / remoto
- **A y B**: fusionados a `main` **localmente**.
- **C, D, E**: **commiteados en sus ramas, NO fusionados a `main`** (a la espera de
  auditoría del usuario; se acordó no fusionar).
- **`main` está 17 commits por delante de `origin/main`** → **no se ha hecho
  `push`**; el remoto no tiene ninguna de estas fusiones.

---

## 7. Qué queda pendiente (global)

- **Hito F — Producción Hetzner** (no iniciado, revisión manual del usuario):
  dominio/DNS, HTTPS + Cloudflare, **CSP que permita Turnstile**, firewall de
  origen, build/deploy de los `dist`, backups, convivencia Docker del clon.
- **Hito G — Hardening**: carga (k6), pentest-lite, auditoría PII, simulacro de
  rollback.
- **Decisión de TTL** del access de paciente para web (10 → 30 min) por env.
- Eliminar el **admin de prueba** de la BD de desarrollo antes de cualquier deploy.
- Portar "Pagar ahora" al tema `default` si se usara `KIOSK_THEME=default`.
- Limpieza opcional de rutas `/kiosk/*` deprecadas (desde Hito A).

> Para el listado exhaustivo de riesgos y supuestos, ver la sección
> **⚠️ REVISAR EN AUDITORÍA** de `estados_hitos.md`.
