# para_nuevo.md — Estado del proyecto tras reinstalación de Ubuntu 22

**Fecha del diagnóstico:** 2026-06-16
**Rama actual:** `para_produccion`
**Remoto:** `https://github.com/fvargasrose/kiosco_v4.git`
**Evento:** reinstalación de Ubuntu 22 en **otro disco**. El disco donde vive este proyecto (`/media/val/55a86eea-...`) **no se tocó** → todos los archivos del proyecto están intactos.

> Documento de diagnóstico únicamente. **No se instaló ni modificó nada.**

---

## 1. Resumen ejecutivo

| Pregunta | Respuesta |
|----------|-----------|
| ¿El código del proyecto sobrevivió? | ✅ Sí, completo (estaba en el disco de datos) |
| ¿Se puede arrancar tal cual ahora mismo? | ❌ No. Faltan herramientas del sistema y la base de datos |
| ¿Hay que reinstalar todo desde cero? | ❌ No. Solo herramientas de sistema + recrear la base de datos |
| ¿Se perdió algún código o configuración? | ✅ No. `.env`, `node_modules`, `pnpm-lock.yaml` y migraciones presentes |
| ¿Se perdieron los datos de la base? | ⚠️ **Sí, muy probablemente** (ver sección 3) |

**Conclusión:** el proyecto es recuperable sin reinstalarlo. El trabajo pendiente es de **entorno** (instalar Docker + pnpm) y de **datos** (recrear Postgres/Redis desde migraciones). El código fuente no requiere reinstalación.

---

## 2. Qué sobrevivió (disco de datos, intacto)

| Elemento | Estado |
|----------|--------|
| Código fuente (`apps/`, `central/`, `installer/`, etc.) | ✅ Presente |
| `.env` (raíz) | ✅ Presente (4377 bytes, fecha 15-jun) |
| `node_modules/` (raíz y `apps/api/`) | ✅ Presente (instalado 06-jun) |
| `pnpm-lock.yaml` | ✅ Presente |
| Migraciones SQL `001` → `017` | ✅ Presentes (17 migraciones, no 11 como dicen los docs) |
| Git (historial, rama `para_produccion`) | ✅ Intacto |

> **Nota:** README.md y CLAUDE.md dicen "11/11 migraciones". En realidad ya hay **17** (`012_optional_cedula_hash` … `017_nullable_kiosk_id_web`). Los docs están desactualizados.

---

## 3. Qué se perdió o falta

### 3.1 Herramientas del sistema (vivían en el disco del SO reinstalado)

| Herramienta | Requerido | Estado actual | Acción |
|-------------|-----------|---------------|--------|
| **Node.js** | 22 (engines: `>=20`) | ⚠️ Instalado pero **v24.16.0** | Funciona por engines, pero ver 3.3 |
| **pnpm** | `9.4.0` (packageManager) | ❌ No instalado | `corepack enable` (corepack sí está, v0.35.0) |
| **Docker** | Compose plugin | ❌ No instalado, no existe `/var/lib/docker` | Reinstalar Docker Engine + Compose |
| **psql** (cliente) | Opcional | ❌ No instalado | Opcional, solo para consultas manuales |
| **git** | — | ✅ v2.34.1 | OK |

### 3.2 Datos de la base de datos — **PÉRDIDA PROBABLE**

`docker-compose.yml` define la persistencia como **named volumes** de Docker:

```yaml
volumes:
  postgres_data:
    driver: local   # → se guarda en /var/lib/docker/volumes/
```

No es un *bind mount* a una carpeta del proyecto. Confirmado: no existe ningún directorio `pgdata`/`postgres_data` dentro del repo. Por tanto los datos de Postgres y Redis vivían en **`/var/lib/docker/`**, que estaba en el **disco del SO reinstalado**. Ese directorio ya **no existe**.

**Implicación:** la base de datos (admins, kioscos, transacciones, consentimientos, etc.) **se perdió**. Hay que recrearla desde las migraciones. Esto es lo único realmente "perdido" del proyecto.

> Si en algún momento se hizo un `pg_dump` / backup externo en el disco de datos, se podría restaurar. **Conviene buscar un backup antes de dar la base por perdida** (ver opciones).

### 3.3 Módulos nativos compilados contra otra versión de Node

`node_modules` contiene **`argon2@0.44.0`** (módulo nativo, usado para el hash de contraseñas del admin). Estos binarios `.node` se compilaron con la versión de Node que había **antes** de la reinstalación (probablemente Node 22). Ahora el sistema tiene **Node 24**.

**Riesgo:** los binarios nativos pueden fallar al cargar con un Node de versión mayor distinta (ABI diferente). Si al arrancar la API aparece un error tipo `Error: The module '...argon2...' was compiled against a different Node.js version`, hay que reconstruir (`pnpm rebuild` o reinstalar dependencias). No es grave, pero hay que tenerlo en cuenta.

