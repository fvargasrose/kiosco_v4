# Auditoría independiente — Hito B (Seguridad de perímetro)

> **Auditor:** rol híbrido (verifica; solo corrige trivia de lista blanca, sin commitear).
> **Fecha:** 2026-06-04
> **Rama de trabajo:** `hito-e-admin-responsive` (HEAD). Justificación abajo (PASO 0).
> **Base limpia de diffs de B:** `4ec62e4^` = `3826f6f` (merge de Hito A). Confirmado.

## PASO 0 — Estado de fusión y base de diffs

`git branch -v` + grafo:
- **`main` (569e25c)** = *"Merge branch 'hito-b-seguridad-perimetro'"*, `[ahead 17]`.
  → **`main` contiene SOLO Hito A + Hito B.**
- **C / D / E NO están en `main`.** Viven en la cadena lineal sobre `569e25c` que
  termina en `hito-e-admin-responsive` (commits 69770d3…4447ac6), sin merge de vuelta.
- **Veredicto del conflicto de reportes:** la afirmación *"C/D/E NO están en main"* es
  **CORRECTA**. La otra (*"main ya contiene B–E"*, de la auditoría de A) era **imprecisa**:
  main solo tiene A+B.

Commits de B presentes: `4ec62e4`, `8b93dc7`, `8350a1d`, `e174af1`, `8c91405` ✅.

**¿Por qué audito sobre HEAD (hito-e) y no sobre la rama B?** Diff `569e25c..HEAD` de los
archivos de seguridad de B: solo `patient-auth.ts` (+98, el `/auth/refresh` de C) y
`config.ts` (+4) cambiaron; **`server.ts`, `turnstile.ts`, `auth-middleware.ts`,
`admin-auth.ts` están idénticos a B**. El handler `request-otp` (buckets/Turnstile) no fue
tocado por C/D/E. Auditar en HEAD = auditar B, y deja cualquier corrección trivial en la
rama donde trabaja el usuario.

## ⚠️ Limitación de entorno (afecta verificaciones de runtime)
En esta sesión: **Docker daemon caído** (`/var/run/docker.sock` existe pero `GET /_ping`
→ HTTP 000), **CLI `docker` ausente**, y **ningún Postgres/Redis** en 5432/5433/5434/
6379/6380/6381, sin binarios locales. → La **suite §6.2** y el **smoke HTTP de extremo a
extremo** NO son ejecutables ahora (🔭). **Mitigación:** el hallazgo crítico (bypass XFF)
se probó con un **PoC aislado** que replica la config exacta de Fastify (no requiere BD), y
la suite se analizó estáticamente. `typecheck` sí se ejecutó (no requiere BD).

---

## A) Rate-limit global

### A.1 — `@fastify/rate-limit` con store Redis, nameSpace, ventana 1 min ✅
`server.ts:95-106`: `app.register(rateLimit, { global:true, redis: redis.getClient(),
nameSpace:'dk-rl:', timeWindow:'1 minute', keyGenerator:(req)=>req.ip, … })`.

### A.2 — Techos por ruta ✅
`server.ts:85-91`: `GLOBAL_MAX=300`; `ROUTE_MAX = { 'POST:/auth/request-otp':10,
'POST:/auth/verify-otp':20, 'POST:/admin/auth/login':10, 'POST:/me/payments':15 }`.
`max:(req)=> ROUTE_MAX[`${method}:${routeOptions.url}`] ?? GLOBAL_MAX` (102-105). Coincide
con el DoD.

---

## B) *** CRÍTICO — Bypass del rate-limit por X-Forwarded-For — CONFIRMADO (ALTO) ***

### B.3 — Configuración trustProxy / keyGenerator / allowList
- `server.ts:48` → **`trustProxy: true`** (comentario "Estamos detrás de Caddy").
  Sin lista de proxies de confianza ni CIDR; **no es configurable por env** (hardcodeado).
- `server.ts:100` → `keyGenerator:(req)=>req.ip`.
- `server.ts:101` → `allowList:(req)=> isLoopback(req.ip) || req.url.startsWith('/health')`.
- `server.ts:92-93` → `isLoopback` compara `req.ip` contra `127.0.0.1`/`::1`/`::ffff:127.`.

