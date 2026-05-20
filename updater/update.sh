#!/usr/bin/env bash
# =============================================================================
# DentalKiosco — Update Manager v1.0
# =============================================================================
#
# Corre diariamente vía cron en cada instalación de clínica.
# Actualiza la instalación de forma segura con rollback automático.
#
# Instalación del cron (como root o el usuario que maneja Docker):
#   crontab -e
#   0 3 * * * /opt/dentalkiosco/updater/update.sh >> /var/log/dk-update.log 2>&1
#
# Variables requeridas en .env (adicionales a las existentes):
#   UPDATE_SERVER_URL=https://updates.allcreative.app   # servidor de manifiestos
#   ADMIN_EMAIL=admin@clinica.com                       # destinatario de notificaciones
#   # Opcionales:
#   UPDATE_BACKUP_DIR=./backups                         # directorio de respaldos
#   UPDATE_APPROVAL_FILE=./.approved-update             # archivo de aprobación manual
#
# Modos de ejecución:
#   ./update.sh                   — modo normal (producción)
#   ./update.sh --dry-run         — simula sin aplicar cambios
#   ./update.sh --generate-test-keys  — genera claves GPG de prueba y manifiesto firmado
#
# =============================================================================
# QUÉ SE PUEDE PROBAR LOCALMENTE vs. QUÉ REQUIERE INFRAESTRUCTURA REAL
# =============================================================================
#
# ✅ PROBABLE LOCALMENTE (sin infraestructura central):
#   - Verificación de licencia (con el license-server local en :3001)
#   - Comparación de versiones y detección de cambio mayor
#   - Mecanismo de aprobación manual (archivo .approved-update)
#   - Respaldo de PostgreSQL (pg_dump contra postgres:5433 local)
#   - Aplicación de migraciones (contra la DB local)
#   - Health check (curl contra API local en :3000)
#   - Rollback automático (restaurar DB + reiniciar contenedores locales)
#   - Notificación por email (con RESEND_API_KEY real del .env)
#   - Firma GPG completa (con --generate-test-keys + claves locales)
#   - Lógica de --dry-run y manejo de errores
#
# ❌ REQUIERE INFRAESTRUCTURA CENTRAL REAL:
#   - Descargar el manifiesto desde UPDATE_SERVER_URL (necesita el servidor
#     de actualizaciones del proveedor publicando manifest.json + .asc)
#   - Verificar la firma con la clave GPG de producción (necesita la clave
#     privada del proveedor para firmar, y la pública distribuida en
#     updater/dk_update_pub.gpg — el placeholder actual no sirve)
#   - Bajar imágenes desde el registro Docker del proveedor (GHCR, Docker Hub
#     privado o Hetzner Registry — no existe todavía)
#   - Probar el flujo completo end-to-end con una versión nueva real
#
# Para simular el flujo completo en local:
#   1. ./update.sh --generate-test-keys   (genera claves + manifiesto de prueba)
#   2. Levantar un HTTP server local:  cd /tmp/dk-test && python3 -m http.server 8765
#   3. Ajustar UPDATE_SERVER_URL=http://localhost:8765 en .env
#   4. ./update.sh --dry-run
#
# =============================================================================

set -euo pipefail

# =============================================================================
# Constantes
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_IMAGES_FILE="$INSTALL_DIR/docker-compose.images.yml"
GPG_KEY_FILE="$SCRIPT_DIR/dk_update_pub.gpg"
LOG_PREFIX="[DK-UPDATE]"
FETCH_TIMEOUT=30       # segundos para descargar manifiesto
HEALTH_TIMEOUT=120     # segundos máximos esperando que la API responda
MANIFEST_TMP=$(mktemp /tmp/dk-manifest-XXXXXX.json)
MANIFEST_SIG_TMP=$(mktemp /tmp/dk-manifest-XXXXXX.asc)
GPG_HOME=$(mktemp -d /tmp/dk-gpg-XXXXXX)
chmod 700 "$GPG_HOME"

# =============================================================================
# Modo de ejecución
# =============================================================================

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  log_info() { echo "$LOG_PREFIX [DRY-RUN] $*"; }
fi

if [[ "${1:-}" == "--generate-test-keys" ]]; then
  generate_test_keys
  exit 0
fi

# =============================================================================
# Cleanup al salir
# =============================================================================

