# Plan abierto — Convertir DentalKiosco en aplicación web pública (móvil/tablet/PC)

> **Estado:** ANÁLISIS Y PLANIFICACIÓN. No se ha implementado nada.
> Requiere aprobación antes de ejecutar cualquier hito.
> Fecha de análisis: 2026-06-03.

---

## 0. Resumen ejecutivo

El sistema hoy es un **kiosco de autoatención de pantalla fija**. Toda la entrada
al flujo del paciente está atada a un **`kiosk_token`** (JWT de 90 días) que
identifica un dispositivo físico previamente "pareado" por un admin. La buena
noticia: **una vez autenticado el paciente, todo `/me/*` (citas, tratamientos,
pagos, agendamiento) ya es autosuficiente y NO depende del `kiosk_token`** — la
sesión de paciente (JWT de 10 min) basta. El `kiosk_token` solo controla:

1. La config inicial (`/kiosk/bootstrap`, `/kiosk/standby`, `/kiosk/standby/media`)
2. El **arranque de la autenticación** (`/auth/request-otp`, `/auth/login-direct`)
3. El registro de paciente nuevo (`/kiosk/register`)

Por tanto, el corazón de la migración es **reemplazar el modelo "identidad de
dispositivo" por un modelo "web pública de clínica"** en esos 3 puntos, endurecer
la seguridad (el sistema queda expuesto a internet) y adaptar el frontend del
kiosco (que asume pantalla grande, teclado táctil propio, standby, idle agresivo
y sin URLs). El admin ya es web pero **no tiene responsividad** (0 media queries).

### Decisión arquitectónica central (a aprobar)

Cómo sustituir el `kiosk_token` en la web pública. Recomendación: **Opción A**.

| Opción | Descripción | Veredicto |
|--------|-------------|-----------|
| **A — Endpoints públicos de clínica (recomendada)** | El frontend web no usa `kiosk_token`. `bootstrap`/`standby`/`request-otp` se exponen como rutas públicas de la única clínica (id=1). El control real de acceso pasa a ser **rate-limiting robusto + OTP obligatorio** (posesión del teléfono registrado). | Más simple, sin secreto embebido en JS, alineado con que el sistema es mono-clínica. |
| B — Token público compartido en el bundle | Mantener `kiosk_token` pero embeber uno "web" en el JS. | Falso sentido de seguridad: el token viaja en el bundle, es público de facto. Descartada. |
| C — Híbrido kiosco físico + web | Conservar modo kiosco (con token) y añadir modo web en paralelo. | Más superficie de mantenimiento; útil solo si se siguen usando kioscos físicos. Posible como variante de A. |

> **Nota:** las tablas, complejidades e hitos de abajo asumen **Opción A**. Si se
> elige C (mantener también kioscos físicos), añade ~1 hito de compatibilidad.

---

## 1. Hallazgos por área

### 1.1 Frontend kiosco (`apps/kiosco-frontend`)

Arquitectura: Vanilla JS + Vite 5, router propio sin URLs, estado en memoria,
tema "apple" por defecto. Pantallas: standby → habeas-data → login-cedula →
login-otp → home → {appointments, treatments, booking, payment, profile}.

| Componente | Supuesto de kiosco fijo | Impacto para web |
|------------|-------------------------|------------------|
| `main.js` (bootstrap) | Exige `kiosk_token` (sessionStorage o `?kiosk_token=` en URL). Sin token → pantalla "Kiosco no pareado". | **Bloqueante.** Hay que quitar la dependencia y arrancar contra config pública. |
| `api.js` | Cliente con `kioskToken` en sessionStorage + `_useKiosk`. `patientToken` **solo en memoria** (se pierde al refrescar). | Quitar `kioskToken`. La sesión de paciente debe sobrevivir refresh (sessionStorage), si no, en móvil cualquier cambio de app/recarga cierra sesión. |
| `router.js` | **Sin URLs ni History API** (a propósito, "para que el back-button no viole el flujo"). Todo vive en `/`. | En web esto rompe expectativas: no hay back, no hay deep-link, refrescar pierde el lugar. Migrar a rutas reales (hash o History). |
| `idle.js` | Logout agresivo: warning a 60s, cierre a 90s. Correcto en kiosco compartido. | En dispositivo personal es hostil. Debe relajarse mucho o desactivarse en modo web. |
| `components/keyboard.js` | Teclado táctil en pantalla propio (QWERTY/numérico, `position:fixed`). | En móvil/PC sobra y estorba (choca con el teclado nativo). Solo lo usa `register.js` (`data-kb`). Desactivar en web. |
| `screens/standby.js` | Pantalla "atractor" con video/gif cacheado en IndexedDB, "Toca para comenzar". | Concepto de kiosco. En web debe ser una **landing/home pública** (o saltarse directo al login). |
| `screens/payment.apple.js` | Muestra **QR** del link de Wompi para escanear con *otro* teléfono. | En móvil el paciente **ya está en su teléfono**: mostrar un QR para escanearse a sí mismo es absurdo. Necesita botón "Pagar ahora" que abra el link + manejo de retorno. |
| `index.html` | `user-scalable=no, maximum-scale=1` (bloquea zoom). | Anti-accesibilidad en web; revisar. CSP (ver infra) bloquea las fuentes CDN del tema apple. |
| `styles*.css` | 12 + 4 media queries; diseñado para pantalla grande horizontal. | Requiere pasada responsive (layouts, tamaños táctiles, sidebar apple en móvil). |