Con `trustProxy:true`, Fastify deriva `req.ip` del valor **más a la izquierda** de
`X-Forwarded-For` (totalmente controlado por el cliente). Tanto la **clave** del rate-limit
como la **allowList** dependen de ese `req.ip` forjable.

### B.4 / B.5 — PoC de evasión (réplica exacta de la config, sin BD) — ❌ EVADIBLE
Script con `Fastify({ trustProxy:true })` + el `isLoopback` real, `remoteAddress:10.0.0.9`:
```
sin XFF                          -> {"ip":"10.0.0.9","allowListed":false}
XFF 1.2.3.4                      -> {"ip":"1.2.3.4","allowListed":false}
XFF 5.6.7.8                      -> {"ip":"5.6.7.8","allowListed":false}
XFF 127.0.0.1                    -> {"ip":"127.0.0.1","allowListed":true}
XFF "127.0.0.1, 10.0.0.9"        -> {"ip":"127.0.0.1","allowListed":true}   (Caddy hace append)
```
**Dos vías de evasión, ambas reales:**
1. **Rotación de IP:** un XFF distinto por request → `req.ip` distinto → **bucket nuevo cada
   vez**. Defeats el rate-limit global, los techos por ruta y los buckets §7.2 *por-IP*
   (`otp:ip:*`, `otp:ipday:*`). (Los buckets *por-teléfono* y el `otp:global` —clave única—
   NO se evaden.)
2. **Loopback spoof:** `XFF: 127.0.0.1` → `allowListed=true` → el limitador se **omite por
   completo**. La 5ª línea prueba que **funciona aun detrás de Caddy** (Caddy *anexa* la IP
   real; Fastify toma la izquierda = `127.0.0.1` del atacante).

> **Corroboración desde la propia suite:** `security.test.ts:148-158` ("aísla por IP")
> agota `IP_A` vía `x-forwarded-for` y luego `IP_B` (otro XFF) **no** queda limitado — es
> decir, el test trata como *feature* exactamente el mecanismo que el atacante explota.
> **Ningún test** cubre XFF forjado como ataque (ni `XFF=127.0.0.1`→allowList).

**Severidad: ALTO.** El smoke HTTP de extremo a extremo (>16 POST con XFF rotatorio →
nunca 429) queda 🔭 por falta de BD, pero el PoC aislado es **más concluyente** (aísla el
mecanismo). Para cerrar la brecha al nivel de B: `trustProxy` debería ser un *hop count* o
CIDR de Caddy/Cloudflare (no `true`), y/o Caddy debería **reescribir** (no *append*) el XFF;
el `trusted_proxies` de Caddy está diferido a Hito F (`plan_abierto.md §8`).
**Acción del auditor: REPORTAR, no tocar** (hallazgo de seguridad).

---

## C) Turnstile (fail-closed, server-side)

### C.6 — siteverify + fail-closed + obligatorio en prod ✅
`lib/turnstile.ts`: POST a `challenges.cloudflare.com/.../siteverify` (38). **Fail-closed**:
sin token→`false` (28), sin secret→`false` (30), excepción/red→`false` (50-53),
`success!==true`→`false` (48). `isEnforced()=!!config.TURNSTILE_SECRET` (66).
`config.ts:157-159`: en `NODE_ENV==='production'` sin `TURNSTILE_SECRET` → `process.exit(1)`
(**aborta arranque**, no solo loguea).

> Matiz (no defecto): `staging` queda exento (solo `production` obliga). Coherente con el
> comentario y el DoD ("obligatorio en producción").

### C.7 — Orden: Turnstile ANTES de lookup/SMS ✅
`patient-auth.ts:149-160`: `if (isTurnstileEnforced()) { verifyTurnstile(...) → 403
TURNSTILE_REQUIRED }` ocurre en el **paso 3**, antes del INSERT de consentimiento (paso 5),
del lookup Dentalink (paso 7) y del envío de OTP (paso 9). Los buckets se evalúan justo
antes (paso 2) para no gastar siteverify ante un flood — orden razonable.

---

