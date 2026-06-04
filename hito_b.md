# Reporte de ejecución — Hito A (Backend web-ready)

> **Plan:** `plan_abierto_v2.md` · **Rama:** `hito-a-backend-web-ready` (base: `main`)
> **Fecha:** 2026-06-03 · **Estado:** ✅ Completo, listo para auditoría.
> **No se avanzó al Hito B.**

## Decisiones aplicadas (dadas por el usuario)
- **Rutas públicas:** `/public/*` (ej. `/public/bootstrap`).
- **kiosk_id en sesión/registros:** `NULL` (sin sentinel `"web"`).
- **`/kiosk/register`:** ruta pública gobernada por `FEATURE_REGISTRO`.

---

## 1. Archivos creados / modificados

| Archivo | Tipo | Resumen del cambio |
|---------|------|--------------------|
| `apps/api/migrations/017_nullable_kiosk_id_web.sql` | **nuevo** | Migración idempotente que garantiza `kiosk_id` nullable en `otp_codes`, `patient_sessions`, `transactions`, `habeas_data_consents`. Incluye reverso documentado. Termina con el `INSERT INTO schema_migrations` exigido. |
| `apps/api/src/lib/jwt.ts` | mod | `signPatientSession.kioskId` pasa a opcional (`string \| null`); el claim emite `kiosk_id` `null` para sesiones web. `PatientSessionClaims.kiosk_id` → `string \| null`. |
| `apps/api/src/lib/config.ts` | mod | Añade `TURNSTILE_SECRET`/`TURNSTILE_SITEKEY` (opcionales) y `features.turnstileConfigured`. Hook para el Hito B. |
| `apps/api/src/routes/public.ts` | **nuevo** | Rutas públicas sin `requireKiosk`: `GET /public/bootstrap`, `GET /public/standby`, `GET /public/standby/media`. Reusa la lógica de clínica de `kiosk.ts` sin telemetría/identidad de kiosco; expone `turnstile_sitekey`. |
| `apps/api/src/server.ts` | mod | Importa y registra `publicRoutes`. |
| `apps/api/src/routes/patient-auth.ts` | mod | `request-otp` deja de exigir `kiosk_token` (se elimina verificación de token y chequeo de kiosco activo); rate-limit por teléfono+IP (se retira bucket por kiosco); `otp_codes`/`habeas_data_consents` con `kiosk_id=NULL`; audit a `actorType:'system'`; hook `turnstile_token` (opcional). **Se elimina la ruta `/auth/login-direct`.** |
| `apps/api/src/routes/patient-register.ts` | mod | Quita `requireKioskAuth`; nuevo `requireFeatureRegistro` (403 `FEATURE_DISABLED` si el flag está apagado, evaluado por request); auditoría a `actorType:'system'`. |
| `apps/api/tests/patient-auth.test.ts` | mod | Ver §2. |
| `apps/api/tests/patient-register.test.ts` | mod | Ver §2. |
| `apps/api/tests/public.test.ts` | **nuevo** | Ver §2. |
| `apps/api/vitest.config.ts` | mod | `FEATURE_REGISTRO='true'` en env de test (la ruta de registro ahora está gated). |

Diffstat: **11 archivos, +427 / −367**. Un commit por subtarea (7 commits, convencionales):

```
e0c678c feat(db): migración 017 — kiosk_id nullable para acceso web público
f6c3e95 feat(jwt): kioskId opcional en signPatientSession (sesiones web)
70b5e0e feat(config): claves Cloudflare Turnstile (hook anti-abuso OTP)
286c97f feat(api): rutas /public/* (bootstrap, standby) sin kiosk_token
8af8063 refactor(patient-auth): request-otp público sin kiosk_token; quita login-direct
32e6134 refactor(patient-register): registro público gobernado por FEATURE_REGISTRO
8923a01 test(api): adapta auth/register al modelo web público + tests /public/*
```