**Observación importante:** el tema apple (`KIOSK_THEME=apple`, default) carga
Inter y Tabler Icons desde `fonts.googleapis.com` / `cdn.jsdelivr.net`, pero la
**CSP de producción no los permite** (`style-src 'self' 'unsafe-inline'`,
`font-src 'self' data:`). Hoy en prod el tema apple probablemente sale sin
tipografía/iconos correctos. Hay que decidir: self-host de fuentes o ampliar CSP.

### 1.2 Frontend admin (`apps/admin-frontend`)

- Ya es web real: token en `localStorage`, login + MFA + secciones.
- **Cero responsividad:** `index.html` tiene todos los estilos inline y **no hay
  una sola media query**. Layout `.shell` = sidebar fijo de 220px + `.main`
  padding 2rem. En móvil el sidebar come pantalla y las tablas
  (`transactions`, `kiosks`, `dentists`) se desbordan.
- Viewport correcto (`width=device-width, initial-scale=1.0`).
- Gaps concretos: sidebar no colapsable, tablas sin scroll/responsive, modales
  `max-width:480px` OK pero sin ajuste fino móvil, formularios usables pero
  apretados.

### 1.3 Backend (`apps/api`, Fastify + TS)

- **Dependencia de `kiosk_token`** (mapa exacto):
  - `requireKiosk`: `/kiosk/bootstrap`, `/kiosk/standby`, `/kiosk/standby/media`
  - `verifyKioskToken` inline: `/auth/request-otp`, `/auth/login-direct`
  - `requireKioskAuth`: `/kiosk/register`
  - **Todo `/me/*` usa solo `requirePatient`** → ya es web-ready.
- `signPatientSession()` exige un `kioskId`. La sesión de paciente lleva
  `kiosk_id` embebido (se usa de forma informativa en `transactions`, auditoría).
  Para web habrá que permitir un `kiosk_id` nulo o un "kiosk virtual web".
- Autenticación de paciente: OTP por SMS+Email al contacto **registrado en
  Dentalink**, con **anti-enumeración** (respuesta idéntica exista o no el
  paciente) y rate-limit por teléfono/IP/kiosco. Este diseño es **excelente para
  web pública** (factor posesión real). Mantener `OTP_REQUIRED=true`.
- `login-direct` (sin OTP) existe para `OTP_REQUIRED=false`: **NO debe usarse en
  web pública** (basta teléfono → suplantación trivial). Forzar OTP en web.
- Mono-clínica: todo es `clinic WHERE id = 1`.
- Pagos vía Wompi *payment link* (URL) + polling de estado + reconciliador +
  webhook HMAC. Compatible con web; solo cambia la UX (link directo vs QR).

### 1.4 Seguridad

| Hallazgo | Severidad | Detalle |
|----------|-----------|---------|
| **Sin rate-limit global por IP** | Alta | `@fastify/rate-limit` está en `package.json` pero **no se registra** en `server.ts`. Solo hay rate-limit custom en OTP y lockout por cuenta en admin. Expuesto a internet, `/me/*`, `/admin/auth/login`, pagos y polling quedan sin techo por IP. |
| **Pérdida del muro `kiosk_token`** | Alta | Hoy el `kiosk_token` actúa como primer filtro (solo dispositivos pareados llegan al OTP). Al abrir a internet ese muro desaparece; el rate-limit + OTP + anti-enumeración deben absorberlo. Reforzar buckets (hoy: 3/teléfono/h, 10/IP/h). |
| `login-direct` sin OTP | Alta | Debe quedar deshabilitado/eliminado en despliegue web. |
| CSP del kiosco vs tema apple | Media | CDNs bloqueados (ver 1.1). Resolver self-host o ampliar CSP con cuidado. |
| Sesión admin no revocable | Media | JWT stateless; el "logout" admin solo borra el token cliente (sin blocklist). Con exposición pública conviene blocklist en Redis (ya disponible). |
| Token admin en `localStorage` | Media | Vulnerable a XSS. Mitigado por CSP estricta; considerar cookie `HttpOnly`+CSRF a futuro. |
| Sesión paciente solo en memoria | Baja (seguridad) / Alta (UX) | Segura, pero en web obliga a re-login en cada refresh. Al persistirla, hacerlo en `sessionStorage` y respetar el TTL de 10 min. |
| Subida de archivos admin | Baja | `multipart` 50MB, 1 archivo. Validar tipos/redimensionar; revisar que `uploads/` no sea servible como ejecutable. |
| Habeas Data / PII | Media | Logs enmascaran teléfono/email. Mantener al exponer; revisar retención de `audit`/`otp_codes`/`patient_sessions`. |

