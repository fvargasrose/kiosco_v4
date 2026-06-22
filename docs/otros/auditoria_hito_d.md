# Auditoría independiente — Hito D (Responsive + routing completo)

> **Auditor:** rol de verificación independiente, modo HÍBRIDO (verifica; no implementa, no
> fusiona; corrige solo trivia de lista blanca sin commitear).
> **Fecha:** 2026-06-04 · **Rama auditada:** `hito-d-responsive-routing` (tip `75094cb`).
> **Base de diffs:** `hito-c-front-web` (tip de C) → el diff muestra SOLO lo que D añadió sobre C.
> **Leyenda:** ✅ cumple · ⚠️ matiz/desviación · ❌ incumple · 🔭 no verificable en este entorno.

---

## 0. Entorno

- **Docker daemon CAÍDO** (`/var/run/docker.sock` → HTTP `000`, CLI no en PATH). Sin Postgres/Redis
  → **suite backend y E2E Playwright = 🔭** (pase mayormente estático: specs + código de routing/CSS,
  aritmética como en B/C). Lo verificable sin BD se ejecutó.
- **typecheck:** exit 0 ✅. **build kiosco-frontend:** ✅ (`✓ built in 954ms`).
- **lint:** exit 2 (ESLint 9 sin `eslint.config.js`) — **gap PREEXISTENTE**, una línea ⚠️.
- **Árbol:** sin arrastre de tracked (esta vez `estados_hitos.md` no se arrastró). Queda `M idle.js`
  = **corrección trivial del Hito C** (carried-over; D no tocó esos comentarios) — se deja y se anota,
  no es ruido de D.
- **Alcance de D (diff sobre C):** `index.html` (2), `main.js` (23), `router.js` (94),
  `styles-apple.css` (15), `e2e/helpers.ts` (22), `patient-flow.spec.ts` (-25, extrae helpers),
  `responsive-routing.spec.ts` (+68 nuevo), `estados_hitos.md`. **D NO tocó `apps/api`** (diff vacío)
  → suite backend heredada de C (280), sin cambios.

---

## A) Routing History API — ✅

- `router.js`: tabla `ROUTES` nombre↔path con **12 rutas** (`router.js:22-35`): incluye las 10 del
  plan (`/inicio /citas /tratamientos /agendar /pagar /perfil /ingresar /ingresar/codigo /registro
  /aviso-privacidad`) + `standby '/'` + `faq '/faq'`. `pathForScreen`/`screenForPath` con normalización
  de trailing slash (`:39-47`).
- `navigate()` hace `pushState`/`replaceState` (`:147,149`) con `params` en `history.state`
  (`:145`). `initRouter()` instala `popstate` (`:159-170`); entrada sin estado → deriva de la URL
  (`:166`). ✅
- `main.js`: resuelve pantalla inicial por **URL + sesión** (`main.js:169-187`): `initRouter()` +
  `screenForPath(location.pathname)`. ✅
- `index.html`: se **quitó** `user-scalable=no, maximum-scale=1`; se añadió `viewport-fit=cover`
  (`index.html:5`). Coincide con la decisión del plan ("mantener zoom habilitado"). ✅

## B) Deep-link / autoredirección — ✅ SEGURA (sin bypass)

> Pregunta crítica del pase: ¿la autoredirección "intencional" permite saltarse habeas-data/OTP o
> iniciar pago sin sesión? **No.** Defensa en profundidad confirmada (no se tocó nada).

**Gate en `main.js` (resolución inicial):**
- **Con sesión** válida (`api.hasSession` + `refreshSession()` ok + `state.patient`): respeta el
  deep-link a `urlScreen` (incluso AUTHED) con `navigate(target, {}, {replace})` y **params vacíos**
  (`main.js:172-178`).
