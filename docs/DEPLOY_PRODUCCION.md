# DentalKiosco — Guía de despliegue a producción

**Stack de producción:** Docker Compose · Caddy (TLS automático) · PostgreSQL 16 · Redis 7 · Node.js 20

---

## Índice

1. [Requisitos del servidor](#1-requisitos-del-servidor)
2. [Preparar el servidor](#2-preparar-el-servidor)
3. [Clonar el repositorio](#3-clonar-el-repositorio)
4. [Correcciones antes del primer deploy](#4-correcciones-antes-del-primer-deploy)
5. [Generar secretos](#5-generar-secretos)
6. [Configurar el archivo .env](#6-configurar-el-archivo-env)
7. [Construir los frontends](#7-construir-los-frontends)
8. [Arrancar los servicios](#8-arrancar-los-servicios)
9. [Aplicar migraciones](#9-aplicar-migraciones)
10. [Crear el primer administrador](#10-crear-el-primer-administrador)
11. [Verificar que todo funciona](#11-verificar-que-todo-funciona)
12. [Firewall y seguridad del servidor](#12-firewall-y-seguridad-del-servidor)
13. [Backups](#13-backups)
14. [Actualizar a una versión nueva](#14-actualizar-a-una-versión-nueva)
15. [Logs y monitoreo básico](#15-logs-y-monitoreo-básico)
16. [Checklist final](#16-checklist-final)

---

## 1. Requisitos del servidor

### Especificaciones mínimas

| Recurso | Mínimo | Recomendado |
|---------|--------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 2 GB | 4 GB |
| Disco | 20 GB SSD | 40 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

**Referencias de precio (Hetzner, 2025):**
- `CAX11` ARM (2 vCPU, 4 GB, 40 GB) — ~€5/mes (más barato, buen rendimiento)
- `CPX21` x86 (3 vCPU, 4 GB, 80 GB) — ~€8/mes (más compatible con binarios nativos como argon2)

> **Recomendación:** `CPX21` x86 para evitar problemas de compilación de módulos
> nativos (argon2, bcrypt) en ARM. Si usas ARM, asegúrate de que la imagen
> Docker base soporte `linux/arm64`.

### Requisitos de red

- IP pública estática
- Puerto 80 y 443 accesibles desde internet (para Let's Encrypt)
- Dominio con registro A apuntando al servidor

---

## 2. Preparar el servidor

Conectarse al servidor y ejecutar como root o con sudo:

```bash
# Actualizar el sistema
apt-get update && apt-get upgrade -y

# Instalar dependencias base
apt-get install -y \
  git curl wget ufw fail2ban \
  ca-certificates gnupg lsb-release

# Instalar Docker
curl -fsSL https://get.docker.com | bash

# Instalar Docker Compose plugin (viene incluido con Docker moderno)
docker compose version   # verificar que está disponible

# Instalar pnpm (necesario para builds)
curl -fsSL https://get.pnpm.io/install.sh | bash
source ~/.bashrc
pnpm --version

# Instalar Node.js 20 (necesario para builds y scripts)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash
apt-get install -y nodejs
node --version   # debe ser 20.x
```

### Crear usuario de despliegue (buena práctica — no correr como root)

```bash
useradd -m -s /bin/bash deploy
usermod -aG docker deploy
# Copiar tu clave SSH al usuario deploy
mkdir -p /home/deploy/.ssh
# Pegar tu clave pública en /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

A partir de aquí, trabajar como usuario `deploy`:

```bash
su - deploy
```

---

## 3. Clonar el repositorio

```bash
cd /opt
git clone https://github.com/fvargasrose/kiosco_v3_produccion.git dentalkiosco
cd dentalkiosco
git checkout main   # o la rama/tag de producción
```

Instalar dependencias del monorepo:

```bash
pnpm install
```

---

## 4. Correcciones antes del primer deploy

Hay dos ajustes necesarios que no están en el código base por defecto:

### 4a. `docker-compose.yml` — ruta del build del panel admin

El `docker-compose.yml` monta `apps/admin-frontend/out` pero Vite construye en `dist`.
Corregir el volumen:

```bash
sed -i 's|./apps/admin-frontend/out:/srv/admin|./apps/admin-frontend/dist:/srv/admin|' docker-compose.yml
```

Verificar:

```bash
grep "admin-frontend" docker-compose.yml
# Debe mostrar: ./apps/admin-frontend/dist:/srv/admin:ro
```

### 4b. `vite.config.js` del panel admin — base path

El panel admin se sirve bajo `/admin` en Caddy. Sin `base: '/admin/'` en Vite,
los assets del bundle usan rutas absolutas (`/assets/...`) que Caddy no puede
resolver desde el subdirectorio.

```bash
# Añadir base: '/admin/' al bloque build del vite.config.js del admin
sed -i "s|outDir: 'dist',|outDir: 'dist',\n    base: '/admin/',|" apps/admin-frontend/vite.config.js
```

Verificar:

```bash
grep -A5 "build:" apps/admin-frontend/vite.config.js
# Debe mostrar outDir: 'dist' y base: '/admin/'
```

> Estos dos fixes son permanentes; no se pierden con actualizaciones si se hace
> `git pull` (los archivos modificados tienen cambios locales que git preserva).
> Pero si haces `git checkout apps/admin-frontend/vite.config.js` se perderán.

---

## 5. Generar secretos

Usar el script incluido para generar todos los secretos criptográficos:

```bash
bash scripts/generate-secrets.sh
```

El script imprime los valores y opcionalmente crea el `.env` desde `.env.example`.
Si no lo crea automáticamente, copiar el ejemplo manualmente:

```bash
cp .env.example .env
```

---

## 6. Configurar el archivo `.env`

Editar `.env` con los valores reales:

```bash
nano .env
```

### Variables obligatorias para producción

```bash
# ── Entorno ──────────────────────────────────────────────────────────────────
NODE_ENV=production
INSTALLATION_ID=miclinica-popayan-01      # identificador único de esta instalación

# ── URLs ─────────────────────────────────────────────────────────────────────
PUBLIC_BASE_URL=https://kiosco.miclinica.co
CADDY_DOMAIN=kiosco.miclinica.co          # dominio principal (kiosco + /api + /admin)
CADDY_EMAIL=admin@miclinica.co            # para Let's Encrypt

# ── Base de datos ─────────────────────────────────────────────────────────────
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=dentalkiosco
POSTGRES_USER=dentalkiosco
POSTGRES_PASSWORD=<generado por generate-secrets.sh>

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=<generado por generate-secrets.sh>

# ── Secretos de cifrado ───────────────────────────────────────────────────────
JWT_SECRET=<generado por generate-secrets.sh>       # mínimo 32 chars
ENCRYPTION_KEY=<generado por generate-secrets.sh>   # 32 bytes base64

# ── Dentalink ─────────────────────────────────────────────────────────────────
DENTALINK_TOKEN=<token de la API de Dentalink de la clínica>
DENTALINK_API_URL=https://api.dentalink.healthatom.com

# ── SMS (Twilio) ──────────────────────────────────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=<auth token>
TWILIO_FROM_NUMBER=+1XXXXXXXXXX

# ── Email (Resend) ────────────────────────────────────────────────────────────
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
RESEND_FROM_EMAIL=no-reply@miclinica.co   # debe ser dominio verificado en Resend
RESEND_REPLY_TO_EMAIL=soporte@miclinica.co

# ── Wompi ─────────────────────────────────────────────────────────────────────
WOMPI_PUBLIC_KEY=pub_prod_xxxx
WOMPI_PRIVATE_KEY=prv_prod_xxxx
WOMPI_EVENTS_SECRET=<secret de webhook en dashboard Wompi>
WOMPI_INTEGRITY_SECRET=<secret de integridad en dashboard Wompi>
WOMPI_ENVIRONMENT=production
WOMPI_API_URL=https://production.wompi.co/v1

# ── Mocks — TODOS en false en producción ─────────────────────────────────────
DEV_MOCK_EXTERNAL_SERVICES=false
DEV_MOCK_WOMPI=false
DEV_LOG_OTP=false                          # NUNCA true en producción

# ── Logs ──────────────────────────────────────────────────────────────────────
LOG_LEVEL=info
LOG_FORMAT=json                            # json para ingestión en Loki/Grafana
```

### Variables que NO cambiar en producción

```bash
POSTGRES_HOST=postgres    # nombre del servicio en la red de Docker
REDIS_HOST=redis          # nombre del servicio en la red de Docker
```

---

## 7. Construir los frontends

Los archivos estáticos deben existir antes de arrancar Caddy:

```bash
# Desde la raíz del monorepo
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build

# Verificar que los dist existen
ls apps/kiosco-frontend/dist/
ls apps/admin-frontend/dist/
```

---

## 8. Arrancar los servicios

```bash
# Primera vez (o tras cambios en el Dockerfile del API)
docker compose build api

# Arrancar todo en segundo plano
docker compose up -d

# Verificar que todos los contenedores están healthy
docker compose ps
```

Salida esperada (tras ~30 segundos):

```
NAME          IMAGE                STATUS
dk-caddy      caddy:2-alpine       Up (healthy)
dk-api        dentalkiosco-api     Up (healthy)
dk-postgres   postgres:16-alpine   Up (healthy)
dk-redis      redis:7-alpine       Up (healthy)
```

Si algún contenedor aparece como `unhealthy` o `restarting`:

```bash
docker compose logs api       # ver errores del backend
docker compose logs caddy     # ver errores del proxy
docker compose logs postgres  # ver errores de la BD
```

---

## 9. Aplicar migraciones

Las migraciones se corren **dentro del contenedor** del API (que ya tiene las
credenciales de BD en su entorno):

```bash
docker compose exec api node dist/migrate.js
```

Verificar estado:

```bash
docker compose exec api node dist/migrate.js status
# Debe mostrar: Total: 11, Aplicadas: 11, Pendientes: 0
```

> Las migraciones son idempotentes. Correrlas múltiples veces es seguro.

---

## 10. Crear el primer administrador

```bash
# Acceder al contenedor del API
docker compose exec api sh

# Dentro del contenedor — crear admin con un script inline
node -e "
import('./dist/routes/admin-auth.js').then(async ({ createAdmin }) => {
  const id = await createAdmin({
    email: 'admin@miclinica.co',
    password: 'CambiarEnPrimerLogin2025!',
    fullName: 'Administrador Clínica',
    role: 'admin',
  });
  console.log('Admin creado, id:', id);
  process.exit(0);
});
"

# Salir del contenedor
exit
```

El administrador deberá:
1. Abrir `https://kiosco.miclinica.co/admin`
2. Iniciar sesión con el email y contraseña recién creados
3. Configurar MFA (el panel mostrará el QR automáticamente)
4. Guardar los 10 códigos de recuperación en un lugar seguro

---

## 11. Verificar que todo funciona

```bash
# Health check público
curl https://kiosco.miclinica.co/health

# Respuesta esperada:
# {"status":"ok","postgres":"ok","redis":"ok","version":"3.0.0-alpha.1"}

# Acceso al kiosco
open https://kiosco.miclinica.co

# Acceso al panel admin
open https://kiosco.miclinica.co/admin
```

### Probar el flujo de login del kiosco

1. Ir a `https://kiosco.miclinica.co/?kiosk_token=<token>`
2. (Ver [guia.md](../guia.md) para generar el token del kiosco)
3. La pantalla de espera debe mostrarse correctamente

---

## 12. Firewall y seguridad del servidor

```bash
# Configurar UFW (Uncomplicated Firewall)
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh          # puerto 22 — SSH
ufw allow 80/tcp       # HTTP (Caddy lo redirige a HTTPS)
ufw allow 443/tcp      # HTTPS

# Activar
ufw enable
ufw status
```

### fail2ban para proteger SSH

```bash
# Configuración básica (normalmente se activa sola al instalar fail2ban)
systemctl enable fail2ban
systemctl start fail2ban
fail2ban-client status sshd
```

### Deshabilitar login root por SSH

```bash
# En /etc/ssh/sshd_config:
echo "PermitRootLogin no" >> /etc/ssh/sshd_config
echo "PasswordAuthentication no" >> /etc/ssh/sshd_config
systemctl reload sshd
```

> **Importante:** asegúrate de tener tu clave SSH funcionando en el usuario
> `deploy` antes de deshabilitar login por contraseña.

---

## 13. Backups

### PostgreSQL — backup diario automático

```bash
# Crear directorio de backups
mkdir -p /opt/backups/dentalkiosco

# Script de backup
cat > /opt/backups/backup-db.sh << 'EOF'
#!/bin/bash
set -euo pipefail
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/opt/backups/dentalkiosco
COMPOSE_DIR=/opt/dentalkiosco

cd "$COMPOSE_DIR"

# Dump comprimido
docker compose exec -T postgres pg_dump \
  -U dentalkiosco dentalkiosco \
  | gzip > "$BACKUP_DIR/postgres_${DATE}.sql.gz"

# Mantener solo los últimos 30 días
find "$BACKUP_DIR" -name "postgres_*.sql.gz" -mtime +30 -delete

echo "Backup completado: postgres_${DATE}.sql.gz"
EOF
chmod +x /opt/backups/backup-db.sh

# Programar con cron (2 AM todos los días)
crontab -e
# Añadir esta línea:
# 0 2 * * * /opt/backups/backup-db.sh >> /var/log/dentalkiosco-backup.log 2>&1
```

### Backup de archivos de uploads

Los uploads (fotos de odontólogos, media de standby) viven en `apps/api/uploads/`
dentro del repo en el servidor. Incluirlos en el backup:

```bash
cat >> /opt/backups/backup-db.sh << 'EOF'

# Backup de uploads
tar -czf "$BACKUP_DIR/uploads_${DATE}.tar.gz" \
  -C /opt/dentalkiosco/apps/api uploads/

find "$BACKUP_DIR" -name "uploads_*.tar.gz" -mtime +30 -delete
EOF
```

### Restaurar un backup

```bash
# Restaurar BD (el contenedor debe estar corriendo)
gunzip -c /opt/backups/dentalkiosco/postgres_YYYYMMDD_HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U dentalkiosco dentalkiosco

# Restaurar uploads
tar -xzf /opt/backups/dentalkiosco/uploads_YYYYMMDD_HHMMSS.tar.gz \
  -C /opt/dentalkiosco/apps/api/
```

---

## 14. Actualizar a una versión nueva

```bash
cd /opt/dentalkiosco

# 1. Obtener los cambios
git pull origin main

# 2. Instalar nuevas dependencias (si las hay)
pnpm install

# 3. Construir frontends
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build

# 4. Reconstruir imagen del API (si hay cambios en el backend)
docker compose build api

# 5. Reiniciar servicios con zero-downtime relativo
#    (Caddy y las DBs no se reinician si no cambiaron)
docker compose up -d --no-deps api
docker compose up -d --no-deps caddy   # recarga los nuevos estáticos

# 6. Aplicar migraciones nuevas (si las hay)
docker compose exec api node dist/migrate.js

# 7. Verificar
docker compose ps
curl https://kiosco.miclinica.co/health
```

> Los frontends estáticos son recargados por Caddy inmediatamente ya que se
> sirven como archivos del volumen montado — no necesita reinicio.

---

## 15. Logs y monitoreo básico

```bash
# Ver logs en tiempo real de todos los servicios
docker compose logs -f

# Solo el API (más común)
docker compose logs -f api

# Solo errores del API
docker compose logs -f api | grep '"level":50'   # nivel 50 = error en pino

# Ver el reconciliador de pagos
docker compose logs api | grep -i "reconciler"

# Ver intentos de login fallidos
docker compose logs api | grep "admin.login.invalid_password\|admin.login.locked"

# Espacio en disco
df -h
docker system df    # espacio usado por imágenes, volúmenes y contenedores

# Limpiar imágenes huérfanas (ocasionalmente)
docker image prune -f
```

### Health checks automatizados (opcional — cron)

```bash
# Alerta simple si el health check falla (requiere un email configurado)
cat > /opt/healthcheck.sh << 'EOF'
#!/bin/bash
if ! curl -sf https://kiosco.miclinica.co/health > /dev/null; then
  echo "ALERTA: DentalKiosco health check FALLIDO $(date)" \
    | mail -s "DentalKiosco DOWN" admin@miclinica.co
fi
EOF
chmod +x /opt/healthcheck.sh
# Cron cada 5 minutos:
# */5 * * * * /opt/healthcheck.sh
```

---

## 16. Checklist final

Antes de dar el sistema por listo en producción:

### Infraestructura
- [ ] Servidor creado y actualizado (Ubuntu 22.04+ / 24.04)
- [ ] Docker y pnpm instalados
- [ ] Usuario `deploy` con acceso Docker, sin acceso root por SSH
- [ ] Firewall UFW activo (solo 22, 80, 443)
- [ ] fail2ban activo

### DNS y TLS
- [ ] Dominio apuntando al servidor (registro A)
- [ ] `https://kiosco.miclinica.co` responde (Caddy obtuvo certificado Let's Encrypt)
- [ ] HTTP redirige automáticamente a HTTPS

### Variables de entorno
- [ ] `NODE_ENV=production`
- [ ] `DEV_MOCK_EXTERNAL_SERVICES=false`
- [ ] `DEV_MOCK_WOMPI=false`
- [ ] `DEV_LOG_OTP=false`
- [ ] Secretos generados (no los defaults de `.env.example`)
- [ ] Credenciales de Twilio reales
- [ ] Credenciales de Resend con dominio verificado
- [ ] Credenciales de Wompi producción
- [ ] Token de Dentalink real

### Aplicación
- [ ] Todos los contenedores `healthy`
- [ ] `curl /health` devuelve `postgres: ok, redis: ok`
- [ ] Migraciones aplicadas (11/11)
- [ ] Admin creado con email real y contraseña fuerte
- [ ] MFA configurado en el primer login del admin
- [ ] Kiosk token generado y probado en el dispositivo kiosco
- [ ] Flujo de OTP funcionando (SMS o email llega al paciente)

### Backups
- [ ] Cron de backup diario activo
- [ ] Backup de prueba generado y restaurado exitosamente
- [ ] Backups almacenados fuera del servidor (Hetzner Object Storage, S3, etc.)

---

## Apéndice — Estructura de archivos en el servidor

```
/opt/dentalkiosco/
├── .env                          # secretos de producción (no en git)
├── docker-compose.yml            # servicios de producción
├── apps/
│   ├── api/
│   │   └── uploads/             # fotos de dentistas y media standby
│   ├── kiosco-frontend/
│   │   └── dist/                # build estático del kiosco (→ Caddy)
│   └── admin-frontend/
│       └── dist/                # build estático del panel admin (→ Caddy)
└── infra/
    └── caddy/
        └── Caddyfile            # configuración del reverse proxy

/opt/backups/dentalkiosco/
├── postgres_YYYYMMDD_HHMMSS.sql.gz
└── uploads_YYYYMMDD_HHMMSS.tar.gz
```
