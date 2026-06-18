# Contexto para trabajar en la rama `seguridad2` (vuelo libre pero seguro)

> **Para Claude Code (nueva conversación).** Este documento te da todo lo necesario
> para ejecutar el plan de seguridad **sin pedir permiso a cada paso**, pero
> **sin tocar producción ni `main`** hasta que el usuario confirme.
> Léelo completo antes de empezar.

---

## 0. Regla de oro (NO la rompas)

**Todo el trabajo nuevo vive SOLO en la rama `seguridad2`.** Mientras se prueba y
confirma:

- ✅ Permitido: commitear en `seguridad2`, correr typecheck/test/builds, levantar
  servicios locales, pushear `seguridad2` a origin (backup).
- ❌ **PROHIBIDO sin autorización explícita del usuario:**
  - Hacer merge/push a `main` o `para_produccion`.
  - Desplegar a producción (`git pull` en el server, `docker compose ... up -d`).
  - Tocar la BD de producción (Hetzner `5.78.110.152`).
  - Modificar archivos prohibidos (ver §5).

**Garantía:** mientras solo commitees en `seguridad2` y no despliegues, producción
(`para_produccion @ 064a938`, desplegada) y `main` quedan **intactas**. Los cambios
quedan aislados hasta que el usuario diga "merge a main / desplegar".

Antes de cualquier commit, confirma que estás en la rama correcta:
```bash
git branch --show-current   # debe decir: seguridad2
```

---

## 1. Estado actual (al crear esta rama)

- Ramas alineadas: `main` = `seguridad2` (parten del mismo commit de docs).
  `para_produccion @ 064a938` es **lo desplegado en prod** (no lo muevas).
- Producción: Hetzner `5.78.110.152` → `https://sistema.2ways.us`. Sana.
- **MFA admin:** `mfa_required=false` en prod (decisión del usuario = opción a:
  sin 2FA temporal mientras se construye el 2FA por **email** en el Hito 4b).
  Admin único: `partners2ways@gmail.com` (recuperación de clave por email ya
  funciona desde el login: "¿Olvidaste tu contraseña?").
- Documentos de referencia (en el repo):
  - `plan_seguridad.md` — **el plan a ejecutar**, por hitos.
  - `informe_seguridad.md` — diagnóstico de riesgos (con citas a archivos).
  - `descripcion_sistema.md` — mapa del sistema.
  - `scripts/gen_diagramas.sh` — genera diagramas en `docs/diagramas/`.

---

## 2. Misión

Ejecutar `plan_seguridad.md` hito por hito. Orden sugerido (ver el plan):

1. **Hito 1** — Higiene de secretos: borrar `.env.bak.*` de disco (local; el de
   prod NO, eso es prod). Rotación de secretos: **preguntar al usuario** antes
   (puede implicar coordinación con Wompi). `.gitignore` ya está hecho.
2. **Hito 2** — Eliminar el flag muerto `OTP_REQUIRED` (login-direct ya no existe).
   Quitar de `config.ts`, `public.ts:109`, `kiosk.ts:176`, frontend y docs.
3. **Hito 4** — Gestión de usuarios admin (UI nueva en `admin-frontend`) + **2FA por
   código de email** (reusar infra de `forgot-password`; reemplaza TOTP/QR).
4. **Hito 6** — TTL/CSP/cabeceras.
5. **Hito 5** — Parametrizar `app.encryption_key` (cripto, bajo riesgo, con cuidado).
6. **Hito 3** — Hash de cédula → HMAC con *pepper* (**el más delicado, por fases,
   doble escritura, sin reemplazo de golpe**).

Cierra **un commit por hito** (mensaje convencional: `feat(...)`, `fix(...)`,
`chore(...)`). Si un hito requiere decisión del usuario, **pregunta y espera**.

---

## 3. Puerta de verificación (obligatoria al cerrar cada hito)

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test      # 287 tests, mock
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build
```
`pnpm lint` (raíz) está roto de fábrica (sin `eslint.config.js`) — no es puerta.
Probar en local contra servicios reales antes de dar un hito por bueno.

---

## 4. Entorno local

- Node 22 en **nvm**: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22`.
- Postgres host `5434`, Redis host `6381`. Levantar: `docker compose up -d postgres redis`.
- API dev: `DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev`.
- Frontends: `pnpm --filter @dentalkiosco/kiosco-frontend dev` (5173) /
  `... admin-frontend dev` (5174).
- Política TODO REAL en local (`DEV_MOCK_*` = false); los tests siguen en mock.
- Re-aplicar siempre `boolEnv()` (`config.ts`) y `normalizeCelular()` (`dentalink.ts`)
  si un parche los pierde (ver CLAUDE.md §Fixes).

---

## 5. Archivos PROHIBIDOS de tocar sin autorización (CLAUDE.md §1)

- `apps/api/src/routes/payments.ts` (webhook Wompi)
- `apps/api/src/lib/reconciler.ts`
- `apps/api/src/lib/license/*`
- `apps/api/migrations/001-017_*.sql` (migraciones aplicadas)

Migración nueva = **versión nueva** (018, 019…) terminando con
`INSERT INTO schema_migrations (version, name) VALUES ('NNN','nombre') ON CONFLICT DO NOTHING;`

---

## 6. Acceso a producción (solo lectura / diagnóstico; NO desplegar)

SSH: `ssh -i backup2/ssh/id_ed25519 root@5.78.110.152` (el `Bash` corre en sandbox
sin red → usar `dangerouslyDisableSandbox: true` para ssh/git push). Detalles en
CLAUDE.md §"Acceso SSH a producción". **Para esta rama, prod es solo de consulta.**

---

## 7. Cuando un hito esté probado y confirmado

El **merge a `main`/`para_produccion` y el deploy los decide el usuario.** Cuando lo
autorice: `main` ← `seguridad2` (fast-forward o merge), luego `para_produccion` y
deploy (ver CLAUDE.md §Producción). Hasta entonces, todo se queda en `seguridad2`.
