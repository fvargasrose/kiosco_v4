# Plan abierto v2 — PLAN DE EJECUCIÓN (DentalKiosco → web pública)

> **Propósito:** guía de trabajo **secuencial, hito por hito**, lista para
> implementar. Es el documento operativo del día a día.
>
> **Documento de referencia:** [`plan_abierto.md`](./plan_abierto.md) (análisis
> completo: hallazgos, riesgos, tests detallados §6, anti-abuso OTP §7, WAF §8,
> rollback §9, sesión móvil §10). **No se modifica**; este v2 lo ejecuta.
>
> **Estado global:** ☐ Sin iniciar. Pendiente de aprobación del Hito A.
> **Fecha:** 2026-06-03.

## Regla de oro

1. **Un hito a la vez.** No se empieza el siguiente sin la casilla
   *"Aprobado por humano"* del actual marcada.
2. **Los 253 tests siempre verdes.** `pnpm test && pnpm typecheck && pnpm lint`
   es gate de cierre de cada hito. Tests que dependían de `kiosk_token` se
   **adaptan, no se borran** (conservando las aserciones de seguridad).
3. **Nada se expone a internet antes de cerrar el Hito B** (seguridad de
   perímetro). Ruta crítica: **A → B → C → F**; D, E y G se solapan.

## Decisiones ya tomadas (no son "abiertas")

- **Modelo de acceso = Opción A:** endpoints **públicos de clínica**, sin
  `kiosk_token`, **sin kioscos físicos**. El control real es rate-limit + OTP +
  Turnstile + anti-enumeración.
- **Cloudflare Turnstile = SÍ desde el inicio** en `request-otp`.
- Quedan **a resolver al llegar a su hito**: standby/landing (Hito C), routing
  History vs hash (Hito D), self-host de fuentes apple (Hito C/F), dominio y
  subdominios (Hito F), convivencia Docker con el proyecto original (Hito F).

---

## Tabla resumen de hitos

| Hito | Nombre | Objetivo (1 línea) | Estado | Depende de |
|------|--------|--------------------|--------|------------|
| **A** | Backend web-ready | API sin `kiosk_token`: endpoints públicos + sesión paciente sin kiosco + OTP forzado | ✅ | — |
| **B** | Seguridad de perímetro | Rate-limit global por IP, Turnstile enforced, blocklist admin | 🔄 | A |
| **C** | Front web del paciente (núcleo) | Arranca sin token, login OTP web, home/citas/pago móvil | ☐ | A |
| **D** | Responsive + routing | URLs reales (deep-link/back/refresh) y responsive total | ☐ | C |
| **E** | Admin responsive | Panel admin usable en móvil/tablet | ☐ | A (paralelo) |
| **F** | Producción Hetzner | HTTPS + Cloudflare + firewall de origen + deploy/rollback | ☐ | B y C |
| **G** | Hardening y pruebas finales | Carga, pentest-lite, auditoría PII, simulacro rollback | ☐ | F |

Leyenda: ☐ pendiente · 🔄 en progreso · ✅ hecho.

---

## Hito A — Backend web-ready

### Objetivo
Eliminar la dependencia del `kiosk_token` en el flujo del paciente y exponer la
configuración de la clínica y el arranque de autenticación como **rutas públicas**
(clínica única `id=1`), forzando OTP.

### Sub-tareas (archivos y cambios)
- **`apps/api/src/routes/` — crear `public.ts`** con la config pública de clínica:
  `GET /public/bootstrap`, `GET /public/standby`, `GET /public/standby/media`.
  Reusar la lógica de `kiosk.ts` **sin `requireKiosk`** y sin la telemetría de
  kiosco (`last_seen_at`/`last_ip`). Mantener `otp_required`, `theme`,
  `feature_registro`, datos de clínica, FAQ, procedimientos, standby.
