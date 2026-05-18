#!/usr/bin/env bash
# =============================================================================
# generate-secrets.sh
# =============================================================================
# Genera secretos criptográficamente seguros para .env
# Uso: bash scripts/generate-secrets.sh
# =============================================================================

set -euo pipefail

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Detectar herramienta de aleatoriedad disponible
if command -v openssl &> /dev/null; then
    GEN="openssl"
elif [[ -r /dev/urandom ]]; then
    GEN="urandom"
else
    echo -e "${RED}ERROR: Se necesita openssl o /dev/urandom${NC}"
    exit 1
fi

# Funciones generadoras
gen_base64() {
    local bytes="${1:-32}"
    if [[ "$GEN" == "openssl" ]]; then
        openssl rand -base64 "$bytes" | tr -d '\n'
    else
        head -c "$bytes" /dev/urandom | base64 | tr -d '\n'
    fi
}

gen_hex() {
    local bytes="${1:-32}"
    if [[ "$GEN" == "openssl" ]]; then
        openssl rand -hex "$bytes"
    else
        head -c "$bytes" /dev/urandom | xxd -p | tr -d '\n'
    fi
}

gen_password() {
    # Password alphanumérico fuerte (sin caracteres problemáticos en .env)
    if [[ "$GEN" == "openssl" ]]; then
        openssl rand -base64 32 | tr -d "=+/" | head -c 32
    else
        head -c 64 /dev/urandom | base64 | tr -d "=+/" | head -c 32
    fi
}

echo -e "${GREEN}=== Generando secretos para DentalKiosco ===${NC}"
echo ""

POSTGRES_PASSWORD=$(gen_password)
REDIS_PASSWORD=$(gen_password)
JWT_SECRET=$(gen_base64 48)
ENCRYPTION_KEY=$(gen_base64 32)

cat <<EOF
${YELLOW}Copia las siguientes líneas a tu archivo .env:${NC}

POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}

${RED}IMPORTANTE:${NC}
  - NO commitees el archivo .env al repositorio
  - Guarda estos valores en un gestor de contraseñas
  - En producción, rotar JWT_SECRET cada 3 meses
  - En producción, rotar ENCRYPTION_KEY requiere migración de datos
EOF

# Opcional: escribir directamente al .env si no existe
if [[ ! -f .env ]]; then
    echo ""
    read -p "$(echo -e ${YELLOW}¿Crear archivo .env con estos valores? [y/N]: ${NC})" -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [[ -f .env.example ]]; then
            cp .env.example .env
            # Reemplazar placeholders
            sed -i.bak "s|POSTGRES_PASSWORD=CHANGE_ME.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
            sed -i.bak "s|REDIS_PASSWORD=CHANGE_ME.*|REDIS_PASSWORD=${REDIS_PASSWORD}|" .env
            sed -i.bak "s|JWT_SECRET=CHANGE_ME.*|JWT_SECRET=${JWT_SECRET}|" .env
            sed -i.bak "s|ENCRYPTION_KEY=CHANGE_ME.*|ENCRYPTION_KEY=${ENCRYPTION_KEY}|" .env
            rm -f .env.bak
            echo -e "${GREEN}✓ Archivo .env creado${NC}"
        else
            echo -e "${RED}ERROR: .env.example no encontrado${NC}"
        fi
    fi
fi