Bien resuelto ya: Argon2id, MFA TOTP + recovery codes, lockout admin,
constant-time login, anti-enumeración OTP, HMAC webhooks, helmet, cifrado de
secretos (Dentalink token, TOTP), trustProxy detrás de Caddy.

### 1.5 Infraestructura (Hetzner: Docker Compose + Caddy)

- `docker-compose.yml`: caddy + api + postgres + redis, red interna `dk-net`,
  healthchecks. `docker-compose.prod.yml`: usa `Caddyfile.prod` (Let's Encrypt
  real) y no expone puertos de DB.
- `Caddyfile.prod`: HTTPS ACME, HSTS, X-Frame-Options DENY, nosniff,
  Referrer-Policy, Permissions-Policy, CSP por sección, gzip/zstd, rutas
  `/` (kiosco), `/admin` (admin), `/api/*` (handle_path strip), `/webhooks/*`,
  `/health`. **Base sólida y ya pensada para producción.**
- Gaps para web pública:
  - `Permissions-Policy` incluye `payment=()` → **bloquea Payment Request API**
    si algún día se usa; con redirect a Wompi no afecta, pero anotarlo.
  - CSP kiosco no contempla el tema apple (CDN) ni `connect-src` a Wompi si se
    hiciera client-side (hoy va por backend, OK).
  - Falta dominio real, `CADDY_EMAIL`, `PUBLIC_BASE_URL=https://...`,
    `NODE_ENV=production` y secretos productivos en `.env`.
  - **Aislamiento Docker de este clon** (`kiosko_v4`): comparte nombres de
    contenedor/volumen `dentalkiosco_*` con el original. Para correr ambos en el
    mismo host hay que fijar `COMPOSE_PROJECT_NAME`/volúmenes distintos. (Fuera
    del alcance funcional, pero relevante si conviven.)

---

## 2. Cambios necesarios ordenados por impacto/prioridad

> Complejidad: **B** bajo · **M** medio · **A** alto.

### Prioridad 0 — Habilitadores (sin esto no hay web)

| # | Cambio | Área | Complejidad |
|---|--------|------|-------------|
| 0.1 | Backend: exponer `bootstrap`/`standby` como **público de clínica** (sin `kiosk_token`) o nueva ruta `/public/*`. | Backend | M |
| 0.2 | Backend: `request-otp` (y registro) **sin `kiosk_token`**; mover los controles del kiosco (kiosco activo) a control por IP/rate-limit. | Backend | M |
| 0.3 | Backend: permitir sesión de paciente con `kiosk_id` nulo / "web" (`signPatientSession`, `patient_sessions`, `transactions`). | Backend | M |
| 0.4 | Frontend kiosco: quitar gate de `kiosk_token` en `main.js`/`api.js`; arrancar contra config pública. | Front kiosco | M |
| 0.5 | Forzar `OTP_REQUIRED=true` y deshabilitar `login-direct` en web. | Backend/Config | B |

### Prioridad 1 — Seguridad (obligatoria antes de exponer)

| # | Cambio | Área | Complejidad |
|---|--------|------|-------------|
| 1.1 | Registrar **`@fastify/rate-limit` global por IP** + límites finos en `/auth/*`, `/me/payments`, `/admin/auth/login`. | Seguridad | M |
| 1.2 | Endurecer buckets OTP (revisar 3/tel/h, 10/IP/h) y añadir captcha/turnstile opcional en `request-otp` si hay abuso. | Seguridad | M |
| 1.3 | Blocklist de sesiones admin en Redis (logout/revocación real). | Seguridad | M |
| 1.4 | Revisar CSP (kiosco/web) y `Permissions-Policy`; resolver fuentes del tema apple (self-host recomendado). | Infra/Sec | M |
| 1.5 | Persistencia de sesión paciente en `sessionStorage` con expiración estricta y limpieza. | Front kiosco/Sec | B |