- **`apps/api/src/routes/patient-auth.ts`:**
  - `request-otp`: quitar `extractBearer`+`verifyKioskToken`+chequeo de kiosco
    activo. Dejar punto de enganche para Turnstile (enforcement completo en B).
    El `INSERT habeas_data_consents` pasa a `kiosk_id = NULL`.
  - `login-direct`: **deshabilitar** (devolver 410/404 o eliminar la ruta) —
    Opción A fuerza OTP.
- **`apps/api/src/lib/jwt.ts` → `signPatientSession`:** `kioskId` **opcional**.
- **`apps/api/src/routes/patient-register.ts`:** `/kiosk/register` → público
  (sin `requireKioskAuth`), gobernado por `FEATURE_REGISTRO`.
- **Migración DB nueva** (`apps/api/migrations/...`): permitir `kiosk_id NULL` en
  `otp_codes`, `patient_sessions`, `transactions`, `habeas_data_consents` (donde
  hoy sea NOT NULL). Reversible (`down`).
- **`apps/api/src/lib/config.ts`:** añadir `TURNSTILE_SECRET`/`TURNSTILE_SITEKEY`
  (opcionales en A, requeridos en B). Garantizar `OTP_REQUIRED=true` en web.
- **`apps/api/src/server.ts`:** registrar las nuevas rutas públicas; las
  `/kiosk/*` y `admin-kiosks` quedan **marcadas como deprecadas** (no se borran en
  A para minimizar churn; limpieza opcional posterior).

### Decisiones que se resuelven en este hito
- Nomenclatura de rutas públicas → **propuesta: `/public/*`** (confirmar).
- `kiosk_id` en sesión/registros → **propuesta: `NULL`** (vs sentinel `"web"`).
- ¿`/kiosk/register` se mantiene tras `FEATURE_REGISTRO` o se elimina?

### Tests a crear/adaptar (ver `plan_abierto.md` §6.1 fila A)
- Adaptar `patient-auth.test.ts` y `kiosk-bootstrap-*.test.ts` a rutas públicas
  (conservando anti-enumeración, rate-limit, "OTP nunca en logs/responses").
- Nuevos: `public/bootstrap` 200 sin token; `request-otp` sin token mantiene
  anti-enum; sesión con `kiosk_id null` → `/me/*` OK; `login-direct` → bloqueado.

### Comandos de verificación
```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
pnpm lint
# Smoke manual:
curl -s http://localhost:3000/public/bootstrap | jq .
```

### Criterio de cierre (DoD)
- Endpoints públicos responden sin `kiosk_token`; `login-direct` bloqueado.
- Sesión de paciente funciona con `kiosk_id` nulo; todo `/me/*` operativo.
- Migración aplica y revierte. Suite (adaptado) + typecheck + lint verdes.

**[x] Aprobado por humano para avanzar al siguiente** — 2026-06-03. Suite 262 verde, merge a `main`. Ver `hito_A.md`.

---

## Hito B — Seguridad de perímetro

### Objetivo
Sustituir el muro perdido (`kiosk_token`) por defensa real: rate-limit global,
Turnstile obligatorio y revocación de sesión admin. **Gate antes de exponer (F).**

### Sub-tareas (archivos y cambios)
- **`apps/api/src/server.ts`:** registrar **`@fastify/rate-limit` global** (ya en
  `package.json`, hoy sin registrar) con store en **Redis** (`lib/redis.ts`),
  `keyGenerator` por IP (`trustProxy` ya activo), allowList para `/health`.
- **Límites por ruta** sobre `/auth/*`, `/me/payments`, `/admin/auth/login` (más
  estrictos que el global).
- **Buckets OTP** (`fn_rate_limit_check`): añadir bucket por **día** y **global de
  clínica/hora** según `plan_abierto.md` §7.2; al exceder → 429 + `Retry-After` +
  `audit`; alerta al admin al superar el cap global.
- **Turnstile enforced** en `patient-auth.ts request-otp`: validar token con
  `siteverify` **antes** de lookup/envío; sin token válido → 4xx sin tocar Twilio.
  Hacer `TURNSTILE_SECRET` requerido en producción (`config.ts`).
