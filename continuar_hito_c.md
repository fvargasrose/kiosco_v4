# Continuar — Auditoría del Hito C (handoff para nueva conversación)

> **Propósito:** arrancar en limpio la auditoría del **Hito C — Front web del paciente**,
> con todo el contexto que las auditorías de A y B dejaron. Pegar el bloque de ROL (abajo)
> al iniciar la nueva conversación.
> **Fecha de cierre de la sesión anterior:** 2026-06-04. **Auditor:** rol híbrido.

---

## 0. Estado actual del repo (al cerrar hoy)

- **Rama actual:** `hito-e-admin-responsive` (HEAD). Contiene A+B+C+D+E en cadena lineal.
- **Working tree (sin commitear):**
  - `M plan_abierto_v2.md` ← cambio del usuario (añadió Hitos F y G). **NO es de auditoría.**
  - `?? auditoria_hito_a.md`, `?? auditoria_hito_b.md` ← reportes de auditoría entregados.
  - `?? pendientes_menores.md` ← registro acumulado de hallazgos menores.
- **Las auditorías NO commitean.** Antes del siguiente pase, el usuario debe revisar
  `git diff` y commitear/descartar lo que quiera. Ningún código fue modificado por las
  auditorías (solo se añadieron `.md`).

## 1. Topología git / estado de fusión (¡importante!)

```
hito-e-admin-responsive (HEAD)  ── D, E encima de ──┐
  ...E... 4447ac6                                    │
  ...D... 75094cb                                    │
  ...C... 00fed12 9d81beb 0c00288 e10753f bcc43be 69770d3
main / sistema_abierto = 569e25c  "Merge hito-b" [ahead 17]  ← SOLO contiene A + B
  └ Hito B: 8c91405 e174af1 8350a1d 8b93dc7 4ec62e4
  3826f6f "Merge Hito A"
  └ Hito A: a396522 … f6c3e95
```
- **`main` solo tiene A + B fusionados. C/D/E NO están en main** (viven en la rama
  `hito-e-admin-responsive` y en sus ramas `hito-c-front-web`, `hito-d-responsive-routing`).
- **NO diffear contra `main`** para auditar C: contamina (main no tiene C). Usar base por rango.

## 2. Base de diffs para Hito C

- **Commits de C** (rama `hito-c-front-web`, también en la cadena de HEAD):
  | Hash | Descripción |
  |------|-------------|
  | `69770d3` | feat(auth): endpoint `/auth/refresh` (sesión deslizante + máximo absoluto, §10) ← **único backend** |
  | `bcc43be` | feat(web): cliente público sin kiosk_token + sesión en `sessionStorage` (§10) |
  | `e10753f` | feat(web): landing pública, restauración de sesión, idle relajado, fuentes self-host |
  | `0c00288` | feat(web): widget Turnstile en login, teclado nativo en registro, pago móvil |
  | `9d81beb` | test(e2e): Playwright (Pixel7/iPad/Desktop) + fix fetch |
  | `00fed12` | docs(bitacora): cierre del Hito C (`estados_hitos.md`) |
- **Base limpia = `69770d3^` = `569e25c`.** Diffs de C: `git diff 569e25c..hito-c-front-web`.
- **Auditar sobre HEAD es válido** si se confirma antes que D/E no tocaron lo de C
  (técnica usada en B: `git diff <tip-C>..HEAD -- <archivos>`; si vacío → HEAD == C).
  Para C, los archivos clave son frontend (`apps/kiosco-frontend/src/*`) + backend
  `apps/api/src/routes/patient-auth.ts` (`/auth/refresh`) y `playwright.config.ts` (raíz).

## 3. Entorno — quirks y arranque (LEER antes de verificar runtime)

⚠️ **En la sesión anterior el Docker daemon estaba CAÍDO** (`/var/run/docker.sock` existe
pero `curl --unix-socket … /_ping` → HTTP 000; el CLI `docker` tampoco estaba en PATH).
Sin Postgres/Redis no se pudo correr la suite ni smoke HTTP. **Primero verificar Docker:**

```bash
# ¿daemon vivo?
curl -s --unix-socket /var/run/docker.sock http://localhost/_ping -w '%{http_code}\n'   # 200 = ok
docker ps    # si "command not found" o ping 000 → daemon/CLI no disponibles esta sesión
```

