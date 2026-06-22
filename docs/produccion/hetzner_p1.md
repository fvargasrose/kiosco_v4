# Hetzner — Preparación P1 (pasos del usuario)

> Este archivo te guía en lo que **tú debes hacer manualmente** antes de
> que Antigravity ejecute el deploy. Cuando termines cada sección,
> dile "listo, sigue" y él toma el control.
>
> **Sobre privacidad:** Antigravity no se entrena con tus conversaciones.
> Lo que escribes aquí vive solo en tu disco local (`/home2/kiosko_v4/`).
> El archivo `deploy/prod.env` que crearás **nunca se commitea** (está en
> `.gitignore`). Antigravity lo lee una sola vez para usarlo, no lo guarda
> en ningún lado externo.

---

## PASO 1 — Crear el servidor en Hetzner Cloud

1. Entra a https://console.hetzner.cloud
2. Crea un nuevo proyecto (o usa uno existente).
3. Crea un servidor con estos valores:

   | Campo | Valor |
   |-------|-------|
   | **Tipo** | `CX22` (2 vCPU · 4 GB RAM) — suficiente para empezar |
   | **Sistema operativo** | Ubuntu 24.04 |
   | **Región** | La más cercana a ti (ej. Falkenstein o Ashburn) |
   | **SSH Key** | Ve al paso 2 primero, luego vuelve aquí y agrega la clave |
   | **Nombre** | `kiosko-prod` (o el que prefieras) |

4. Una vez creado, anota la IP pública. La necesitarás en el Paso 4.

---

## PASO 2 — Crear un par de claves SSH dedicado

En **tu terminal local** (no en el servidor), ejecuta:

```bash
ssh-keygen -t ed25519 -C "kiosko-prod" -f /home2/kiosko_v4/deploy/ssh_kiosko_prod
```

- Cuando pida passphrase: **déjala vacía** (presiona Enter dos veces).
- Esto crea dos archivos:
  - `deploy/ssh_kiosko_prod`       ← clave privada (Antigravity la usará)
  - `deploy/ssh_kiosko_prod.pub`   ← clave pública (tú la subes a Hetzner)

**Sube la clave pública a Hetzner:**
- En Hetzner Console → *SSH Keys* → *Add SSH Key*
- Pega el contenido de `deploy/ssh_kiosko_prod.pub`
- Asigna esa clave al servidor al crearlo (Paso 1).

> ⚠️ `deploy/` ya está en `.gitignore`. Nunca se subirá al repositorio.

---

## PASO 3 — Configurar Cloudflare

### 3a. Dominio y DNS

1. Tienes que tener un dominio apuntando a Cloudflare (si no tienes,
   puedes comprar uno barato en Namecheap/Porkbun y transferir los NS).
2. Decide el subdominio que usarás, por ejemplo:
   - `kiosko.tudominio.com`  (para el paciente)
3. **NO crees el registro A todavía** — Antigravity lo creará con la IP
   real del servidor cuando el deploy esté listo.
4. Anota el **Zone ID** de tu dominio en Cloudflare:
   - Cloudflare Dashboard → elige el dominio → panel derecho → *Zone ID*

### 3b. API Token de Cloudflare

1. Ve a https://dash.cloudflare.com/profile/api-tokens
2. Crea un token con permisos:
   - `Zone → DNS → Edit` para tu dominio
3. Copia el token. Lo pondrás en el archivo del Paso 4.

### 3c. Cloudflare Turnstile (protección del formulario OTP)

1. Ve a Cloudflare Dashboard → **Turnstile** → *Add site*
2. Nombre: `kiosko-prod`
3. Dominio: el que elegiste (ej. `kiosko.tudominio.com`)
4. Widget type: **Managed**
5. Copia:
   - `Site Key` (pública, va en el frontend)
   - `Secret Key` (privada, va en el backend)

---

## PASO 4 — Crear el archivo de credenciales de producción

Crea el archivo `/home2/kiosko_v4/deploy/prod.env` con el siguiente
contenido, rellenando **solo los valores que ya tienes**. Los que no
tengas déjalos vacíos — Antigravity generará los que puede automáticamente.

```bash
# ── Servidor ─────────────────────────────────────────────
SERVER_IP=                        # IP pública del servidor Hetzner
SSH_KEY_PATH=deploy/ssh_kiosko_prod

# ── Dominio ──────────────────────────────────────────────
CADDY_DOMAIN=                     # ej: kiosko.tudominio.com
CADDY_EMAIL=                      # tu email (para Let's Encrypt)
PUBLIC_BASE_URL=                  # ej: https://kiosko.tudominio.com

# ── Cloudflare ───────────────────────────────────────────
CF_API_TOKEN=                     # token con Zone:DNS:Edit
CF_ZONE_ID=                       # Zone ID del dominio

# ── Turnstile ────────────────────────────────────────────
TURNSTILE_SITEKEY=                # Site Key (pública)
TURNSTILE_SECRET=                 # Secret Key (privada)

# ── Wompi (deja en blanco para seguir en sandbox/mock) ───
WOMPI_PUBLIC_KEY=
WOMPI_PRIVATE_KEY=
WOMPI_EVENTS_SECRET=
WOMPI_INTEGRITY_SECRET=
WOMPI_API_URL=https://sandbox.wompi.co/v1

# ── Twilio SMS (deja vacío para seguir mockeado) ─────────
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=

# ── Email notificaciones (ya tienes Resend configurado) ──
# Antigravity copia los valores del .env local actual.

# ── Secretos generados automáticamente por Antigravity ───
# (No los toques; él los genera y escribe aquí)
JWT_SECRET=
ENCRYPTION_KEY=
POSTGRES_PASSWORD=
REDIS_PASSWORD=
```

> ⚠️ Este archivo **nunca se sube a Git**. Solo existe en tu disco local.

---

## PASO 5 — Verificar conectividad SSH (opcional pero recomendado)

Cuando el servidor esté creado y la clave SSH subida, prueba conectarte:

```bash
ssh -i /home2/kiosko_v4/deploy/ssh_kiosko_prod root@<IP_DEL_SERVIDOR>
```

Si ves el prompt de Ubuntu, todo está listo. Escribe `exit` y dile a
Antigravity: **"todo listo, haz el deploy"**.

---

## Checklist antes de llamar a Antigravity

- [ ] Servidor Ubuntu 24.04 creado en Hetzner con la clave SSH
- [ ] Archivo `deploy/ssh_kiosko_prod` (clave privada) generado localmente
- [ ] Dominio con Cloudflare activo y Zone ID anotado
- [ ] API Token de Cloudflare creado
- [ ] Turnstile Site Key + Secret Key creados
- [ ] `deploy/prod.env` creado con los valores rellenados
- [ ] SSH manual probado (opcional)

Cuando todo esté marcado → dile **"todo listo, haz el deploy"**.
Antigravity hará el resto: instalar Docker, construir las imágenes,
configurar Caddy con HTTPS, crear el registro DNS y verificar que
el sistema responde por HTTPS.