- **Blocklist admin en Redis:** `admin-auth.ts logout` añade `jti` a blocklist
  (TTL = vida restante del JWT); `lib/auth-middleware.ts requireAdmin` la consulta.
- **Twilio (ops):** Geo-permissions a Colombia + alertas de facturación.

### Decisiones que se resuelven en este hito
- Límites exactos finales (partir de §7.2). Store del rate-limit (**Redis**).
- Turnstile: widget **managed/invisible** (confirmar modo).

### Tests a crear (ver `plan_abierto.md` §6.2 — suite de seguridad)
- Rate-limit global por IP (429 + `Retry-After`; aislamiento por IP; reset).
- Fuerza bruta OTP (`max_attempts` → 429; código correcto tras lockout rechazado).
- Abuso SMS: sender mockeado no se invoca tras el límite; **teléfono no
  registrado → 0 SMS**; sin Turnstile → bloqueo antes del sender.
- Anti-enumeración (respuesta idéntica registrado/no registrado).
- Blocklist admin: token tras logout → 401.

### Comandos de verificación
```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
pnpm typecheck && pnpm lint
# Carga local (opcional): k6/hey contra /api/auth/request-otp esperando 429
```

### Criterio de cierre (DoD)
- Rate-limit global activo (Redis) + límites por ruta. Turnstile obligatorio.
- Blocklist admin funcionando. Suite §6.2 verde + 253 verdes.

**[ ] Aprobado por humano para avanzar al siguiente**

---

## Hito C — Front web del paciente (núcleo)

### Objetivo
La app del paciente arranca **sin token**, hace login por OTP en web, y permite
home/citas/tratamientos/pago en móvil.

### Sub-tareas (archivos y cambios)
- **`apps/kiosco-frontend/src/main.js`:** quitar gate de `kiosk_token` y
  `showUnpairedScreen`; arrancar contra `/public/bootstrap`.
- **`apps/kiosco-frontend/src/api.js`:** eliminar `kioskToken`/`_useKiosk`;
  persistir la sesión de paciente en **`sessionStorage`** e integrar
  `/auth/refresh` (ver `plan_abierto.md` §10); adjuntar token Turnstile en
  `request-otp`.
- **`apps/kiosco-frontend/src/screens/standby.js`:** **DECISIÓN aquí** (landing
  pública vs login directo) y reemplazar el atractor de kiosco.
- **`apps/kiosco-frontend/src/idle.js`:** desactivar el idle agresivo (60/90 s);
  pasar a inactividad larga (~30 min) o nada (§10).
- **`apps/kiosco-frontend/src/screens/register.js`:** dejar de montar
  `keyboard.js` (`mountKeyboard`); usar teclado nativo.
- **`apps/kiosco-frontend/src/screens/payment.apple.js`:** botón **"Pagar ahora"**
  que abre el link de Wompi + reanudar polling al volver (`visibilitychange`);
  QR como **fallback de escritorio** (decisión).
- **`apps/kiosco-frontend/src/screens/login-cedula.js`:** integrar widget
  Turnstile antes de `request-otp`.
- **Crear `playwright.config.ts`** (raíz): devices Pixel 7 / iPad / Desktop
  (hoy existe el script `test:e2e` pero **no la config**).

### Decisiones que se resuelven en este hito
- Standby → **landing pública** vs **login directo**.
- QR de pago como fallback en escritorio: sí/no.
- Self-host de fuentes apple (Inter + Tabler) vs CDN (impacta CSP; coordinar F).

### Tests a crear (ver `plan_abierto.md` §6.1 fila C)
- E2E móvil: arranque sin token → login OTP (código vía hook/redis dev) → home →
  ver citas → iniciar pago (Wompi mockeado) → "Pagar ahora".

