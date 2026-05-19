# DentalKiosco — Guía de trabajo

## Estado del proyecto (al 2026-05-18)

| Hito | Descripción | Tests | Estado |
|------|-------------|-------|--------|
| 1-4 | Base: servidor, auth admin, DB, Redis, kiosk pairing | — | ✅ Validado |
| 5-6 | Auth paciente OTP (SMS + email), perfil, citas, tratamientos | 82 | ✅ Validado |
| 7 | Cancelación de citas + pagos Wompi + pantalla QR | 103 | ✅ Validado |
| 8 | Booking (agendar cita), reconciliador, comprobantes, migración 009 | 131 | ✅ Validado |
| 9 | Standby multimodal, registro paciente, fotos dentistas, panel admin | 159 | 🔄 En progreso |
| 10 | License server, monitoreo, métricas, deploy producción | — | 🔲 Pendiente |

**Migraciones**: 11/11 aplicadas (001 → 011).
**Tests actuales**: 159 / 159 pasando (7 archivos).

---

## Secuencia completa para levantar el proyecto

### 1. Servicios de infraestructura (PostgreSQL + Redis)

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
docker compose up -d
```

Verifica que estén healthy:
```bash
docker compose ps
```

Espera hasta ver `(healthy)` en ambos contenedores. Puertos:
- PostgreSQL → `localhost:5433`
- Redis → `localhost:6380`

---

### 2. Instalar dependencias (solo si es la primera vez o cambia package.json)

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
pnpm install
```

---

### 3. Migraciones (solo si hay migraciones nuevas pendientes)

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status
# Si hay pendientes:
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
```

---

### 4. Arrancar la API (backend)

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
```

- Servidor en `http://localhost:3000`
- Recarga automática al modificar archivos (tsx watch)
- Confirma en los logs: `Server listening at http://0.0.0.0:3000`
- El reconciliador arranca solo: `[INFO] Reconciler started`

**Dejar corriendo en una terminal.**

---

### 5. Arrancar el frontend del kiosco

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
pnpm --filter @dentalkiosco/kiosco-frontend dev
```

- Frontend en `http://localhost:5173`
- El proxy `/api → http://localhost:3000` está configurado en `vite.config.js`

**Dejar corriendo en otra terminal.**

---

### 5b. (Opcional) Arrancar el panel admin

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
pnpm --filter @dentalkiosco/admin-frontend dev
```

- Panel en `http://localhost:5174`
- Login con credenciales de administrador (tabla `admins`)
- Secciones: Configuración clínica · Odontólogos

---

### 6. Conectar al kiosco (primer acceso del día)

El frontend necesita un `kiosk_token` JWT. Para obtenerlo:

```bash
# 1. Obtener el ID del kiosco
psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco \
  -c "SELECT id, name, is_active FROM kiosks;"

# 2. Generar el token (reemplaza <kiosk_id> y <JWT_SECRET>)
node -e "
const { SignJWT } = require('jose');
const secret = new TextEncoder().encode('<JWT_SECRET_del_.env>');
new SignJWT({ sub: '<kiosk_id>' })
  .setProtectedHeader({ alg: 'HS256' })
  .setAudience('kiosk')
  .setIssuer('dentalkiosco')
  .setExpirationTime('90d')
  .sign(secret)
  .then(t => console.log(t));
"
```

Luego abre: `http://localhost:5173/?kiosk_token=<token>`

---

## Comandos de verificación / diagnóstico

```bash
# Type-check (0 errores esperados)
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck

# Tests (159 en total, siempre en mock mode)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test

# Build de producción de los frontends
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build

# Estado de migraciones
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status

# Logs de la API en tiempo real (si arrancaste con redirección)
tail -f /tmp/dk-api.log | grep --line-buffered -A3 "MOCK\|OTP\|ERROR\|WARN"

# Ver OTP en logs cuando DEV_LOG_OTP=true
# Busca la línea: [INFO] OTP generated {"otp":"XXXXXX",...}

# Simular pago aprobado (mock Wompi)
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<ref>","status":"APPROVED","amount_in_cents":100000}},"sent_at":"2026-05-19T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'

# Matar procesos colgados de la API
kill $(ps aux | grep "tsx.*server.ts" | grep -v grep | awk '{print $2}')
```

---

## Configuración de mocks (.env actual)

```
DEV_MOCK_EXTERNAL_SERVICES=false   # Dentalink real
DEV_MOCK_WOMPI=true                # Wompi simulado
DEV_LOG_OTP=true                   # OTP visible en logs
```

Con esta configuración:
- **Dentalink**: llama a la API real (token descifrado de la BD)
- **SMS (Twilio)**: mock — OTP aparece en log como `[MOCK SMS]`
- **Email (Resend)**: real — OTP y comprobantes llegan a `fabiavargas@gmail.com`
- **Wompi**: mock — genera payment links falsos; usa el curl de arriba para aprobar

---

## Reglas de trabajo con hitos nuevos

1. Extraer el zip del hito en carpeta temporal.
2. Aplicar archivos sobre `dentalkiosco/` sin tocar lo anterior.
3. **Re-aplicar siempre estos fixes** (los parches los borran):
   - `config.ts`: helper `boolEnv()` en vars booleanas
   - `dentalink.ts`: función `normalizeCelular()` + su uso en `lookupPatientByCedula`
   - `vitest.config.ts`: bloque `env: { DEV_MOCK_EXTERNAL_SERVICES: 'true', DEV_MOCK_WOMPI: 'true' }`
   - Cada migración `.sql` nueva debe terminar con `INSERT INTO schema_migrations (...) ON CONFLICT DO NOTHING`
4. `pnpm install` → migraciones → type-check → tests → API + frontend → validar manualmente.
5. Commit solo cuando todo pasa. Nunca mezclar cambios de hitos distintos.