> Nota: `docker-compose.override.yml` aparece como modificado en el working tree
> pero **es de la tarea de clonado previa** (puertos 5434/6381), no del Hito A;
> no se incluyó en ningún commit del hito.

---

## 2. Tests: adaptados vs. creados

### Adaptados (transporte del token, SIN vaciar aserciones de seguridad)

**`tests/patient-auth.test.ts`**
- Bloque `describe('POST /auth/request-otp - kiosk token')` (3 tests:
  *sin header → 401*, *token inválido → 401*, *kiosco revocado → 403*) →
  reemplazado por `describe('... - acceso público (sin kiosk token)')` (2 tests:
  *sin header → 200*, *header espurio ignorado → 200*). Las 3 aserciones viejas
  validaban el muro de kiosco, **feature eliminada en Opción A**; las nuevas
  validan el contrato público.
- Se retiró el header `Authorization: Bearer <kioskToken>` de las 22 llamadas a
  `request-otp` (ya no se envía token). Se eliminó la creación de kioscos y
  `signKioskToken` del `beforeAll`.
- **Aserciones de seguridad conservadas intactas** (mismo código, solo cambió el
  transporte):
  - Anti-enumeración: *“teléfono que NO existe recibe la MISMA respuesta”* y
    *“teléfono que NO existe → NO se envía ningún OTP”* (`captured.sms/email` = 0).
  - Rate-limit: *“4º intento desde mismo phone es bloqueado (limit=3)”* → 429.
  - verify-otp: código incorrecto, formato inválido, **single-use**,
    **5 intentos → 429 TOO_MANY_ATTEMPTS**, expirado, OTP de rechazo silencioso.
  - *“OTP nunca aparece en logs ni responses”* (request y verify).
  - Audit no contiene el OTP.
- **Añadido** en el happy path: `expect(claims.kiosk_id).toBeNull()` (valida la
  sesión web sin kiosco).

**`tests/patient-register.test.ts`**
- `post()` helper deja de enviar `Authorization`; se elimina creación de kiosco y
  `signKioskToken`.
- `it('401 sin kiosk token')` → reemplazado por
  `it('no exige kiosk token: ... llega a validación (no 401)')` (body vacío →
  400 `VALIDATION_ERROR`). Las demás aserciones (confirmaciones de
  cédula/celular/email, formatos, 409 duplicado, 201 creación) **intactas**.

### Creados

**`tests/public.test.ts`** (4 tests):
- `/public/bootstrap` 200 **sin** Authorization.
- Contrato esperado por el frontend (clinic, habeas_data, procedures, faq,
  standby, otp_required, feature_registro, `turnstile_sitekey`, server_time).
- **No-exposición de secretos**: el payload no contiene `dentalink_token`,
  `token_encrypted`, `kiosk_token` ni paths internos (`/var/`).
- `/public/standby` 200 sin auth.

**Nuevo test de seguridad de feature flag** en `patient-register.test.ts`:
- `403 FEATURE_DISABLED cuando FEATURE_REGISTRO está apagado` (muta `config` en
  runtime con `try/finally` y restaura).

### Diff de aserciones de seguridad — confirmación de que NO se vaciaron
- **Anti-enumeración:** se conserva el mismo par de tests (respuesta idéntica +
  cero envíos para teléfono inexistente). **Sin cambios de lógica.**
- **Rate-limit:** test de límite por teléfono (429) **intacto**; lo único
  retirado es el *bucket por kiosco*, porque ya no existe el concepto de kiosco
  (no es una aserción de abuso de paciente).
- **Fuerza bruta / single-use OTP:** los 7 tests de `verify-otp` (incluido
  *5 intentos → 429*) **intactos**.
- **OTP fuera de logs/responses:** los 2 tests + el de audit **intactos**.
- **Único borrado real:** las 3 aserciones del muro `kiosk_token`
  (requerido/inválido/revocado) — eliminadas por diseño (Opción A), sustituidas
  por aserciones del nuevo contrato público. **Ninguna aserción de
  anti-abuso/anti-enumeración/OTP fue eliminada ni debilitada.**

