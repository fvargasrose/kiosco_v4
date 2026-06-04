# Estados de Hitos C, D, E — Bitácora de implementación

> Bitácora de la ejecución autónoma de los Hitos **C, D, E** de `plan_abierto_v2.md`.
> Implementación de corrido, sin aprobación entre hitos. **DETENER al terminar E.**
> **NO** implementar Hito F (producción/exposición a internet).
> Inicio: 2026-06-03. Rama base: `sistema_abierto` (desde `main`, con A y B fusionados).

---

## ⚠️ REVISAR EN AUDITORÍA

> Todo lo riesgoso, dudoso, asumido o no verificable al 100% se registra aquí de
> forma destacada. Revisar con prioridad.

### Hito C — seguridad / autenticación / sesión / PII

1. **[AUTH] `/auth/refresh` — diseño de sesión deslizante (nuevo, toca auth).**
   - `plan_abierto.md §10` no existía en el backend; lo implementé en el Hito C
     (no estaba en el Hito B pese a que §10.3 lo mencionaba). **Revisar el diseño.**
   - **Decisión propia:** un único token (no hay refresh token separado). El
     refresh **reemite el JWT conservando el mismo `jti`** y extiende
     `patient_sessions.expires_at`. El **máximo absoluto** (8 h por defecto,
     `JWT_PATIENT_SESSION_ABSOLUTE_MAX_HOURS`) se ancla en `created_at`, que no
     cambia entre refrescos.
   - **Decisión propia (importante):** `/auth/refresh` **NO acepta tokens
     expirados**. El cliente debe refrescar mientras la sesión sigue viva
     (visibilitychange/pageshow). Esto es más conservador que un refresh-token de
     larga vida: evita aceptar JWTs vencidos, pero implica que si la app queda en
     segundo plano más que el TTL del access (`JWT_PATIENT_SESSION_TTL_MINUTES`,
     **default 10 min**) sin volver al foco, el paciente re-loguea. **Riesgo: bajo
     (seguridad) — desviación de UX respecto a §10 que sugería access de 30 min.**
   - **No cambié** `JWT_PATIENT_SESSION_TTL_MINUTES` (sigue 10) para no romper
     tests existentes; §10 sugería 30 min para web. **Decidir en prod** vía env.

2. **[PII/Sesión] Persistencia en `sessionStorage`.** Ahora el access token
   (`dk_patient_token`) y el nombre del paciente (`dk_patient_info`) viven en
   `sessionStorage` (antes el token solo en memoria). Trade-off ya documentado en
   `plan_abierto.md §10.1` (sessionStorage vs memoria/localStorage). El token es
   un JWT de corta vida y el backend revalida cada request. **Revisar** que sea
   aceptable guardar el nombre del paciente en sessionStorage.

3. **[Auth/Bug-fix] Cambio global en `api.js _fetch`.** Dejé de enviar
   `Content-Type: application/json` en POSTs sin body. Antes Fastify devolvía
   **400** a `/auth/refresh` y `/auth/logout` (body vacío). Esto **hacía que el
   logout fallara silenciosamente** (se ignoraba el error) y rompía el refresh.
   El cambio afecta a TODAS las llamadas del cliente; verificado por la suite E2E
   + builds, pero **revisar** que ningún endpoint dependiera del header en GETs.

4. **[Infra/CSP] Turnstile carga script de `challenges.cloudflare.com`.** El
   widget (`lib/turnstile.js`) inyecta el script de Cloudflare. **La CSP de
   producción (Caddyfile.prod) debe permitir `challenges.cloudflare.com` en
   `script-src` y `frame-src` (Hito F).** Si el script no carga, el frontend
   degrada *fail-open* (no bloquea la UI) y **el backend es quien rechaza** la
   solicitud sin token cuando el enforcement está activo (fail-closed server-side,
   ya implementado en Hito B). En dev (sin `TURNSTILE_SITEKEY`) el widget no se
   renderiza.

5. **[Cobertura] `payment.js` (tema NO-apple) sin actualizar.** Solo actualicé
   `payment.apple.js` (tema por defecto = apple). El tema `default` sigue
   mostrando QR sin botón "Pagar ahora". Si algún despliegue usa `KIOSK_THEME=default`,
   falta portar el botón. **No es el camino por defecto.**

6. **[E2E] Requiere stack vivo + datos mock.** El E2E lee el OTP de dev vía
   `dk:otp` (Redis) y resetea buckets con `psql`. Depende de: Postgres/Redis
   arriba, clínica id=1 con Habeas Data configurada, y `DEV_MOCK_EXTERNAL_SERVICES=true`
   (lo fuerza el `webServer` de Playwright). **iPad se fuerza a Chromium** (no se
   instaló WebKit) → no es Safari real; cubre viewport/touch, no el motor.

7. **[Menor] Bundle:** el webfont Tabler incluye un `.ttf` de ~2.8 MB (fallback de
   navegadores viejos; los modernos usan el `.woff2` de ~457 KB). Optimizable a
   futuro (subset de iconos).