- **Puertos:** el `.env` usa **Postgres 5434 / Redis 6381**. El `docker-compose.override.yml`
  en HEAD mapea a **5433/6380** (NO coincide). En `hito-a` mapeaba 5433/6380; el commit
  `39c36e3` de la rama B reajustó a 5434/6381. **Verificar qué mapea el override actual**
  (`grep -A2 ports docker-compose.override.yml`) y usar esos puertos.
- **`dotenv/config` NO sobreescribe env existente** → se puede forzar puerto desde el shell:
  `POSTGRES_PORT=<x> REDIS_PORT=<y>` antes del comando gana sobre `.env`.
- **Levantar infra (si Docker funciona):** `docker compose up -d postgres redis`
  (container_name fijos `dk-postgres`/`dk-redis`). La BD persiste volúmenes con las **17
  migraciones aplicadas** (en la sesión previa `migrate:status` → 17/17, 0 pendientes).

**Comandos de verificación (prefijo `DOTENV_CONFIG_PATH=$(pwd)/.env`, puerto override si aplica):**
```bash
# typecheck (NO requiere BD): exit 0 confirmado en sesión previa
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
# suite backend (requiere Postgres+Redis): en A daba 262/18; B aritmética 274
DOTENV_CONFIG_PATH=$(pwd)/.env POSTGRES_PORT=<x> REDIS_PORT=<y> pnpm --filter @dentalkiosco/api test
# lint: SIEMPRE exit 2 (ESLint 9 sin eslint.config.js) → GAP PREEXISTENTE, no investigar
pnpm lint
```
- **Hito C es FRONTEND + E2E.** Verificación propia de C:
  ```bash
  pnpm --filter @dentalkiosco/kiosco-frontend dev    # http://localhost:5173
  pnpm --filter @dentalkiosco/kiosco-frontend build   # build de prod
  pnpm test:e2e                                        # Playwright (necesita config + browsers + API+front arriba)
  ```
  - **`playwright.config.ts`** debía crearse en C (era una sub-tarea). **Verificar que
    existe** (`ls playwright.config.ts`) y los devices Pixel7/iPad/Desktop.
  - Playwright necesita navegadores (`npx playwright install`) y la API + front sirviendo.
    Si no se pueden levantar → marcar E2E como 🔭 con el motivo (igual que en B).
  - Hay un **MCP `playwright`** disponible en este entorno (browser_navigate, snapshot,
    etc.) por si conviene un smoke manual del front sin la suite E2E.
- **Truco para OTP en dev** (usado en A): el código vive en Redis `otp:dev:<phone>` como JSON
  `{"code","request_id","expires_at"}`. Leerlo: `docker exec dk-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning GET "otp:dev:+573001234567"`. Paciente mock válido:
  `+573001234567` (María, en `lib/dentalink.ts`). Arrancar API mock en puerto alterno:
  `API_PORT=3100 POSTGRES_PORT=<x> REDIS_PORT=<y> DEV_MOCK_EXTERNAL_SERVICES=true DEV_MOCK_WOMPI=true DEV_LOG_OTP=true pnpm --filter @dentalkiosco/api dev`.

## 4. Fuentes de verdad (leer del repo antes de auditar)

- **`plan_abierto_v2.md`** → sección **`## Hito C`** (en HEAD, **línea ~161**). DoD al final.
- **`plan_abierto.md`** → **§6.1 fila C** (pruebas) y **§10** (sesión web: refresh deslizante,
  sessionStorage, idle). ⚠️ Este archivo **fue movido a `docs/otros/plan_abierto.md`** en la
  rama B; en HEAD puede no estar en la raíz. Extraer con:
  `git show hito-b-seguridad-perimetro:docs/otros/plan_abierto.md > /tmp/plan_abierto.md`.
- **Reporte/bitácora de ejecución de C:** `estados_hitos.md` (commit `00fed12` "cierre del
  Hito C") y/o `hito_conversacion.md`. (Los reportes de A y B estaban en `hito_b.md`, que
  vive en `docs/otros/` o raíz de la rama B: `git show hito-b-seguridad-perimetro:hito_b.md`.)
