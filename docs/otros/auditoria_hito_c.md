# Auditoría independiente — Hito C (Front web del paciente)

> **Auditor:** rol de verificación independiente, modo HÍBRIDO (verifica; no implementa, no
> fusiona; corrige solo trivia de lista blanca sin commitear).
> **Fecha:** 2026-06-04 · **Rama auditada:** `hito-c-front-web` (tip `00fed12`, fondo del stack).
> **Base de diffs:** `569e25c` (= merge de B / tip de main). NO se diffeó contra HEAD/hito-e.
> **Leyenda:** ✅ cumple · ⚠️ matiz/desviación · ❌ incumple · 🔭 no verificable en este entorno.

---

## 0. Entorno

- **Docker daemon CAÍDO** (`/var/run/docker.sock` → HTTP `000`) y **CLI `docker` no en PATH**.
  Sin Postgres/Redis → **suite backend y E2E Playwright = 🔭** (análisis estático + aritmética,
  como en Hito B). Lo verificable sin BD se ejecutó de verdad.
- **typecheck:** `pnpm --filter @dentalkiosco/api typecheck` → **exit 0** ✅.
- **build kiosco-frontend:** ✅ (`✓ built in 930ms`; fuentes self-host presentes en `dist/`).
- **lint:** `pnpm lint` → ESLint 9 sin `eslint.config.js` (exit 2). **Gap PREEXISTENTE**, una línea ⚠️.
- Git re-confirmado: `main = 569e25c` (solo A+B). C/D/E NO en main; cadena lineal hasta `hito-e`.
  D/E **sí** tocan archivos de C (`main.js`, `router.js`, `styles-apple.css`, `playwright.config.ts`)
  → correcto auditar sobre `hito-c-front-web`, no sobre HEAD.

---

## A) Arranque sin kiosk_token — ✅

- `main.js`: sin gate de `kiosk_token`, sin `showUnpairedScreen`; arranca contra `/public/bootstrap`
  (`main.js:146` `api.bootstrap()` → `api.js:94-95` `/public/bootstrap`). Restaura sesión persistida
  y la revalida con `refreshSession()` (`main.js:165-172`).
- `api.js`: **0** refs a `kioskToken`/`_useKiosk`/`loginDirect` (`grep` limpio). Comentario de
  cabecera declara el modelo web "ya NO hay kiosk_token" (`api.js:4`).
- Sesión en **`sessionStorage`**: token `dk_patient_token` (`api.js:16,31,39`), expira
  `dk_patient_expires` (`api.js:17`), info paciente `dk_patient_info` (`state.js:18,68`).
- `refreshSession()` presente (`api.js:127-130`) y `turnstile_token` adjunto en `request-otp`
  (`api.js:108`).
- `login-direct`/`loginDirect` en **todo el front**: 0 referencias de código (única ocurrencia es un
  comentario en `login-cedula.js:5` "login-direct fue eliminado del backend").

## B) *** CRÍTICO — Seguridad de /auth/refresh *** — ✅ (diseño sólido)

> No se tocó `jwt.ts` ni `patient-auth.ts` (prohibido). Solo lectura.

`jwt.refreshPatientSession()` (`jwt.ts:165-185`) **solo re-firma** el JWT con el `jti` y el
`expiresAt` que recibe — toda la lógica de seguridad vive en la ruta `POST /auth/refresh`
(`patient-auth.ts:518-601`). Verificado punto por punto:

| Requisito | Veredicto | Evidencia |
|-----------|-----------|-----------|
| Reemite JWT con **mismo `jti`** | ✅ | `patient-auth.ts:580` pasa `jti: claims.jti`; `jwt.ts:173,181` lo conserva |
| Extiende `patient_sessions.expires_at` | ✅ | `UPDATE patient_sessions SET expires_at=$1 WHERE jti=$2` (`patient-auth.ts:584-587`) |
| **Tope absoluto ENFORZADO** (no solo calculado) | ✅ | `:553` `if (Date.now() >= absoluteMax) →` revoca (`revoked_reason='absolute_max_reached'`) + audita + **401 SESSION_EXPIRED** |
| `created_at` **releído de BD** cada refresh, inmutable | ✅ | `:537` `SELECT … created_at FROM patient_sessions WHERE jti=$1`; el `UPDATE` solo toca `expires_at`/`revoked_at`, nunca `created_at` |
| **NO acepta tokens expirados** | ✅ | doble guarda: `verifyPatientSession` (`jwtVerify` valida `exp` → 401 `INVALID_OR_EXPIRED`, `:526-528`) + chequeo BD `session.expires_at < now()` (`:543`) |
| Rechaza revocados | ✅ | `:543` `session.revoked_at` → 401 `SESSION_INVALID` |
| Expiración deslizante **capeada al tope** | ✅ | `:575` `newExpiresAt = slidingExpiry < absoluteMax ? slidingExpiry : absoluteMax` → el JWT nunca sobrevive al techo |

