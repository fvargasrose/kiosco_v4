# Pendientes de producción

> Documento de tareas pendientes / planes aprobados antes de codificar.
> Cada entrada describe el problema, el plan y cómo revertir a estado de producción.

---

## 0. ⚠️ REVERTIR CORS del API en producción (`origin: true` → `origin: false`)

**Fecha:** 2026-06-06
**Estado:** ⚠️ Cambio temporal de testing APLICADO — **DEBE revertirse en producción**
**Archivo modificado:** `apps/api/src/server.ts`

### Qué se cambió y por qué

Para poder probar por ngrok / red local (celulares), se relajó la política CORS
del API. En `apps/api/src/server.ts`, registro de `@fastify/cors`:

```js
await app.register(cors, {
  // DEV: reflect origin → permite ngrok y acceso desde red local/celulares.
  // PRODUCCIÓN: revertir a `origin: false` (Caddy filtra orígenes antes de llegar aquí).
  origin: true,        // ← TEMPORAL para testing
  credentials: true,
});
```

El valor original era `origin: false` (mismo origen, servido por Caddy).

### Riesgo

`origin: true` refleja **cualquier** origen y, combinado con `credentials: true`,
permite que cualquier sitio haga peticiones autenticadas al API. Aceptable solo
en desarrollo/testing tras un túnel controlado; **inseguro en producción.**

### CAMBIO A HACER EN PRODUCCIÓN

Revertir a:

```js
await app.register(cors, {
  origin: false, // Mismo origen (servido por Caddy)
  credentials: true,
});
```

> En producción los frontends y el API se sirven bajo el mismo dominio detrás de
> Caddy, así que `origin: false` es lo correcto y no rompe nada.

---

## 1. Exponer dev server por ngrok para testing (`allowedHosts` de Vite)

**Fecha:** 2026-06-06
**Estado:** ✅ Implementado en desarrollo (enfoque por env var) — pendiente de verificar en deploy
**Archivos modificados:** `apps/kiosco-frontend/vite.config.js`, `apps/admin-frontend/vite.config.js`

### Síntoma

Al exponer el dev server de Vite por ngrok, el navegador recibe:

```
Blocked request. This host ("peritonitic-uninterestingly-candyce.ngrok-free.dev")
is not allowed.
To allow this host, add "peritonitic-...ngrok-free.dev" to
`server.allowedHosts` in vite.config.js.
```

### Causa raíz

- Vite instalado: **5.4.21** (incluye el chequeo de `Host` header por seguridad).
- Ambos `vite.config.js` tienen `allowedHosts: 'all'`, que es **sintaxis de
  webpack-dev-server, NO de Vite**.
- Vite evalúa `allowedHosts.includes(host)`; con el string `'all'` esto es
  `'all'.includes('...ngrok...')` → `false` → la petición se bloquea.
- Valores válidos en Vite:
  - `allowedHosts: true` → permite cualquier host (cómodo, menos seguro).
  - `allowedHosts: ['host1', 'host2']` → lista blanca explícita (recomendado).

### Solución implementada (reversible por env var)

En lugar de hardcodear el host de ngrok (cambia en cada sesión del túnel
gratuito), `allowedHosts` se lee de la variable de entorno `VITE_ALLOWED_HOSTS`.
Así "testear" y "volver a como debe funcionar" no requiere editar ni commitear
nada — solo setear/quitar la env var.

Ambos `vite.config.js` quedaron así (antes tenían el inválido `allowedHosts: 'all'`):

```js
// Dev/testing: VITE_ALLOWED_HOSTS="host1,host2" para exponer por ngrok.
// Vacío (default) = solo localhost → estado correcto de producción.
allowedHosts: process.env.VITE_ALLOWED_HOSTS
  ? process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim())
  : [],
```

### Cómo TESTEAR ahora (dos túneles distintos)

```bash
# Terminal A — kiosco (puerto 5173)
VITE_ALLOWED_HOSTS="peritonitic-uninterestingly-candyce.ngrok-free.dev" \
  pnpm --filter @dentalkiosco/kiosco-frontend dev
ngrok http 5173

# Terminal B — admin (puerto 5174), con SU PROPIO host de ngrok
VITE_ALLOWED_HOSTS="<host-ngrok-admin>.ngrok-free.dev" \
  pnpm --filter @dentalkiosco/admin-frontend dev
ngrok http 5174
```

> Cada túnel ngrok genera un host distinto. Poné en `VITE_ALLOWED_HOSTS` el host
> que te muestre ngrok para ESE puerto. Podés listar varios separados por coma.

### CAMBIOS A HACER / VERIFICAR EN PRODUCCIÓN

Resumen para el deploy (esto es lo que hay que controlar al pasar a prod):

1. **NO setear `VITE_ALLOWED_HOSTS`** en el entorno de producción (ni en `.env`,
   ni en docker-compose, ni en variables del host). Si no está seteada, el
   config queda en `[]` → solo localhost → estado seguro. **No hay que revertir
   código**, el default ya es el correcto.
2. **El dev server de Vite NO corre en producción.** Los frontends se sirven
   compilados (`pnpm build` → `dist/`) detrás de Caddy. Por tanto `allowedHosts`
   no tiene efecto en el deploy real. Confirmar que ningún script/contenedor de
   prod ejecute `vite dev`.
3. **Antes de buildear el deploy:** asegurarse de que la terminal/CI no tenga
   `VITE_ALLOWED_HOSTS` exportada de una sesión de testing previa (no afecta el
   build estático, pero conviene dejar el entorno limpio).

