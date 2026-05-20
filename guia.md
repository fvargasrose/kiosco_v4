# DentalKiosco — Guía de desarrollo local

## Requisitos previos

- Docker Desktop o Docker Engine con Compose plugin
- Node.js 22 + pnpm (`npm i -g pnpm` o `corepack enable && corepack prepare pnpm@latest --activate`)
- PostgreSQL client (`psql`) — opcional, para consultas directas
- Archivo `.env` en la raíz del monorepo (nunca se commitea)

---

## 1. Levantar infraestructura (PostgreSQL + Redis)

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco

# Solo postgres y redis — NO el API ni Caddy (esos corren fuera de Docker en dev)
docker compose up -d postgres redis
```

Verifica que estén `(healthy)`:
```bash
docker compose ps
```

| Servicio | Puerto host | Puerto contenedor |
|----------|-------------|-------------------|
| PostgreSQL 16 | `localhost:5433` | 5432 |
| Redis 7 | `localhost:6380` | 6379 |

> El override `docker-compose.override.yml` expone esos puertos al host automáticamente.

---

## 2. Instalar dependencias

Solo necesario la primera vez o cuando cambia `package.json`:

```bash
pnpm install
```

---

## 3. Migraciones de base de datos

```bash
# Ver estado
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status

# Aplicar pendientes (si hay alguna nueva)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate

# Verificar checksums (detecta si alguna fue modificada)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:verify
```

Debe mostrar `11/11 applied` antes de continuar.

---

## 4. Arrancar la API (backend)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
```

Confirma en los logs:
```
Server listening at http://0.0.0.0:3000
Reconciler started
License worker disabled (LICENSE_DEV_MODE=true)   ← en modo dev
```

**Dejar corriendo en una terminal.** La API recarga automáticamente al editar archivos TypeScript.

> **Importante:** `tsx watch` no recarga `.env`. Si cambias una variable de entorno, mata la API (`Ctrl+C`) y vuélvela a arrancar.

---

## 5. Arrancar el kiosco (frontend)

```bash
pnpm --filter @dentalkiosco/kiosco-frontend dev
# → http://localhost:5173
```

El kiosco necesita un `kiosk_token` JWT para funcionar. Sin él muestra pantalla de error. Ver sección 7.

---

## 6. Arrancar el panel admin

```bash
pnpm --filter @dentalkiosco/admin-frontend dev
# → http://localhost:5174
```

### Credenciales del admin de desarrollo

El admin de demo se crea manualmente la primera vez:

```bash
# Crear admin (usa argon2id, idempotente si ya existe)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin \
  --email admin@demo.local \
  --password "Admin@Demo2026" \
  --name "Administrador Demo"
```

Login en `http://localhost:5174`:
- **Email:** `admin@demo.local`
- **Contraseña:** `Admin@Demo2026`
- MFA: desactivado (`mfa_required=false` por defecto en dev)

> Si el admin tiene `mfa_required=true` pero no está enrolado, el panel muestra "Contacta al superadmin". Fix rápido:
> ```bash
> PGPASSWORD=<ver .env> psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco \
>   -c "UPDATE admins SET mfa_required = false WHERE email = 'admin@demo.local';"
> ```

---

## 7. Conectar el kiosco (obtener kiosk_token)

### Opción A — Desde el panel admin (recomendado)

1. Iniciar sesión en `http://localhost:5174`
2. Ir a **Kioscos → Nuevo kiosco**
3. Completar nombre y ubicación → **Crear**
4. **Copiar el token** que aparece en ese momento (solo se muestra una vez)
5. Abrir: `http://localhost:5173/?kiosk_token=<token_copiado>`

### Opción B — Desde la base de datos (cuando el admin panel no está disponible)

```bash
# 1. Ver kioscos existentes
PGPASSWORD=<ver .env> psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco \
  -c "SELECT id, name, is_active, token_expires_at FROM kiosks;"

# 2. Generar JWT manualmente (requiere JWT_SECRET del .env)
JWT_SECRET=$(grep '^JWT_SECRET=' .env | cut -d= -f2)
KIOSK_ID=<uuid del SELECT anterior>

DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx -e "
import { SignJWT } from 'jose';
const secret = new TextEncoder().encode('$JWT_SECRET');
const token = await new SignJWT({ sub: '$KIOSK_ID' })
  .setProtectedHeader({ alg: 'HS256' })
  .setAudience('kiosk')
  .setIssuer('dentalkiosco')
  .setExpirationTime('90d')
  .sign(secret);
console.log(token);
" 2>/dev/null
```

Luego: `http://localhost:5173/?kiosk_token=<token>`

El token se guarda en `sessionStorage` del navegador para el resto de la sesión.

---

## 8. Flujo completo del paciente en el kiosco