- **Sin sesión:** `target = urlScreen ∈ PUBLIC_SCREENS ? urlScreen : 'standby'`
  (`main.js:184-186`). `PUBLIC_SCREENS = {standby, faq, habeas-data, login-cedula, login-otp,
  register}` (`:51-53`). → cualquier AUTHED en frío (`/pagar`, `/inicio`, `/citas`, `/tratamientos`,
  `/perfil`) **sin sesión → standby**. ✅

**Gate en cada pantalla (defensa redundante):**

| Caso (deep-link en frío) | Resultado | Evidencia |
|--------------------------|-----------|-----------|
| `/ingresar/codigo` sin `requestId` | → `habeas-data`, **no salta OTP** | `login-otp.js:15-17`; además `verifyOtp({requestId,code})` exige request_id+code server-side (`:102`) |
| `/pagar` sin sesión | → `standby` (doble gate) | `main.js` PUBLIC + `payment.apple.js:14-16` / `payment.js:32-34` `!state.patient → standby` |
| `/pagar` con sesión, sin params | → `returnTo` (treatments) **antes** de `createPayment` | `payment.apple.js:21-23` (redirect en `:22`, `createPayment` en `:68`); `payment.js:39-41` idéntico |
| `/citas` `/tratamientos` `/inicio` con sesión | restauran (sessionStorage) | `main.js:172-178` `target=urlScreen`; specs `:33-36` |

**VEREDICTO B:** la autoredirección **no abre ningún bypass**. No se puede iniciar un pago sin
sesión ni con sesión-sin-params (redirige antes del `POST /me/payments`), ni saltar el OTP por
deep-link a `/ingresar/codigo`. Sin hallazgo de seguridad.

## C) Responsive — afirmación del reporte **SE SOSTIENE** (con matices de cobertura)

**Afirmación del reporte:** "el front ya era responsive (sidebar @900px, bottom-nav @600px); solo
añadí overflow test + columna única <400px + targets ≥44px". **Verificada contra el código:**

- ✅ **CIERTA.** La base C del tema apple ya traía `@media (max-width:900px)` (sidebar colapsable,
  `styles-apple.css:560` en C), `@media (max-width:600px)` (bottom-nav, `:573`), además de 380px y
  800px. D **solo añadió** (`diff styles-apple.css`): `@media (max-width:400px){ grid 1fr }` y
  `@media (max-width:900px) and (pointer:coarse){ … min-height:44px }`. **El reporte no exagera.**
