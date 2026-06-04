# Levantar DentalKiosco v4 — guía de pruebas (Hitos A–E)

> Cómo arrancar **todo** el sistema (infra + API + 2 frontends) y probarlo a mano y con
> los tests automatizados. Clon aislado en `/home2/kiosko_v4`.
>
> **Puertos del clon:** Postgres **5434** · Redis **6381** · API **3000** · kiosco **5173** ·
> admin **5174**. La **API corre FUERA de Docker** en desarrollo (Docker solo da Postgres+Redis).
>
> ⚠️ Este clon comparte contenedores/volúmenes Docker (`dk-postgres`, `dk-redis`) con el
> proyecto original → **no levantes ambos stacks a la vez.**

---

## 0. Requisitos (una vez)

```bash
cd /home2/kiosko_v4
pnpm install                              # deps del monorepo
pnpm exec playwright install chromium     # navegador para E2E (solo si vas a correr E2E)
```

- Node 22 · pnpm 9 · Docker + Docker Compose.
- Todos los comandos de la API llevan el prefijo **`DOTENV_CONFIG_PATH=$(pwd)/.env`** (carga el
  `.env` del clon). `dotenv` **no** pisa variables ya presentes en el shell: puedes forzar
  `POSTGRES_PORT=… REDIS_PORT=…` por delante si hiciera falta.

---

## 1. Arranque rápido (TL;DR)

Cuatro terminales en `/home2/kiosko_v4`:

```bash
# ── Terminal 1: infraestructura ──
docker compose up -d postgres redis
docker compose ps                                              # ambos "healthy" (5434 / 6381)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate          # aplica migraciones
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"

# ── Terminal 2: API (con servicios externos mockeados) ──
DOTENV_CONFIG_PATH=$(pwd)/.env DEV_MOCK_EXTERNAL_SERVICES=true DEV_MOCK_WOMPI=true \
  pnpm --filter @dentalkiosco/api dev                          # → http://localhost:3000

# ── Terminal 3: app del paciente ──
pnpm --filter @dentalkiosco/kiosco-frontend dev                # → http://localhost:5173

# ── Terminal 4: panel admin ──
pnpm --filter @dentalkiosco/admin-frontend dev                 # → http://localhost:5174
```

Verifica que la API está viva: `curl http://localhost:3000/health` → `200`.

> El proxy de Vite reenvía `/api` → `http://localhost:3000` en ambos frontends.

---

## 2. Detalle paso a paso

### 2.1 Infraestructura (Postgres + Redis)

```bash
docker compose up -d postgres redis
docker compose ps          # STATUS = healthy en dk-postgres (5434→5432) y dk-redis (6381→6379)
```

### 2.2 Migraciones

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status   # qué falta
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate          # aplicar pendientes
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:verify   # checksums (opcional)
```

### 2.3 Datos de prueba — dos opciones

**Opción A — mínima (admin + nada más):** crea solo el admin (idempotente, `ON CONFLICT DO NOTHING`):

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"
```

**Opción B — seed de desarrollo (clínica id=1 con Habeas Data + `admin@demo.local`):**

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm db:seed
```

> El seed **se niega a correr con `NODE_ENV=production`** (guard de seguridad). Deja la clínica
> id=1 configurada con Habeas Data — **necesario** para el login del paciente y para el E2E.

> Para el E2E ya se asume en la BD de dev el admin `admin@e2e.local` / `E2e@Admin2026`
> (creado con el mismo `setup.ts`). **Es solo para desarrollo local — nunca en producción.**

### 2.4 API (fuera de Docker)

```bash
# Real (Dentalink real, Twilio mock, Resend real — según .env):
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev

# Todo mockeado (recomendado para probar sin credenciales externas):
DOTENV_CONFIG_PATH=$(pwd)/.env DEV_MOCK_EXTERNAL_SERVICES=true DEV_MOCK_WOMPI=true \
  pnpm --filter @dentalkiosco/api dev
