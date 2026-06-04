# CLONAR_PROYECTO.md — Clonar DentalKiosco a `/home2/kiosko_v4` (rama paralela aislada)

> **Propósito:** crear una copia totalmente independiente del proyecto en
> `/home2/kiosko_v4`, con su propio remoto (`kiosco_v4.git`) y puertos
> alternativos, para correr en paralelo sin chocar con el original.
>
> ⚠️ **Este documento se ejecuta UNA sola vez.** Después puede archivarse.

## Datos reales del proyecto original (detectados al generar este doc)

| Dato | Valor |
|------|-------|
| Remoto actual (`git remote get-url origin`) | `https://github.com/fvargasrose/kiosco_v3_produccion.git` |
| Carpeta original (`git rev-parse --show-toplevel`) | `/home2/kiosco_v3_produccion_18_05_26/dentalkiosco` |
| Carpeta destino del clon | `/home2/kiosko_v4` |
| Remoto nuevo (aislado) | `https://github.com/fvargasrose/kiosco_v4.git` |
| Puertos host originales | postgres `5433`, redis `6380`, API `3000`, kiosco `5173`, admin `5174` |
| Puertos host del clon (propuestos) | postgres `5434`, redis `6381`, API `3001`, kiosco `5273`, admin `5274` |

## Prerrequisito (hacer ANTES del paso 4)

Crear en GitHub el repositorio **vacío** `fvargasrose/kiosco_v4`
(sin README, sin .gitignore, sin licencia — para que el primer `push` no choque).

---

## 1. Detectar el repo remoto actual

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
git remote get-url origin
# → https://github.com/fvargasrose/kiosco_v3_produccion.git
```

## 2. Clonar el repo actual en la carpeta destino

```bash
git clone https://github.com/fvargasrose/kiosco_v3_produccion.git /home2/kiosko_v4
cd /home2/kiosko_v4
git checkout main          # asegurar estar en main antes del push inicial
```

## 3. Cambiar el remote `origin` al nuevo repo aislado

```bash
git remote set-url origin https://github.com/fvargasrose/kiosco_v4.git
git remote -v
# origin  https://github.com/fvargasrose/kiosco_v4.git (fetch)
# origin  https://github.com/fvargasrose/kiosco_v4.git (push)
```

A partir de aquí, `/home2/kiosko_v4` ya **no** apunta al repo original.

## 4. Push inicial al nuevo remoto

```bash
git push -u origin main
```
> (Opcional) Si quieres llevar también otras ramas, p. ej.:
> `git push -u origin pagos`

## 5. Copiar el `.env` manualmente desde el proyecto original

El `.env` **NUNCA** se commitea ni viaja con el `git clone`. Hay que copiarlo a mano:

```bash
cp /home2/kiosco_v3_produccion_18_05_26/dentalkiosco/.env /home2/kiosko_v4/.env
```
> ⚠️ **ADVERTENCIA:** si vas a correr ambos proyectos en paralelo, debes ajustar
> los puertos en este `.env` del clon (ver paso 7). Si no, chocarán.

## 6. Instalar dependencias

```bash
cd /home2/kiosko_v4
pnpm install
```

## 7. Levantar infraestructura con puertos alternativos (no chocar con el original)

El archivo `docker-compose.override.yml` **sí viene con el clon** (está versionado) y
trae los puertos del original (`5433`/`6380`). Edítalo en el clon para usar puertos
distintos:

**`/home2/kiosko_v4/docker-compose.override.yml`** — dejarlo así:
```yaml
services:
  postgres:
    ports:
      - "5434:5432"   # antes 5433:5432

  redis:
    ports:
      - "6381:6379"   # antes 6380:6379
```

Reflejar esos mismos puertos en **`/home2/kiosko_v4/.env`**:
```bash
POSTGRES_PORT=5434     # antes 5433
REDIS_PORT=6381        # antes 6380
# Si vas a correr ambos backends/frontends a la vez, cambia también:
# API_PORT=3001        # antes 3000   (backend del clon)
# y arranca los frontends del clon en otros puertos, p. ej.:
#   pnpm --filter @dentalkiosco/kiosco-frontend dev -- --port 5273
#   pnpm --filter @dentalkiosco/admin-frontend  dev -- --port 5274
```

Levantar la infraestructura del clon:
```bash
cd /home2/kiosko_v4
docker compose up -d postgres redis
docker compose ps     # confirmar mapeos 5434->5432 y 6381->6379
```

## 8. Aplicar migraciones

```bash
cd /home2/kiosko_v4
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
```

## 9. Verificar instalación completa

```bash
cd /home2/kiosko_v4
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test

# Arrancar el backend del clon (en otra terminal) y comprobar salud:
#   DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev
curl -s http://localhost:3000/health/ready | jq .
# Si cambiaste API_PORT=3001 para correr en paralelo:
#   curl -s http://localhost:3001/health/ready | jq .
```

---

## NOTAS IMPORTANTES

- **El `.env` NUNCA se commitea.** No viaja con `git clone`; siempre se copia a mano
  (paso 5). Tampoco lo subas al nuevo repo.
- **Los dos proyectos no pueden correr simultáneamente con los mismos puertos.**
  El clon debe usar puertos distintos: postgres `5434`, redis `6381`, y —si corres
  ambos backends/frontends a la vez— API `3001` y frontends `5273`/`5274`
  (paso 7). Cada cambio de puerto host va en **dos** sitios: `docker-compose.override.yml`
  **y** `.env`.
- **Aislamiento total:** tras el paso 3, `/home2/kiosko_v4` apunta a
  `kiosco_v4.git`, no al repo original. Commits/push del clon no afectan al
  proyecto `kiosco_v3_produccion`.
- **El `docker-compose.override.yml` sí está versionado** (viene con el clon); por eso
  hay que editarlo en el clon, no crearlo desde cero.
- **Este documento se ejecuta UNA sola vez.** Una vez clonado y verificado, puede
  archivarse.
