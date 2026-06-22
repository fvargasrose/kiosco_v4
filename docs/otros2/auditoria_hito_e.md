# Auditoría independiente — Hito E (Admin responsive)

> **Auditor:** rol de verificación independiente, modo HÍBRIDO (verifica; no implementa, no
> fusiona; corrige solo trivia de lista blanca sin commitear).
> **Fecha:** 2026-06-04 · **Rama auditada:** `hito-e-admin-responsive` (tip `4447ac6`, tope del stack).
> **Base de diffs:** `hito-d-responsive-routing` (tip de D) → el diff muestra SOLO lo que E añadió.
> **Leyenda:** ✅ cumple · ⚠️ matiz/desviación · ❌ incumple · 🔭 no verificable en este entorno.

---

## 0. Entorno

- **Docker daemon CAÍDO** (`/var/run/docker.sock` → HTTP `000`). Sin Postgres/Redis →
  **E2E Playwright y suite backend = 🔭** (pase estático + aritmética). El hallazgo del admin de
  prueba **no necesita runtime** (git/grep).
- **typecheck:** exit 0 ✅. **build admin-frontend:** ✅ (`✓ built in 289ms`). **lint:** exit 2
  (gap PREEXISTENTE ESLint 9) ⚠️.
- **Árbol:** sin arrastre de tracked. Persiste `M idle.js` = corrección trivial del Hito C
  (heredada, ya registrada C-6) — no es del pase E.
- **Alcance de E (diff sobre D):** `apps/admin-frontend/index.html` (+36), `…/src/main.js` (+21),
  `e2e/admin-responsive.spec.ts` (+66 nuevo), `e2e/helpers.ts` (+17), `playwright.config.ts` (+6),
  `estados_hitos.md`, `levantar_2.md` (nuevo), `reporte_hitos_A_b_c_d_e.md` (nuevo). **E NO tocó
  `apps/api`** (diff vacío) → suite backend heredada de C (280), sin cambios.

---

## A) Shell responsive — ✅

- `admin-frontend/index.html`: **media queries `@media (max-width:768px)` y `(max-width:480px)`**
  (antes 0). Topbar + hamburguesa (`.topbar`, `.hamburger`); **sidebar off-canvas**
  (`position:fixed; transform:translateX(-100%)` → `.shell.nav-open .sidebar{translateX(0)}`);
  **backdrop** (`.sidebar-backdrop`, `.nav-open` → overlay); `.main { min-width:0 }`;
  `modal-card{max-width:100%}` y cards full-width en móvil; `dentist-admin-grid:1fr` @768px.
- `main.js`: markup de topbar+hamburguesa+backdrop; `setNav(open)` togglea `.nav-open` y
  `aria-expanded`; click en hamburguesa/backdrop; **`setNav(false)` cierra el menú al navegar**
  (`main.js` navigate). ✅ Todos los ítems del DoD del shell presentes.

## B) *** HALLAZGO DE SEGURIDAD — credencial de admin commiteada *** — 🔴 ALTA (con mitigación práctica)

> No se tocó nada (credencial/config de test = prohibido). Solo lectura.

**Hechos verificados:**
- `e2e/helpers.ts:53-54`: `ADMIN_EMAIL='admin@e2e.local'`, **`ADMIN_PASSWORD='E2e@Admin2026'`
  HARDCODEADA y COMMITEADA**. `git log -- e2e/helpers.ts`: el archivo nace en `9d81beb` (Hito C) y
  el bloque admin se añade en **`6153995`** (commit de Hito E). La credencial queda **en el
  historial git de forma permanente**.
- El admin se crea **manualmente** vía `setup.ts create-admin` (`estados_hitos.md:105`;
  `setup.ts:62-66` fija `mfa_required=false, must_change_password=true`). **`setup.ts` NO tiene
  guard de entorno** — puede ejecutarse en producción con cualquier credencial.
- **NO existe seed automático del admin e2e.** `seed.ts` crea `admin@demo.local` (`seed.ts:118`),
  **no** `admin@e2e.local`, y **sí tiene guard de prod** (`seed.ts:31` `if NODE_ENV==='production'
  throw`). Ningún script/CI/installer siembra el admin e2e (grep limpio).

**Mecanismo que impida llegar a prod:** **no hay** gitignore, ni guard de entorno en `setup.ts`,
ni seed-solo-dev específico del admin e2e. Por la rúbrica del pase ⇒ **severidad ALTA**.