- **Contraste obligatorio (3 vías):** (1) lo que el reporte AFIRMA · (2) lo que el código
  HACE · (3) el DoD del PLAN. Si el reporte suavizó el DoD, declararlo como hallazgo.

## 5. DoD del Hito C (a verificar punto por punto)

Del plan (`plan_abierto_v2.md §Hito C`):
1. **App arranca sin `kiosk_token`** (frontend contra `/public/bootstrap`; sin
   `showUnpairedScreen`; sin `kioskToken`/`_useKiosk` en `api.js`).
2. **Login OTP web** funcional; sesión persistida en **`sessionStorage`**; integra
   **`/auth/refresh`** (sesión deslizante + máximo absoluto, §10); adjunta **token Turnstile**
   en `request-otp`.
3. **home / citas / tratamientos / pago móvil** funcionales; botón **"Pagar ahora"** abre
   link Wompi + reanuda polling en `visibilitychange`; QR como fallback de escritorio.
4. **idle** relajado (no 60/90 s; ~30 min o nada). **register** usa teclado nativo (sin
   `mountKeyboard`). Standby → decisión landing pública vs login directo.
5. **`playwright.config.ts`** creado (Pixel7/iPad/Desktop). **E2E móvil verde en Pixel 7.**
6. **Backend sigue verde:** typecheck + suite (el plan dice "253"; realidad: A=262, B≈274;
   confirmar el número real y declarar la discrepancia del DoD numérico, como en A/B).
7. **`/auth/refresh`** (backend, `patient-auth.ts`, commit 69770d3): auditar sesión
   deslizante y **máximo absoluto** — que no permita refrescar indefinidamente; revisar que
   no reintroduzca dependencia de kiosk y que respete revocación/expiración.

## 6. Modo HÍBRIDO — reglas (igual que en B)

- **CORREGIR (lista blanca ESTRICTA, sin commitear):** comentarios obsoletos/engañosos,
  typos, imports/vars muertos evidentes, strings de documentación. Dejar sin commitear y
  listar en el reporte + `pendientes_menores.md` (estado 🔧).
- **PROHIBIDO corregir en:** `payments.ts`, `reconciler.ts`, `license/*`, cualquier
  migración, y toda lógica de seguridad (`turnstile.ts`, rate-limit en `server.ts`,
  `auth-middleware.ts`, buckets/Turnstile de `patient-auth.ts`, **incluido `/auth/refresh`
  por ser auth**), ni tests que asierten seguridad.
- **REPORTAR Y DETENERSE (no tocar):** hallazgos de seguridad, DoD no cumplido, discrepancias
  con el reporte, cualquier cosa con criterio. **Ante la mínima duda → reportar.**
- **Menores fuera de lista blanca** (tests vacuos, decisiones de config) → `pendientes_menores.md`
  estado ⬜, y seguir.
- **Salida:** `auditoria_hito_c.md` (✅/⚠️/❌/🔭 + evidencia archivo:línea o salida de comando).
  **Agregar** sección "## Hito C" a `pendientes_menores.md` (NO reescribir; tabla
  `| ID | Hallazgo | Tipo | Destino | Estado |`, IDs `C-1, C-2, …`). Recordar al usuario
  revisar `git diff` y commitear/descartar. **No avanzar al Hito D.**

## 7. Hallazgos previos relevantes para C

- **🔴 ALTO abierto (Hito B):** bypass del rate-limit por `X-Forwarded-For` (`server.ts:48`
  `trustProxy:true` + `keyGenerator:req.ip` + `allowList isLoopback(req.ip)`). Probado por
  PoC: `XFF` falsificable → rotar IP o `XFF:127.0.0.1` evade/omite el limitador, **incluso
  detrás de Caddy**. Mitigación = Hito F (`trusted_proxies`). No corregir; sigue pendiente.
- **Turnstile en C:** el front debe **adjuntar el token** Turnstile en `request-otp`
  (sub-tarea C). El backend ya lo exige fail-closed solo si `TURNSTILE_SECRET` está set
  (dev/test: omitido). Verificar que el widget se monte en `login-cedula.js` y que el token
  viaje en el body (`turnstile_token`, ya aceptado por el schema, `patient-auth.ts:59`).