## D) Buckets §7.2 — los 6, incluidos DÍA y GLOBAL ✅
`patient-auth.ts:111-118`:
| Bucket | Clave | Límite | Ventana |
|--------|-------|--------|---------|
| cooldown | `otp:cooldown:${phone}` | 1 | 60 s ✅ |
| phone/hora | `otp:phone:${phone}` | `config…PER_PHONE_PER_HOUR`=**3** | 3600 s ✅ |
| **phone/DÍA** | `otp:phoneday:${phone}` | 5 | 86400 s ✅ |
| ip/hora | `otp:ip:${request.ip}` | 5 | 3600 s ✅ |
| **ip/DÍA** | `otp:ipday:${request.ip}` | 20 | 86400 s ✅ |
| **GLOBAL/hora** | `otp:global` | 100 | 3600 s ✅ |
Cap global → `logger.error('ALERTA: cap global de OTP superado…')` (133-138). Default
`PER_PHONE_PER_HOUR=3` confirmado en `config.ts:60`.
> Menor (B-1): los buckets ip usan **literal 5/20**; la var `RATE_LIMIT_OTP_PER_IP_PER_HOUR`
> (`config.ts:61`, default 10) queda **muerta/engañosa**. No es defecto de seguridad (5<10,
> más estricto y conforme al plan). → `pendientes_menores`.

---

## E) Blocklist admin ✅
- `admin-auth.ts:578-585` (`/admin/auth/logout`, `preHandler: requireAdmin`):
  `ttl = admin.exp - nowSecs` (vida restante del JWT; fallback al TTL completo) →
  `redis.set('admin:blocklist:'+jti,'1',ttl)`. **TTL dinámico, no fijo** ✅.
- `redis.set` con `ttlSeconds` → `SET … EX ttlSeconds` (`lib/redis.ts:93-97`) ✅.
- `auth-middleware.ts:53-67`: verifica JWT **primero**, luego `redis.get(blocklist)` → si
  existe, **401** + audit `admin.auth.revoked_token` ✅.