---

## 3. Resultados de verificación (números reales)

| Comando | Resultado |
|---------|-----------|
| `pnpm --filter @dentalkiosco/api test` | ✅ **257 passed** (17 archivos), 0 fallos. Antes: 253/16. |
| `pnpm --filter @dentalkiosco/api typecheck` (`tsc --noEmit`) | ✅ sin errores |
| `migrate` / `migrate:status` | ✅ 17/17 aplicadas, 0 pendientes (017 aplicada) |
| `pnpm --filter kiosco-frontend build` | ✅ built (sin cambios de frontend) |
| `pnpm --filter admin-frontend build` | ✅ built |
| `pnpm lint` | ⚠️ **No ejecutable** — ver Desviación D1 |

**Delta de tests 253 → 257:** `+4` public.test, `+1` gate FEATURE_REGISTRO,
`−1` bloque kiosk-token (3→2). Neto **+4**.

### Smoke en vivo (API real, puerto 3000)
```
GET  /public/bootstrap            → HTTP 200  (sin token)
   clinic="Odontología German Fernandez", otp_required=true,
   feature_registro=false, theme=apple, turnstile_sitekey=null, habeas presente
POST /auth/request-otp (sin Authorization) → HTTP 200  {request_id, expires_in_seconds}
POST /auth/login-direct           → HTTP 404  (ruta eliminada)
```

---

## 4. DoD del Hito A — punto por punto

| Criterio (plan_abierto_v2 §Hito A) | Estado | Evidencia |
|------------------------------------|--------|-----------|
| Endpoints públicos responden sin `kiosk_token` | ✅ | `/public/bootstrap` 200 sin token (test + smoke) |
| `login-direct` bloqueado | ✅ | Ruta eliminada → 404 (smoke); sin tests rotos |
| Sesión de paciente funciona con `kiosk_id` nulo | ✅ | `claims.kiosk_id` = null en happy path; `signPatientSession` opcional |
| Todo `/me/*` operativo | ✅ | `patient-me`/`booking`/`payments` tests verdes (sin cambios; usan `requirePatient`) |
| Migración aplica y revierte | ✅ aplica / ⚠️ revierte | Aplica (017 en BD). Reverso **documentado** en el `.sql`; ver Desviación D2 (runner sin `down`) |
| Suite (adaptado) + typecheck + lint verdes | ✅/✅/⚠️ | test 257 ✅, typecheck ✅, lint ⚠️ (D1) |
| No queda dependencia de `kiosk_token` en el flujo paciente | ✅ | `request-otp`, `/public/*`, `/kiosk/register` ya no usan `kiosk_token`; verificado por grep |

---

## 5. Desviaciones y decisiones tomadas durante la ejecución

- **D1 — `pnpm lint` no es ejecutable (preexistente, NO causado por el hito).**
  El repo usa ESLint 9 (`"eslint": "^9.0.0"`) pero **no existe `eslint.config.js`**
  (ni `.eslintrc.*`). `eslint .` falla con *“couldn't find an eslint.config file”*
  en `main`, antes de cualquier cambio. No se creó configuración nueva (fuera del
  alcance del Hito A y podría introducir ruido). **Gate de calidad efectivo:**
  `typecheck` + 257 tests. *Recomendación:* crear `eslint.config.js` (flat config)
  como tarea aparte.

- **D2 — La migración 017 es defensiva/idempotente; las columnas YA eran
  nullable.** En el esquema actual `kiosk_id` se definió como
  `UUID REFERENCES kiosks(id) ON DELETE SET NULL` (sin `NOT NULL`) en las 4
  tablas. La migración formaliza el invariante con `DROP NOT NULL` idempotente
  (no-op seguro) y deja constancia del cambio de modelo. **No fue un cambio
  NOT NULL→NULL real.** Se creó igualmente por la regla “nueva migración
  versionada” y como garantía para instalaciones divergentes.

