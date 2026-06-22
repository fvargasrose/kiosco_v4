# Levantar DentalKiosco (kiosko_v4) — Guía autocontenida

Esta guía tiene **todo lo necesario** para levantar el sistema en local, con los
valores reales que ya están en el `.env` de este clon (`kiosko_v4`).
No necesitas conocer nada externo: las claves, puertos y comandos están aquí.

> Importante: este clon usa **puertos propios** (Postgres `5434`, Redis `6381`)
> para no chocar con el proyecto original (`5433` / `6380`). Si tienes el original
> corriendo, ambos conviven sin problema.

---

## 0. Requisitos (lo que debes tener instalado)

| Herramienta | Versión usada | Cómo verificar |
|-------------|---------------|----------------|
| Node.js    | 22.20.0       | `node -v`  |
| pnpm       | 9.4.0         | `pnpm -v`  |
| Docker + Docker Compose | cualquiera reciente | `docker --version` |

⚠️ **Estado verificado de Docker en este equipo (2026-06-04):**

| Comprobación | Resultado |
|--------------|-----------|
| Binario `docker` | ❌ **No instalado** (no está en `which`, `/usr/bin`, `/usr/local/bin`, `/snap/bin`) |
| Servicio `docker` | `inactive` |
| Usuario en grupo `docker` | ✅ **Sí** (`joy` ya está en el grupo) |
| `sudo` sin contraseña | ❌ No — pide contraseña, la instalación la haces tú |

Como el binario no existe, **debes instalar Docker primero** o nada de Postgres/Redis
arrancará. En Ubuntu:

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker     # arranca el servicio (está inactive)
```

> No necesitas `sudo usermod -aG docker $USER`: tu usuario **ya está** en el grupo
> `docker`. (Si justo acabas de instalar y aún pide permisos, cierra y reabre sesión.)

Comprueba después:
```bash
docker --version
docker compose version
```

Si NO quieres Docker, puedes usar un Postgres 16 y Redis 7 instalados
directamente en el host, pero deberás crear la BD/usuario manualmente con los
datos de la sección 2.

---

## 1. El ambiente / `.env` (YA está configurado)

El archivo `/home2/kiosko_v4/.env` ya existe y tiene todo. Estos son los valores
clave que el sistema te pedirá conocer:

### Infraestructura (puertos de este clon)
```
POSTGRES_HOST=localhost
POSTGRES_PORT=5434
POSTGRES_DB=dentalkiosco
POSTGRES_USER=dentalkiosco
POSTGRES_PASSWORD=8hpyKJ1ZEqZ0NsqDRdJIlEJjlDhLPTOI

REDIS_HOST=localhost
REDIS_PORT=6381
REDIS_PASSWORD=lcjJzIQUT7FylMKyaR6DzKYzR3ezelet
```

### Modo de operación (importante)
```
LICENSE_DEV_MODE=true          # sin validación de licencia (dev)
OTP_REQUIRED=true              # login con código OTP
DEV_LOG_OTP=true               # el OTP se imprime en la consola del API
DEV_MOCK_EXTERNAL_SERVICES=false
DEV_MOCK_WOMPI=false           # Wompi en sandbox real (ver claves abajo)
FEATURE_REGISTRO=false
KIOSK_THEME=apple
```

### Integraciones (sandbox / pruebas — ya cargadas)
- **Wompi**: sandbox (`pub_test_…` / `prv_test_…`), base `https://sandbox.wompi.co/v1`
- **Dentalink**: token real cargado, API `https://api.dentalink.healthatom.com`
- **Twilio**: vacío → SMS mockeado
- **Email (Resend + SMTP 2ways)**: claves cargadas; notificaciones a `fvargas@unicauca.edu.co`

### Datos de prueba (paciente demo)
```
Cédula (rut):  10697021
Teléfono:      3206505239   (el frontend lo envía como +573206505239)
```

### Admin del panel
No hay admin precreado: lo creas tú en el paso 5. Usa lo que quieras, por ejemplo:
```
email:    admin@demo.local
password: Admin@Demo2026
```

---

## 2. Levantar Postgres + Redis (Docker)

Desde `/home2/kiosko_v4`:

```bash
docker compose up -d postgres redis
docker compose ps          # ambos deben estar "Up"/healthy
```

Esto expone Postgres en `localhost:5434` y Redis en `localhost:6381`
(según `docker-compose.override.yml`).

---

## 3. Instalar dependencias

```bash
cd /home2/kiosko_v4
pnpm install
```

---

## 4. Aplicar migraciones de base de datos

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status   # verifica
```

---

## 5. Crear el primer admin

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"
```
(Es idempotente: puedes repetirlo sin romper nada.)

---

## 6. Arrancar el backend (API)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
```
- Corre en **http://localhost:3000**
- No recarga el `.env` automáticamente: si cambias el `.env`, reinícialo (Ctrl+C y de nuevo).
- El OTP de login aparecerá **en esta consola** (porque `DEV_LOG_OTP=true`).

Verifica que vive:
```bash
curl http://localhost:3000/health/ready
```

---

## 7. Arrancar los frontends

En terminales separadas:

```bash
# Kiosco (paciente)
pnpm --filter @dentalkiosco/kiosco-frontend dev    # http://localhost:5173

# Admin (panel)
pnpm --filter @dentalkiosco/admin-frontend dev     # http://localhost:5174
```

---

## 8. Probar de punta a punta

1. Abre el **admin** en http://localhost:5174 → entra con `admin@demo.local` / `Admin@Demo2026`.
2. Abre el **kiosco** en http://localhost:5173.
3. En el kiosco, login con la cédula demo **10697021** y teléfono **3206505239**.
4. Como `OTP_REQUIRED=true`, mira la **consola del API** (paso 6) para leer el OTP e ingrésalo.
5. Para simular un pago aprobado con Wompi, dispara el webhook (cambia `<ref>` por la referencia real de la transacción):

```bash
curl -X POST http://localhost:3000/webhooks/wompi \
  -H "Content-Type: application/json" \
  -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<ref>","status":"APPROVED","amount_in_cents":550000}},"sent_at":"2026-06-04T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'
```

---

## 9. Verificación (opcional, recomendado)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test     # 195 tests, mock mode
```

---

## Problemas frecuentes

| Síntoma | Causa / solución |
|---------|------------------|
| `ECONNREFUSED 127.0.0.1:5434` | Postgres no está arriba → `docker compose up -d postgres` |
| `docker: command not found` | Instala Docker (sección 0) |
| El login pide OTP y no llega SMS | Es normal: Twilio está mockeado. Lee el OTP en la **consola del API**. |
| Cambié el `.env` y no surte efecto | Reinicia el proceso del API (no recarga en caliente). |
| Puerto 3000/5173/5174 ocupado | Mata el proceso previo o cambia el puerto. |
| Choca con el proyecto original | No debería: este clon usa 5434/6381, el original 5433/6380. |

---

## Resumen ultrarrápido (copia-pega)

```bash
cd /home2/kiosko_v4
docker compose up -d postgres redis
pnpm install
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"
# Terminal 1:
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
# Terminal 2:
pnpm --filter @dentalkiosco/kiosco-frontend dev
# Terminal 3:
pnpm --filter @dentalkiosco/admin-frontend dev
```