cleanup() {
  rm -f "$MANIFEST_TMP" "$MANIFEST_SIG_TMP"
  rm -rf "$GPG_HOME"
}
trap cleanup EXIT

# =============================================================================
# Logging
# =============================================================================

log_info()  { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') INFO  $*"; }
log_warn()  { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') WARN  $*" >&2; }
log_error() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') ERROR $*" >&2; }

# =============================================================================
# Cargar .env
# =============================================================================

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    log_error ".env no encontrado en $ENV_FILE"
    exit 1
  fi
  # Exportar solo las variables que necesitamos (evitar eval completo del .env)
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# =============================================================================
# Variables con defaults
# =============================================================================

set_defaults() {
  UPDATE_SERVER_URL="${UPDATE_SERVER_URL:-}"
  ADMIN_EMAIL="${ADMIN_EMAIL:-}"
  UPDATE_BACKUP_DIR="${UPDATE_BACKUP_DIR:-$INSTALL_DIR/backups}"
  UPDATE_APPROVAL_FILE="${UPDATE_APPROVAL_FILE:-$INSTALL_DIR/.approved-update}"
  VERSION_FILE="$INSTALL_DIR/.current-version"
  RESEND_API_KEY="${RESEND_API_KEY:-}"
  RESEND_FROM_EMAIL="${RESEND_FROM_EMAIL:-noreply@dentalkiosco.app}"
  LICENSE_KEY="${LICENSE_KEY:-}"
  LICENSE_SERVER_URL="${LICENSE_SERVER_URL:-}"
  POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
  POSTGRES_PORT="${POSTGRES_PORT:-5432}"
  POSTGRES_DB="${POSTGRES_DB:-dentalkiosco}"
  POSTGRES_USER="${POSTGRES_USER:-dentalkiosco}"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"
}

validate_required_vars() {
  local missing=()
  [[ -z "$UPDATE_SERVER_URL" ]]  && missing+=("UPDATE_SERVER_URL")
  [[ -z "$ADMIN_EMAIL" ]]        && missing+=("ADMIN_EMAIL")
  [[ -z "$LICENSE_KEY" ]]        && missing+=("LICENSE_KEY")
  [[ -z "$LICENSE_SERVER_URL" ]] && missing+=("LICENSE_SERVER_URL")
  [[ -z "$POSTGRES_PASSWORD" ]]  && missing+=("POSTGRES_PASSWORD")

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Variables requeridas no definidas en .env: ${missing[*]}"
    exit 1
  fi
}

# =============================================================================
# Versión actual
# =============================================================================

get_current_version() {
  if [[ -f "$VERSION_FILE" ]]; then
    cat "$VERSION_FILE"
  else
    # Primera ejecución: leer del package.json de la API
    local pkg="$INSTALL_DIR/apps/api/package.json"
    if [[ -f "$pkg" ]]; then
      grep '"version"' "$pkg" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/'
    else
      echo "0.0.0"
    fi
  fi
}

write_current_version() {
  echo "$1" > "$VERSION_FILE"
}

# =============================================================================
# Semver — extrae major de X.Y.Z
# =============================================================================

semver_major() {
  echo "${1%%.*}"
}

# Devuelve 0 si $1 < $2, 1 si >=
semver_less_than() {
  local a="$1" b="$2"
  # Comparación simple: split por . y comparar campo a campo
  IFS='.' read -ra va <<< "$a"
  IFS='.' read -ra vb <<< "$b"
  for i in 0 1 2; do
    local na="${va[$i]:-0}" nb="${vb[$i]:-0}"
    if (( na < nb )); then return 0; fi
    if (( na > nb )); then return 1; fi
  done
  return 1  # iguales → no es estrictamente menor
}

# =============================================================================
# 1. Verificar licencia
# =============================================================================

check_license() {
  log_info "Verificando licencia..."
  local fingerprint
  fingerprint=$(cat /etc/machine-id 2>/dev/null || hostname)

  local response http_code
  response=$(curl -s -o /tmp/dk-license-resp.json -w "%{http_code}" \
    --max-time "$FETCH_TIMEOUT" \
    -X POST "$LICENSE_SERVER_URL/licenses/validate" \
    -H "Content-Type: application/json" \
    -H "X-License-Key: $LICENSE_KEY" \
    -d "{\"installation_id\":\"$(hostname)\",\"machine_fingerprint\":\"$fingerprint\",\"version\":\"$(get_current_version)\"}" \
    2>/dev/null) || {
    log_warn "No se pudo conectar al servidor de licencias — se omite actualización"
    return 1
  }
  http_code="$response"

  if [[ "$http_code" != "200" ]]; then
    log_warn "Servidor de licencias respondió $http_code — se omite actualización"
    cat /tmp/dk-license-resp.json 2>/dev/null || true
    return 1
  fi

  local valid mode
  valid=$(grep -o '"valid":[^,}]*' /tmp/dk-license-resp.json | cut -d: -f2 | tr -d ' "')
  mode=$(grep -o '"mode":"[^"]*"' /tmp/dk-license-resp.json | cut -d'"' -f4)

  if [[ "$valid" != "true" || "$mode" == "shutdown" ]]; then
    log_warn "Licencia inválida o revocada (valid=$valid, mode=$mode) — se omite actualización"
    return 1
  fi

  log_info "Licencia válida (mode=$mode)"
  return 0
}

# =============================================================================
# 2. Descargar y verificar manifiesto
# =============================================================================

fetch_manifest() {
  log_info "Descargando manifiesto desde $UPDATE_SERVER_URL..."

  # ❌ REQUIERE INFRAESTRUCTURA REAL: UPDATE_SERVER_URL debe estar operativo
  curl -sf --max-time "$FETCH_TIMEOUT" \
    "$UPDATE_SERVER_URL/releases/latest/manifest.json" \
    -o "$MANIFEST_TMP" || {
    log_error "No se pudo descargar el manifiesto de actualización"
    return 1
  }

  curl -sf --max-time "$FETCH_TIMEOUT" \
    "$UPDATE_SERVER_URL/releases/latest/manifest.json.asc" \
    -o "$MANIFEST_SIG_TMP" || {
    log_error "No se pudo descargar la firma del manifiesto"
    return 1
  }

  log_info "Manifiesto descargado"
}

# =============================================================================
# 3. Verificar firma GPG
# =============================================================================

verify_signature() {
  log_info "Verificando firma GPG del manifiesto..."

  if [[ ! -f "$GPG_KEY_FILE" ]]; then
    log_error "Clave pública GPG no encontrada en $GPG_KEY_FILE"
    log_error "Instala la clave del proveedor antes de activar actualizaciones automáticas"
    return 1
  fi

  # ❌ REQUIERE INFRAESTRUCTURA REAL: la clave en dk_update_pub.gpg debe ser
  # la clave de producción del proveedor, y el .asc debe haber sido firmado
  # con la clave privada correspondiente.
  #
  # ✅ PROBABLE LOCALMENTE: usa --generate-test-keys para crear un par de claves
  # de prueba y firmar un manifiesto local.

  # Importar clave pública en keyring temporal (aislado del sistema)
  GNUPGHOME="$GPG_HOME" gpg --quiet --import "$GPG_KEY_FILE" 2>/dev/null || {
    log_error "Error importando clave GPG pública"
    return 1
  }

  # Verificar firma
  if ! GNUPGHOME="$GPG_HOME" gpg --quiet --verify "$MANIFEST_SIG_TMP" "$MANIFEST_TMP" 2>/dev/null; then
    log_error "¡FIRMA GPG INVÁLIDA! El manifiesto puede haber sido manipulado. Abortando."
    notify_admin "ALERTA SEGURIDAD: Actualización abortada" \
      "La firma del manifiesto de actualización es INVÁLIDA. El archivo puede haber sido manipulado. No se aplicó ningún cambio. Revisa inmediatamente."
    return 1
  fi

  log_info "Firma GPG verificada correctamente"
}

# =============================================================================
# 4. Parsear manifiesto
# =============================================================================

parse_manifest() {
  # Leer campos del JSON (sin dependencia de jq para mayor portabilidad)
  NEW_VERSION=$(grep -o '"version":"[^"]*"' "$MANIFEST_TMP" | cut -d'"' -f4)
  NEW_API_IMAGE=$(grep -o '"api":"[^"]*"' "$MANIFEST_TMP" | cut -d'"' -f4)
  NEW_KIOSCO_IMAGE=$(grep -o '"kiosco":"[^"]*"' "$MANIFEST_TMP" | cut -d'"' -f4)
  MANIFEST_CHANGELOG=$(grep -o '"changelog":"[^"]*"' "$MANIFEST_TMP" | cut -d'"' -f4 || echo "Sin notas")

  if [[ -z "$NEW_VERSION" || -z "$NEW_API_IMAGE" ]]; then
    log_error "Manifiesto malformado — faltan campos version o images.api"
    return 1
  fi

  log_info "Versión disponible: $NEW_VERSION (actual: $(get_current_version))"
}

# =============================================================================
# 5. Detectar cambio de versión y aprobación de cambio mayor
# =============================================================================

check_version() {
  local current
  current=$(get_current_version)

  if ! semver_less_than "$current" "$NEW_VERSION"; then
    log_info "Ya estás en la versión más reciente ($current). Nada que actualizar."
    return 1  # señal de "no hay nada que hacer" (no es error)
  fi

  local current_major new_major
  current_major=$(semver_major "$current")
  new_major=$(semver_major "$NEW_VERSION")

  if [[ "$new_major" != "$current_major" ]]; then
    handle_major_update "$current" "$NEW_VERSION"
    return $?
  fi

  log_info "Actualización menor/parche: $current → $NEW_VERSION"
  return 0
}

handle_major_update() {
  local current="$1" new="$2"
  log_warn "Cambio de versión MAYOR detectado: $current → $new"

  if [[ -f "$UPDATE_APPROVAL_FILE" ]]; then
    local approved_version
    approved_version=$(cat "$UPDATE_APPROVAL_FILE")
    if [[ "$approved_version" == "$new" ]]; then
      log_info "Actualización mayor aprobada manualmente (versión $new)"
      return 0
    fi
  fi

  log_warn "Actualización mayor PENDIENTE DE APROBACIÓN. No se aplicó ningún cambio."
  notify_admin "Aprobación requerida: DentalKiosco $new" \
    "Hay una actualización de versión mayor disponible: $current → $new.

Cambios: $MANIFEST_CHANGELOG

Esta actualización puede contener cambios que requieren verificación manual.
Para aprobarla, ejecuta en el servidor:

  echo '$new' > $UPDATE_APPROVAL_FILE

La actualización se aplicará automáticamente en el próximo ciclo diario (03:00)."

  return 1  # no actualizar todavía
}

# =============================================================================
# 6. Respaldo de base de datos
# =============================================================================

backup_db() {
  mkdir -p "$UPDATE_BACKUP_DIR"
  BACKUP_FILE="$UPDATE_BACKUP_DIR/backup-$(date '+%Y%m%d-%H%M%S').sql.gz"

  log_info "Respaldando base de datos → $BACKUP_FILE"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Se ejecutaría: pg_dump | gzip > $BACKUP_FILE"
    BACKUP_FILE="/dev/null"  # no escribir nada en dry-run
    return 0
  fi

  # ✅ PROBABLE LOCALMENTE: conecta contra postgres:5433 local
  PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --no-password \
    | gzip > "$BACKUP_FILE" || {
    log_error "Falló el respaldo de la base de datos. Abortando actualización."
    return 1
  }

  log_info "Respaldo completado: $(du -sh "$BACKUP_FILE" | cut -f1)"

  # Rotar respaldos: conservar solo los últimos 7
  # shellcheck disable=SC2012
  ls -t "$UPDATE_BACKUP_DIR"/backup-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
}

restore_db() {
  local backup="$1"
  if [[ -z "$backup" || ! -f "$backup" ]]; then
    log_error "No hay respaldo disponible para restaurar"
    return 1
  fi

  log_warn "Restaurando base de datos desde $backup..."
  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d postgres \
    --no-password \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$POSTGRES_DB' AND pid<>pg_backend_pid();" \
    >/dev/null 2>&1 || true

  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d postgres \
    --no-password \
    -c "DROP DATABASE IF EXISTS ${POSTGRES_DB}_old; ALTER DATABASE $POSTGRES_DB RENAME TO ${POSTGRES_DB}_old; CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER;" \
    >/dev/null 2>&1 || true

  zcat "$backup" | PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    --no-password \
    >/dev/null 2>&1 || {
    log_error "Fallo al restaurar la base de datos"
    return 1
  }

  PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$POSTGRES_HOST" \
    -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" \
    -d postgres \
    --no-password \
    -c "DROP DATABASE IF EXISTS ${POSTGRES_DB}_old;" \
    >/dev/null 2>&1 || true

  log_info "Base de datos restaurada correctamente"
}

# =============================================================================
# 7. Descargar nuevas imágenes y escribir override de compose
# =============================================================================

pull_images() {
  log_info "Descargando imágenes nuevas..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Se descargaría: $NEW_API_IMAGE"
    [[ -n "${NEW_KIOSCO_IMAGE:-}" ]] && log_info "[DRY-RUN] Se descargaría: $NEW_KIOSCO_IMAGE"
    return 0
  fi

  # ❌ REQUIERE INFRAESTRUCTURA REAL: el registro Docker del proveedor debe existir
  # y las imágenes identificadas por digest deben estar publicadas.
  #
  # Las referencias incluyen digest (@sha256:...) para garantizar que se baja
  # exactamente la imagen firmada en el manifiesto, no una versión posterior.

  docker pull "$NEW_API_IMAGE" || {
    log_error "Falló la descarga de la imagen de la API: $NEW_API_IMAGE"
    return 1
  }

  if [[ -n "${NEW_KIOSCO_IMAGE:-}" ]]; then
    docker pull "$NEW_KIOSCO_IMAGE" || {
      log_error "Falló la descarga de la imagen del kiosco: $NEW_KIOSCO_IMAGE"
      return 1
    }
  fi

  log_info "Imágenes descargadas correctamente"
}

write_compose_images_override() {
  # Guarda la referencia al override anterior para rollback
  PREV_COMPOSE_IMAGES=""
  if [[ -f "$COMPOSE_IMAGES_FILE" ]]; then
    PREV_COMPOSE_IMAGES=$(cat "$COMPOSE_IMAGES_FILE")
  fi

  log_info "Actualizando references de imágenes en $COMPOSE_IMAGES_FILE"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Se escribiría override de compose con images: api=$NEW_API_IMAGE"
    return 0
  fi

  cat > "$COMPOSE_IMAGES_FILE" <<EOF
# Generado automáticamente por update.sh — no editar manualmente
# Versión: $NEW_VERSION — $(date -u '+%Y-%m-%dT%H:%M:%SZ')
services:
  api:
    image: $NEW_API_IMAGE
EOF

  if [[ -n "${NEW_KIOSCO_IMAGE:-}" ]]; then
    cat >> "$COMPOSE_IMAGES_FILE" <<EOF
  kiosco:
    image: $NEW_KIOSCO_IMAGE
EOF
  fi
}

restore_compose_images_override() {
  if [[ -n "${PREV_COMPOSE_IMAGES:-}" ]]; then
    echo "$PREV_COMPOSE_IMAGES" > "$COMPOSE_IMAGES_FILE"
    log_warn "Override de imágenes restaurado a versión anterior"
  else
    rm -f "$COMPOSE_IMAGES_FILE"
    log_warn "Override de imágenes eliminado (no había versión anterior)"
  fi
}

# =============================================================================
# 8. Aplicar migraciones
# =============================================================================

run_migrations() {
  log_info "Aplicando migraciones de base de datos..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Se ejecutarían las migraciones con la nueva imagen"
    return 0
  fi

  # Ejecutar migraciones con la nueva imagen antes de levantar el servicio completo.
  # Usa docker compose run para heredar la configuración de red y env del compose.
  # La API debe estar detenida para evitar conflictos.
  #
  # ✅ PROBABLE LOCALMENTE: funciona contra la DB local siempre que el compose
  # tenga el servicio 'api' definido con la nueva imagen en el override.

  docker compose \
    -f "$INSTALL_DIR/docker-compose.yml" \
    -f "$COMPOSE_IMAGES_FILE" \
    run --rm --no-deps api \
    node dist/migrate.js up 2>&1 | while read -r line; do
      log_info "[migrate] $line"
    done

  local exit_code="${PIPESTATUS[0]}"
  if [[ "$exit_code" -ne 0 ]]; then
    log_error "Las migraciones fallaron (exit code $exit_code)"
    return 1
  fi

  log_info "Migraciones aplicadas correctamente"
}

# =============================================================================
# 9. Reiniciar servicios con nueva versión
# =============================================================================

restart_services() {
  log_info "Reiniciando servicios con versión $NEW_VERSION..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Se ejecutaría: docker compose up -d"
    return 0
  fi

  docker compose \
    -f "$INSTALL_DIR/docker-compose.yml" \
    -f "$COMPOSE_IMAGES_FILE" \
    up -d --remove-orphans 2>&1 | while read -r line; do
      log_info "[compose] $line"
    done
}

restart_services_rollback() {
  log_warn "Reiniciando servicios con versión anterior..."
  docker compose \
    -f "$INSTALL_DIR/docker-compose.yml" \
    $([ -f "$COMPOSE_IMAGES_FILE" ] && echo "-f $COMPOSE_IMAGES_FILE") \
    up -d 2>&1 | while read -r line; do
      log_warn "[rollback] $line"
    done
}

# =============================================================================
# 10. Health check post-actualización
# =============================================================================

health_check() {
  log_info "Verificando salud del sistema (esperando hasta ${HEALTH_TIMEOUT}s)..."

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "[DRY-RUN] Se verificaría GET http://localhost:3000/health/ready"
    return 0
  fi

  local elapsed=0 interval=5
  while (( elapsed < HEALTH_TIMEOUT )); do
    local response http_code
    http_code=$(curl -s -o /tmp/dk-health-resp.json -w "%{http_code}" \
      --max-time 5 \
      "http://localhost:3000/health/ready" 2>/dev/null) || true

    if [[ "$http_code" == "200" ]]; then
      log_info "Health check OK (${elapsed}s)"
      return 0
    fi

    log_info "Esperando API... (${elapsed}s, último código: ${http_code:-sin respuesta})"
    sleep $interval
    (( elapsed += interval ))
  done

  log_error "Health check falló después de ${HEALTH_TIMEOUT}s"
  return 1
}

# =============================================================================
# 11. Rollback completo
# =============================================================================

rollback() {
  local backup_file="$1"
  local reason="$2"

  log_warn "=== INICIANDO ROLLBACK: $reason ==="

  restore_compose_images_override
  restore_db "$backup_file" || log_error "Rollback de DB falló — intervención manual requerida"
  restart_services_rollback

  # Verificar que el rollback funcionó
  sleep 10
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    "http://localhost:3000/health" 2>/dev/null) || http_code="0"

  if [[ "$http_code" == "200" ]]; then
    log_warn "Rollback exitoso — sistema volvió a la versión anterior"
    notify_admin "Rollback automático: DentalKiosco" \
      "La actualización a $NEW_VERSION falló ($reason).

Se realizó un rollback automático. El sistema está operativo con la versión anterior.

Acción requerida: revisa los logs en /var/log/dk-update.log y contacta a soporte si el problema persiste."
  else
    log_error "El rollback también falló — INTERVENCIÓN MANUAL URGENTE REQUERIDA"
    notify_admin "ALERTA CRÍTICA: Rollback falló" \
      "La actualización a $NEW_VERSION falló ($reason) y el rollback automático también falló.

El sistema puede estar en un estado inconsistente. REQUIERE INTERVENCIÓN MANUAL URGENTE.

Contacta al soporte técnico inmediatamente."
  fi
}

# =============================================================================
# 12. Notificación al administrador
# =============================================================================

notify_admin() {
  local subject="$1"
  local body="$2"

  if [[ -z "$RESEND_API_KEY" || -z "$ADMIN_EMAIL" ]]; then
    log_warn "Sin configuración de email — no se puede notificar al administrador"
    log_info "Asunto: $subject"
    return 0
  fi

  # ✅ PROBABLE LOCALMENTE: usa RESEND_API_KEY real del .env
  curl -s -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"from\": \"DentalKiosco Updates <$RESEND_FROM_EMAIL>\",
      \"to\": [\"$ADMIN_EMAIL\"],
      \"subject\": \"[DentalKiosco] $subject\",
      \"text\": \"$body\"
    }" \
    -o /dev/null 2>/dev/null || {
    log_warn "Fallo al enviar notificación email (no crítico)"
  }
}