- **D3 — El runner de migraciones (`migrate.ts`) solo implementa `up`.** No hay
  comando `down`. El reverso se entrega **documentado dentro del `.sql`**
  (re-imponer `NOT NULL` + borrar la fila de `schema_migrations`), con la
  advertencia de que solo aplica si no existen filas `kiosk_id IS NULL`.

- **D4 — `login-direct` se eliminó por completo** (en vez de dejarlo respondiendo
  403). Opción A fuerza OTP y no contempla el flujo sin OTP. El método
  `loginDirect` del frontend (`kiosco-frontend/api.js`) queda sin backend, pero
  **es trabajo del Hito C** (frontend) y solo se invocaba con `OTP_REQUIRED=false`
  (no aplica en web). Documentado para el Hito C.

- **D5 — `vitest.config.ts` ahora fija `FEATURE_REGISTRO='true'`.** Necesario
  porque la ruta de registro quedó gated; sin esto, los 14 tests de registro
  fallarían. Ningún test afirma el valor de `feature_registro`, así que el cambio
  global es seguro. El caso desactivado (403) se cubre mutando `config` en runtime.

- **D6 — Rutas `/kiosk/*` (kiosk.ts) y `admin-kiosks` se mantienen (deprecadas).**
  Para minimizar churn y no romper sus tests durante la migración. Limpieza
  sugerida en un hito posterior. `verifyKioskToken`/`signKioskToken` siguen
  existiendo en `jwt.ts` por estas rutas.

---

## 6. Cómo auditar / reproducir

```bash
cd /home2/kiosko_v4
git checkout hito-a-backend-web-ready
git log --oneline main..HEAD                 # 7 commits
git diff --stat main..HEAD

DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test        # 257 passed
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck   # OK
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status  # 17/17
```

---

## 7. Anexo de auditoría (a petición del revisor)

### 7.1 Test de pago completo con sesión web (`kiosk_id = NULL`)
**No existía** — el `payments.test.ts` previo siempre usaba sesiones con
`kiosk_id` no-nulo. **Creado:** `tests/payments-web-session.test.ts` (5 tests),
commit `a396522`. Ejercita de extremo a extremo:
1. `POST /me/payments` con sesión web → **INSERT en `transactions` con
   `kiosk_id NULL`** (verificado por query directa).
2. `GET /me/payments/:reference` (lectura propia) → 200.
3. **LEFT JOIN del admin** (`transactions LEFT JOIN kiosks`) → fila con
   `kiosk_name` NULL, sin error.
4. **`reconciler.runCycle()`** sobre la transacción aprobada con `kiosk_id NULL`
   → procesa y registra (mock) sin lanzar.
5. **`audit_log`** registra `patient.payment.create`.

Suite total tras el anexo: **262 passed (18 archivos)**.

### 7.2 Grep de TODAS las lecturas de `kiosk_id` en `apps/api/src`
`reconciler.ts` y `audit.ts` **no aparecen** en el grep → no referencian
`kiosk_id`. Clasificación de cada ocurrencia:

| Ubicación | Tipo | ¿NULL-safe? |
|-----------|------|-------------|
| `lib/jwt.ts:42` | tipo `kiosk_id: string \| null` | ✅ declara null |
| `lib/jwt.ts:135` | **escritura** del claim (`?? null`) | ✅ |
| `routes/patient-auth.ts:75` | tipo `OtpRow.kiosk_id: string\|null` | ✅ |
| `routes/patient-auth.ts:141, 216, 405` | **escrituras** (INSERT, `null`/`otp.kiosk_id`) | ✅ |
| `routes/patient-auth.ts:298` | **lectura** `SELECT ... kiosk_id` (otp) | ✅ se consume en 397/405/421/431 |
| `routes/patient-auth.ts:397` | **lectura→uso** `kioskId: otp.kiosk_id` | ✅ param opcional `string\|null` |
| `routes/patient-auth.ts:405` | escritura INSERT `patient_sessions` | ✅ acepta NULL |
| `routes/patient-auth.ts:421` | lectura→`audit metadata {kiosk_id}` | ✅ JSON admite null |
| `routes/patient-auth.ts:431` | lectura→`logger {kiosk}` | ✅ log admite null |
| `routes/payments.ts:164/181` | **escritura** INSERT (`patient.kiosk_id ?? null`) | ✅ |
| `routes/admin-transactions.ts:91` | tipo `string\|null` | ✅ |
| `routes/admin-transactions.ts:109/112` | **lectura** `t.kiosk_id` + `LEFT JOIN kiosks` | ✅ LEFT JOIN → null |
| `routes/admin-dashboard.ts:87` | **lectura** `LEFT JOIN kiosks ON k.id=t.kiosk_id` | ✅ LEFT JOIN → null |

