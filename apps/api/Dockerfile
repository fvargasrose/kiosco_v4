# =============================================================================
# Dockerfile API - DentalKiosco
# =============================================================================
# Multi-stage build:
#   1. deps   - solo deps de producción
#   2. build  - compila TypeScript
#   3. runtime - imagen final minimalista
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Dependencias de producción
# -----------------------------------------------------------------------------
FROM node:20-alpine AS deps

# Necesario para compilar argon2 y bcrypt nativos
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Habilitar pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

# Copiar archivos de deps
COPY package.json pnpm-lock.yaml* ./

# Instalar solo deps de producción (mejora seguridad y tamaño)
RUN pnpm install --frozen-lockfile --prod || pnpm install --prod

# -----------------------------------------------------------------------------
# Stage 2: Build
# -----------------------------------------------------------------------------
FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.4.0 --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

# -----------------------------------------------------------------------------
# Stage 3: Runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# tini para manejo correcto de señales y zombies
RUN apk add --no-cache tini wget

# Usuario no-root
RUN addgroup -g 1001 -S app && \
    adduser -u 1001 -S app -G app

WORKDIR /app

# Copiar deps de producción y dist
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./

# Variables por defecto
ENV NODE_ENV=production
ENV PORT=3000

USER app

EXPOSE 3000

# Healthcheck interno
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