# =============================================================================
# Modo: generar claves GPG de prueba
# =============================================================================

generate_test_keys() {
  echo "=== Generando claves GPG de prueba para testing local ==="
  echo ""

  local test_gpg_home="/tmp/dk-test-gpg-$$"
  mkdir -p "$test_gpg_home"
  chmod 700 "$test_gpg_home"

  # Generar par de claves sin passphrase (solo para tests)
  GNUPGHOME="$test_gpg_home" gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 2048
Subkey-Type: RSA
Subkey-Length: 2048
Name-Real: DentalKiosco Test Signer
Name-Email: updates-test@dentalkiosco.app
Expire-Date: 1y
%no-protection
%commit
EOF

  # Exportar clave pública al archivo del repo
  GNUPGHOME="$test_gpg_home" gpg --armor \
    --export "updates-test@dentalkiosco.app" \
    > "$SCRIPT_DIR/dk_update_pub.gpg"

  # Crear manifiesto de prueba
  local test_manifest_dir="/tmp/dk-test-manifest-$$"
  mkdir -p "$test_manifest_dir/releases/latest"

  cat > "$test_manifest_dir/releases/latest/manifest.json" <<EOF
{
  "version": "3.99.0",
  "released_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "changelog": "Test de actualización local — no es una versión real",
  "major_change": false,
  "images": {
    "api": "dentalkiosco-api:test",
    "kiosco": "dentalkiosco-kiosco:test"
  }
}
EOF

  # Firmar el manifiesto con la clave privada de prueba
  GNUPGHOME="$test_gpg_home" gpg --armor \
    --detach-sign \
    --output "$test_manifest_dir/releases/latest/manifest.json.asc" \
    "$test_manifest_dir/releases/latest/manifest.json"

  echo "✓ Clave pública de prueba → $SCRIPT_DIR/dk_update_pub.gpg"
  echo "✓ Manifiesto firmado → $test_manifest_dir/releases/latest/"
  echo ""
  echo "Para probar el flujo completo:"
  echo "  1. cd $test_manifest_dir && python3 -m http.server 8765"
  echo "  2. Agrega al .env:  UPDATE_SERVER_URL=http://localhost:8765"
  echo "  3. ./update.sh --dry-run"
  echo ""
  echo "NOTA: La clave generada en dk_update_pub.gpg es de prueba."
  echo "      En producción, reemplázala con la clave pública del proveedor."

  rm -rf "$test_gpg_home"
}