**Conclusión:** no hay ningún `WHERE kiosk_id = ...`, ningún `JOIN` interno
(INNER) por kiosco, ni ninguna desreferencia que asuma no-nulo. Toda lectura es
(a) un `LEFT JOIN` (devuelve `kiosk_name` NULL), (b) un valor opcional ya tipado
`string | null`, o (c) un destino tolerante a null (JSON de audit / log). El
reconciler no lee `kiosk_id` en absoluto. **Ningún comportamiento downstream
cambia ni falla con `kiosk_id` NULL.**

---

**Hito A APROBADO** por humano (2026-06-03) y fusionado a `main` (merge
`3826f6f`).

---
---

# Reporte de ejecución — Hito B (Seguridad de perímetro)

> **Plan:** `plan_abierto_v2.md` · **Rama:** `hito-b-seguridad-perimetro` (base: `main` con Hito A)
> **Fecha:** 2026-06-03 · **Estado:** ✅ Completo, listo para auditoría.
> **No se avanzó al Hito C.**

## Decisiones aplicadas (dadas por el usuario)
- **Store del rate-limit:** Redis (`lib/redis.ts`, `redis.getClient()`).
- **Turnstile:** modo managed/invisible; **enforced** server-side en `request-otp`.
- **Límites §7.2:** cooldown 60s/teléfono, 3/h y 5/día por teléfono, 5/h y 20/día
  por IP, 100/h global con alerta.

## B.1 Archivos creados / modificados

| Archivo | Tipo | Resumen |
|---------|------|---------|
| `apps/api/src/lib/turnstile.ts` | **nuevo** | `verifyTurnstile()` (siteverify, **fail-closed**), `isEnforced()` (lee `config` en vivo → activo si hay `TURNSTILE_SECRET`), `setTurnstileVerifier()` para tests. |
| `apps/api/src/lib/config.ts` | mod | En `NODE_ENV=production`, **`TURNSTILE_SECRET` es obligatorio** (falla el arranque si falta). |
| `apps/api/src/server.ts` | mod | Registra **`@fastify/rate-limit` global** (store Redis, `nameSpace dk-rl:`, ventana 1 min). `keyGenerator` = IP (XFF/trustProxy). **`allowList` excluye loopback y `/health`.** Techos por ruta: request-otp 10, verify-otp 20, admin/login 10, me/payments 15; resto 300/min. |
| `apps/api/src/routes/patient-auth.ts` | mod | `request-otp`: buckets §7.2 (cooldown/phone-hour/phone-day/ip-hour/ip-day/global) ANTES de lookup/envío; cap global emite alerta. **Turnstile enforced** (si configurado) antes de cualquier lookup/envío → 403 `TURNSTILE_REQUIRED`. |
| `apps/api/src/lib/auth-middleware.ts` | mod | `requireAdmin` consulta la **blocklist Redis** (`admin:blocklist:<jti>`) tras verificar el JWT → 401 + audit si está revocada. Exporta `ADMIN_BLOCKLIST_PREFIX`. |
| `apps/api/src/routes/admin-auth.ts` | mod | `/admin/auth/logout` añade el `jti` a la blocklist con **TTL = vida restante** del token (revocación real). |
| `apps/api/tests/patient-auth.test.ts` | mod | Test de rate-limit OTP adaptado al **cooldown** (2º intento inmediato → 429). |
| `apps/api/tests/security.test.ts` | **nuevo** | Suite §6.2 (12 tests). |