> Es decir: el único "cambio" operativo en producción es **asegurar la ausencia**
> de `VITE_ALLOWED_HOSTS`. El código quedó seguro por defecto y no requiere
> rollback.

### Notas de seguridad

- No commitear hosts de ngrok (cambian por sesión en el plan gratuito).
- `allowedHosts: true` deja el dev server accesible desde cualquier dominio
  apuntado a la IP/túnel — usar solo durante la prueba y revertir.
- El proxy `/api` → `localhost:3000` ya funciona a través del túnel; el backend
  no necesita cambios de host para esta prueba.

### Verificación al terminar

```bash
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build
# Confirmar que el .env / scripts NO dejan VITE_ALLOWED_HOSTS seteada en prod.
```

---

## 2. Timeout de inactividad configurable (kiosco físico vs web personal)

**Fecha:** 2026-06-06
**Estado:** 📋 Planificado — **NO implementado** (pendiente para después)
**Modo elegido:** Ambos / configurable

### Contexto / situación actual

El auto-logout por inactividad YA existe (`apps/kiosco-frontend/src/idle.js`,
cableado en `apps/kiosco-frontend/src/main.js:95-113`):

- Solo corre cuando hay **sesión de paciente activa** y no se está en standby.
- **28 min** sin actividad → modal "¿Sigues ahí?" (2 min para responder).
- **30 min** sin actividad → `api.logout()` + `clearPatient()` + vuelve a standby.
- Actividad = `pointerdown`, `touchstart`, `keydown` (no mousemove).
- Tiempos **hardcodeados** (`WARN_AT_MS`, `LOGOUT_AT_MS` en `idle.js:23-24`).

Se eligió 30 min porque el sistema se reconvirtió a "web pública" (celular del
paciente), donde un idle agresivo (60/90 s) era hostil. **Problema:** en un
kiosco físico compartido, 30 min deja la sesión del paciente anterior expuesta
al siguiente. Hay que poder configurar el tiempo por despliegue.

### Plan (mismo patrón que `OTP_REQUIRED`: env var expuesta vía bootstrap)

**1. `apps/api/src/lib/config.ts`** — dos vars nuevas (default = comportamiento actual):

```ts
IDLE_WARN_SECONDS:    z.coerce.number().int().positive().default(1680), // 28 min
IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800), // 30 min
```

**2. `apps/api/src/routes/public.ts`** — agregar al objeto de `/public/bootstrap`:

```ts
idle: {
  warn_seconds:    config.IDLE_WARN_SECONDS,
  timeout_seconds: config.IDLE_TIMEOUT_SECONDS,
},
```

**3. `apps/kiosco-frontend/src/idle.js`** — `startIdleTimer({ warnMs, timeoutMs, onTimeout, onWarning })`
con fallback a 28/30 min si no llegan (en vez de las constantes hardcodeadas).

**4. `apps/kiosco-frontend/src/main.js`** — leer `idle` del bootstrap y pasar
`warnMs`/`timeoutMs` (segundos × 1000) a `startIdleTimer`.

### Uso resultante por despliegue

| Despliegue | `.env` | Efecto |
|-----------|--------|--------|
| Web personal (celular) | (nada) | 28/30 min — comportamiento actual |
| Kiosco físico | `IDLE_WARN_SECONDS=60`<br>`IDLE_TIMEOUT_SECONDS=90` | aviso 60 s, cierre 90 s |

### Verificación al implementar

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
pnpm --filter @dentalkiosco/kiosco-frontend build
```

> Validación funcional rápida: bajar `IDLE_*` a 10/15 s en dev, iniciar sesión
> de paciente, no tocar nada y confirmar el modal a los 10 s y el logout→standby
> a los 15 s.

---

## 3. Reset de rate limits durante testing (referencia operativa)

**Fecha:** 2026-06-06
**Estado:** 🛠️ Procedimiento (no es cambio de prod)

Durante testing del kiosco es fácil topar el límite de OTP ("demasiados
intentos", HTTP 429). Los topes (anti-abuso) son: **3 OTP/teléfono/hora**,
límites diarios por teléfono e IP, cooldown entre envíos, y un rate-limit global
por IP en Redis (`@fastify/rate-limit`, ns `dk-rl:`, ventana 1 min).

**Reset manual (entorno de prueba):**

```bash
# Postgres — buckets de OTP/booking (ver puerto/credenciales en .env)
PGPASSWORD=<POSTGRES_PASSWORD> psql -h localhost -p <POSTGRES_PORT> \
  -U <POSTGRES_USER> -d <POSTGRES_DB> -c "DELETE FROM rate_limits;"

# Redis — rate-limit global por IP
docker compose exec -T redis sh -c \
  "redis-cli -a '<REDIS_PASSWORD>' --no-auth-warning KEYS 'dk-rl:*' \
   | xargs -r redis-cli -a '<REDIS_PASSWORD>' --no-auth-warning DEL"
```

**Alternativas para no toparlo:** `DEV_LOG_OTP=true` (OTP en logs, sin SMS),
subir `RATE_LIMIT_OTP_PER_PHONE_PER_HOUR` / `RATE_LIMIT_OTP_PER_IP_PER_HOUR` en
`.env`, o `OTP_REQUIRED=false` (login solo cédula + teléfono).

> **En producción:** NO relajar estos límites; son protección anti-abuso real.