### Prioridad 2 — Frontend web del paciente (UX)

| # | Cambio | Área | Complejidad |
|---|--------|------|-------------|
| 2.1 | Router con **URLs reales** (deep-link, back, refresh) reemplazando el router sin-URL. | Front kiosco | A |
| 2.2 | **Responsive** de todas las pantallas (home/citas/tratamientos/booking/pago/perfil) móvil-first. | Front kiosco | A |
| 2.3 | Pago en móvil: botón "Pagar ahora" (abre link Wompi/redirect) + retorno; QR solo como fallback escritorio. | Front kiosco | M |
| 2.4 | Reemplazar standby por **landing/home pública** (o login directo); desactivar idle agresivo y teclado táctil en web. | Front kiosco | M |
| 2.5 | Revisar viewport (`user-scalable`), foco, accesibilidad táctil/teclado. | Front kiosco | B |

### Prioridad 3 — Admin responsive

| # | Cambio | Área | Complejidad |
|---|--------|------|-------------|
| 3.1 | Sidebar colapsable + media queries; tablas con scroll/responsive (transactions, kiosks, dentists). | Front admin | M |
| 3.2 | Ajuste de formularios/modales en móvil. | Front admin | B |

### Prioridad 4 — Infra/Producción Hetzner

| # | Cambio | Área | Complejidad |
|---|--------|------|-------------|
| 4.1 | Dominio + DNS + `CADDY_DOMAIN`/`CADDY_EMAIL`/`PUBLIC_BASE_URL`/`NODE_ENV=production`. | Infra | B |
| 4.2 | CSP/headers finales en `Caddyfile.prod` para el frontend web del paciente. | Infra | M |
| 4.3 | Build y publicación de `dist` (kiosco-web + admin) en Caddy; pipeline/healthchecks. | Infra | M |
| 4.4 | (Si conviven con el original) aislar `COMPOSE_PROJECT_NAME`/volúmenes. | Infra | B |
| 4.5 | Backups de Postgres, rotación de logs, alertas (Sentry DSN ya soportado). | Infra | M |

---

## 3. Riesgos

1. **Apertura del perímetro (alto):** quitar el `kiosk_token` elimina el primer
   filtro. Si el rate-limit global (1.1) no está antes de exponer, se abre a
   fuerza bruta de OTP, scraping y abuso de SMS (coste real Twilio). *Mitigación:*
   P1 es prerrequisito duro de P4.
2. **Abuso de envío de OTP / coste SMS (alto):** `request-otp` dispara SMS+Email.
   Sin límites por IP/teléfono robustos y/o captcha, es un vector de gasto y
   spam. *Mitigación:* 1.1 + 1.2.
3. **Enumeración de pacientes (medio):** ya hay anti-enumeración, pero el
   timing/efectos colaterales deben re-auditarse en web. *Mitigación:* pruebas
   específicas.
4. **Router sin URLs (medio):** migrar a rutas reales puede romper flujos y
   `cleanup()` de pantallas; riesgo de fugas de estado/listeners. *Mitigación:*
   migración incremental con tests de navegación.
5. **Pérdida/retención de sesión (medio):** persistir la sesión paciente mal
   hecho = riesgo de robo de token en dispositivo compartido. *Mitigación:*
   `sessionStorage` + TTL corto (10 min ya existente) + logout claro.
6. **CSP rompiendo el tema apple (medio):** si se amplía CSP a CDNs se debilita;
   si no, la UI sale degradada. *Mitigación:* self-host de Inter + Tabler.
7. **Pagos en móvil (medio):** flujo de retorno desde Wompi (app switch, deep
   link de vuelta, polling tras volver). *Mitigación:* manejar `return`/reanudar
   polling al recuperar foco.
8. **Mono-clínica (bajo/medio):** todo es `id=1`. La web pública sigue siendo de
   una sola clínica; si se quisiera multi-clínica sería otro proyecto.
9. **Convivencia con el proyecto original en el host (bajo):** colisión de
   contenedores/volúmenes Docker (ver 4.4).

---

## 4. Propuesta de hitos

Orden pensado para poder **exponer a internet lo más tarde posible y solo cuando
la seguridad esté lista**.

- **Hito A — Backend "web-ready" (P0 backend).** 0.1–0.3, 0.5. Endpoints
  públicos de clínica + sesión paciente sin kiosco + OTP forzado. Con tests.
  *Sin exponer aún.*