Diffstat: **8 archivos, +479 / −39**. 5 commits convencionales:
```
4ec62e4 feat(turnstile): verificador siteverify + TURNSTILE_SECRET obligatorio en prod
8b93dc7 feat(security): rate-limit global por IP con store Redis
8350a1d feat(security): Turnstile enforced + buckets anti-abuso OTP (§7.2)
e174af1 feat(security): blocklist de sesión admin en Redis (logout revoca de verdad)
8c91405 test(security): suite de perímetro §6.2 (...)
```

## B.2 Tests de seguridad creados (aserción concreta de cada uno)

**`tests/security.test.ts` (12 tests).** Turnstile activado en el archivo
(`config.TURNSTILE_SECRET` + verifier mock que solo acepta el token `good`);
SMS/email mockeados; buckets Redis/Postgres limpiados en `beforeEach`.

*Rate-limit global por IP* (vía `POST /me/payments`, techo 15, IP por `X-Forwarded-For`):
- **429 + Retry-After:** 15 peticiones no-429, la 16ª → `429` y `headers['retry-after']` definido.
- **Aislamiento por IP:** agotada IP_A, una petición desde IP_B → no 429.
- **Reset:** tras 429, limpiar el store (`dk-rl:*`) ⇒ siguiente petición no 429.
- **No afecta `/health`:** 25 GET `/health` con XFF → ninguno 429.

*Anti-abuso OTP/SMS:*
- **Teléfono no registrado → 0 SMS:** `request-otp` (token válido) a número no registrado → 200 y `captured.sms/email` vacíos.
- **Cooldown no reinvoca al sender:** 1º envío → 200 y 1 SMS; 2º inmediato → 429 y **sigue 1 SMS** (no se invocó el sender).
- **Sin token Turnstile → 403 antes del sender:** `request-otp` sin `turnstile_token` → `403 TURNSTILE_REQUIRED`, 0 SMS.
- **Token Turnstile inválido → 403:** token `bad-token` → 403, 0 SMS.

*Anti-enumeración:* registrado vs no registrado → mismas claves de respuesta (200/200).

*Fuerza bruta OTP:* 5 `verify-otp` con código incorrecto → el siguiente → `429 TOO_MANY_ATTEMPTS`.

*Blocklist admin:* token válido → `/admin/auth/me` 200; tras `/admin/auth/logout`, el **mismo token** → `/admin/auth/me` **401**.

Además, en `patient-auth.test.ts` el test de rate-limit se adaptó al cooldown
(2º intento inmediato del mismo teléfono → 429 + `retry_after_seconds`).

## B.3 Resultados de verificación (números reales)

| Comando | Resultado |
|---------|-----------|
| `pnpm --filter @dentalkiosco/api test` | ✅ **274 passed** (19 archivos), 0 fallos. (Hito A: 262/18.) |
| `pnpm --filter @dentalkiosco/api typecheck` | ✅ sin errores |
| `migrate:status` | ✅ 17/17 aplicadas, 0 pendientes (**Hito B no requiere migración**: blocklist en Redis, `rate_limits` ya existía) |
| `pnpm lint` | ⚠️ no ejecutable (preexistente, ver Hito A §5 D1) |

### Smoke en vivo (API real)
```
GET  /health  × 30 (X-Forwarded-For: 203.0.113.50) → 200 ×30, CERO 429
POST /me/payments × 18 (X-Forwarded-For: 203.0.113.51) → 401 ×15, luego 429 ×3
     respuesta 429 incluye:  retry-after: 60
```