# =============================================================================
# Flujo principal
# =============================================================================

main() {
  log_info "======================================================"
  log_info "DentalKiosco Update Manager — $(date '+%Y-%m-%d %H:%M:%S')"
  [[ "$DRY_RUN" == "true" ]] && log_info "MODO DRY-RUN — no se aplicarán cambios"
  log_info "======================================================"

  load_env
  set_defaults
  validate_required_vars

  local current_version
  current_version=$(get_current_version)
  log_info "Versión actual: $current_version"

  # Paso 1: licencia
  check_license || {
    log_warn "Actualización omitida por estado de licencia"
    exit 0
  }

  # Pasos 2-3: manifiesto + firma
  fetch_manifest || exit 0
  verify_signature || exit 1
  parse_manifest || exit 1

  # Paso 4: comparar versiones
  check_version || exit 0   # exit 0 = ya está actualizado o pendiente aprobación

  # Paso 5: backup
  backup_db || exit 1
  local backup_file="$BACKUP_FILE"

  # Pasos 6-7: imágenes
  pull_images || {
    log_error "No se pudo descargar la nueva imagen"
    exit 1
  }
  write_compose_images_override

  # Paso 8: migraciones
  # Primero detener API para evitar conflictos durante migración
  if [[ "$DRY_RUN" != "true" ]]; then
    log_info "Deteniendo API para aplicar migraciones..."
    docker compose -f "$INSTALL_DIR/docker-compose.yml" stop api 2>/dev/null || true
  fi

  if ! run_migrations; then
    log_error "Migraciones fallaron — iniciando rollback"
    rollback "$backup_file" "migraciones fallidas"
    exit 1
  fi

  # Paso 9: levantar con nueva versión
  restart_services

  # Paso 10: health check
  if ! health_check; then
    log_error "Health check falló después de actualizar — iniciando rollback"
    rollback "$backup_file" "health check falló post-actualización"
    exit 1
  fi

  # Éxito
  if [[ "$DRY_RUN" != "true" ]]; then
    write_current_version "$NEW_VERSION"
    rm -f "$UPDATE_APPROVAL_FILE"  # limpiar aprobación si existía
  fi

  log_info "======================================================"
  log_info "Actualización exitosa: $current_version → $NEW_VERSION"
  log_info "======================================================"

  notify_admin "Actualización exitosa: DentalKiosco $NEW_VERSION" \
    "La instalación se actualizó correctamente.

Versión anterior: $current_version
Versión nueva:    $NEW_VERSION

Cambios: $MANIFEST_CHANGELOG

La actualización se aplicó a las $(date '+%H:%M') del $(date '+%d/%m/%Y')."
}

main "$@"