- **Hito B — Seguridad de perímetro (P1).** 1.1–1.5. Rate-limit global, blocklist
  admin, CSP/fuentes, persistencia de sesión. **Gate obligatorio** antes de C/F.
- **Hito C — Frontend web del paciente, núcleo (P0 front + parte P2).** 0.4,
  2.4, 2.3. App arranca sin token, login OTP, home, pago móvil. Funcional en
  móvil aunque sin pulido total.
- **Hito D — Responsive + routing completo (resto P2).** 2.1, 2.2, 2.5. URLs
  reales y responsive de todas las pantallas.
- **Hito E — Admin responsive (P3).** 3.1, 3.2.
- **Hito F — Producción Hetzner (P4).** 4.1–4.5. Dominio, HTTPS, build/deploy,
  backups. Exposición pública real **solo tras B**.
- **Hito G — Hardening y pruebas finales.** Pentest ligero, pruebas de carga de
  OTP/pagos, auditoría de logs/PII, smoke E2E móvil/tablet/PC.

Ruta crítica: **A → B → C → F**. D, E, G se solapan tras C.

---

## 5. Decisiones abiertas (requieren tu respuesta antes de implementar)

1. **Modelo de acceso:** ¿Opción A (recomendada), o C (mantener también kioscos
   físicos en paralelo)?
2. **Standby/landing:** ¿landing pública con marca de la clínica, o ir directo al
   login al entrar a la URL?
3. **Routing:** ¿URLs con History API (`/citas`, `/pagar`) o hash (`#/citas`)?
   (History es más limpio pero exige fallback en Caddy — ya hay `try_files`.)
4. **Fuentes del tema apple:** ¿self-host (recomendado) o ampliar CSP a CDNs?
5. **Dominio:** ¿qué dominio/subdominio? ¿mismo dominio para paciente y `/admin`
   o subdominios separados (`app.` vs `admin.`)?
6. **Captcha/Turnstile** en `request-otp`: ¿lo incluimos desde el inicio o solo
   si aparece abuso?
7. **Convivencia:** ¿este clon `kiosko_v4` se despliega en el mismo host que el
   original (requiere aislar Docker) o en uno nuevo?

---

## 6. Plan de pruebas (por hito A–G)

### 6.0 Estrategia general y cómo NO romper los 253 tests actuales

**Stack de pruebas existente (a reutilizar tal cual):**
- **Unit/integración backend:** Vitest (`pnpm test` → `vitest run`). Patrón real:
  `buildServer()` + **`app.inject()`** (no abre socket), Postgres/Redis de test
  reales, y **senders inyectables** (`setSmsSender`/`setEmailSender`) para mockear
  SMS/email sin coste. 253 tests en 16 archivos.
- **E2E:** existe el script `pnpm test:e2e` → `playwright test`, **pero todavía no
  hay `playwright.config.ts`** → hay que crearlo (parte del Hito C).
- **Calidad:** `pnpm typecheck` y `pnpm lint` ya pasan; son gate adicional.

**Regla de oro:** `pnpm test && pnpm typecheck && pnpm lint` deben quedar verdes
al cerrar cada PR. Ningún hito se da por terminado con tests rojos.

**Cómo conviven los 253 tests con el cambio de `kiosk_token` → web pública:**
- Hoy varios tests dependen del token de kiosco: `patient-auth.test.ts` usa
  `signKioskToken`, y `kiosk-bootstrap-*.test.ts` prueban `requireKiosk`. **No se
  borran: se adaptan.**
  - **Opción A (recomendada):** se refactorizan a las nuevas rutas públicas,
    **conservando intactas** las aserciones de valor (anti-enumeración,
    rate-limit, "el OTP nunca aparece en logs/responses", sesión válida tras
    verify). Lo único que cambia es que ya no se envía `Authorization: Bearer
    <kiosk_token>`.
  - **Opción C (kiosco físico + web):** los tests de kiosco se mantienen y se
    **añaden** variantes `*-public` para las rutas web. Suite crece, no se rompe.
- Cada PR que toque auth corre el suite completo antes y después; los diffs de
  tests se revisan explícitamente para confirmar que solo cambió el transporte
  del token, no la lógica de seguridad.
- Se añade (Hito F/G) un job de CI: `test` + `typecheck` + `lint` + `test:e2e`.

### 6.1 Pruebas por hito

