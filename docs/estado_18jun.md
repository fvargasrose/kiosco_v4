# Estado — 18 de junio 2026

> **Archivo de estado rápido.** Al iniciar una conversación nueva, pídeme
> "dime el estado actual de local y producción" y respondo desde aquí, **sin
> escanear todo el sistema** (ahorra tokens). Si necesitas detalle de una pieza,
> ahí sí abrimos el código.
> Sucede a `docs/dia17jun.md` (handoff anterior, ya consumido).

---

## 1. Resumen en una línea

Trabajo del 18-jun vive en la rama local **`mejora_17jun`** (6 commits, **sin
pushear**). Producción sigue intacta en `para_produccion @ ef0dd59`. Contenedores
Docker locales **apagados**.

---

## 2. Git

| Cosa | Estado |
|------|--------|
| **Rama actual** | `mejora_17jun` — **solo local, NO está en origin** |
| Adelanto sobre `main` | **6 commits** (ver §3); no mergeada |
| `main` / `para_produccion` (local y origin) | en `ef0dd59` (sin cambios) |
| Cambios sin commitear | `.gitignore`, `CLAUDE.md` (M) + varios docs nuevos en `docs/` (untracked) |
| Ramas existentes | `main`, `para_produccion`, `mejora_17jun` (local) · origin solo tiene `main` y `para_produccion` |

⚠️ **`mejora_17jun` no está respaldada en remoto.** Si importa, pushear.

---

## 3. Local (dev) — qué se hizo en `mejora_17jun`

Rama parte de `ef0dd59`. Commits (reciente → antiguo):

1. `f984073` fix(kiosco-ui): responsive móvil + icono `ti-dental` en menú/bottom-nav
2. `2c9c062` fix(admin): link de kiosco al puerto del paciente en dev + revocar sin body vacío
3. `bb4bfe9` feat(kiosco): teclado en pantalla en modo kiosco (`data-kb` + mount en `#app`)
4. `c5d2650` feat(auth): rate-limit por modo (kiosco vs web) + mensaje 429 suavizado
5. `157f4ff` feat(kiosco): modo kiosco vs web por token en el link (`?k=<token>`)
6. `1963cc2` fix(kiosco-ui): icono `ti-dental` en "Mis tratamientos" + resumen de cita en columna

**Equivale a:** Fase 1 (visual: icono ① + resumen ④), Fase 2 (modo kiosco/web:
token `?k=` + rate-limit por modo ② + teclado ③ + link en admin) y parte de
Fase 3 (responsive móvil). Plan completo en `docs/plan_17junio.md`.

**Entorno local (sin cambios respecto al 17-jun):**
- Node 22 en **nvm**: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` antes de node/pnpm.
- Postgres host **5434**, Redis host **6381**. Proyecto compose = `dentalkiosco`.
- **Contenedores postgres/redis están APAGADOS** (al cerrar el 18-jun no se levantaron). Para arrancar: `docker compose start postgres redis` (o `up -d postgres redis`).
- Política **TODO REAL**: `DEV_MOCK_EXTERNAL_SERVICES=false`, `DEV_MOCK_WOMPI=false`. Tests siguen en mock (vitest lo fuerza).

---

## 4. Producción (Hetzner) — INTACTA, no se tocó el 18-jun

- Servidor `5.78.110.152` → `https://sistema.2ways.us`.
- Rama desplegada: **`para_produccion` @ `ef0dd59`** (igual que el 17-jun; esta sesión NO desplegó nada).
- `dk-api`/`dk-postgres`/`dk-redis` healthy; `dk-caddy` aparece `unhealthy` = **falsa alarma conocida** (healthcheck interno wget localhost:80→308; sirve 200 normal).
- Salud real: `https://sistema.2ways.us/api/health/ready` (el `/health/ready` "pelado" devuelve el HTML del SPA).
- Deploy: `git pull` en `/opt/dentalkiosco` + `docker compose -f docker-compose.yml -f docker-compose.prod.yml build api && up -d api`.

> Nada de `mejora_17jun` está en producción todavía.

---

## 5. Pendiente / siguientes pasos

- **Recordatorios de citas (⑥):** sin implementar. Contexto completo y actualizado en **`docs/implementar_recordatorios.md`** (creado el 18-jun; corrige el plan viejo: migración **018**, falta `getAppointmentsByDate`, las citas Dentalink no traen contacto).
- **Check-in "ya estoy en recepción" (⑤):** sin implementar; bloqueado por el `id_estado` de Dentalink para "en recepción".
- Decisiones pendientes del usuario: hora de recordatorios, estados recordables, `id_estado` de check-in (ver `docs/plan_17junio.md` §"Decisiones pendientes").
- ¿Pushear `mejora_17jun`? ¿probar las mejoras de Fase 1–3 en local con servicios reales antes de subir?
- Administrativo (heredado): confirmar borrado de `backup2/credenciales.md`; commitear (o no) los cambios de `CLAUDE.md`/docs.

---

## 6. Reglas del proyecto (recordatorio)
- No tocar sin autorización: `payments.ts`, `reconciler.ts`, `license/*`, migraciones `001-017`.
- Migración nueva = versión nueva + `INSERT … ON CONFLICT DO NOTHING`.
- Verificación: typecheck + test (287) + builds frontend (`pnpm lint` raíz roto, preexistente).
- Probar en local contra servicios reales antes de subir a git.
- No tocar producción sin autorización explícita; no cambiar `JWT_SECRET`/`ENCRYPTION_KEY` de prod.
- Re-aplicar siempre `normalizeCelular()` y `boolEnv()` (se pierden en parches).
</content>