- Test estático: `security.test.ts:260,266` ("válido antes del logout"; "tras /logout →
  401 revocación real"). Ejecución 🔭 (sin BD), código verificado.

---

## F) DoD del plan NO cumplido / diferido

### F.10 — Twilio geo-permissions Colombia + alertas de facturación ⏸️ DIFERIDO (declarado)
Sub-tarea de B en el plan; el reporte la difiere a F/G. **No hay hook en código**: grep en
`lib/sms.ts`/`notifications.ts` de `geo|geographic|billing|spend|colombia` → 0 (solo un
string no relacionado). → Punto del DoD **no implementado en B**; coherente con la
desviación del reporte, pero formalmente **pendiente**.

---

## G) Gate y números

### G.11 — Suite §6.2 + base + typecheck
- `security.test.ts`: **12 tests** (4 rate-limit · 4 OTP/SMS · 1 anti-enum · 1 fuerza
  bruta · 2 blocklist) con aserciones reales (429/Retry-After, 0 SMS, 403 pre-sender, 401
  tras logout). Conteo estático ✅; **ejecución 🔭** (sin BD/Docker).
- **Total de la suite:** reporte dice **274**. No ejecutable aquí (🔭). **Comprobación
  aritmética:** Hito A cerró en 262/18 archivos; B añade `security.test.ts` (12) →
  262+12 = **274**, consistente con el reporte (sin poder confirmarlo en vivo).
- **`typecheck` → EXIT 0** ✅ (ejecutado; no requiere BD).
- **`pnpm lint` → EXIT 2** ⚠️ **preexistente** (ESLint 9 sin `eslint.config.js`; ya
  documentado en Hito A; gate efectivo = typecheck + suite). No se investiga más.

### G.12 — Smoke /health (30 GET con XFF público → 0×429) 🔭
No ejecutable (sin API+BD en vivo). Estático: `allowList` excluye `req.url.startsWith
('/health')` incondicionalmente (`server.ts:101`) y el test `security.test.ts:161` ("NO
afecta a /health") lo cubre → `/health` no se limita por diseño. Confianza alta, sin runtime.

---

## H) Tabla DoD del plan (Hito B)

| Criterio DoD | Estado | Evidencia |
|--------------|--------|-----------|
| Rate-limit global Redis + límites por ruta | ⚠️ **implementado pero EVADIBLE** | Registrado y cableado (A.1/A.2) **pero** bypass por XFF probado (B.4) → ALTO |
| Turnstile **obligatorio** | ✅ | fail-closed + `process.exit(1)` en prod + antes del envío (C.6/C.7) |
| Blocklist admin funcionando | ✅ | TTL dinámico + check→401 + test (E) |
| Suite §6.2 verde + base verde | 🔭 | 12 tests presentes; typecheck ✅; **no ejecutable** (sin BD); aritmética 262+12=274 |

---

## Correcciones triviales aplicadas (sin commitear)
**NINGUNA.** Todos los candidatos caen en zona **prohibida** por la lista blanca:
- Bypass XFF y rate-limit (`server.ts`) → seguridad: **reportar, no tocar**.
- Var de config muerta `RATE_LIMIT_OTP_PER_IP_PER_HOUR` → "decisión de config": **no
  whitelist** → va a `pendientes_menores` (B-1).
- Comentario obsoleto `patient-auth.ts:10` (de Hito A) → archivo de seguridad y ya
  registrado en `auditoria_hito_a.md`: **no tocar**.

El working tree de código queda **sin modificaciones** por esta auditoría (solo se
añadieron los `.md` de auditoría y `pendientes_menores.md`).

---

## CIERRE

### Conteo
- ✅ **Confirmados:** A.1, A.2, C.6, C.7, D (6 buckets), E (blocklist), G.11-typecheck → **7**
- ⚠️ / ⏸️ / 🔭: DoD rate-limit (⚠️ evadible), F.10 (⏸️ diferido), G.11-suite (🔭),
  G.12 (🔭), lint (⚠️ preexistente), B-1 (menor) → **6**
- ❌ **Falla de seguridad:** **1** → **bypass XFF del rate-limit (ALTO)**.

### ¿El bypass XFF es real? — **SÍ, ROTUNDAMENTE.**
PoC con la config exacta lo prueba: `req.ip` es forjable vía `X-Forwarded-For` (porque
`trustProxy:true`), lo que (1) permite **rotar IPs** para un bucket nuevo por request y
(2) permite `XFF:127.0.0.1` para **caer en la allowList y omitir el limitador**, y esto
**último funciona incluso detrás de Caddy** (que hace *append*, y Fastify toma el valor
izquierdo). Sobreviven solo los buckets por-teléfono y el `otp:global`; la protección por-IP
y el backstop global de aplicación son derrotables. Mitigación correcta (Hito F): acotar
`trustProxy` a los proxies de confianza y/o reescribir el XFF en Caddy.

### Los 3 hallazgos top
1. **ALTO — Bypass del rate-limit por X-Forwarded-For** (`server.ts:48,100,101`). Vector de
   IP-rotation + loopback-spoof, probado por PoC, efectivo aun tras Caddy. Mina el primer
   criterio del DoD ("rate-limit global + por ruta").
2. **DoD parcial/diferido:** (a) la **suite §6.2 no pudo ejecutarse** en esta sesión (sin
   BD/Docker) → 🔭 (12 tests presentes, typecheck verde, 274 aritméticamente consistente);
   (b) **Twilio geo-permissions + alertas de facturación** del plan **no están en código**
   (diferidas a F/G).
3. **Bien hecho:** Turnstile **fail-closed**, **obligatorio en prod** (aborta arranque) y
   **antes del envío** de SMS; **blocklist admin** con **TTL dinámico** real y revocación
   efectiva (401); los **6 buckets §7.2** presentes (incluidos día y global con alerta). El
   reporte no exagera en estos puntos.

---

**RECORDATORIO AL USUARIO:** revisa `git diff` y commitea/descarta lo pendiente del Hito A
(las auditorías no commitean). Esta auditoría **no modificó código** (solo añadió `.md`).

**FIN DE LA AUDITORÍA DEL HITO B. El auditor se detiene — no avanza al Hito C, no aplica
correcciones fuera de la lista blanca (ninguna aplicada).**