### Con verificación por código (OTP_REQUIRED=true)

1. **Standby** → toca la pantalla
2. **Habeas Data** → aceptar
3. **Cédula** → ingresar número → "Enviar código"
4. **OTP** → ingresar el código de 6 dígitos
   - En dev con `DEV_LOG_OTP=true`: busca en los logs de la API `"otp":"XXXXXX"`
   - En dev con `DEV_MOCK_EXTERNAL_SERVICES=false` y email real: llega a `fabiavargas@gmail.com`
5. **Home** → ver citas, tratamientos, agendar, cancelar, pagar

### Sin código de verificación (OTP_REQUIRED=false)

1. **Standby** → toca la pantalla
2. **Habeas Data** → aceptar
3. **Cédula + Teléfono** → ingresar ambos → "Ingresar"
   - El teléfono debe coincidir exactamente con el registrado en Dentalink (con prefijo `+57`)
4. Directo a **Home** sin pantalla de OTP

---

## 9. Activar / desactivar el código de verificación

Controlado por `OTP_REQUIRED` en el archivo `.env`.

```bash
# Deshabilitar OTP (login solo con cédula + teléfono)
sed -i 's/^OTP_REQUIRED=.*/OTP_REQUIRED=false/' .env

# Habilitar OTP (comportamiento por defecto)
sed -i 's/^OTP_REQUIRED=.*/OTP_REQUIRED=true/' .env
```

Luego reiniciar la API (tsx watch no recarga .env):
```bash
# Matar el proceso actual
kill $(ps aux | grep "tsx.*server.ts" | grep -v grep | awk '{print $2}') 2>/dev/null || true

# Volver a arrancar
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
```

> **Recomendación:** en producción mantén `OTP_REQUIRED=true` para mayor seguridad. Usa `false` solo para demos, pruebas de usabilidad, o cuando los pacientes no tienen teléfono registrado en Dentalink.

---

## 10. Configuración de mocks en desarrollo

En el `.env` actual:

| Variable | Valor dev | Efecto |
|----------|-----------|--------|
| `DEV_MOCK_EXTERNAL_SERVICES` | `false` | Dentalink real, Twilio mock, Resend real |
| `DEV_MOCK_WOMPI` | `true` | Wompi simulado (links falsos) |
| `DEV_LOG_OTP` | `true` | OTP visible en log de la API |
| `LICENSE_DEV_MODE` | `true` | Sin verificación de licencia |
| `OTP_REQUIRED` | `false` | Sin código de verificación (demo) |

### Cambiar a mock total (sin llamadas externas)

```bash
# En .env:
DEV_MOCK_EXTERNAL_SERVICES=true
DEV_MOCK_WOMPI=true
```

Con esto: Dentalink, Twilio, Resend y Wompi son todos simulados. Útil para tests offline.

---

## 11. Simular un pago aprobado (mock Wompi)

Cuando `DEV_MOCK_WOMPI=true`, los pagos quedan en estado `PENDING`. Para simularlos:

```bash
# Obtener la referencia de la transacción pendiente
PGPASSWORD=<ver .env> psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco \
  -c "SELECT reference, status, amount_cents FROM transactions ORDER BY created_at DESC LIMIT 5;"

# Simular webhook de pago aprobado
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{
    "event": "transaction.updated",
    "data": {
      "transaction": {
        "reference": "<referencia>",
        "status": "APPROVED",
        "amount_in_cents": 100000
      }
    },
    "sent_at": "2026-05-20T00:00:00Z",
    "signature": { "checksum": "mock", "properties": [] }
  }'
```

El reconciliador también puede procesar transacciones aprobadas cada minuto (si `DEV_MOCK_WOMPI=false` y hay respuesta real de Wompi).

---

## 12. Comandos de verificación y diagnóstico

```bash
# ── Calidad del código ──
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck   # 0 errores esperados
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test        # 195 tests pasando

# ── Estado de la infraestructura ──
docker compose ps                                                            # ver contenedores
curl -s http://localhost:3000/health | jq .                                  # liveness
curl -s http://localhost:3000/health/ready | jq .                           # readiness (DB + Redis)

# ── Base de datos ──
PGPASSWORD=<ver .env> psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco

# Consultas útiles dentro de psql:
#   \dt                        → listar tablas
#   SELECT * FROM admins;      → ver admins
#   SELECT * FROM kiosks;      → ver kioscos
#   SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10;
#   SELECT version, name, applied_at FROM schema_migrations ORDER BY version;

# ── Logs de la API en tiempo real ──
# (si arrancaste con redirección a archivo)
tail -f /tmp/dk-api.log | grep -E "MOCK|OTP|ERROR|WARN|otp"

# ── Buscar el OTP en los logs de la terminal donde corre la API ──
# Busca la línea: {"msg":"OTP generated","otp":"123456",...}

# ── Matar la API si quedó colgada ──
kill $(ps aux | grep "tsx.*server.ts" | grep -v grep | awk '{print $2}') 2>/dev/null || true

# ── Reiniciar infraestructura limpia ──
docker compose down -v   # ⚠ borra los datos de postgres y redis
docker compose up -d postgres redis
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
```

