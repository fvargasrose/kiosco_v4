# Plan — Gestión de credenciales del panel admin

> Estado: **propuesta aprobada para diseño, pendiente de implementar.**
> No requiere auto-registro de admins. Sistema llave en mano.

## Contexto / hallazgos (verificados en código)

| Pieza | Situación actual |
|---|---|
| Creación del admin | `installer/install.sh` pide email+clave, los guarda en `.env` (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) y llama `setup.ts create-admin`, que inserta con `must_change_password=true` |
| Cambio de clave desde el panel | ❌ No existe (no hay endpoint `change-password` ni pantalla en `admin-frontend`) |
| `must_change_password` | Se guarda y se devuelve en el login, pero el frontend lo ignora — flag muerto |
| Reset / recordatorio por correo | ❌ No existe (sin endpoint, sin tabla de tokens, sin columnas) |
| Reutilizable | `hashPassword`/`verifyPassword` (argon2id), `getEmailSender()` (SMTP), `audit()`, `fn_rate_limit_check`, `requireAdmin`, `boolEnv()`, `admins.phone`/`last_password_change` |

**Restricción clave:** la contraseña es argon2id (hash irreversible) → no se puede "enviar un recordatorio con la clave". El correo **restablece**, no recuerda.

## Decisiones aplicadas

- Incluir **ambos** mecanismos: cambio autenticado **+** restablecimiento por correo.
- Restablecimiento por correo mediante **enlace de un solo uso** (magic link).
- `must_change_password`: **no se fuerza** — el cambio es voluntario (el primer login entra directo).
- Sin auto-registro: ningún endpoint crea cuentas.
- Conmutable por `.env` (feature flag).

## 1. Migración nueva `018_admin_password_reset.sql`

```sql
admin_password_resets(
  id uuid pk, admin_id uuid fk→admins,
  token_hash text not null,        -- token aleatorio, guardado hasheado
  expires_at timestamptz not null, -- TTL ~30 min
  consumed_at timestamptz,
  request_ip inet, created_at timestamptz default now()
)
```

Cerrar con:
```sql
INSERT INTO schema_migrations (version, name)
VALUES ('018', 'admin_password_reset') ON CONFLICT DO NOTHING;
```

## 2. Backend — `apps/api/src/routes/admin-auth.ts`

- **`POST /admin/auth/change-password`** (`requireAdmin`): `{ current_password, new_password }`
  → verifica actual, valida fuerza (≥12), `hashPassword`,
  `UPDATE password_hash, last_password_change=now(), must_change_password=false`.
  Audita `admin.password.changed`. Opción: revocar otras sesiones (blocklist).
- **`POST /admin/auth/password-reset/request`** (público, gated por flag): `{ email }`
  → rate-limit (`fn_rate_limit_check`) + anti-enumeración (siempre 200).
  Si el admin existe: genera token aleatorio, guarda `token_hash` con TTL,
  envía correo con enlace `${PUBLIC_BASE_URL}/admin/#/reset?token=…` vía `getEmailSender()`.
- **`POST /admin/auth/password-reset/confirm`** (público, gated): `{ token, new_password }`
  → valida token vigente/no consumido, fija clave, `consumed_at=now()`, audita `admin.password.reset`.
  **MFA:** si el admin tiene `mfa_enrolled`, exigir también `code` TOTP en este paso (recomendado).

## 3. Config — `apps/api/src/lib/config.ts`

- `ADMIN_PASSWORD_RESET_EMAIL: boolEnv(false)` (usar `boolEnv`, nunca `z.coerce.boolean`).
- Si `false`: endpoints de reset deshabilitados y el frontend oculta el enlace.
- Exponer el flag en el bootstrap del admin (mostrar/ocultar "¿Olvidaste tu contraseña?").

## 4. Frontend admin — `apps/admin-frontend/src/`

- Nueva pantalla **"Cambiar contraseña"** (config/perfil) → `change-password`.
- En `login.js`: enlace **"¿Olvidaste tu contraseña?"** (solo si el flag está activo)
  → pantalla que pide email → `password-reset/request`.
- Nueva ruta **`/reset`** que lee `?token=` → formulario nueva clave → `password-reset/confirm`.
- Cliente HTTP en `api.js` para los 3 endpoints.

## 5. Llave en mano / installer

- `ADMIN_PASSWORD_RESET_EMAIL=true` **exige SMTP válido** (`SENDER_*`) — misma dependencia
  que el error `535 Incorrect authentication data` detectado; el correo va a `admins.email`.
- Añadir la var a `.env.example` y, opcionalmente, preguntarla en `install.sh`.

## 6. Seguridad transversal

- Tokens aleatorios (≥32 bytes), almacenados hasheados, un solo uso, expiración corta.
- Rate-limit por email/IP en `request`. Auditoría en cada paso. No revelar existencia del email.

## 7. Orden y verificación

1. Migración 018 → `migrate` + `migrate:verify`.
2. Backend + tests Vitest (SMTP en mock).
3. Flag en `config.ts`.
4. Frontend (3 vistas + `api.js`).
5. Verificación (CLAUDE.md §5): `typecheck`, `test`, `lint`, `build` kiosco-frontend, `build` admin-frontend.
6. Un commit por tarea (`feat(admin): …`).

## Pendiente menor a confirmar al implementar

- **MFA en el reset:** recomendación = exigir TOTP en `password-reset/confirm` si el admin
  tiene MFA enrollado (evita saltar el 2º factor con solo acceso al correo).

---

## Nota relacionada (sesión 2026-06-06)

El envío de OTP por correo fallaba por **SMTP `535 Incorrect authentication data`**
(credenciales de `notificaciones@2ways.us` rechazadas por `mail.2ways.us:465`).
El pipeline (Dentalink lookup, generación OTP, SMTP alcanzable) funciona; solo falta
corregir `SENDER_PASSWORD` en `.env` y reiniciar la API.
Twilio quedó aislado: las 3 vars (`TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER`) vacías
→ `MockSmsSender` (no opera SMS, solo correo). Respaldo del `.env` en `.env.bak.*`.