- **Comentario obsoleto** `apps/api/src/routes/patient-auth.ts:10` (menciona
  `Authorization: Bearer <kiosk_token>` en request-otp; ya no aplica). Registrado en
  `auditoria_hito_a.md`. Es archivo de seguridad → en modo híbrido, **dudoso de tocar**;
  se dejó sin corregir. Decidir en C si se registra como menor doc.
- **Lint:** `pnpm lint` → exit 2 **preexistente** (ESLint 9 sin flat config). Una línea ⚠️,
  no investigar. Gate efectivo = typecheck + suite.
- **DoD numérico de tests:** el plan dice "253"; ya está desactualizado (A=262/18, B≈274).
  No es incumplimiento; declararlo.

## 8. Pendientes menores ya registrados (en `pendientes_menores.md`)
- **B-1** ⬜ `RATE_LIMIT_OTP_PER_IP_PER_HOUR` (config.ts:61, default 10) muerta; bucket ip
  hardcodea 5. — chore.
- **B-2** ⬜ `security.test.ts` no cubre XFF forjado como ataque. — test.
- **B-3** ⏸️ Twilio geo-permissions Colombia + alertas de facturación (diferido a F/G). — plan.

---

## 9. BLOQUE DE ROL — pegar al iniciar la nueva conversación

```
ROL: AUDITOR de software independiente, modo HÍBRIDO. Por defecto VERIFICAS, no
implementas. Reportas paso a paso y al terminar TE DETIENES. Lee primero
/home2/kiosko_v4/continuar_hito_c.md (handoff con todo el contexto de A y B).

HITO AUDITADO: Hito C — Front web del paciente. Base limpia de diffs = 569e25c
(= 69770d3^). NO diffear contra main (no contiene C).

MODO HÍBRIDO (lista blanca de correcciones triviales sin commitear: comentarios
obsoletos, typos, imports/vars muertos, docstrings). PROHIBIDO tocar: payments.ts,
reconciler.ts, license/*, migraciones, y toda lógica de seguridad/auth (incluido
/auth/refresh, turnstile, rate-limit, auth-middleware, buckets de patient-auth) ni
tests de seguridad. Seguridad / DoD no cumplido / discrepancias → REPORTAR, no tocar.
Ante la mínima duda → reportar.

ENTORNO: verificar primero si Docker está vivo (curl --unix-socket /var/run/docker.sock
/_ping). Postgres/Redis según override actual (ojo 5434/6381 en .env vs 5433/6380 en
override). dotenv no pisa env del shell. typecheck no necesita BD; lint exit 2 es gap
preexistente (1 línea ⚠️). Hito C es frontend+E2E (Playwright): si no se puede levantar
front+API+browsers, marcar E2E 🔭 con motivo. Hay MCP playwright disponible.

FUENTES: plan_abierto_v2.md §Hito C (línea ~161); plan_abierto.md §6.1-C y §10 (en
docs/otros de la rama hito-b); reporte de C en estados_hitos.md / hito_conversacion.md.
Contrasta (1) lo que el reporte afirma, (2) lo que el código hace, (3) el DoD del plan.

SALIDA: /home2/kiosko_v4/auditoria_hito_c.md (✅/⚠️/❌/🔭 + evidencia). Agrega sección
"## Hito C" a pendientes_menores.md (no reescribir; IDs C-1, C-2…). Al cerrar: conteo
✅/⚠️/❌ + 3 hallazgos top + "Correcciones triviales aplicadas (sin commitear)". Recuerda
al usuario revisar git diff y commitear/descartar. DETENTE: no avances al Hito D.

DoD de C a verificar: (1) app arranca sin kiosk_token (/public/bootstrap, sin
showUnpairedScreen, sin kioskToken en api.js); (2) login OTP web + sesión en
sessionStorage + /auth/refresh (deslizante con máximo absoluto, §10) + token Turnstile
en request-otp; (3) home/citas/tratamientos/pago móvil + "Pagar ahora" (link Wompi +
polling en visibilitychange) + QR fallback desktop; (4) idle relajado, register con
teclado nativo, standby (landing vs login); (5) playwright.config.ts creado + E2E móvil
Pixel 7 verde; (6) backend sigue verde (typecheck + suite; confirmar número real y
declarar discrepancia con el "253" del plan).
```