### Comandos de verificación
```bash
pnpm --filter @dentalkiosco/kiosco-frontend dev   # prueba local
pnpm test:e2e
# 253 backend siguen verdes:
pnpm test && pnpm typecheck && pnpm lint
```

### Criterio de cierre (DoD)
- App arranca sin `kiosk_token`; login OTP web; home/citas/pago móvil funcionales.
- E2E móvil verde en Pixel 7. 253 tests backend siguen verdes.

**[ ] Aprobado por humano para avanzar al siguiente**

---

## Hito D — Responsive + routing completo

### Objetivo
URLs reales (deep-link, botón atrás, refresh mantiene estado) y responsividad
total de las pantallas del paciente.

### Sub-tareas (archivos y cambios)
- **`apps/kiosco-frontend/src/router.js`:** migrar del router sin-URL a **rutas
  reales** (DECISIÓN: History API vs hash). Tabla de rutas, back-button,
  deep-link, restauración tras refresh. Caddy ya hace `try_files .../index.html`.
- **`styles.css` + `styles-apple.css`:** responsive en todas las pantallas
  (home/citas/tratamientos/booking/pago/perfil), breakpoints 360/768/1280,
  targets táctiles, sidebar apple en móvil (`screens/shared/shell.apple.js`).
- **`apps/kiosco-frontend/index.html`:** revisar `user-scalable=no` (accesibilidad).

### Decisiones que se resuelven en este hito
- Routing **History API** (`/citas`) vs **hash** (`#/citas`).
- Política de zoom (viewport).

### Tests a crear (ver `plan_abierto.md` §6.1 fila D)
- Playwright: deep-link directo, botón atrás, refresh mantiene sesión/ruta, sin
  teclado táctil, idle relajado. Snapshots por breakpoint.

### Comandos de verificación
```bash
pnpm test:e2e
pnpm test && pnpm typecheck && pnpm lint
```

### Criterio de cierre (DoD)
- URLs reales operativas; responsive correcto en 360/768/1280; E2E routing +
  responsive verdes.

**[ ] Aprobado por humano para avanzar al siguiente**

---

## Hito E — Admin responsive

### Objetivo
Que el panel admin sea usable en móvil/tablet (hoy: **0 media queries**, sidebar
fijo de 220px, tablas desbordadas).

### Sub-tareas (archivos y cambios)
- **`apps/admin-frontend/index.html`:** añadir media queries (los estilos están
  inline aquí); sidebar **colapsable** (hamburguesa) en móvil.
- **`apps/admin-frontend/src/main.js`:** toggle de navegación en móvil.
- **`apps/admin-frontend/src/screens/{transactions,kiosks,dentists}.js`:** tablas
  con scroll horizontal/responsive; modales y formularios en móvil.

### Decisiones que se resuelven en este hito
- (Ninguna mayor.)

### Tests a crear (ver `plan_abierto.md` §6.1 fila E)
- Playwright admin en móvil/tablet: sidebar colapsable, login + MFA, tablas.

### Comandos de verificación
```bash
pnpm --filter @dentalkiosco/admin-frontend dev
pnpm test:e2e
```

### Criterio de cierre (DoD)
- Admin usable en móvil/tablet; E2E admin móvil verde.

> Nota: E es independiente del flujo de paciente; puede solaparse en cuanto A esté
> cerrado.

**[ ] Aprobado por humano para avanzar al siguiente**

---

## Hito F — Producción Hetzner

### Objetivo
Exponer la app por HTTPS de forma robusta: Cloudflare delante de Caddy, firewall
de origen cerrado, deploy versionado y rollback probado. **Solo tras cerrar B.**

### Sub-tareas (archivos y cambios)
- **Dominio + DNS** (DECISIÓN): dominio/subdominios (paciente vs `/admin`).
  Cloudflare proxied, SSL **Full (Strict)** (ver `plan_abierto.md` §8).
- **Hetzner Cloud Firewall:** 80/443 **solo desde rangos de Cloudflare** (cerrar
  bypass del origen).