---

## 13. Probar el servidor de licencias (local)

El servidor de licencias corre independiente del stack principal:

```bash
cd central/license-server

# Instalar dependencias
pnpm install

# Variables mínimas para correr en local
export PORT=3001
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5433
export POSTGRES_DB=dentalkiosco   # puede usar la misma DB o una separada
export POSTGRES_USER=dentalkiosco
export POSTGRES_PASSWORD=<ver .env>
export SUPERADMIN_API_KEY=superadmin-clave-local-32chars-minimo

# Arrancar
pnpm dev

# Crear una licencia de prueba
curl -X POST http://localhost:3001/licenses \
  -H "Content-Type: application/json" \
  -H "X-Superadmin-Key: superadmin-clave-local-32chars-minimo" \
  -d '{"clinic_name":"Clínica Demo","plan":"basic","expires_at":"2027-12-31T00:00:00Z"}'

# Validar la licencia creada
curl -X POST http://localhost:3001/licenses/validate \
  -H "Content-Type: application/json" \
  -H "X-License-Key: DK-XXXXXXXX-XXXXXXXX-XXXXXXXX"

# Listar todas las licencias
curl http://localhost:3001/licenses \
  -H "X-Superadmin-Key: superadmin-clave-local-32chars-minimo" | jq .
```

Para que la API principal use el license server local, editar `.env`:
```
LICENSE_DEV_MODE=false
LICENSE_SERVER_URL=http://localhost:3001
LICENSE_KEY=DK-XXXXXXXX-XXXXXXXX-XXXXXXXX   ← la clave que creaste arriba
```

---

## 14. Probar el update manager (local)

```bash
# Generar claves GPG de prueba y un manifiesto firmado de ejemplo
bash updater/update.sh --generate-test-keys

# Simular una actualización sin aplicar cambios reales
bash updater/update.sh --dry-run

# Variables requeridas en .env para el updater
UPDATE_SERVER_URL=https://updates.allcreative.app   # solo para el flujo real
ADMIN_EMAIL=admin@clinica.com                       # recibe notificaciones
```

> El manifiesto real y las imágenes Docker se descargan de `UPDATE_SERVER_URL` — esa parte requiere infraestructura central activa.

---

## 15. Hacer cambios en el código

### Frontend (kiosco o admin)

Los cambios en `apps/kiosco-frontend/src/` o `apps/admin-frontend/src/` se reflejan instantáneamente gracias al HMR de Vite. No necesitas reiniciar nada.

### Backend (API)

Los cambios en `apps/api/src/` son detectados por `tsx watch` y el servidor se reinicia automáticamente en ~1–2 segundos. Verás en los logs:
```
[INFO] Restarting...
[INFO] Server listening at http://0.0.0.0:3000
```

> Si agregas una variable nueva a `.env`, sí debes reiniciar manualmente.

### Agregar una migración SQL

1. Crear `apps/api/migrations/012_descripcion.sql`
2. Terminarla con:
   ```sql
   INSERT INTO schema_migrations (version, name)
   VALUES ('012', 'descripcion') ON CONFLICT (version) DO NOTHING;
   ```
3. Ejecutar: `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate`

### Agregar una nueva ruta en la API

1. Crear `apps/api/src/routes/mi-ruta.ts`
2. Importar y registrar en `apps/api/src/server.ts`:
   ```typescript
   import { miRutaRoutes } from './routes/mi-ruta.js';
   // ...
   await app.register(miRutaRoutes);
   ```
3. El servidor recarga solo (tsx watch).

---

## 16. Reglas de trabajo con hitos nuevos

1. Extraer el zip del hito en carpeta temporal.
2. Aplicar archivos sobre `dentalkiosco/` sin tocar lo anterior.
3. **Re-aplicar siempre estos fixes** (los parches del proveedor los borran):
   - `config.ts`: helper `boolEnv()` en vars booleanas
   - `dentalink.ts`: función `normalizeCelular()` + su uso en `lookupPatientByCedula`
   - `vitest.config.ts`: bloque `env: { DEV_MOCK_EXTERNAL_SERVICES: 'true', DEV_MOCK_WOMPI: 'true' }`
   - Migraciones SQL: terminar con `INSERT INTO schema_migrations ON CONFLICT DO NOTHING`
4. `pnpm install` → migraciones → type-check → tests → arrancar → validar manualmente.
5. Commit solo cuando todo pasa. Nunca mezclar cambios de hitos distintos.