**RIESGO evaluado — token filtrado dentro de su TTL:** un atacante con el JWT vivo puede
refrescarlo, **pero solo hasta `created_at + 8h`** (`JWT_PATIENT_SESSION_ABSOLUTE_MAX_HOURS`),
tras lo cual la sesión se revoca server-side. Es el trade-off estándar de sesión deslizante con
techo absoluto, documentado en §10 y en el reporte (auditoría #1). `logout` revoca y mata ambos
(atacante y usuario), `:487-488`. **No es bug; el diseño es conservador y correcto.**

**Tests `patient-refresh.test.ts` (6, 🔭 no ejecutados — sin BD):** cubren (1) refresh válido →
nuevo token mismo jti + expira después + fila actualizada; (2) token nuevo aceptado en ruta
protegida; (3) sin token → 401; (4) token inválido → 401; (5) revocado tras logout → 401
`SESSION_INVALID`; (6) máximo absoluto (`created_at` envejecido 9h) → 401 `SESSION_EXPIRED` +
`revoked_reason='absolute_max_reached'`. **Gap de cobertura (C-3):** ningún test pasa un JWT
*criptográficamente expirado* (el #6 mantiene el JWT vivo y solo envejece `created_at`); el rechazo
de expirados está en código pero **no testeado directamente**.

**VEREDICTO seguridad `/auth/refresh`: SÓLIDO.** Tope absoluto enforzado, `created_at` inmutable y
releído, expirados/revocados rechazados, expiración capeada. Sin hallazgo de seguridad.

## C) Desviación del §10 — TTL 10 vs 30 — ⚠️ (desviación de plan, no bug)

- `JWT_PATIENT_SESSION_TTL_MINUTES` sigue en **10** (`config.ts:51`, `z.coerce.number()…default(10)`).
  §10.1 sugería **30 min** para web. **Es configurable por env** (no hardcode). El reporte lo declara
  abiertamente (auditoría #1, "no cambié … para no romper tests; decidir en prod vía env").
- Consecuencia real: si la app queda en background **>10 min** sin volver al foco, el access vence y,
  como `/auth/refresh` no acepta expirados, el paciente re-loguea. UX más estricta que §10. Registrado
  como **C-2** (decisión de prod, no incumplimiento).

## D) Fix global de Content-Type — ✅ (sin regresión)

- `api.js _fetch` solo añade `Content-Type: application/json` **cuando hay body** (`:65-66`) y solo
  serializa body si existe (`:76`). Los únicos POST sin body son `/auth/refresh` y `/auth/logout`
  (`:130,145`). Todo POST con body (verify-otp, register, cancel, payments, booking…) **sí** manda
  el header.
- Backend: **0** lecturas manuales de `content-type` del request (`grep` en `routes/` + `lib/`).
  Fastify parsea por content-type; sin body y sin header no hay nada que parsear. **Alcance real:
  global pero inocuo**; corrige el 400 que rompía logout/refresh (reporte auditoría #3, exacto).

## E) sessionStorage / PII / XSS — ✅ con trade-off documentado (CSP → F, 🔭)

- Persisten en `sessionStorage`: token (`dk_patient_token`) e info del paciente
  (`dk_patient_info`, JSON con el nombre; `state.js:68`). Trade-off documentado en §10.1 y reporte
  auditoría #2.
- **Nombre del paciente** (lo nuevo que C persiste) se renderiza **escapado**:
  `home.js:16,21` `escapeHtml(firstName)`; idem `home.apple.js`. No se halló sink XSS con el nombre
  sin sanitizar.
- El front usa `escapeHtml` de forma consistente (helper duplicado en 10 archivos — patrón
  preexistente, no introducido por C; ver C-5). 78 usos de `innerHTML` (patrón de render existente).
- **CSP de producción = Hito F** (🔭): mitiga el riesgo de `sessionStorage` + XSS; Turnstile además
  exige `challenges.cloudflare.com` en `script-src`/`frame-src` (reporte auditoría #4). Trade-off
  correctamente diferido.

## F) Resto de sub-tareas C — ✅

- **standby → landing pública:** botón CTA **"Comenzar"** (`standby.js:151-152`); atractor de kiosco
  reemplazado. Logo/nombre escapados (`standby.js:136`).
- **idle.js:** `WARN_AT_MS = 28*60_000`, `LOGOUT_AT_MS = 30*60_000` (`:23-24`); el 60/90 s agresivo
  retirado (comentario `:11`). *(Corrección trivial aplicada — ver abajo.)*
- **register.js:** **0** imports de `keyboard.js`, sin `mountKeyboard`; usa teclado nativo
  (`inputmode`). Atributos `data-kb` quedan **inertes** (sin keyboard.js que los lea) — como dice el
  reporte.
- **payment.apple.js:** botón **"Pagar ahora"** (link Wompi) + **QR como fallback de escritorio**
  (`:126-127`) + **reanudar polling en `visibilitychange`** (`:108-117`).
- **login-cedula.js + lib/turnstile.js:** widget Turnstile con carga **perezosa** del script CF
  (`turnstile.js:16,36`), renderizado solo si `turnstile_sitekey` configurado (`login-cedula.js:91`);
  token adjuntado a `requestOtp` (`:130-134`) con **guarda**: sitekey set y sin token → bloquea
  (`:118-121`). OTP obligatorio (login-direct eliminado).

## G) Cobertura / deuda

- **payment.js (tema NO-apple):** sigue **sin** "Pagar ahora", sin `visibilitychange`, solo QR
  (`payment.js:2,6-8`). **Deuda si `KIOSK_THEME=default`** (reporte auditoría #5). Registrado **C-1**.
- **Fuentes self-host:** `@fontsource/inter` + `@tabler/icons-webfont` en `package.json:13-14`;
  importadas en `main.js:67-72`. **0** refs a CDN de fuentes (`fonts.googleapis`/`gstatic`) en
  `src/` ni `index.html`. ✅ (importa para CSP de F). El bundle incluye `tabler-icons.ttf` de ~2.8 MB
  (fallback navegadores viejos; modernos usan `.woff2`) → menor **C-4**.
- **E2E (🔭, sin BD):** `playwright.config.ts` existe con devices **Pixel 7 / iPad / Desktop**
  (`:33-36`); `webServer` fuerza `DEV_MOCK_EXTERNAL_SERVICES=true` (`:49`). `e2e/patient-flow.spec.ts`:
  3 specs (arranque sin token→OTP→home→citas; sesión sobrevive a refresh; pago móvil "Pagar ahora")
  × 3 perfiles = 9 tests. **iPad forzado a Chromium** (sin WebKit) → **no cubre el motor Safari**
  (declarado por el reporte, auditoría #6). No ejecutado en este entorno → **🔭**.

## H) Gate y números

- **typecheck API:** exit 0 ✅. **builds:** kiosco-frontend ✅ (admin no aplica a C).
- **Suite backend: 🔭** (sin BD). **Aritmética:** 20 archivos de test, **280** bloques `it()/test()`
  contados; `patient-refresh.test.ts` aporta **6**. `280 = 274 (base B) + 6`. **Coincide con el
  reporte** ("280 / 20 archivos"). No verificado en verde por falta de BD.
- **DoD numérico del plan dice "253"** (`plan_abierto_v2.md:201,207`): **desactualizado** (real ≈280).
  No es incumplimiento; el reporte usa 280 y lo declara. Discrepancia del plan, no del hito.

---

## I) Tabla DoD del plan (Hito C) → veredicto

| # | DoD (plan §Hito C) | Veredicto | Evidencia |
|---|--------------------|-----------|-----------|
| 1 | App arranca **sin `kiosk_token`** | ✅ | `main.js` sin gate, `/public/bootstrap`; `api.js` sin kioskToken; 0 login-direct |
| 2 | **Login OTP web** | ✅ | `login-cedula` → `request-otp` (+turnstile_token) → `login-otp`; OTP obligatorio |
| 3 | **home/citas/pago móvil** funcionales | ✅ (build/estático) · 🔭 runtime | "Pagar ahora"+QR+visibility (`payment.apple.js`); E2E sin BD |
| 4 | **E2E móvil verde en Pixel 7** | 🔭 | config+spec existen (9 tests); no ejecutable sin Docker/BD; iPad sin WebKit |
| 5 | **Base de tests backend sigue verde** | 🔭 (suite) · ✅ typecheck | aritmética 280=274+6 cuadra; suite no corrida sin BD |

**Bonus DoD del reporte:** "Sesión sobrevive a refresh" → ✅ por diseño (`sessionStorage` +
`/auth/refresh` revalidado en `main.js:165-172`); E2E test 2 lo cubre (🔭).

---

## Resumen

- **Conteo:** ✅ **5 bloques plenos** (A, B, D, E, F) · ⚠️ **1** (C: TTL 10 vs 30) ·
  🔭 **2 áreas runtime** (suite backend, E2E Pixel 7 — por Docker caído, no por defecto del hito).
  **0 incumplimientos (❌). 0 hallazgos de seguridad.**
- **El reporte NO exagera ni suaviza el DoD:** declara abiertamente TTL 10≠30, la deuda de
  `payment.js` default, iPad sin WebKit, el `.ttf` de 2.8 MB y la dependencia CSP→F. Coinciden con
  el código. Números (280/20) correctos por aritmética.

### 3 hallazgos top
1. **`/auth/refresh` es seguro** (veredicto explícito): tope absoluto **enforzado** desde un
   `created_at` inmutable y releído, expirados/revocados rechazados, expiración capeada al techo. Sin
   defecto. **Único pero:** desviación de UX del §10 (access 10 min vs 30 sugeridos) — configurable.
2. **`payment.js` (tema `default`) sin "Pagar ahora"** → deuda si algún despliegue usa
   `KIOSK_THEME=default` (el camino por defecto es `apple`, que sí lo tiene). **C-1.**
3. **Gap de cobertura** en `/auth/refresh`: no hay test que pase un **JWT criptográficamente
   expirado** y asierte el rechazo (el #6 solo envejece `created_at`). **C-3.**

### Correcciones triviales aplicadas (sin commitear)
- `apps/kiosco-frontend/src/idle.js:43,45` — comentarios JSDoc **obsoletos** ("al alcanzar 90s/60s")
  corregidos a "30 min / 28 min" para coincidir con el código real (`WARN_AT_MS`/`LOGOUT_AT_MS`).
  Lista blanca (comentario engañoso). **No commiteado.** → `pendientes_menores.md` C-6 (🔧).

---

> **Recordatorio al usuario:** ningún archivo de código de C fue modificado salvo la corrección
> trivial de comentarios en `idle.js` (sin commitear). Revisa `git diff` y commitea/descarta antes
> del siguiente pase. **Auditoría detenida en Hito C — no se avanzó al Hito D.**