8. **[Menor] Copy idle:** el modal de inactividad muestra el countdown en
   segundos (hasta 120 s). Cosmético; no afecta función.

**Nada BLOQUEADO en Hito C.** No se tocaron `payments.ts`, `reconciler.ts` ni
`license/*`. No se añadieron migraciones (el máximo absoluto usa `created_at`
existente).

---

## Hito C — Front web del paciente (núcleo)

**Estado:** ✅ completo · rama `hito-c-front-web` (NO fusionada)

### Decisiones tomadas (dadas por el usuario)
- Standby → **landing pública** con marca de la clínica.
- QR de pago como **fallback de escritorio: SÍ**.
- Sesión en **sessionStorage** con `/auth/refresh` (§10).
- Fuentes apple: **self-host** (Inter + Tabler localmente, no CDN).

### Archivos creados/modificados
**Backend:**
- `apps/api/src/lib/config.ts` — añade `JWT_PATIENT_SESSION_ABSOLUTE_MAX_HOURS` (8).
- `apps/api/src/lib/jwt.ts` — añade `refreshPatientSession()` (re-firma con mismo jti).
- `apps/api/src/routes/patient-auth.ts` — añade `POST /auth/refresh`.
- `apps/api/tests/patient-refresh.test.ts` — **nuevo** (6 tests).

**Frontend kiosco:**
- `src/api.js` — sin kiosk_token; `/public/bootstrap` y `/public/standby`; sesión
  en sessionStorage; `refreshSession()`; turnstile_token; fix Content-Type.
- `src/state.js` — persiste info del paciente en sessionStorage.
- `src/main.js` — sin gate de token; restaura sesión; refresh en visibility/pageshow;
  fuentes self-host.
- `src/idle.js` — 28 min aviso / 30 min cierre.
- `src/screens/standby.js` — landing pública (copy "Comenzar").
- `src/screens/login-cedula.js` — widget Turnstile; OTP forzado (sin login-direct).
- `src/lib/turnstile.js` — **nuevo** (carga perezosa del widget CF).
- `src/screens/register.js` — teclado nativo (quita `mountKeyboard`).
- `src/screens/payment.apple.js` — botón "Pagar ahora" + QR fallback escritorio +
  reanudar polling en visibilitychange.
- `apps/kiosco-frontend/package.json` — `@fontsource/inter`, `@tabler/icons-webfont`.

**E2E / raíz:**
- `playwright.config.ts` — **nuevo** (Pixel7/iPad/Desktop + webServer API+Vite).
- `e2e/patient-flow.spec.ts`, `e2e/helpers.ts` — **nuevos** (9 tests = 3×3 perfiles).
- `package.json` (raíz) — `@playwright/test`.

### Decisiones propias
- **`/auth/refresh`:** token único, mismo jti, deslizante, tope absoluto desde
  `created_at`; no acepta tokens expirados (ver auditoría #1). Sin migración.
- **TTL del access** sin cambiar (10 min); §10 sugería 30 (ver auditoría #1).
- **idle** 28/30 min (§10 pedía 30 min de inactividad).
- **standby** mínimamente modificado: ya era una landing con marca; solo cambió
  el copy y la fuente de datos a `/public/*`.
- **Fuentes self-host:** `@fontsource/inter` pesos 300–700 + `@tabler/icons-webfont`.
- **E2E:** iPad forzado a Chromium (sin WebKit instalado); OTP leído vía `dk:otp`.
- `register.js`: se dejaron los atributos `data-kb` (inertes sin keyboard.js).

### Resultado test / typecheck / build (números reales)
- Backend: **280 tests / 20 archivos** verdes (274 base + 6 nuevos de refresh).
- Typecheck API: **OK**.
- Build kiosco-frontend: **OK**. Build admin-frontend: **OK**.
- E2E: **9/9 verdes** (Pixel 7 / iPad / Desktop × 3 specs).

### DoD punto por punto
- [x] App arranca sin `kiosk_token`; login OTP web. *(E2E test 1, los 3 perfiles)*
- [x] home/citas/pago móvil funcionales. *(E2E tests 1 y 3)*
- [x] E2E móvil verde en Pixel 7. *(+ iPad y Desktop)*
- [x] 253+ tests backend siguen verdes. *(280 verdes)*
- [x] Sesión sobrevive a refresh (sessionStorage + /auth/refresh). *(E2E test 2)*

---

## Hito D — Responsive + routing completo

**Estado:** ⏳ pendiente

### Decisiones tomadas (dadas por el usuario)
- Routing con **History API** (Caddy ya tiene `try_files`).
- Mantener zoom habilitado (quitar `user-scalable=no`).

### Archivos creados/modificados
_(pendiente)_

### DoD punto por punto
- [ ] URLs reales operativas (deep-link, back, refresh).
- [ ] Responsive correcto en 360/768/1280.
- [ ] E2E routing + responsive verdes.

---

## Hito E — Admin responsive

**Estado:** ⏳ pendiente

### Archivos creados/modificados
_(pendiente)_

### DoD punto por punto
- [ ] Admin usable en móvil/tablet.
- [ ] E2E admin móvil verde.
