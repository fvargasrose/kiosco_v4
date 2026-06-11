# Guía de despliegue — DentalKiosco

> Cómo desplegar el sistema en un servidor desde cero y cómo actualizarlo.
> **Rama de producción:** `para_produccion`. Repo público (no incluye secretos).

---

## 0. Arquitectura

```
cPanel (DNS de 2ways.us) → A record sistema.2ways.us → IP del servidor (Hetzner)
                                            │
Servidor Ubuntu 24.04 ── Docker Compose
   └─ Caddy (80/443, SSL Let's Encrypt automático)
        ├─ /         → kiosco (estático)
        ├─ /admin    → panel admin (estático, base '/admin/')
        ├─ /api/*    → backend Node/Fastify (prefijo /api se quita en Caddy)
        └─ /webhooks/* → webhooks Wompi
   backend ↔ Postgres 16 + Redis 7 (contenedores internos)
```

- **Prod actual:** Hetzner `dentalkiosco-prod`, IP `5.78.110.152`, dominio `https://sistema.2ways.us`.
- **Acceso:** `ssh root@5.78.110.152` (por llave). Repo en `/opt/dentalkiosco`.
- Prefijo de comandos: `CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"`.

---

## 1. Prerrequisitos (antes de desplegar)

| Recurso | Detalle |
|---|---|
| Servidor | Ubuntu 22.04/24.04, ≥2 vCPU / 4 GB RAM. Puertos 22/80/443 abiertos. |
| DNS | A record `sistema.2ways.us` → IP del servidor (en cPanel Zone Editor). |
| Cloudflare Turnstile | **Obligatorio** con `NODE_ENV=production`. Crear widget para el hostname en dash.cloudflare.com → Turnstile. Obtener **SITEKEY** + **SECRET**. |
| Wompi | Llaves de **producción** (`pub_prod_` / `prv_prod_` + events + integrity). |
| SMTP | Cuenta de correo (ej. `notificaciones@2ways.us`) con su contraseña. **Usar puerto 587** (ver Consideraciones). |
| Dentalink | Token de la cuenta Dentalink de la clínica. |

---

## 2. Preparar el servidor (como root)

```bash
# Firewall
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable

# Docker + compose
curl -fsSL https://get.docker.com | sh

# Node 20 + git + pnpm (para construir los frontends)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git
corepack enable && corepack prepare pnpm@9.4.0 --activate
```

## 3. Clonar (rama para_produccion) e instalar

```bash
cd /opt
git clone https://github.com/fvargasrose/kiosco_v4.git dentalkiosco
cd /opt/dentalkiosco
git checkout para_produccion        # ← rama con todos los fixes de deploy
pnpm install
```

## 4. Crear el `.env`

Copiar `doc_producir/env.ejemplo` a `/opt/dentalkiosco/.env` y rellenar.
**Generar secretos** (uno por variable) con: `openssl rand -hex 32`.
Puntos críticos (ver `CONSIDERACIONES.md`): `SMTP_PORT=587`, `TURNSTILE_*`, Wompi prod,
`POSTGRES_HOST=postgres`, `REDIS_HOST=redis`, `UPLOADS_DIR=/app/uploads`.

```bash
chmod 600 /opt/dentalkiosco/.env
```

## 5. Construir frontends

```bash
cd /opt/dentalkiosco
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build   # vite.config.js ya trae base '/admin/'
```

## 6. Levantar el stack (Caddy saca el SSL solo)

```bash
CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
mkdir -p apps/api/uploads/dentists && chown -R 1001:1001 apps/api/uploads
$CP build api
$CP up -d
$CP ps                       # 4 servicios "healthy"
$CP logs -f caddy            # buscar "certificate obtained"
```

## 7. Migraciones + primer admin + fila clinic

```bash
$CP exec api node dist/migrate.js          # aplica las migraciones
$CP exec api node dist/migrate.js status   # verificar

# Crear primer admin (contraseña ≥12, fuerte)
$CP exec api node dist/setup.js create-admin \
  --email admin@tu-dominio.com --password "<clave-fuerte>" --name "Admin"

# ⚠️ Crear la fila singleton clinic (id=1) — NO se crea sola (ver CONSIDERACIONES #3)
```

## 8. Verificación

```bash
curl https://sistema.2ways.us/api/health/ready        # database + redis ok
curl https://sistema.2ways.us/api/public/bootstrap     # config clínica (no NOT_CONFIGURED)
# Navegador: /  (kiosco) · /admin/ (panel)
```

---

## Actualizar / redesplegar (nuevo código)

```bash
cd /opt/dentalkiosco
CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
git fetch origin
git checkout -f para_produccion && git pull       # o la rama/commit a desplegar
pnpm install
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build
$CP build api && $CP up -d api                    # recrea el API (~10s de corte)
$CP exec api node dist/migrate.js                 # si hay migraciones nuevas
curl https://sistema.2ways.us/api/health/ready
```

> Si vienes de un server "main + parches a mano": `git checkout -f para_produccion`
> descarta los parches locales (ya están versionados en la rama). Quita primero
> archivos untracked que colisionen (p.ej. `rm apps/api/tsconfig.base.json`).

---

## Comandos de operación

```bash
CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
$CP ps                       # estado
$CP logs -f api              # logs backend
$CP logs --since 10m api | grep '"level":50'   # errores recientes
$CP restart api              # tras cambiar .env (o $CP up -d api)
$CP restart caddy            # tras cambiar Caddyfile.prod

# Backup DB
$CP exec -T postgres pg_dump -U dentalkiosco dentalkiosco > /opt/backup_$(date +%F).sql

# Reset manual de contraseña admin (ver CONSIDERACIONES #8)
```