- **`infra/caddy/Caddyfile.prod`:** `trusted_proxies` = Cloudflare + leer
  `CF-Connecting-IP`; CSP final del front del paciente (resolver fuentes apple,
  §8); revisar `Permissions-Policy payment=()`.
- **`.env` producción:** `NODE_ENV=production`, `PUBLIC_BASE_URL=https://...`,
  `CADDY_DOMAIN`, `CADDY_EMAIL`, secretos (`pnpm secrets:generate`), claves
  Turnstile y Twilio productivas.
- **Build & deploy:** `pnpm build`; `dist` servido por Caddy; API por imagen vía
  `updater/update.sh`; **versionar artefactos `dist`** para rollback de front
  (`plan_abierto.md` §9.2).
- **Convivencia Docker** (DECISIÓN): si comparte host con el original, fijar
  `COMPOSE_PROJECT_NAME`/volúmenes distintos.
- Backups, rotación de logs, `SENTRY_DSN`, monitoreo.

### Decisiones que se resuelven en este hito
- Dominio y subdominios. Convivencia con el proyecto original. Self-host de
  fuentes apple (cierre final).

### Tests a crear (ver `plan_abierto.md` §6.1 fila F y §9.4)
- Smoke post-deploy: `GET /health/ready` 200, TLS válido, header HSTS, login E2E
  contra staging, webhook Wompi alcanzable.
- **Simulacro de rollback** (restaurar imagen previa + DB + `dist` anterior).

### Comandos de verificación
```bash
pnpm build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
curl -sI https://<dominio>/ | grep -i strict-transport-security
curl -s https://<dominio>/health/ready | jq .
bash updater/update.sh --dry-run    # ensayo de despliegue/rollback
```

### Criterio de cierre (DoD)
- App pública por HTTPS detrás de Cloudflare; firewall cerrando el origen; smoke
  verde; **simulacro de rollback exitoso**. (Requiere B cerrado.)

**[ ] Aprobado por humano para avanzar al siguiente**

---

## Hito G — Hardening y pruebas finales

### Objetivo
Endurecer y validar el sistema ya productivo antes de darlo por terminado.

### Sub-tareas
- Matriz E2E completa (móvil/tablet/PC) sobre staging/producción.
- Carga con **k6** sobre OTP y pagos; verificar 429 y estabilidad.
- `pnpm audit` (dependencias); escaneo **ZAP/Nikto** baseline.
- Auditoría de **logs/PII** (enmascarado) y revisión de **retención**
  (`audit`, `otp_codes`, `patient_sessions`).
- Repetir simulacro de rollback.

### Tests / verificación (ver `plan_abierto.md` §6.1 fila G)
```bash
pnpm test && pnpm test:e2e && pnpm audit
# k6 run load/otp.js ; k6 run load/payments.js
```

### Criterio de cierre (DoD)
- Sin hallazgos críticos/altos abiertos; carga aceptable; documentación final
  actualizada.

**[ ] Aprobado por humano — proyecto completo**

---

## Anexos (referencia)

Para no duplicar, el detalle vive en [`plan_abierto.md`](./plan_abierto.md):

- **Anti-abuso de OTP y costo Twilio** → §7 (Turnstile, límites por
  IP/teléfono/ventana, qué pasa al exceder, control de canal/proveedor).
- **DDoS / WAF (Cloudflare + Caddy + firewall Hetzner)** → §8.
- **Estrategia de rollback** (`updater/update.sh`, gaps de front estático,
  expand-contract, runbook, simulacro) → §9.
- **Persistencia de sesión en móvil** (sessionStorage, TTL 30 min, `/auth/refresh`
  deslizante, comportamiento al cambiar de app) → §10.

---

*Plan de ejecución. No se ha implementado nada todavía. Cada hito se inicia solo
tras la aprobación del anterior. `plan_abierto.md` permanece como análisis de
referencia y no se modifica.*