```

Paciente mock (cuando `DEV_MOCK_EXTERNAL_SERVICES=true`): **`+573001234567`** (María Pérez).

> `tsx watch` **no recarga el `.env`**: si cambias variables, reinicia la API a mano.

### 2.5 Frontends

```bash
pnpm --filter @dentalkiosco/kiosco-frontend dev   # paciente → http://localhost:5173
pnpm --filter @dentalkiosco/admin-frontend dev    # admin    → http://localhost:5174
```

---

## 3. Probar el flujo del paciente (web pública)

1. Abre **http://localhost:5173** → **landing pública** con botón **Comenzar** (sin pantalla
   "kiosco no pareado": el front arranca contra `/public/bootstrap`, sin `kiosk_token`).
2. **Comenzar** → aceptar **Habeas Data** → ingresar el celular `3001234567`.
3. **Enviar código** → leer el OTP de desarrollo desde Redis:
   ```bash
   DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dk:otp +573001234567
   ```
4. Ingresar el código → **home** (`/inicio`). Prueba:
   - **Mis citas** (`/citas`) · **Mis tratamientos** (`/tratamientos`).
   - **Pago móvil:** un tratamiento con saldo → **Pagar ahora** (en mock abre el link Wompi);
     el QR queda como **fallback de escritorio**.
   - **Routing real:** botón **atrás** del navegador, **refresh** (mantiene sesión + ruta vía
     `sessionStorage` + `/auth/refresh`), **deep-link** directo a `/citas` o `/tratamientos`.
   - **Sesión deslizante:** al volver a la pestaña (`visibilitychange`) la sesión se renueva sola.

**Simular un pago aprobado (Wompi mock):**
```bash
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<ref>","status":"APPROVED","amount_in_cents":100000}},"sent_at":"2026-05-20T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'
```
(Reemplaza `<ref>` por la referencia que generó el front al iniciar el pago.)

---

## 4. Probar el panel admin (responsive)

1. Abre **http://localhost:5174** → login con `admin@demo.local` / `Admin@Demo2026`.
2. **Escritorio/tablet (>768px):** sidebar fijo de 220px, sin hamburguesa.
3. **Móvil (DevTools → responsive ≤768px):** aparece la **hamburguesa** en la topbar; el sidebar
   entra/sale (off-canvas) con backdrop; al **navegar de sección el menú se cierra**.
4. Recorre **Dashboard · Transacciones · Kioscos · Dentistas · Configuración** — las tablas
   scrollean en su contenedor (`overflow-x:auto`), sin desbordar el layout.

> El admin que crea `setup.ts` trae `must_change_password=true`, pero el backend **no fuerza** el
> cambio (entra directo). El token de sesión vive en `localStorage`.

---

## 5. Pruebas automatizadas

```bash
# Backend (Vitest) — ~280 tests, siempre en mock mode. Requiere Postgres+Redis arriba.
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck

# Builds de producción de los frontends
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build

# E2E (Playwright) — levanta API (mock) + kiosco (5173) + admin (5174) AUTOMÁTICAMENTE.
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm test:e2e
# Un solo perfil:
pnpm exec playwright test --project="Pixel 7"      # o "iPad" / "Desktop"
```

> El `webServer` de `playwright.config.ts` arranca la API forzando
> `DEV_MOCK_EXTERNAL_SERVICES=true` + `DEV_MOCK_WOMPI=true`. **Requiere Postgres/Redis arriba**,
> la clínica id=1 con Habeas Data (paso 2.3) y los navegadores instalados (paso 0).
> Total esperado: **23 verdes + 7 skipped** (los skips son chequeos atados a un solo perfil).

---

## 6. Variables de entorno útiles (`.env` del clon)

| Variable | Valor por defecto (dev) | Efecto |
|----------|------------------------|--------|
| `OTP_REQUIRED` | `true` | `false` = login solo con cédula + teléfono (sin código) |
| `DEV_MOCK_EXTERNAL_SERVICES` | `false` | `true` = mock Dentalink + Twilio + Resend + Wompi |
| `DEV_MOCK_WOMPI` | `false` | `true` = mock solo Wompi |
| `DEV_LOG_OTP` | `true` | muestra el OTP en los logs de la API |
| `LICENSE_DEV_MODE` | `true` | omite todo control de licencia |

> Para mockear todo sin tocar el `.env`, pásalas por delante del comando de la API (paso 2.4).

---

## 7. Troubleshooting

- **`docker compose ps` no responde / `Cannot connect to the Docker daemon`:** el daemon está
  caído. Verifícalo con:
  ```bash
  curl -s --unix-socket /var/run/docker.sock http://localhost/_ping -w ' [%{http_code}]\n'
  # 200 = vivo · 000 = daemon caído (arráncalo: sudo systemctl start docker)
  ```
- **La API no conecta a la BD:** confirma los puertos. El `.env` usa **5434/6381** y el
  `docker-compose.override.yml` los mapea igual. Si chocaran, fuerza desde el shell:
  `POSTGRES_PORT=5434 REDIS_PORT=6381 DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev`.
- **Login del paciente falla con "configuración pendiente":** falta la clínica id=1 con Habeas
  Data → corre el seed (paso 2.3, Opción B).
- **El E2E del paciente no encuentra el OTP:** la API debe correr en mock (`DEV_MOCK_EXTERNAL_SERVICES=true`,
  ya lo fuerza el `webServer`) y Redis arriba; el código se lee de `otp:dev:<phone>`.
- **`pnpm lint` falla con exit 2:** gap conocido (ESLint 9 sin `eslint.config.js`). **No** bloquea;
  el gate real es `typecheck` + `test`.
- **Choque con el proyecto original:** `dk-postgres`/`dk-redis` se comparten. Baja el otro stack
  antes de levantar este.

---

## 8. Apagar todo

```bash
# API y frontends: Ctrl+C en cada terminal (o matar los procesos tsx/vite).
# Infraestructura Docker del clon:
docker compose down            # detiene dk-postgres y dk-redis (compartidos con el original)
# Para borrar también los datos (¡destruye la BD!):
# docker compose down -v
```
