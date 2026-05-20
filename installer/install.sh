#!/usr/bin/env bash
# =============================================================================
# DentalKiosco — Installer v1.0
# =============================================================================
#
# Instala DentalKiosco en un servidor Ubuntu 22.04 o 24.04 limpio.
# Debe ejecutarse como root desde la raíz del repositorio:
#
#   sudo bash installer/install.sh
#
# Idempotente: si encuentra .dk-installed no regenera secretos ni borra la DB.
#
# =============================================================================
# QUÉ SE PUEDE PROBAR LOCALMENTE vs. QUÉ REQUIERE UN VPS REAL
# =============================================================================
#
# ✅ PROBABLE LOCALMENTE (Ubuntu VM o el entorno de dev con ajustes):
#   - Fase 1: check_os / check_resources / check_internet (funciona si eres Ubuntu)
#   - Fase 5: wizard interactivo (toda la lógica de input/validación)
#   - Fase 6: generate_env (generación de secretos y formato del .env)
#   - setup.ts: create-admin contra la DB local de desarrollo
#
# ❌ REQUIERE VPS REAL (servidor limpio):
#   - Fase 3: instalación de Docker vía apt (no docker-in-docker fiable)
#   - Fase 4: UFW (necesita el kernel real, no rootless)
#   - Fase 7: build frontends (funciona si hay Node.js pero lento en CI)
#   - Fase 8: levantar stack completo + healthchecks Docker
#   - Fase 9: TLS Let's Encrypt (requiere dominio real con DNS apuntando al VPS)
#   - Fase 10: migraciones (requiere stack levantado)
#   - Fase 11: crear admin (requiere stack levantado)
#   - Fase 12: health check final (requiere HTTPS respondiendo)
#
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constantes y rutas
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${DK_INSTALL_DIR:-$REPO_DIR}"
MARKER_FILE="$INSTALL_DIR/.dk-installed"
ENV_FILE="$INSTALL_DIR/.env"
LOG_FILE="/var/log/dk-install.log"
COMPOSE_BASE="-f docker-compose.yml -f docker-compose.prod.yml"