- ⚠️ **Cobertura parcial del test de overflow:** `responsive-routing.spec.ts:50`
  `test.skip(project.name !== 'Desktop', …)` → corre **solo en Desktop chromium** con viewports
  forzados (`setViewportSize`, `:58`). **No** ejercita `pointer:coarse` (Desktop es `pointer:fine`)
  ni un motor móvil real. Mide solo desbordamiento de ancho. (Coincide con la auto-confesión del
  reporte, auditoría #11.) **D-2.**
- ⚠️ **Desviación de método vs DoD:** el plan §6.1-D pide **"Snapshots por breakpoint"**; se
  implementó una **assertion de overflow** (`scrollWidth-clientWidth ≤ 1`), no snapshots visuales.
  Cumple el espíritu (responsive verificable) pero **cambia el método**. **D-1.**
- Breakpoints del test: exactamente **360/768/1280** (`:54`) ✅. Paths cubiertos: `/`,
  `/aviso-privacidad`, `/inicio`, `/citas`, `/tratamientos`, `/agendar` (`:55`) — **no** cubre
  `/pagar` ni `/perfil` (menor; `/pagar` requiere params). **D-3.**
- Nota: las adiciones CSS de D están **solo en `styles-apple.css`** (tema web por defecto). El tema
  `default` (`styles.css`) conserva media queries orientadas a kiosco (orientation/1400px); no recibe
  la columna <400px ni `≥44px`. Consistente con la deuda C-1 (tema default es camino no-web).

## D) SPA fallback (dependencia de F) — 🔭

- El deep-link funciona en dev por el fallback de Vite; en **producción depende del
  `try_files … index.html` de Caddy** (`router.js:12` lo asume; reporte "confirmar en F"). No
  verificable en dev. **Declarado como dependencia de Hito F a no olvidar (D-4).**

## E) Gate y números

- **typecheck API:** exit 0 ✅. **build kiosco-frontend:** ✅.
- **E2E: 🔭** (sin BD). **Aritmética:** `patient-flow.spec.ts` 3 tests + `responsive-routing.spec.ts`
  3 tests, × 3 perfiles (Pixel7/iPad/Desktop) = 18; el test de overflow hace `skip` en Pixel7+iPad
  (`:50`) = **2 skipped** → **16 activos + 2 skipped = 18 total**. **Coincide con el reporte**
  ("16 verdes + 2 skipped"). No corrido en verde por falta de BD.
- **Suite backend: 🔭** — D no tocó `apps/api`; hereda los **280** de C (no re-contado).

---

## F) Tabla DoD del plan (Hito D) → veredicto

| # | DoD (plan §Hito D) | Veredicto | Evidencia |
|---|--------------------|-----------|-----------|
| 1 | **URLs reales operativas** (deep-link, back, refresh) | ✅ (estático) · 🔭 runtime | `router.js` History API; `responsive-routing.spec.ts:14-37` (deep-link+back+reload+sesión) |
| 2 | **Responsive correcto en 360/768/1280** | ⚠️ | Front ya responsive (CSS confirmado); verificado por overflow (no snapshots) solo en Desktop → cobertura parcial |
| 3 | **E2E routing + responsive verdes** | 🔭 | specs existen (16+2); no ejecutables sin Docker/BD |

---

## Resumen

- **Conteo:** ✅ **2 bloques plenos** (A routing, B seguridad de autoredirección) · ⚠️ **1**
  (C responsive: método overflow≠snapshots + cobertura solo-Desktop) · 🔭 **3 áreas runtime**
  (E2E, suite backend, SPA fallback de prod). **0 incumplimientos (❌). 0 hallazgos de seguridad.**
- **El reporte no exagera ni suaviza:** la afirmación fuerte "ya era responsive" es **literalmente
  cierta** en el CSS; el reporte declara por su cuenta la cobertura solo-Desktop (auditoría #11) y la
  dependencia de F. La única desviación no explicitada como tal es **método overflow vs snapshots**
  del DoD — la declaro aquí (D-1).

### 3 hallazgos top
1. **La afirmación "ya era responsive" SE SOSTIENE** (sidebar @900px / bottom-nav @600px ya en la
   base C; `styles-apple.css:560,573`). D solo añadió columna <400px + targets ≥44px. Sin exageración.
2. **La autoredirección de `/pagar` e `/ingresar/codigo` es SEGURA**: doble gate (PUBLIC_SCREENS en
   `main.js` + `!state.patient`/`!params` en cada pantalla, redirigiendo **antes** de `createPayment`
   y de cualquier verificación de OTP). Sin bypass.
3. **Desviación de método del DoD** (D-1) + **cobertura parcial** (D-2): el plan pedía *snapshots por
   breakpoint*; se hizo *assertion de overflow* en **solo Desktop chromium** (no `pointer:coarse`, no
   motor móvil). Verde por aritmética (16+2), no ejecutado (🔭).

### Correcciones triviales aplicadas (sin commitear)
- **Ninguna en el Hito D.** (Persiste `M idle.js` de la corrección trivial del Hito C — comentarios
  JSDoc obsoletos; ya registrada como C-6. No es del pase D.)

---

> **Recordatorio al usuario:** ningún archivo de código de D fue modificado en este pase. El working
> tree solo tiene: `M idle.js` (corrección trivial heredada del Hito C, pendiente de tu revisión),
> `M plan_abierto_v2.md` (tu cambio de F/G) y los `.md` de auditoría/pendientes. Revisa `git diff` y
> commitea/descarta antes del siguiente pase. **Auditoría detenida en Hito D — no se avanzó al Hito E.**