| Hito | Pruebas automatizadas | Pruebas manuales | Gate de cierre |
|------|----------------------|------------------|----------------|
| **A — Backend web-ready** | Vitest `app.inject`: (a) `bootstrap`/`standby` públicos responden 200 sin token y siguen ocultando datos sensibles; (b) `request-otp` sin `kiosk_token` mantiene anti-enumeración y rate-limit; (c) `signPatientSession` con `kiosk_id` nulo → sesión válida y `/me/*` funciona; (d) `login-direct` deshabilitado en web → 403; (e) refactor de `patient-auth`/`kiosk-bootstrap` tests. | `curl` del flujo completo request-otp → verify → `/me/appointments`. | 253 (adaptados) verdes + typecheck. |
| **B — Seguridad** | Ver **6.2** (suite de seguridad dedicada). | OWASP ZAP baseline + carga con `k6`/`hey` contra staging. | Suite 6.2 verde + escaneo sin hallazgos altos. |
| **C — Front web núcleo** | **Crear `playwright.config.ts`** con devices (Pixel 7 / iPad / Desktop). E2E: arranque sin token → login OTP (código vía hook de test/redis dev) → home → ver citas → iniciar pago (Wompi mockeado) → "Pagar ahora" abre link. | iOS Safari + Android Chrome reales; retorno desde Wompi sandbox. | E2E móvil verde en los 3 perfiles. |
| **D — Responsive + routing** | Playwright: deep-link directo (`/citas`), botón atrás del navegador, **refresh mantiene estado/sesión**, sin teclado táctil (usa el nativo), idle relajado. Snapshots por breakpoint. | Recorrido en breakpoints 360/768/1280px; foco y zoom. | E2E routing + responsive verdes. |
| **E — Admin responsive** | Playwright admin en móvil/tablet: sidebar colapsable, login + MFA, tablas con scroll. | Revisión de `transactions`/`kiosks`/`dentists` en móvil. | E2E admin móvil verde. |
| **F — Producción Hetzner** | Smoke post-deploy: `GET /health/ready` 200, TLS válido (`curl -vI` / sslscan), header HSTS presente, login E2E contra dominio staging, webhook Wompi alcanzable. | **Simulacro de rollback** (sección 9). | Smoke verde + simulacro de rollback exitoso. |
| **G — Hardening** | Matriz E2E completa, carga `k6` sobre OTP/pagos, `pnpm audit`, escaneo ZAP/Nikto. | Auditoría de logs/PII (enmascarado), revisión de retención. | Sin hallazgos críticos/altos abiertos. |

### 6.2 Tests de seguridad del Hito B (detallado)

> Implementables mayormente con `app.inject` + `X-Forwarded-For` (el server usa
> `trustProxy: true`, así que la IP de rate-limit es controlable en test).

1. **Rate-limit global por IP:**
   - Enviar N+1 requests con el mismo `X-Forwarded-For` → las primeras N pasan,
     la siguiente devuelve **429 con `Retry-After`**.
   - Otra IP distinta no queda limitada (aislamiento por bucket).
   - Tras expirar la ventana, el contador se reinicia.
2. **Fuerza bruta de OTP:**
   - `verify-otp` con código incorrecto repetido hasta `max_attempts` → **429
     `TOO_MANY_ATTEMPTS`**; un código correcto posterior **sigue rechazado**
     (el OTP queda quemado). (Extiende lo ya cubierto en `patient-auth.test.ts`.)
   - `request-otp` repetido sobre el mismo teléfono → **429 `RATE_LIMIT`** según
     los buckets de la sección 7.
3. **Abuso de envío de SMS (coste Twilio):**
   - Con el SMS sender mockeado: tras superar el bucket, el sender **no se invoca
     más** y se responde 429 (no se "gastan" SMS por encima del límite).
   - **Teléfono no registrado → 0 SMS enviados** (escudo principal de coste; ver
     sección 7). Test explícito de que `mockSms.send` no se llamó.
   - Si se activa Turnstile: `request-otp` sin token válido → 400/403 **antes** de
     tocar el sender (mock de `siteverify`).
4. **Anti-enumeración:**
   - Teléfono registrado vs no registrado → **mismo status y misma forma de
     respuesta** (`request_id`, `expires_in_seconds`); diferencia solo en
     auditoría, nunca en la respuesta. Verificar que no se filtra existencia.
5. **Revocación de sesión admin (blocklist Redis):**
   - Tras `POST /admin/auth/logout`, el mismo token → **401** (jti en blocklist),
     aunque el JWT aún no haya expirado.
6. **Cabeceras/CSP (las pone Caddy, no Fastify):** test de integración con
   contenedor (`curl -I`) que verifica HSTS, `X-Frame-Options`, CSP por sección y
   ausencia de `Server`. Se corre en smoke de Hito F, no en `app.inject`.

---

## 7. Anti-abuso de OTP y control de costo Twilio (concreto)