# ---------------------------------------------------------------------------
# Output coloreado
# ---------------------------------------------------------------------------
RED='\033[0;31]'; GREEN='\033[0;32]'; YELLOW='\033[1;33]'
BLUE='\033[0;34]'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*" | tee -a "$LOG_FILE"; }
ok()      { echo -e "${GREEN}[ OK ]${NC}  $*" | tee -a "$LOG_FILE"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*" | tee -a "$LOG_FILE"; }
err()     { echo -e "${RED}[ERR ]${NC}  $*" | tee -a "$LOG_FILE" >&2; }
abort()   { err "$*"; exit 1; }
step()    { echo -e "\n${BOLD}━━━ $* ━━━${NC}" | tee -a "$LOG_FILE"; }

# ---------------------------------------------------------------------------
# Estado global (completado por wizard / .env existente)
# ---------------------------------------------------------------------------
FRESH_INSTALL=true
CLINIC_NAME=''
CLINIC_NIT=''
ADMIN_NAME=''
ADMIN_EMAIL=''
ADMIN_PASSWORD=''
DOMAIN=''
CADDY_EMAIL=''
DENTALINK_TOKEN=''
WOMPI_PUBLIC_KEY=''
WOMPI_PRIVATE_KEY=''
WOMPI_EVENTS_SECRET=''
WOMPI_INTEGRITY_SECRET=''
RESEND_API_KEY=''
RESEND_FROM_EMAIL=''
LICENSE_KEY=''

# ===========================================================================
# FASE 1 — Comprobaciones previas
# ===========================================================================
phase_preflight() {
  step "Fase 1 — Comprobaciones previas"

  # ── OS ──
  if [[ ! -f /etc/os-release ]]; then
    abort "No se puede detectar el sistema operativo."
  fi
  # shellcheck source=/dev/null
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    abort "Sistema operativo no compatible: ${ID:-desconocido}. Se requiere Ubuntu 22.04 o 24.04."
  fi
  if [[ "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
    abort "Versión Ubuntu no compatible: ${VERSION_ID:-?}. Se requiere 22.04 o 24.04."
  fi
  ok "Sistema operativo: Ubuntu $VERSION_ID ✓"

  # ── CPU ──
  local cpus
  cpus=$(nproc)
  if [[ $cpus -lt 2 ]]; then
    abort "CPU insuficientes: $cpus (mínimo 2)."
  fi
  ok "CPU: $cpus núcleos ✓"

  # ── RAM ──
  local ram_mb
  ram_mb=$(free -m | awk '/^Mem:/{print $2}')
  if [[ $ram_mb -lt 3800 ]]; then
    abort "RAM insuficiente: ${ram_mb}MB (mínimo 4GB / ~3800MB)."
  fi
  ok "RAM: ${ram_mb}MB ✓"

  # ── Disco ──
  local disk_gb
  disk_gb=$(df -BG "$INSTALL_DIR" | awk 'NR==2{gsub(/G/,""); print $4}')
  if [[ $disk_gb -lt 20 ]]; then
    abort "Espacio insuficiente en $INSTALL_DIR: ${disk_gb}GB libres (mínimo 20GB)."
  fi
  ok "Disco: ${disk_gb}GB disponibles ✓"

  # ── Internet ──
  if ! curl -sf --max-time 5 https://1.1.1.1 > /dev/null 2>&1; then
    abort "Sin conexión a Internet. Verifica la red antes de continuar."
  fi
  ok "Conexión a Internet ✓"

  # ── Idempotencia ──
  if [[ -f "$MARKER_FILE" ]]; then
    FRESH_INSTALL=false
    warn "Instalación existente detectada ($(cat "$MARKER_FILE"))"
    warn "Modo re-ejecución: secretos y DB preservados."
    if [[ -f "$ENV_FILE" ]]; then
      set -a; source "$ENV_FILE"; set +a
      DOMAIN="${CADDY_DOMAIN:-$DOMAIN}"
    fi
  else
    info "Instalación nueva en: $INSTALL_DIR"
  fi
}

# ===========================================================================
# FASE 2 — Validar licencia
# ===========================================================================
phase_license() {
  step "Fase 2 — Validación de licencia"

  # Reutilizar del .env si ya estaba configurada
  if [[ -z "$LICENSE_KEY" || "$LICENSE_KEY" == "DEV-LOCAL-NOLICENSE-LOCAL" ]]; then
    echo
    echo "  Clave de licencia DentalKiosco"
    echo "  Formato: DK-XXXXXXXX-XXXXXXXX-XXXXXXXX"
    echo "  (La proporcionó el proveedor junto con la compra)"
    echo
    read -rp "  Clave de licencia: " LICENSE_KEY
    LICENSE_KEY="${LICENSE_KEY//[[:space:]]/}"
    [[ -n "$LICENSE_KEY" ]] || abort "Clave de licencia requerida."
  else
    info "LICENSE_KEY cargada del .env existente: ${LICENSE_KEY:0:14}..."
  fi

  local server_url="${LICENSE_SERVER_URL:-https://license.allcreative.app}"
  info "Validando contra $server_url ..."

  local response http_code
  response=$(curl -sf --max-time 15 \
    -w '\n%{http_code}' \
    -X POST "$server_url/licenses/validate" \
    -H "Content-Type: application/json" \
    -H "X-License-Key: $LICENSE_KEY" \
    -d '{"installation_id":"installer"}' 2>&1) \
    || abort "No se pudo contactar el servidor de licencias. Verifica la conexión a Internet."

  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | head -n -1)

  if [[ "$http_code" != "200" ]]; then
    local status
    status=$(echo "$body" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "desconocido")
    abort "Licencia rechazada (HTTP $http_code, status=$status). Contacta al proveedor."
  fi

  local valid
  valid=$(echo "$body" | grep -o '"valid":[^,}]*' | cut -d: -f2 | tr -d ' "')
  if [[ "$valid" != "true" ]]; then
    abort "Licencia inválida. Verifica la clave o contacta al proveedor."
  fi

  local lic_clinic
  lic_clinic=$(echo "$body" | grep -o '"clinic_name":"[^"]*"' | cut -d'"' -f4 || echo "")
  ok "Licencia válida ✓${lic_clinic:+  Clínica: $lic_clinic}"
}

# ===========================================================================
# FASE 3 — Dependencias del sistema
# ===========================================================================
phase_dependencies() {
  step "Fase 3 — Dependencias del sistema"

  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq

  # ── Docker Engine ──
  if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    ok "Docker ya instalado: $(docker --version | cut -d' ' -f3 | tr -d ',')"
  else
    info "Instalando Docker Engine (repo oficial)..."
    apt-get install -y -qq ca-certificates curl gnupg lsb-release
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable --now docker
    ok "Docker instalado: $(docker --version | cut -d' ' -f3 | tr -d ',')"
  fi

  # ── Node.js 22 LTS (para build de frontends) ──
  local node_ok=false
  if command -v node &>/dev/null; then
    local node_major
    node_major=$(node -e "console.log(process.version.split('.')[0].slice(1))" 2>/dev/null || echo 0)
    [[ $node_major -ge 22 ]] && node_ok=true
  fi
  if $node_ok; then
    ok "Node.js ya instalado: $(node --version)"
  else
    info "Instalando Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs
    ok "Node.js instalado: $(node --version)"
  fi

  # ── pnpm ──
  if command -v pnpm &>/dev/null; then
    ok "pnpm ya instalado: v$(pnpm --version)"
  else
    info "Instalando pnpm..."
    corepack enable
    corepack prepare pnpm@latest --activate
    ok "pnpm instalado: v$(pnpm --version)"
  fi

  # ── Fail2ban (protección SSH fuerza bruta) ──
  if systemctl is-active fail2ban &>/dev/null 2>&1; then
    ok "Fail2ban ya activo ✓"
  else
    info "Instalando fail2ban..."
    apt-get install -y -qq fail2ban
    systemctl enable --now fail2ban
    ok "Fail2ban instalado y activo ✓"
  fi

  # ── WireGuard (cliente VPN) ──
  if command -v wg &>/dev/null; then
    ok "WireGuard ya instalado ✓"
  else
    info "Instalando wireguard-tools..."
    apt-get install -y -qq wireguard-tools
    ok "WireGuard instalado ✓ (configura el túnel en /etc/wireguard/wg0.conf)"
  fi
}

# ===========================================================================
# FASE 4 — Cortafuegos (UFW)
# ===========================================================================
phase_firewall() {
  step "Fase 4 — Cortafuegos (UFW)"

  if ! command -v ufw &>/dev/null; then
    apt-get install -y -qq ufw
  fi

  # Reset limpio (en re-ejecución: mantiene el estado si ya estaba bien)
  ufw --force reset > /dev/null 2>&1

  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp  comment 'SSH'
  ufw allow 80/tcp  comment 'HTTP → redirección HTTPS Caddy'
  ufw allow 443/tcp comment 'HTTPS'
  ufw --force enable

  ok "UFW: deny-all entrante · permitido: 22 (SSH), 80 (HTTP), 443 (HTTPS) ✓"
}

# ===========================================================================
# FASE 5 — Asistente interactivo (datos de la clínica)
# ===========================================================================
phase_wizard() {
  step "Fase 5 — Datos de la clínica"

  if [[ "$FRESH_INSTALL" == "false" ]]; then
    info "Instalación existente — wizard omitido. Actualiza datos desde el panel admin."
    return
  fi

  echo
  echo "  Completa los datos de la clínica. Los secretos se generan automáticamente."
  echo

  _ask_required() {
    local var=$1; local prompt=$2
    local val=''
    while [[ -z "$val" ]]; do
      read -rp "  $prompt: " val
      [[ -z "$val" ]] && echo "  (requerido)"
    done
    printf -v "$var" '%s' "$val"
  }

  _ask_email() {
    local var=$1; local prompt=$2
    local val=''
    while true; do
      read -rp "  $prompt: " val
      [[ "$val" =~ ^[^@]+@[^@]+\.[^@]+$ ]] && break
      echo "  Email inválido — intenta de nuevo."
    done
    printf -v "$var" '%s' "$val"
  }

  _ask_domain() {
    local val=''
    while true; do
      read -rp "  Dominio público (ej. kiosco.clinica.com, sin https://): " val
      [[ "$val" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] && break
      echo "  Formato inválido — solo letras, números, guiones y puntos."
    done
    DOMAIN="$val"
  }

  _ask_password() {
    local p1 p2
    while true; do
      read -srp "  Contraseña admin (mín. 12 chars, mayúsc., dígito, símbolo): " p1; echo
      if [[ ${#p1} -lt 12 ]]; then echo "  Mínimo 12 caracteres."; continue; fi
      if ! [[ "$p1" =~ [A-Z] ]]; then echo "  Se necesita al menos una mayúscula."; continue; fi
      if ! [[ "$p1" =~ [0-9] ]]; then echo "  Se necesita al menos un dígito."; continue; fi
      if ! [[ "$p1" =~ [^a-zA-Z0-9] ]]; then echo "  Se necesita al menos un símbolo especial."; continue; fi
      read -srp "  Confirmar contraseña: " p2; echo
      [[ "$p1" == "$p2" ]] && break
      echo "  Las contraseñas no coinciden."
    done
    ADMIN_PASSWORD="$p1"
  }

  _ask_optional() {
    local var=$1; local prompt=$2
    read -rp "  $prompt [Enter para configurar después]: " "$var" || true
  }

  _ask_required CLINIC_NAME "Nombre legal de la clínica"
  _ask_required CLINIC_NIT  "NIT o identificación tributaria"
  _ask_required ADMIN_NAME  "Nombre completo del administrador"
  _ask_email    ADMIN_EMAIL "Email del administrador"
  _ask_password
  _ask_domain

  CADDY_EMAIL="$ADMIN_EMAIL"
  local _tmp_email=''
  read -rp "  Email para certificado TLS/Let's Encrypt [$ADMIN_EMAIL]: " _tmp_email || true
  [[ -n "$_tmp_email" ]] && CADDY_EMAIL="$_tmp_email"

  echo
  echo "  ── Integraciones externas (opcionales) ──"
  echo "  Presiona Enter para configurarlas después desde el panel admin."
  echo

  _ask_optional DENTALINK_TOKEN        "Token API Dentalink"

  echo "  Wompi (pagos):"
  _ask_optional WOMPI_PUBLIC_KEY       "  Wompi Public Key"
  if [[ -n "$WOMPI_PUBLIC_KEY" ]]; then
    _ask_optional WOMPI_PRIVATE_KEY      "  Wompi Private Key"
    _ask_optional WOMPI_EVENTS_SECRET    "  Wompi Events Secret"
    _ask_optional WOMPI_INTEGRITY_SECRET "  Wompi Integrity Secret"
  fi

  echo "  Notificaciones email (Resend):"
  _ask_optional RESEND_API_KEY    "  Resend API Key"
  _ask_optional RESEND_FROM_EMAIL "  Resend From Email"

  echo
  ok "Datos de la clínica recopilados ✓"
}

# ===========================================================================
# FASE 6 — Generar archivo .env
# ===========================================================================
phase_env() {
  step "Fase 6 — Archivo de variables de entorno"

  _gen_secret() { openssl rand -base64 48 | tr -d '/+=\n' | head -c 64; }
  _gen_pass()   { openssl rand -base64 32 | tr -d '/+=\n' | head -c 40; }

  if [[ "$FRESH_INSTALL" == "false" ]]; then
    info "Instalación existente — preservando secretos. Solo actualizo vars opcionales."
    _set_env() {
      local k=$1 v=$2
      [[ -z "$v" ]] && return
      if grep -q "^$k=" "$ENV_FILE" 2>/dev/null; then
        sed -i "s|^$k=.*|$k=$v|" "$ENV_FILE"
      else
        echo "$k=$v" >> "$ENV_FILE"
      fi
    }
    _set_env DENTALINK_TOKEN         "$DENTALINK_TOKEN"
    _set_env WOMPI_PUBLIC_KEY        "$WOMPI_PUBLIC_KEY"
    _set_env WOMPI_PRIVATE_KEY       "$WOMPI_PRIVATE_KEY"
    _set_env WOMPI_EVENTS_SECRET     "$WOMPI_EVENTS_SECRET"
    _set_env WOMPI_INTEGRITY_SECRET  "$WOMPI_INTEGRITY_SECRET"
    _set_env RESEND_API_KEY          "$RESEND_API_KEY"
    _set_env RESEND_FROM_EMAIL       "$RESEND_FROM_EMAIL"
    ok ".env actualizado ✓"
    return
  fi

  local inst_id
  inst_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen || openssl rand -hex 16)

  local pg_pass redis_pass jwt_secret enc_key
  pg_pass=$(_gen_pass)
  redis_pass=$(_gen_pass)
  jwt_secret=$(_gen_secret)
  enc_key=$(_gen_secret)

  cat > "$ENV_FILE" <<EOF
# DentalKiosco — Variables de entorno
# Generado: $(date -u +%Y-%m-%dT%H:%M:%SZ)  por installer v1.0
# NUNCA commitear este archivo. Permisos: 600.

# ── Identificación ──
NODE_ENV=production
APP_VERSION=3.0.0-alpha.1
INSTALLATION_ID=$inst_id
LICENSE_KEY=$LICENSE_KEY

# ── Servidor API ──
API_PORT=3000
PUBLIC_BASE_URL=https://$DOMAIN

# ── PostgreSQL ──
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=dentalkiosco
POSTGRES_USER=dentalkiosco
POSTGRES_PASSWORD=$pg_pass

# ── Redis ──
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=$redis_pass

# ── Seguridad ──
JWT_SECRET=$jwt_secret
ENCRYPTION_KEY=$enc_key

# ── Caddy / TLS ──
CADDY_DOMAIN=$DOMAIN
CADDY_EMAIL=$CADDY_EMAIL
HTTP_PORT=80
HTTPS_PORT=443

# ── Licencia ──
LICENSE_DEV_MODE=false
LICENSE_SERVER_URL=https://license.allcreative.app
LICENSE_HEARTBEAT_INTERVAL_HOURS=6
LICENSE_GRACE_PERIOD_DAYS=7
LICENSE_SHUTDOWN_PERIOD_DAYS=14

# ── Funcionalidades ──
OTP_REQUIRED=true
DEV_MOCK_EXTERNAL_SERVICES=false
DEV_MOCK_WOMPI=false
DEV_LOG_OTP=false

# ── Dentalink (agenda clínica) ──
DENTALINK_TOKEN=${DENTALINK_TOKEN:-}
DENTALINK_API_URL=https://api.dentalink.healthatom.com

# ── Wompi (pagos) ──
WOMPI_PUBLIC_KEY=${WOMPI_PUBLIC_KEY:-}
WOMPI_PRIVATE_KEY=${WOMPI_PRIVATE_KEY:-}
WOMPI_EVENTS_SECRET=${WOMPI_EVENTS_SECRET:-}
WOMPI_INTEGRITY_SECRET=${WOMPI_INTEGRITY_SECRET:-}
WOMPI_API_URL=https://production.wompi.co/v1

# ── Notificaciones ──
RESEND_API_KEY=${RESEND_API_KEY:-}
RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL:-}

# ── Uploads ──
UPLOADS_DIR=./uploads
UPLOADS_MAX_BYTES=52428800

# ── Update Manager ──
UPDATE_SERVER_URL=https://updates.allcreative.app
ADMIN_EMAIL=$ADMIN_EMAIL
EOF

  chmod 600 "$ENV_FILE"
  ok ".env generado con secretos criptográficos (chmod 600) ✓"
  ok "  POSTGRES_PASSWORD: ${pg_pass:0:8}..."
  ok "  JWT_SECRET:        ${jwt_secret:0:8}..."
}

# ===========================================================================
# FASE 7 — Build de frontends
# ===========================================================================
phase_build() {
  step "Fase 7 — Compilación de frontends"

  cd "$INSTALL_DIR"

  # Crear directorio uploads si no existe
  mkdir -p apps/api/uploads

  info "Instalando dependencias npm (puede tardar ~2 min la primera vez)..."
  pnpm install --frozen-lockfile 2>&1 | tail -3

  info "Build kiosco-frontend..."
  pnpm --filter @dentalkiosco/kiosco-frontend build 2>&1 | tail -3
  [[ -d "apps/kiosco-frontend/dist" ]] || abort "Build kiosco-frontend falló — revisa los logs."
  ok "kiosco-frontend compilado ✓  ($(du -sh apps/kiosco-frontend/dist | cut -f1))"

  info "Build admin-frontend..."
  pnpm --filter @dentalkiosco/admin-frontend build 2>&1 | tail -3
  [[ -d "apps/admin-frontend/dist" ]] || abort "Build admin-frontend falló — revisa los logs."
  ok "admin-frontend compilado ✓  ($(du -sh apps/admin-frontend/dist | cut -f1))"
}

# ===========================================================================
# FASE 8 — Levantar el stack Docker
# ===========================================================================
phase_start_stack() {
  step "Fase 8 — Stack Docker"

  cd "$INSTALL_DIR"

  info "Construyendo imagen API (puede tardar ~3 min la primera vez)..."
  # shellcheck disable=SC2086
  docker compose $COMPOSE_BASE build api 2>&1 | tail -5

  info "Iniciando todos los servicios..."
  # shellcheck disable=SC2086
  docker compose $COMPOSE_BASE up -d

  info "Esperando que todos los contenedores estén healthy (máx. 120s)..."
  local attempt=0
  local max=24
  while [[ $attempt -lt $max ]]; do
    # Cuenta contenedores que no están en estado healthy o running
    local not_ready
    not_ready=$(docker compose ps --format '{{.Status}}' 2>/dev/null \
      | grep -cv -E 'healthy|running' || echo 0)
    if [[ "$not_ready" -eq 0 ]]; then
      ok "Todos los contenedores healthy ✓"
      return
    fi
    sleep 5
    (( attempt++ )) || true
    echo -n "."
  done

  echo
  err "Timeout esperando healthchecks. Estado actual:"
  # shellcheck disable=SC2086
  docker compose $COMPOSE_BASE ps
  abort "Verifica los logs con: docker compose logs"
}

# ===========================================================================
# FASE 9 — Esperar aprovisionamiento TLS
# ===========================================================================
phase_tls() {
  step "Fase 9 — Certificado TLS (Let's Encrypt)"

  local my_ip
  my_ip=$(curl -sf --max-time 5 https://ifconfig.me 2>/dev/null \
         || hostname -I | awk '{print $1}')

  info "Dominio configurado: $DOMAIN"
  info "IP pública de este servidor: $my_ip"
  echo
  echo "  Asegúrate de que el registro DNS A de $DOMAIN"
  echo "  apunte a $my_ip antes de continuar."
  echo "  Caddy solicitará el certificado automáticamente."
  echo

  info "Esperando HTTPS (máx. 120s)..."
  local attempt=0
  local max=24
  while [[ $attempt -lt $max ]]; do
    if curl -sf --max-time 5 "https://$DOMAIN/health" > /dev/null 2>&1; then
      ok "HTTPS respondiendo en https://$DOMAIN ✓"
      return
    fi
    sleep 5
    (( attempt++ )) || true
    echo -n "."
  done

  echo
  warn "TLS no respondió en 120s. Posibles causas:"
  warn "  • El registro DNS aún no propagó (puede tardar hasta 48h en algunos registradores)"
  warn "  • Los puertos 80 o 443 no son accesibles desde Internet"
  warn "  • Rate limit de Let's Encrypt (máx. 5 certificados por dominio por semana)"
  warn "Continuando sin verificar TLS. Re-ejecuta el installer cuando el DNS propague."
}

# ===========================================================================
# FASE 10 — Migraciones de base de datos
# ===========================================================================
phase_migrations() {
  step "Fase 10 — Migraciones de base de datos"

  cd "$INSTALL_DIR"

  info "Aplicando migraciones SQL..."
  # shellcheck disable=SC2086
  if docker compose $COMPOSE_BASE exec -T api node dist/migrate.js up; then
    ok "Migraciones aplicadas ✓"
  else
    abort "Las migraciones fallaron. Revisa: docker compose logs api"
  fi
}

# ===========================================================================
# FASE 11 — Crear cuenta de administrador inicial
# ===========================================================================
phase_create_admin() {
  step "Fase 11 — Administrador inicial"

  cd "$INSTALL_DIR"

  if [[ "$FRESH_INSTALL" == "false" ]]; then
    info "Instalación existente — omitiendo creación de admin."
    return
  fi

  info "Creando cuenta admin: $ADMIN_EMAIL ..."
  # shellcheck disable=SC2086
  if docker compose $COMPOSE_BASE exec -T api node dist/setup.js create-admin \
      --email "$ADMIN_EMAIL" \
      --password "$ADMIN_PASSWORD" \
      --name "$ADMIN_NAME"; then
    ok "Admin creado ✓"
  else
    abort "No se pudo crear el admin. Revisa: docker compose logs api"
  fi
}

# ===========================================================================
# FASE 12 — Health check final y reporte
# ===========================================================================
phase_report() {
  step "Fase 12 — Verificación final"

  local base_url="https://$DOMAIN"

  # Health check
  local health_status='desconocido'
  local health_json
  health_json=$(curl -sf --max-time 10 "$base_url/health/ready" 2>/dev/null || echo '{}')
  health_status=$(echo "$health_json" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "desconocido")

  if [[ "$health_status" == "ready" ]]; then
    ok "Sistema healthy (status=ready) ✓"
  else
    warn "Health check respondió: status=$health_status (puede ser normal si TLS aún no propagó)"
  fi

  # ── Instalar cron del updater ──
  local cron_entry="0 3 * * * $INSTALL_DIR/updater/update.sh >> /var/log/dk-update.log 2>&1  # dk-update"
  if crontab -l 2>/dev/null | grep -q "dk-update"; then
    ok "Cron de actualizaciones automáticas ya instalado ✓"
  else
    (crontab -l 2>/dev/null; echo "$cron_entry") | crontab -
    ok "Cron de actualizaciones instalado (03:00 UTC diario) ✓"
  fi

  # ── Marcar instalación completa ──
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER_FILE"

  # ── Reporte final ──
  echo
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  ✓  DentalKiosco instalado correctamente${NC}"
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo
  echo "  Acceso kiosco:   $base_url"
  echo "  Panel admin:     $base_url/admin"
  echo "  Usuario admin:   $ADMIN_EMAIL"
  if [[ "$FRESH_INSTALL" == "true" ]]; then
    echo "  Contraseña:      $ADMIN_PASSWORD"
    echo
    echo -e "${YELLOW}  ⚠  Guarda esta contraseña ahora — no se volverá a mostrar.${NC}"
    echo -e "${YELLOW}     Se te pedirá cambiarla en el primer inicio de sesión.${NC}"
  fi
  echo
  echo "  Próximos pasos:"
  echo "   1. Inicia sesión en el panel y cambia la contraseña"
  echo "   2. Configura Dentalink: Panel → Configuración → Integraciones"
  echo "   3. Configura Wompi si usas cobros: Panel → Configuración → Pagos"
  echo "   4. Activa el primer kiosco: Panel → Kioscos → Nuevo kiosco"
  echo "   5. (Opcional) Configura el túnel VPN: /etc/wireguard/wg0.conf"
  echo
  echo "  Directorio de instalación:  $INSTALL_DIR"
  echo "  Variables de entorno:        $ENV_FILE"
  echo "  Log de instalación:          $LOG_FILE"
  echo "  Log de actualizaciones:      /var/log/dk-update.log"
  echo
}

# ===========================================================================
# main
# ===========================================================================
main() {
  # Debe ejecutarse como root
  if [[ $EUID -ne 0 ]]; then
    abort "El installer debe ejecutarse como root: sudo bash installer/install.sh"
  fi

  mkdir -p "$(dirname "$LOG_FILE")"
  echo "" >> "$LOG_FILE"
  echo "=== DentalKiosco Installer v1.0 — $(date -u) ===" >> "$LOG_FILE"

  echo
  echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}║         DentalKiosco — Installer v1.0                   ║${NC}"
  echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
  echo

  phase_preflight
  phase_license
  phase_wizard
  phase_env
  phase_dependencies
  phase_firewall
  phase_build
  phase_start_stack
  phase_tls
  phase_migrations
  phase_create_admin
  phase_report
}

main "$@"
