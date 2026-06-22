# Estado de Producción — DentalKiosco

> Documento para **retomar el trabajo sobre el sistema en línea sin perder contexto**.
> Rama de trabajo: **`para_produccion`**. Última actualización: **2026-06-11**.
> ⚠️ Este archivo es público (repo en GitHub): **NO contiene secretos**. Las
> credenciales viven en `/opt/dentalkiosco/.env` del servidor (chmod 600).

---

## 1. Qué hay y dónde

- **Sistema LIVE en:** https://sistema.2ways.us
  - `/` → kiosco del paciente · `/admin/` → panel admin · `/api/*` → backend · `/webhooks/*` → Wompi
- **Servidor:** Hetzner `dentalkiosco-prod`, Ubuntu 24.04, **IP `5.78.110.152`**.
- **Stack:** Docker Compose + Caddy (SSL Let's Encrypt automático). Repo clonado en **`/opt/dentalkiosco`**, rama `main` + parches (ver §4).
- **DNS:** A record `sistema.2ways.us → 5.78.110.152` (gestionado en cPanel de 2ways.us). NO tocar nameservers/MX.
- **SSL:** cert Let's Encrypt válido (~vence sep-2026), **auto-renueva**.

## 2. Cómo acceder / operar (SSH)

```bash
ssh root@5.78.110.152            # acceso por llave (sin contraseña)
cd /opt/dentalkiosco
CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

$CP ps                           # estado de los 4 contenedores
$CP logs -f api                  # logs del backend
$CP logs -f caddy                # logs del proxy/SSL
$CP up -d api                    # recrea api tras editar .env
$CP restart caddy                # recarga Caddy tras editar Caddyfile.prod
```

Los 4 contenedores: `dk-caddy`, `dk-api`, `dk-postgres`, `dk-redis` (todos `restart: unless-stopped` → sobreviven reinicios del server).

## 3. Acceso al panel admin

- URL: `https://sistema.2ways.us/admin/`
- Usuario: `partners2ways@gmail.com` (es el **identificador del panel**, NO la cuenta Gmail).
- Contraseña: definida al crear el admin (con `must_change_password` → se cambia en el primer login). **No se guarda aquí.**

## 4. Fixes de despliegue aplicados (incluidos en esta rama `para_produccion`)

Bugs reales del repo que impedían construir/servir en producción. **Ya están commiteados** en esta rama:

| # | Archivo | Cambio |
|---|---------|--------|
| 1 | `apps/api/src/server.ts` | CORS `origin: true → false` (los frontends son mismo-origen vía Caddy) |
| 2 | `apps/api/tsconfig.json` + `apps/api/tsconfig.base.json` (nuevo) + `apps/api/Dockerfile` | El build de Docker (contexto `./apps/api`) no veía `../../tsconfig.base.json` → se copió la base al contexto y se ajustó `extends` + `COPY` |
| 3 | `apps/api/Dockerfile` | El runtime no copiaba `migrations/` → `COPY migrations ./migrations` (migrate.js busca `/app/migrations`) |
| 4 | `infra/caddy/Caddyfile.prod` | Bloque admin: `root /srv` + `try_files {path} /admin/index.html` (servía mal `/admin`) |
| 5 | `apps/admin-frontend/vite.config.js` | `base: '/admin/'` (el panel se sirve bajo `/admin`) |
| 6 | `infra/caddy/Caddyfile.prod` | CSP del kiosco: `https://challenges.cloudflare.com` en `script-src`/`connect-src`/`frame-src` (Turnstile) **y** `blob:` en `img-src` + `media-src 'self' blob:` (sin esto el video/GIF de standby no se reproduce — el frontend usa `blob:` URLs) |
| + | `docker-compose.prod.yml` | Volumen `./apps/api/uploads:/app/uploads` para **persistir** fotos/standby entre rebuilds |

## 5. Configuración que NO está en git (entorno/datos — por despliegue)

Estas cosas viven en el servidor y/o son específicas del entorno. **Committear código NO las resuelve**:

- **`/opt/dentalkiosco/.env`** (chmod 600): todos los secretos y flags. Puntos clave:
  - `NODE_ENV=production`, `CADDY_DOMAIN=sistema.2ways.us`, `CADDY_EMAIL=partners2ways@gmail.com`
  - **`SMTP_PORT=587`** ⚠️ — Hetzner **bloquea el SMTP saliente 465 y 25**; 587 (STARTTLS) sí funciona. Si se redepliega, mantener 587.
  - Wompi en **producción** (`WOMPI_ENVIRONMENT=production`, `WOMPI_API_URL=production.wompi.co/v1`, `DEV_MOCK_WOMPI=false`) → **pagos reales**.
  - **Turnstile** (`TURNSTILE_SECRET` + `TURNSTILE_SITEKEY`) — **obligatorio** con `NODE_ENV=production` o el API no arranca.
  - `LICENSE_DEV_MODE=true`. Twilio vacío → OTP solo por correo.
  - **`UPLOADS_MAX_BYTES=209715200`** (200 MB) — subido desde 50 MB para permitir el video de standby. Videos grandes hacen lento el kiosco; conviene subir videos livianos.
  - Secretos `POSTGRES/REDIS/JWT/ENCRYPTION` generados para prod (hex). `ENCRYPTION_KEY` cifra datos en reposo → **NO cambiarla** (rompe lo cifrado).
- **Fila `clinic` (id=1) y datos:** se migraron desde local (ver §6). Es **DATA**, no código.

## 6. Migración de configuración local → prod (hecha 2026-06-11)

- Se creó la fila `clinic` (singleton id=1) copiando la config de local (pg_dump; rutas reescritas a `/app/uploads`).
- Se copiaron **8 fotos de dentistas** + **`standby.mp4`** al volumen de uploads.
- El **token Dentalink** (del `.env`, real) se cifró con la clave de prod vía `fn_encrypt`.
- ⚠️ Gran parte de la config migrada es **demo** (legal_name "Smile Center Demo", NIT "900.000.000-0", Habeas Data "Aviso público bootstrap test", emails `@demo.local`). **Pendiente reemplazar por datos reales desde el panel admin** (especialmente NIT y texto de Habeas Data, que son legalmente relevantes).

## 7. Hueco de producto conocido (pendiente de fix en código)

**Nada crea la fila `clinic` singleton en producción:** las migraciones no insertan fila, `seed` se niega a correr en prod (y trae datos demo), `setup.ts`/installer solo hacen migrate + create-admin, y el panel admin solo hace `UPDATE ... WHERE id=1` (nunca INSERT). Por eso un despliegue nuevo da "Error al cargar la configuración" hasta crear la fila a mano.
→ **Mejora propuesta:** comando `setup.ts create-clinic` o auto-crear la fila singleton al primer arranque.

## 8. Pendientes

- [ ] **Merge `para_produccion` → `main`** (o desplegar desde esta rama) para que un re-clone de `main` ya traiga los fixes.
- [ ] Reemplazar datos demo de la clínica (NIT, razón social, Habeas Data) desde el panel.
- [ ] Resolver el hueco de §7 (crear fila clinic vía código).
- [ ] **Borrar `ojo_borrar.txt`** del repo/raíz (contiene llaves Wompi/Turnstile en claro) y rotar esas llaves si quedó expuesto.
- [ ] §12 pendiente: limpiar datos de prueba en Dentalink + borrar `docs/script_test/` (token expuesto) y rotarlo.
- [ ] (Opcional) Caddy `/health*` para monitoreo externo en ruta sin `/api`.

## 9. Operaciones comunes

```bash
cd /opt/dentalkiosco
CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# Backup de la base de datos
$CP exec -T postgres pg_dump -U dentalkiosco dentalkiosco > /opt/backup_$(date +%F).sql

# Migraciones (tras nuevo código)
$CP exec api node dist/migrate.js
$CP exec api node dist/migrate.js status

# Actualizar el sistema (nuevo deploy desde git)
git pull origin <rama>
pnpm install
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build
$CP build api && $CP up -d
$CP exec api node dist/migrate.js

# Verificación rápida
curl https://sistema.2ways.us/api/health/ready    # database + redis ok
curl https://sistema.2ways.us/api/public/bootstrap # config de la clínica
```

## 10. Verificación de salud actual

- `GET /api/health/ready` → `database ok`, `redis ok`
- `GET /api/public/bootstrap` → config de la clínica (sin `NOT_CONFIGURED`)
- Login de paciente: cédula → teléfono → Turnstile → **OTP por correo (SMTP 587)** → código. ✅ Verificado funcionando.