## B.4 Confirmación explícita: el rate-limit NO afecta `/health`
- **Código:** `allowList: (req) => isLoopback(req.ip) || req.url.startsWith('/health')`
  en `server.ts` → cualquier ruta `/health*` se excluye del limitador.
- **Test:** `security.test.ts › Rate-limit global por IP › NO afecta a /health`
  (25 GET con IP pública → ninguno 429). ✅
- **Smoke en vivo:** 30 GET `/health` con XFF → todos 200. ✅

## B.5 DoD del Hito B — punto por punto

| Criterio (plan_abierto_v2 §Hito B) | Estado | Evidencia |
|------------------------------------|--------|-----------|
| Rate-limit global por IP (Redis) | ✅ | `server.ts` + tests + smoke (429/Retry-After/aislamiento/reset) |
| Límites por ruta (auth, admin/login, me/payments) | ✅ | `ROUTE_MAX` en `server.ts` |
| Turnstile enforced antes de lookup/envío | ✅ | `patient-auth.ts` paso 3 + tests (403 sin/ token inválido, 0 SMS) |
| `TURNSTILE_SECRET` obligatorio en producción | ✅ | `config.ts` (exit si falta en prod) |
| Buckets §7.2 | ✅ | cooldown/phone/ip/global en `patient-auth.ts` + tests |
| Blocklist admin (logout → 401) | ✅ | `auth-middleware.ts` + `admin-auth.ts` + test |
| Suite §6.2 verde + 262 previos verdes | ✅ | 274/274 |
| typecheck / migrate | ✅ / ✅ | sin errores; 17/17 |
| Rate-limit NO afecta `/health` | ✅ | §B.4 |

## B.6 Desviaciones y decisiones tomadas

- **D-B1 — `allowList` de loopback en el rate-limit.** Decisión de diseño: se
  excluye `127.0.0.1`/`::1` además de `/health`. Razón: (a) los health checks
  internos del contenedor y los tests (`app.inject`) usan loopback y no deben
  limitarse; (b) en producción el IP real del cliente llega por `X-Forwarded-For`
  (Cloudflare→Caddy), nunca como loopback, así que los clientes reales **sí**
  se limitan. Efecto colateral positivo: los 262 tests previos no se rompen.
- **D-B2 — Sin migración en el Hito B.** La blocklist admin vive en Redis y la
  tabla `rate_limits` ya existía (mig. 007). No se creó migración (la regla de
  "migración nueva" es condicional a que haga falta).
- **D-B3 — Techo por ruta de `/me/payments` vía configuración central.** Como
  `payments.ts` está protegido, el límite de `/me/payments` se aplica desde
  `server.ts` (mapa `ROUTE_MAX` en el `max` del plugin), **sin tocar**
  `payments.ts`.
- **D-B4 — `isEnforced()` lee `config` en vivo** (no `features`, que se congela
  al importar). Necesario para activar Turnstile por test y, además, más
  correcto. El enforcement queda activo sólo si hay `TURNSTILE_SECRET`
  (obligatorio en prod por `config.ts`).
- **D-B5 — Alerta del cap global = `logger.error` + `audit`.** El "alerta al
  admin" del §7.2 se implementó como señal de log+auditoría. El cableado a
  email/Sentry es un añadido fino que se puede conectar en el Hito F/G.
- **D-B6 — Turnstile gated por configuración.** En dev/test sin `TURNSTILE_SECRET`
  el enforcement se omite (los tests existentes no necesitan token). En prod es
  obligatorio. La suite de seguridad lo activa explícitamente para probarlo.

## B.7 Cómo auditar / reproducir
```bash
cd /home2/kiosko_v4
git checkout hito-b-seguridad-perimetro
git log --oneline main..HEAD            # 5 commits
git diff --stat main..HEAD
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test       # 274 passed
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck  # OK
```

**Pendiente de tu aprobación para avanzar al Hito C.** La rama
`hito-b-seguridad-perimetro` **no se ha fusionado** a `main`.