El coste real de SMS obliga a defensa por capas. **El escudo más fuerte ya
existe:** por anti-enumeración, **solo los teléfonos registrados en Dentalink
reciben SMS** — un atacante no puede quemar SMS contra números arbitrarios. Sobre
esa base, se añade:

### 7.1 Cloudflare Turnstile en `request-otp` — **recomendado desde el inicio**
Dado que el SMS cuesta dinero, no se deja como "opcional". El frontend obtiene un
token Turnstile (widget invisible/managed, gratis) y el backend lo valida
server-side (`siteverify`) **antes** de cualquier lookup o envío. Sin token
válido → 400, sin tocar Twilio.

### 7.2 Límites concretos propuestos (reemplazan los actuales 3/tel/h · 10/IP/h)

| Bucket | Límite propuesto | Hoy |
|--------|------------------|-----|
| Por teléfono — cooldown | 1 cada **60 s** | — |
| Por teléfono — hora | **3 / h** | 3/h |
| Por teléfono — día | **5 / día** | — |
| Por IP — hora | **5 / h** | 10/h |
| Por IP — día | **20 / día** | — |
| Global clínica — hora | **~100 / h** (cap blando con alerta) | — |

(Se implementan con la `fn_rate_limit_check` ya existente, añadiendo buckets de
día y global.)

### 7.3 Qué pasa al exceder
- HTTP **429** + `Retry-After`, mensaje genérico (no revela qué bucket se
  excedió), evento en `audit`.
- Al superar el **cap global/hora** se dispara una **alerta al admin** (email
  `CORREO_NOTIFICACION` ya disponible / Sentry) — señal temprana de ataque.

### 7.4 Control de canal y de proveedor
- **Reenvío:** el primer envío va por SMS+email (como hoy); los reenvíos dentro de
  la ventana van **solo por email**, y el reenvío por SMS exige un cooldown más
  largo (evita duplicar coste).
- **Twilio:** restringir Geo-permissions a **Colombia**, usar Messaging Service
  con límites, y **alertas de facturación** en la consola de Twilio.
- **Observabilidad:** métrica diaria de SMS enviados con umbral de alerta.

---

## 8. Protección DDoS / WAF a nivel de infraestructura

Recomendación: **Cloudflare (plan gratis) por delante de Caddy** (DNS proxied,
"orange cloud"), como capa previa al rate-limit de Fastify (defensa en
profundidad).

| Capa | Qué aporta |
|------|-----------|
| **Cloudflare (edge, gratis)** | WAF con reglas gestionadas, mitigación DDoS L3/L4/L7, rate-limiting rules (p. ej. sobre `/api/auth/*`), Bot Fight Mode, Turnstile nativo, cache de assets estáticos, **oculta la IP de origen**. |
| **Hetzner (red)** | Protección DDoS de red básica incluida + **Cloud Firewall** para cerrar el origen. |
| **Caddy (origen)** | TLS, headers/CSP, reverse proxy (ya configurado). |
| **Fastify (app)** | Rate-limit por IP como backstop (sección 1.1). |

**Configuración clave (imprescindible):**
1. DNS del dominio a Cloudflare, modo SSL **Full (Strict)** (Caddy sigue
   sirviendo su cert; o usar Origin Certificate de Cloudflare).
2. **Firewall de Hetzner: permitir 80/443 solo desde los rangos de Cloudflare** —
   si no, un atacante que descubra la IP de origen **salta Cloudflare**. Esto es
   lo que cierra el bypass.
3. **IP real del cliente:** Caddy con `trusted_proxies` = rangos de Cloudflare y
   leyendo `CF-Connecting-IP` → propaga a `X-Forwarded-For` (Fastify ya tiene
   `trustProxy: true`). Sin esto, el rate-limit por IP vería la IP de Cloudflare.
4. Reglas WAF: ruleset gestionado + rate-limit en `/api/auth/request-otp` y
   `/admin/auth/login`; Bot Fight + Turnstile.

Alternativa solo-Caddy (rate-limit con plugin `caddy-ratelimit`, requiere build
custom): **no recomendada** como única defensa — sin WAF gestionado ni mitigación
DDoS a nivel de red.

---

## 9. Estrategia de rollback

### 9.1 Lo que ya existe (`updater/update.sh`) y sí aplica
El proyecto ya trae un updater robusto, **reutilizable para el backend**:
- Manifiesto **firmado (GPG)** + comparación semver, deploy de la **API por
  imagen** (`images.api`), con override de compose para fijar la imagen.
- **Backup de Postgres** (`pg_dump | gzip`, conserva los últimos 7) antes de
  migrar.
- Migraciones, luego **health check `GET /health/ready`**.
- **Rollback automático** si el health check falla: restaura la imagen previa +
  **restaura la DB** + reinicia; tiene modo `--dry-run` y notificación al admin.