**Mitigación práctica (honesta):** ningún camino *automático* introduce este admin en prod; requiere
**acción manual** del operador (copiar la BD de dev a prod, o ejecutar `setup.ts create-admin` con
estas credenciales). El reporte lo declara abiertamente (`estados_hitos.md:107-109` "NO debe existir
en producción — revisar/eliminar antes de cualquier despliegue").

**Factores que AGRAVAN si llega a prod (ver C y D):** ese admin tiene `mfa_required=false`
(login full sin segundo factor, Caso 3) **y** `must_change_password` **no está gateado** → sesión de
admin con acceso total, contraseña pública en git, sin MFA y sin rotación forzada.

**Recomendación (no aplicada):** rotar/eliminar el row en cualquier despliegue; mover credenciales
E2E a variables de entorno; añadir guard de entorno a `setup.ts` (rechazar correos `*@e2e.local` o
exigir `--force` fuera de dev). **Reportado, no corregido.**

## C) MFA no ejercitado por el E2E — ⚠️ (DoD parcial)

- El plan (`plan_abierto.md §6.1-E`) pide E2E admin con **"login + MFA"**. El E2E usa
  `admin@e2e.local` con **`mfa_required=false`** (`adminLogin` en `helpers.ts:56-66`) → entra por el
  **Caso 3** del login (`admin-auth.ts:276-303`, sesión `mfaVerified:true` directa). **El camino MFA
  (TOTP enroll/verify) NO se ejercita en E2E.** DoD parcialmente incumplido (login+shell sí, MFA no).
- **Cobertura compensatoria:** `apps/api/tests/admin-auth.test.ts` = **17 tests** unitarios (incluye
  flujos MFA). El reporte lo declara (`estados_hitos.md:110-114`). ⚠️ aceptable pero declarado.

## D) `must_change_password` NO gateado — ⚠️ (riesgo real, preexistente)

- Verificado en el login: `must_change_password` se devuelve **solo como flag** en la respuesta
  (`admin-auth.ts:272` y `:302`) — **no bloquea** la emisión del token. En el Caso 3
  (`mfa_required=false`, el del admin e2e) el login firma una sesión **`mfaVerified:true` completa**
  (`:277-282`) y la entrega; el flag es informativo. **No hay enforcement en login ni en
  `requireAdmin`.**
- Consecuencia: un admin con `must_change_password=true` (todos los creados por `setup.ts`, incl. el
  de prod del installer) **entra y opera sin cambiar la contraseña**. El reporte lo reconoce
  (`estados_hitos.md:118-119`). Preexistente, fuera del alcance de E, pero **es un riesgo real**:
  el "deberá cambiar la contraseña en el primer login" de `setup.ts:74` **no se cumple**. **E-2.**

## E) Token admin en `localStorage` (§1.4) — ⚠️ trade-off conocido

- `admin-frontend/src/api.js:18,23`: token en **`localStorage`** ("sesiones de larga duración"),
  no `sessionStorage` ni cookie httpOnly. Riesgo XSS persistente (robo de token), nota preexistente
  del plan §1.4. Sin cambios en E.
- **Sinks XSS:** el admin **sí escapa** los datos de servidor/usuario con un helper `esc()`
  (duplicado en 5 pantallas: `transactions.js:229`, `kiosks.js:284`, `dashboard.js:161`,
  `clinic-config.js:685`, `dentists.js:158`). Muestreo: nombre de paciente, `status_message`,
  `dentalink_treatment_id`, nombre de dentista, especialidad → todos `esc()` (`transactions.js:183-194`;
  `dentists.js:115-151`). **No se halló sink sin escapar.** Patrón preexistente (Hito 9), no de E.
- **CSP de prod = Hito F** (🔭): mitiga el binomio `localStorage`+XSS. Trade-off documentado. **E-3.**

## F) Tablas responsive — ✅ (afirmación "solo tocó el shell" = CIERTA)

- **Verificado contra el diff:** el cambio de E en `apps/admin-frontend` son **solo** `index.html` +
  `main.js` (el shell). **Ninguna pantalla/tabla fue modificada por E.**
- Las tablas ya traían el wrapper **`<div style="overflow-x:auto">`**: `transactions.js:147`,
  `kiosks.js:87` (preexistentes). `dentist-admin-grid` ya usaba `grid auto-fill`
  (`index.html:109` en base D). E añade `.main{min-width:0}` y `dentist-admin-grid:1fr` @768px para
  que el scroll viva en el contenedor y no en el body. **El reporte no exagera.**
- No se halló pantalla omitida que desborde: `clinic-config` y `dashboard` son formularios/cards (sin
  tablas anchas); las dos pantallas con tabla (`transactions`, `kiosks`) tienen `overflow-x:auto`.

## G) Breakpoint 768px — ⚠️ menor

- Off-canvas se activa en `@media (max-width:768px)`; **iPad (810px) queda por encima → usa el layout
  de escritorio** (sidebar fijo, sin drawer). Usable (cabe sidebar+contenido), pero no hay drawer en
  tablet. El E2E lo asume (`admin-responsive.spec.ts:43-50`, iPad en rama "desktop/tablet"). Menor. **E-4.**

## H) Gate y números

- **typecheck API:** exit 0 ✅. **build admin-frontend:** ✅. **lint:** exit 2 (preexistente).
- **E2E: 🔭** (sin BD). **Aritmética (C+D+E, 3 perfiles Pixel7/iPad/Desktop):**
  - `patient-flow` 3 tests → 9 activos / 0 skip
  - `responsive-routing` 3 tests → 7 activos / 2 skip (overflow solo-Desktop)
  - `admin-responsive` 4 tests → 7 activos / 5 skip (test1 ×3; "móvil" ×2 = 2act+4skip; "desktop/tablet" 2act+1skip)
  - **Total: 23 activos + 7 skipped.** **Coincide con el reporte** ("23 verdes + 7 skipped"). No corrido en verde por falta de BD.
- **Suite backend: 🔭** — E no tocó `apps/api`; hereda los **280** de C.

---

## I) Tabla DoD del plan (Hito E) → veredicto

| # | DoD (plan §Hito E) | Veredicto | Evidencia |
|---|--------------------|-----------|-----------|
| 1 | **Admin usable en móvil/tablet** | ✅ (estático) · 🔭 runtime | `index.html` @768/@480 off-canvas+topbar; `main.js` setNav; tablas `overflow-x:auto` |
| 2 | **E2E admin móvil verde** | 🔭 | `admin-responsive.spec.ts` (4 tests, 7+5); no ejecutable sin Docker/BD |
| 3 | E2E con **"login + MFA"** (texto del §6.1-E) | ⚠️ parcial | login+shell sí; **MFA no ejercitado** (admin sin MFA); compensado con 17 tests unitarios |

---

## Resumen

- **Conteo:** ✅ **2 bloques plenos** (A shell, F tablas) · ⚠️ **4** (C MFA no E2E, D
  must_change_password no gateado, E token localStorage, G breakpoint iPad) · 🔴 **1 ALTA**
  (B credencial admin commiteada) · 🔭 **2 runtime** (E2E, suite). **0 incumplimientos duros del DoD
  de responsive.**
- **El reporte es FRANCO:** declara por su cuenta el admin de prueba ("no debe existir en
  producción"), el MFA no ejercitado, el breakpoint iPad y `must_change_password` no gateado. No
  suaviza; coincide con el código.

### 3 hallazgos top
1. **🔴 ALTA — Credencial de admin commiteada** (`E2e@Admin2026`, `helpers.ts:54`, en git desde
   `6153995`). **Sin guard** en `setup.ts` que impida crearla en prod; `seed.ts` sí protege pero crea
   otro admin. **Mitigación:** requiere acción manual del operador (no hay seed automático a prod). Se
   AGRAVA por `mfa_required=false` + `must_change_password` no gateado. Rotar/eliminar antes de
   desplegar; mover creds E2E a env; añadir guard a `setup.ts`.
2. **`must_change_password` NO se enforza** (`admin-auth.ts:272,302` solo flag; Caso 3 emite sesión
   completa). El "cambio obligatorio en el primer login" de `setup.ts:74` es **letra muerta** —
   preexistente, afecta también al admin de prod del installer.
3. **DoD del E2E parcial:** el plan pedía "login + MFA"; el MFA **no se ejercita** (admin sin MFA).
   Compensado con `admin-auth.test.ts` (17 unitarios), pero el camino TOTP end-to-end queda sin E2E.
   La afirmación "solo tocó el shell" para las tablas **sí se sostiene** (diff confirmado).

### Correcciones triviales aplicadas (sin commitear)
- **Ninguna en el Hito E.** (Persiste `M idle.js` del Hito C — ya registrado como C-6.)

---

> **Recordatorio al usuario:** ningún archivo de código de E fue modificado en este pase. El working
> tree solo tiene `M idle.js` (corrección trivial del Hito C pendiente de tu revisión),
> `M plan_abierto_v2.md` (tu cambio F/G) y los `.md` de auditoría/pendientes. Revisa `git diff` y
> commitea/descarta. **Hito E auditado — fin de los hitos por separado; queda el pase transversal de
> seguridad. No avancé a él.**
