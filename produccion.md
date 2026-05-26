# DentalKiosco — Guía de producción (Hetzner)

## Índice
1. [Requisitos previos](#1-requisitos-previos)
2. [Crear y preparar el VPS en Hetzner](#2-crear-y-preparar-el-vps-en-hetzner)
3. [Obtener la clave de licencia](#3-obtener-la-clave-de-licencia)
4. [Clonar el repositorio en el servidor](#4-clonar-el-repositorio-en-el-servidor)
5. [Ejecutar el installer](#5-ejecutar-el-installer)
6. [Verificar que todo funciona](#6-verificar-que-todo-funciona)
7. [Activar / desactivar OTP en producción](#7-activar--desactivar-otp-en-producción)
8. [Hacer cambios en el frontend](#8-hacer-cambios-en-el-frontend)
9. [Hacer cambios en el backend](#9-hacer-cambios-en-el-backend)
10. [Actualizaciones automáticas](#10-actualizaciones-automáticas)
11. [Operaciones de mantenimiento](#11-operaciones-de-mantenimiento)
12. [Resolución de problemas comunes](#12-resolución-de-problemas-comunes)

---

## 1. Requisitos previos

### Infraestructura
- Cuenta en [Hetzner Cloud](https://console.hetzner.cloud)
- Dominio propio (ej. `kiosco.tuClinica.com`) con acceso al panel DNS

### Integraciones (obtener antes de instalar)
- **Dentalink:** token API de tu instalación de Dentalink
- **Wompi:** llaves de producción (Public Key, Private Key, Events Secret, Integrity Secret) — en `panel.wompi.co`
- **Resend:** API Key para envío de emails — en `resend.com` (plan gratuito funciona hasta 3000 emails/mes)
- **Clave de licencia DentalKiosco:** proporcionada por el proveedor (formato `DK-XXXXXXXX-XXXXXXXX-XXXXXXXX`)

---

## 2. Crear y preparar el VPS en Hetzner

### Especificaciones recomendadas

| Uso | Modelo Hetzner | CPU | RAM | Disco | Costo aprox. |
|-----|---------------|-----|-----|-------|--------------|
| Clínica pequeña (1–2 kioscos) | CX22 | 2 vCPU | 4 GB | 40 GB | ~4 €/mes |
| Clínica mediana (3–5 kioscos) | CX32 | 4 vCPU | 8 GB | 80 GB | ~8 €/mes |
| Clínica grande | CX42 | 8 vCPU | 16 GB | 160 GB | ~16 €/mes |

### Crear el servidor

1. Ir a `console.hetzner.cloud` → **Create Server**
2. **Location:** Falkenstein (o Nuremberg) — ambos en Europa, latencia Colombia ~130 ms
3. **Image:** Ubuntu 24.04 (recomendado) o Ubuntu 22.04
4. **Type:** CX22 mínimo (ver tabla)
5. **Networking:** IPv4 activado (IPv6 opcional)
6. **SSH Keys:** agregar tu llave pública (obligatorio — no usar contraseña root)
7. **Name:** `dentalkiosco-<nombre-clinica>`
8. Clic en **Create & Buy now**

### Apuntar el DNS

En el panel de tu registrador de dominio, crear un registro **A**:

```
Nombre:  kiosco              (o el subdominio que prefieras)
Tipo:    A
Valor:   <IP pública del VPS>
TTL:     300 (5 minutos)
```

Verifica que propaga (puede tardar entre 5 minutos y 2 horas):
```bash
# En tu máquina local
nslookup kiosco.tuClinica.com
# Debe devolver la IP del VPS
```

> **No continúes con la instalación hasta que el DNS propague.** Let's Encrypt necesita resolver el dominio para emitir el certificado TLS.

### Primer acceso al servidor

```bash
ssh root@<IP_del_VPS>
```

---

## 3. Obtener la clave de licencia

Contacta al proveedor de DentalKiosco con:
- Nombre legal de la clínica
- NIT
- Correo del administrador
- Dominio donde se instalará

El proveedor entrega una clave con formato `DK-XXXXXXXX-XXXXXXXX-XXXXXXXX`. Guárdala de forma segura — se necesita durante la instalación.

---

## 4. Clonar el repositorio en el servidor

```bash
# En el servidor (como root)
apt-get update && apt-get install -y git

git clone https://github.com/fvargasrose/kiosco_v3_produccion.git /opt/dentalkiosco

cd /opt/dentalkiosco
```

> Si el repositorio es privado: genera un [Personal Access Token](https://github.com/settings/tokens) en GitHub con permisos `repo` y usa:
> ```bash
> git clone https://<tu_usuario>:<token>@github.com/fvargasrose/kiosco_v3_produccion.git /opt/dentalkiosco
> ```

---

## 5. Ejecutar el installer

```bash
cd /opt/dentalkiosco
sudo bash installer/install.sh
```

El installer te guía por 12 fases. Duración estimada: **20–30 minutos**.

### Lo que pregunta el wizard (Fase 5)

| Campo | Descripción | Ejemplo |
|-------|-------------|---------|
| Nombre legal | Razón social de la clínica | `Clínica Dental Sur SAS` |
| NIT | Identificación tributaria | `900123456-7` |
| Nombre admin | Nombre del administrador | `Juan Pérez` |
| Email admin | Para credenciales y notificaciones | `admin@clinicasur.com` |
| Contraseña admin | Mínimo 12 chars, mayúsc., dígito, símbolo | (la que definas) |
| Dominio | Sin https://, sin barra final | `kiosco.clinicasur.com` |
| Email TLS | Para Let's Encrypt (por defecto = email admin) | `admin@clinicasur.com` |
| Dentalink token | Token de tu instalación Dentalink | (opcional ahora) |
| Wompi keys | 4 llaves del portal Wompi | (opcional ahora) |
| Resend | API Key y email de origen | (opcional ahora) |

> Las integraciones opcionales (Dentalink, Wompi, Resend) se pueden configurar después desde el panel admin en **Configuración → Integraciones**.

### Qué genera automáticamente

El installer genera de forma segura (con `openssl rand`):
- `POSTGRES_PASSWORD` — contraseña de la base de datos
- `REDIS_PASSWORD` — contraseña de Redis
- `JWT_SECRET` — 64 caracteres aleatorios para firmar tokens
- `ENCRYPTION_KEY` — 64 caracteres para cifrado en reposo
- `INSTALLATION_ID` — UUID único de esta instalación

Todos quedan en `/opt/dentalkiosco/.env` con permisos `600` (solo root puede leer).

### Resultado esperado al terminar

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓  DentalKiosco instalado correctamente
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Acceso kiosco:   https://kiosco.tuClinica.com
  Panel admin:     https://kiosco.tuClinica.com/admin
  Usuario admin:   admin@tuClinica.com
  Contraseña:      <contraseña que ingresaste>

  ⚠  Guarda esta contraseña ahora — no se volverá a mostrar.
```

**Guarda la contraseña de inmediato.** El installer no la almacena.

---

## 6. Verificar que todo funciona

### Health check

```bash
# Desde el servidor o desde tu navegador
curl https://kiosco.tuClinica.com/health/ready | python3 -m json.tool
```

Respuesta esperada:
```json
{
  "status": "ready",
  "checks": {
    "database": { "ok": true, "latencyMs": 2 },
    "redis": { "ok": true, "latencyMs": 1 }
  }
}
```

### Verificar contenedores

```bash
cd /opt/dentalkiosco
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Todos deben mostrar `(healthy)`:
```
dk-caddy     running (healthy)
dk-api       running (healthy)
dk-postgres  running (healthy)
dk-redis     running (healthy)
```

### Primer login al panel admin

1. Abrir `https://kiosco.tuClinica.com/admin`
2. Ingresar con el email y contraseña del wizard
3. **Cambiar la contraseña** (el sistema lo solicitará — `must_change_password=true`)

### Primer kiosco

1. Panel admin → **Kioscos → Nuevo kiosco**
2. Dar nombre (ej. `Recepción Principal`) y ubicación
3. **Copiar el token** que aparece (solo se muestra una vez)
4. En la tablet del kiosco, abrir: `https://kiosco.tuClinica.com/?kiosk_token=<token>`

### Standby con video y sonido (Chromium kiosk)

El panel admin permite activar "Video con sonido" en la pantalla de standby
(Configuración → Pantalla de espera → modo Video). Para que el navegador del
kiosco reproduzca audio sin requerir un toque del usuario, **Chromium debe
lanzarse con la política de autoplay relajada**:

```bash
chromium-browser \
  --kiosk \
  --autoplay-policy=no-user-gesture-required \
  https://kiosco.tuClinica.com/?kiosk_token=<token>
```

Notas:
- **No** pasar `--mute-audio`; anula el toggle.
- Si la flag no está presente, el kiosco aplica un fallback seguro: vuelve a
  silenciar el video automáticamente en lugar de romper la pantalla.
- Default del toggle en BD: `false` (sin sonido). Audio sorpresa = mala UX.

---

## 7. Activar / desactivar OTP en producción

El código de verificación (OTP) controla si el paciente debe ingresar un código de 6 dígitos recibido por SMS o email, o si puede autenticarse solo con cédula + número de teléfono.

### Ver estado actual

```bash
grep '^OTP_REQUIRED=' /opt/dentalkiosco/.env
```

### Deshabilitar OTP (login con cédula + teléfono)

```bash
# En el servidor, como root
cd /opt/dentalkiosco
sed -i 's/^OTP_REQUIRED=.*/OTP_REQUIRED=false/' .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
```

Espera ~20 segundos y verifica:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
# api debe volver a (healthy)
```

### Habilitar OTP (recomendado en producción)

```bash
cd /opt/dentalkiosco
sed -i 's/^OTP_REQUIRED=.*/OTP_REQUIRED=true/' .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
```

### Cuándo usar cada modo

| Escenario | OTP_REQUIRED |
|-----------|-------------|
| Producción normal (seguridad máxima) | `true` |
| Demo o capacitación al personal | `false` |
| Pacientes sin teléfono registrado en Dentalink | `false` |
| Pruebas de usabilidad sin SMS/email | `false` |

> Con `OTP_REQUIRED=false`, el sistema valida que el número de teléfono coincida exactamente con el registrado en Dentalink (incluido el prefijo `+57`). No es acceso sin restricción.

---

## 8. Hacer cambios en el frontend

Los frontends son archivos estáticos servidos por Caddy desde bind-mounts de Docker. Caddy los sirve directamente del disco, sin reinicio.

### Flujo para cambiar el kiosco o el admin

```bash
# 1. Editar los archivos fuente en tu máquina local
#    apps/kiosco-frontend/src/   ← kiosco
#    apps/admin-frontend/src/    ← panel admin

# 2. Subir cambios al servidor (si trabajas desde tu máquina local)
git add -A && git commit -m "feat: descripción del cambio"
git push origin hito10

# 3. En el servidor, traer los cambios
cd /opt/dentalkiosco
git pull origin hito10

# 4. Recompilar el frontend que cambiaste
pnpm --filter @dentalkiosco/kiosco-frontend build   # ← kiosco
pnpm --filter @dentalkiosco/admin-frontend build    # ← admin (o ambos)

# 5. Caddy ya sirve los archivos nuevos — no necesita reiniciarse
#    Prueba en el navegador con Ctrl+Shift+R (hard reload)
```

> **No hace falta reiniciar Caddy ni Docker** para cambios en el frontend. El bind-mount hace que Caddy sirva directamente los archivos del disco.

### Cambios de CSS o imágenes (branding)

Las imágenes y estilos están en `apps/kiosco-frontend/src/` y `apps/admin-frontend/src/`. Misma secuencia: editar → build → automático.

### Agregar una pantalla nueva al kiosco

1. Crear `apps/kiosco-frontend/src/screens/mi-pantalla.js`
2. Exportar la función `render()` como `default`
3. Registrar en `apps/kiosco-frontend/src/router.js`
4. Build → automático en prod

---

## 9. Hacer cambios en el backend

El backend (API) corre como imagen Docker compilada. Requiere reconstruir la imagen.

### Flujo

```bash
# 1. Editar archivos en apps/api/src/

# 2. Subir al servidor
git pull origin hito10

# 3. Reconstruir la imagen de la API
cd /opt/dentalkiosco
docker compose -f docker-compose.yml -f docker-compose.prod.yml build api

# 4. Reiniciar la API con la nueva imagen
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api

# 5. Verificar que volvió a healthy
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

### Agregar una migración SQL

```bash
# 1. Crear apps/api/migrations/012_descripcion.sql (localmente)
# 2. Terminarla con INSERT INTO schema_migrations ON CONFLICT DO NOTHING
# 3. Subir al servidor y reconstruir la imagen
git pull origin hito10
docker compose -f docker-compose.yml -f docker-compose.prod.yml build api

# 4. Aplicar la migración (sin bajar el servicio)
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api \
  node dist/migrate.js up

# 5. Reiniciar la API
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
```

> **Nunca modifiques una migración ya aplicada.** El runner verifica checksums y falla si detecta cambios.

---

## 10. Actualizaciones automáticas

El installer configura un cron que corre cada noche a las 03:00 UTC:

```bash
crontab -l | grep dk-update
# 0 3 * * * /opt/dentalkiosco/updater/update.sh >> /var/log/dk-update.log 2>&1  # dk-update
```

### Ver el log de actualizaciones

```bash
tail -50 /var/log/dk-update.log
```

### Aprobar una actualización de versión mayor

El script bloquea actualizaciones mayores (ej. 3.x → 4.x) hasta que el administrador las apruebe:

```bash
# Revisar qué versión nueva está disponible
tail -20 /var/log/dk-update.log | grep "major"

# Aprobar la actualización
touch /opt/dentalkiosco/.approved-update

# La próxima ejecución del cron (o manual) procederá
bash /opt/dentalkiosco/updater/update.sh
```

### Ejecutar una actualización manualmente

```bash
bash /opt/dentalkiosco/updater/update.sh

# En modo simulación (sin aplicar cambios):
bash /opt/dentalkiosco/updater/update.sh --dry-run
```

---

## 11. Operaciones de mantenimiento

### Ver logs de los servicios

```bash
cd /opt/dentalkiosco

# Todos los servicios en tiempo real
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f

# Solo la API
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api

# Solo Caddy (accesos HTTP)
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f caddy

# Filtrar errores
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs api | grep -i "error\|fatal"
```

### Backup manual de la base de datos

```bash
cd /opt/dentalkiosco
source .env

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -h localhost -p 5432 \
  -U "$POSTGRES_USER" \
  "$POSTGRES_DB" \
  | gzip > /opt/backups/manual-$(date +%Y%m%d-%H%M%S).sql.gz

echo "Backup guardado en /opt/backups/"
ls -lh /opt/backups/*.sql.gz | tail -5
```

> El update manager también hace backups automáticos antes de cada actualización (retiene los últimos 7).

### Restaurar un backup

```bash
# ⚠ BORRA la base de datos actual — asegúrate de tener el backup correcto
cd /opt/dentalkiosco
source .env

docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api

PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h localhost -p 5432 \
  -U "$POSTGRES_USER" \
  -c "DROP DATABASE $POSTGRES_DB; CREATE DATABASE $POSTGRES_DB;"

zcat /opt/backups/manual-YYYYMMDD-HHMMSS.sql.gz \
  | PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h localhost -p 5432 \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB"

docker compose -f docker-compose.yml -f docker-compose.prod.yml start api
```

### Crear un admin adicional

```bash
cd /opt/dentalkiosco
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api \
  node dist/setup.js create-admin \
  --email nuevo@clinicasur.com \
  --password "NuevaContraseña@2026" \
  --name "Nombre Apellido"
```

Idempotente: si el email ya existe, no hace nada.

### Cambiar la contraseña de un admin desde la base de datos

```bash
# Generar hash de la nueva contraseña
cd /opt/dentalkiosco
NEW_HASH=$(docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api \
  node -e "
  import('argon2').then(a => a.default.hash('NuevaContraseña@2026', {
    type: 2, memoryCost: 65536, timeCost: 3, parallelism: 4
  })).then(h => { console.log(h); process.exit(0); });
  ")

source .env
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "UPDATE admins SET password_hash='$NEW_HASH', must_change_password=false WHERE email='admin@tuClinica.com';"
```

### Revocar un kiosco

```bash
# Desde el panel admin: Kioscos → toggle desactivar
# O directamente en DB:
source .env
PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "UPDATE kiosks SET is_active=false, revoked_at=now(), revoked_reason='fuera de servicio' WHERE name='Recepción Principal';"
```

### Reiniciar el stack completo

```bash
cd /opt/dentalkiosco
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

### Reiniciar solo un servicio

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart api
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart caddy
```

---

## 12. Resolución de problemas comunes

### El instalador falla en la fase TLS

**Síntoma:** "TLS no respondió en 120s"
**Causas:**
- DNS aún no propagó → esperar y re-ejecutar el installer (es idempotente)
- Los puertos 80/443 están bloqueados en el VPS → verificar UFW y firewall de Hetzner

```bash
# Verificar UFW
ufw status

# Verificar que Caddy está escuchando
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy | tail -20
```

### La API no arranca (status=starting o unhealthy)

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs api | tail -50
```

Causas frecuentes:
- `.env` malformado: busca variables requeridas sin valor (`POSTGRES_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`)
- Postgres no arrancó todavía: esperar 30 segundos más
- Error de migración: revisar logs con `grep -i migration`

### El certificado TLS caducó o es inválido

Caddy renueva automáticamente los certificados de Let's Encrypt. Si hay problemas:

```bash
# Ver logs de Caddy
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy | grep -i "tls\|cert\|acme"

# Forzar renovación (reiniciar Caddy)
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart caddy
```

### El kiosco dice "Token inválido"

El `kiosk_token` venció o fue revocado. Solución:
1. Panel admin → **Kioscos → Revocar** el kiosco actual
2. **Kioscos → Nuevo kiosco** → obtener nuevo token
3. Abrir el kiosco con el nuevo token en la URL

### El OTP no llega al paciente

Verificar en el log de la API:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs api | grep -i "otp\|resend\|twilio\|MOCK"
```

Acciones:
- Verificar que `RESEND_API_KEY` y `RESEND_FROM_EMAIL` están correctos en `.env`
- Verificar en el dashboard de Resend si el email fue enviado
- Si usas SMS: verificar `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- Como alternativa temporal: `OTP_REQUIRED=false` para que el paciente entre solo con cédula + teléfono

### El sistema dice "Licencia restringida" o "Licencia expirada"

```bash
# Ver estado de licencia en Redis
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api \
  node -e "
  import('./dist/lib/redis.js').then(r => 
    r.redis.get('license:state').then(v => { console.log(JSON.parse(v)); process.exit(0); })
  )
  "
```

Acciones:
- Verificar conectividad al servidor de licencias: `curl https://license.allcreative.app/health`
- Renovar la licencia con el proveedor
- En emergencia temporal: `LICENSE_DEV_MODE=true` en `.env` + `docker compose restart api` (desactiva toda verificación de licencia — solo usar mientras se resuelve)

### Disco lleno

```bash
df -h
du -sh /opt/dentalkiosco/apps/api/uploads/*   # uploads de standby y fotos
du -sh /opt/backups/                           # backups automáticos

# Limpiar backups antiguos (el update manager retiene 7)
ls -lt /opt/backups/*.sql.gz | tail -n +8 | awk '{print $NF}' | xargs rm -f
```