- `pnpm db:rollback` = `migrate down` (migraciones reversibles por paso).

### 9.2 Gaps a cubrir para esta migración
1. **Frontend estático no cubierto:** los `dist` de kiosco-web y admin se sirven
   por **bind-mount** en Caddy; el rollback por imagen de la API **no los
   revierte**. Propuesta: **versionar los artefactos `dist`** (carpeta por
   versión + symlink `current`; rollback = re-apuntar symlink + `caddy reload`),
   **o** empaquetar los frontends en imagen y añadirlos al manifiesto firmado
   igual que la API.
2. **Migraciones destructivas bloquean el rollback de código:** si una migración
   borra/renombra columnas, revertir el código choca con el esquema nuevo.
   **Política expand-contract:** primero migraciones aditivas (compatibles con la
   versión anterior); lo destructivo, solo en una release posterior ya estable.
   Tests de las migraciones `down` en CI.

### 9.3 Runbook de rollback manual (si el automático no aplica)
1. Fijar la imagen anterior de la API (override de compose) y `docker compose up -d`.
2. Si el esquema cambió: restaurar el backup pre-deploy (`backups/backup-*.sql.gz`).
3. Re-apuntar el symlink del `dist` a la versión anterior.
4. `caddy reload`.
5. Verificar `GET /health/ready` + smoke E2E mínimo.

### 9.4 Checklist pre-deploy y simulacro
- Backup verificado, migraciones `down` probadas en **staging**, smoke E2E verde
  en staging.
- **Simulacro de rollback** como criterio de cierre del Hito F (y repetido en G).

---

## 10. Persistencia de sesión en móvil

**Hoy:** el `patientToken` vive **solo en memoria** (cualquier refresh, cambio de
app o bloqueo de pantalla cierra sesión); idle agresivo 60/90 s; JWT de paciente
**TTL 10 min** con verificación de revocación en BD. Adecuado para un kiosco
compartido, **hostil para un dispositivo personal**.

### 10.1 Comportamiento propuesto para web

| Parámetro | Propuesta | Razonamiento |
|-----------|-----------|--------------|
| Almacenamiento del token | **`sessionStorage`** (sobrevive refresh, se borra al cerrar pestaña) | Equilibrio entre UX y riesgo en dispositivo prestado. (localStorage = más persistente pero más expuesto a XSS; se documenta el trade-off.) |
| Access token (JWT) | **30 min** (config `JWT_PATIENT_SESSION_TTL_MINUTES`) | Suficiente para un trámite sin re-login constante. |
| Sesión deslizante / refresh | Endpoint **`/auth/refresh`** que valida `patient_sessions` (no revocada/expirada) y emite un access nuevo; **refresh deslizante** hasta un **máximo absoluto ~8 h** | Permite sesiones largas sin tokens de larga vida en el cliente. |
| Logout por inactividad | **30 min** sin actividad (no 90 s) | Protege datos sensibles sin ser hostil. |
| Idle agresivo de kiosco | **Desactivado** en modo web | El 60/90 s es solo para kiosco físico. |

### 10.2 Qué pasa al cambiar de app / bloquear pantalla / volver
- **No** se cierra sesión al perder foco. Se escucha `visibilitychange` /
  `pageshow` (compatible con bfcache):
  - Al **volver** (visible): si el access expiró → **refresh silencioso**; si el
    refresh sigue válido, el usuario no nota nada.
  - Si el refresh ya expiró (pasó el máximo absoluto o se revocó) → redirigir a
    login **preservando la ruta destino** (deep-link de retorno).
- **Pago:** al volver a la app se **reanuda el polling** del estado de la
  transacción (clave para el retorno desde Wompi/Nequi).
- No atar la sesión a la IP (las redes móviles cambian de IP); la seguridad
  descansa en el token + revocación server-side ya existente.
- El botón de **logout** sigue limpiando storage y revocando en servidor
  (`/auth/logout` ya implementado).

### 10.3 Implicaciones
- Cambios de backend: `/auth/refresh`, TTL configurable, (opcional) tabla/uso de
  refresh con rotación. Tests: refresh válido renueva, refresh expirado/revocado
  rechaza, máximo absoluto se respeta (añadir al Hito B).
- Cambios de frontend: capa de sesión en `api.js` (persistencia + refresh
  silencioso), manejo de `visibilitychange`/`pageshow`, reanudación de polling.

---

*Fin del plan. No se ha modificado ningún archivo del sistema salvo la creación y
ampliación de este documento. A la espera de aprobación para iniciar por el Hito A.*