### 3.4 Detalle de configuración (no es pérdida, pero a verificar)

- El `.env` apunta a **puertos 5434 (Postgres) y 6381 (Redis)** — son los puertos del clon `kiosko_v4` definidos en `docker-compose.override.yml`. Coherente. No hay que cambiar nada aquí.
- `.env` actual: `LICENSE_DEV_MODE=true`, `OTP_REQUIRED=true`, `DEV_MOCK_WOMPI=false`, `DEV_MOCK_EXTERNAL_SERVICES=false`, `NODE_ENV=development`.

---

## 4. Diagnóstico: ¿hay que reinstalar el proyecto?

**No.** El proyecto en sí no se reinstala. Lo que falta es:

1. **Reinstalar herramientas de sistema** (Docker, pnpm) — son del SO, no del proyecto.
2. **Recrear la base de datos** desde las migraciones (los datos se perdieron, el esquema no).
3. **Posiblemente reconstruir `node_modules`** si los binarios nativos no cargan con Node 24.

---

## 5. Opciones

### Opción A — Recuperación mínima para desarrollo local (recomendada para verificar que todo funciona)

Pasos (de menor a mayor esfuerzo):

1. **Instalar Docker Engine + Compose plugin** (no estaba; se borró con el SO).
2. **Activar pnpm:** `corepack enable` (corepack ya está disponible).
3. **Levantar infraestructura:** `docker compose up -d postgres redis` → crea volúmenes vacíos nuevos.
4. **Reconstruir dependencias si los binarios nativos fallan:** `pnpm install` o `pnpm rebuild` (por el cambio Node 22 → 24).
5. **Aplicar las 17 migraciones:** `pnpm --filter @dentalkiosco/api migrate` → recrea el esquema en la base vacía.
6. **Recrear el admin demo** con `setup.ts create-admin` (la fila de admins se perdió).
7. **Verificar:** `typecheck` + `test` (195 tests) + `migrate:status` (debe dar 17/17).

Resultado: entorno de desarrollo funcional, **pero con base de datos vacía** (sin transacciones ni configuración previas).

### Opción B — Recuperación con datos previos (si existe un backup)

Antes de la Opción A, **buscar un `pg_dump`/backup** de la base en el disco de datos o en producción:
- Buscar archivos `*.sql`, `*.dump`, `*.backup` en el disco de datos.
- Si el sistema estuvo desplegado en producción (Hetzner, según `docs/produccion/`), la base **real** podría estar viva en el servidor y este entorno local ser solo de desarrollo → en ese caso no se "perdió" nada importante.
- Restaurar el dump tras levantar Postgres, **en vez** de correr migraciones desde cero.

### Opción C — Fijar Node a la versión 22 (entorno idéntico al original)

Si se quiere reproducir exactamente el entorno previo y evitar sorpresas con módulos nativos:
- Instalar Node 22 (vía `nvm` o paquete) en lugar de usar el Node 24 del sistema.
- Reinstalar dependencias con Node 22.
- Más fiel al original, pero más trabajo. Solo necesario si Node 24 da problemas.

---

## 6. Pendientes de decisión (preguntar al usuario)

1. **¿Existe un backup de la base de datos** (pg_dump) en algún lado, o el entorno local era descartable? → decide entre Opción A y B.
2. **¿El sistema está/estuvo desplegado en producción?** Si la base "de verdad" vive en un servidor, este entorno local es solo dev y la pérdida de datos locales es irrelevante.
3. **¿Se autoriza instalar Docker y pnpm?** (el usuario pidió no instalar en este paso; cuando dé luz verde, se procede con la Opción A).
4. **¿Node 24 está bien o se prefiere fijar Node 22?** (Opción C).

---

## 7. Comandos de verificación (para cuando se autorice ejecutar)

```bash
# 1. Activar pnpm
corepack enable

# 2. Infra (tras instalar Docker)
docker compose up -d postgres redis
docker compose ps                       # esperar (healthy)

# 3. Dependencias (rehacer si binarios nativos fallan con Node 24)
pnpm install                            # o: pnpm rebuild

# 4. Migraciones (base vacía → recrea esquema)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status   # 17/17

# 5. Recrear admin demo
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api exec tsx src/setup.ts \
  create-admin --email admin@demo.local --password "Admin@Demo2026" --name "Demo Admin"

# 6. Calidad
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test     # 195 tests
```

---

## 8. Veredicto

El proyecto **no necesita reinstalarse**. El código, la configuración (`.env`) y las dependencias sobrevivieron intactas en el disco de datos. Lo único que se perdió, por estar en el disco del SO reinstalado, es:

- Las **herramientas de sistema** (Docker y pnpm) → reinstalables en minutos.
- Los **datos de la base** (named volumes de Docker) → recreables desde las 17 migraciones, o restaurables desde backup si existe.

El esfuerzo de recuperación es **bajo** (Opción A) y no implica reescribir ni reinstalar el proyecto en sí.
