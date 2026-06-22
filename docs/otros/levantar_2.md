# Levantar el sistema para probarlo (clon `kiosko_v4`)

> Guía rápida para arrancar y probar el sistema tras los Hitos A–E (web pública).
> Clon aislado en `/home2/kiosko_v4`. Puertos del clon: **Postgres 5434**,
> **Redis 6381**. La API corre **fuera de Docker** en desarrollo.
>
> ⚠️ Este clon comparte contenedores/volúmenes Docker (`dk-postgres`, `dk-redis`)
> con el proyecto original → no levantar ambos stacks a la vez.

---

## 0. Requisitos

- Node 22, pnpm 9, Docker + Docker Compose.
- Dependencias instaladas: `pnpm install` (incluye `@playwright/test`,
  `@fontsource/inter`, `@tabler/icons-webfont`).
- Navegador para E2E: `pnpm exec playwright install chromium` (una vez).

---

## 1. Infraestructura (Postgres + Redis)

```bash
cd /home2/kiosko_v4
docker compose up -d postgres redis
docker compose ps           # ambos "healthy" (5434 / 6381)
```

## 2. Migraciones (estado y aplicar pendientes)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
```

## 3. Crear el primer admin (idempotente)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"
```

> Para E2E ya existe en la BD de dev `admin@e2e.local` / `E2e@Admin2026`
> (no usar en producción).

## 4. Arrancar la API (fuera de Docker)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
# → http://localhost:3000   (health: http://localhost:3000/health)
```

Para probar con servicios externos **mockeados** (Dentalink/Twilio/Resend/Wompi),
arrancar con estas variables (el paciente mock es `+573001234567`):

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env DEV_MOCK_EXTERNAL_SERVICES=true DEV_MOCK_WOMPI=true \
  pnpm --filter @dentalkiosco/api dev
```

## 5. Arrancar los frontends

```bash
# App del paciente (web pública)
pnpm --filter @dentalkiosco/kiosco-frontend dev   # → http://localhost:5173

# Panel admin
pnpm --filter @dentalkiosco/admin-frontend dev    # → http://localhost:5174
```

El proxy de Vite reenvía `/api` → `http://localhost:3000` en ambos frontends.

---

## 6. Probar el flujo del paciente (web)

1. Abrir **http://localhost:5173** → **landing pública** (sin "kiosco no pareado").
2. **Comenzar** → aceptar **Habeas Data** → ingresar celular `3001234567`.
3. **Enviar código** → leer el OTP de desarrollo desde Redis:
   ```bash
   DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dk:otp +573001234567
   ```
4. Ingresar el código → **home** (`/inicio`). Probar:
   - **Mis citas** (`/citas`), **Mis tratamientos** (`/tratamientos`).
   - **Pago**: un tratamiento con saldo → **Pagar ahora** (en mock abre el link Wompi).
   - **Routing**: botón atrás del navegador, **refresh** (mantiene sesión y ruta),
     deep-link directo a `/citas` o `/tratamientos`.

Simular un pago aprobado (Wompi mock):
```bash
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<ref>","status":"APPROVED","amount_in_cents":100000}},"sent_at":"2026-05-20T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'
```

## 7. Probar el panel admin (responsive)

1. Abrir **http://localhost:5174** → login (`admin@demo.local` / el que creaste).
2. En **móvil** (DevTools → vista responsive ≤768px): aparece la **hamburguesa**;
   el sidebar entra/sale; al navegar se cierra. En **escritorio/tablet**: sidebar fijo.

---

## 8. Pruebas automatizadas

```bash
# Backend (Vitest) — 280 tests, siempre en mock mode
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck

# Builds de producción
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build

# E2E (Playwright) — levanta API (mock) + ambos frontends automáticamente
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm test:e2e
# Un solo perfil:  pnpm exec playwright test --project="Pixel 7"
```

> El E2E usa `webServer` en `playwright.config.ts`: arranca API (mock), kiosco
> (5173) y admin (5174). Requiere Postgres/Redis arriba y la clínica id=1
> configurada con Habeas Data.

---

## 9. Apagar todo

```bash
# Detener API/frontends: Ctrl+C en cada terminal (o matar los procesos tsx/vite).
# Detener la infraestructura Docker del clon:
docker compose down
```

> Recordar el caveat del paso inicial: `dk-postgres`/`dk-redis` se comparten con
> el proyecto original. `docker compose down` los detiene para ambos.
