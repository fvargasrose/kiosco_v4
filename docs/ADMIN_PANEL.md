# DentalKiosco — Panel de Administración

## Acceso

El panel admin es una aplicación separada del kiosco. En desarrollo corre en:

```
http://localhost:5174
```

Para arrancarlo:

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
pnpm --filter @dentalkiosco/admin-frontend dev
```

> El backend debe estar corriendo en `localhost:3000` previamente.

---

## Flujo de login (primera vez)

El primer login de un admin nuevo tiene **dos fases** porque MFA es obligatorio
pero aún no está configurado:

```
1. Ingresar email + contraseña
       ↓
   { mfa_enrollment_required: true }
       ↓
2. El panel muestra un QR → escanearlo con Google Authenticator (u otra app TOTP)
       ↓
3. Ingresar el código de 6 dígitos que aparece en la app
       ↓
4. El panel guarda los códigos de recuperación → COPIARLOS y guardarlos en un lugar seguro
       ↓
5. Sesión activa (token guardado en localStorage)
```

A partir del segundo login:

```
1. Ingresar email + contraseña
       ↓
2. Ingresar código TOTP de la app de autenticación (válido 30 s)
       ↓
3. Sesión activa
```

---

## Crear un usuario admin

### Opción 1 — Seed de desarrollo (más rápido)

Crea un admin de demo junto con una clínica y un kiosco de prueba.
**Solo para entorno de desarrollo.**

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api seed
```

Credenciales que crea:

| Campo | Valor |
|-------|-------|
| Email | `admin@demo.local` |
| Contraseña | `Admin1234!` |
| Rol | `admin` |
| MFA | No configurado (debes enrollarlo en el primer login) |

> El seed es idempotente para el admin demo; si ya existe, actualiza el hash de contraseña.

---

### Opción 2 — Script one-off con `tsx` (recomendado para producción)

Crea un archivo temporal, ejecútalo y bórralo:

```bash
cat > /tmp/create-admin.ts << 'EOF'
import 'dotenv/config';
import { db } from './apps/api/src/lib/db.js';
import { createAdmin } from './apps/api/src/routes/admin-auth.js';

const id = await createAdmin({
  email:    'tuusuario@tudominio.com',
  password: 'CambiaMeEnElPrimerLogin!',
  fullName: 'Tu Nombre Completo',
  role:     'admin',
});
console.log('Admin creado, id:', id);
await db.pool.end();
EOF

DOTENV_CONFIG_PATH=$(pwd)/.env npx tsx /tmp/create-admin.ts
rm /tmp/create-admin.ts
```

La función `createAdmin` usa `ON CONFLICT (email) DO UPDATE`, así que si el
email ya existe actualiza solo el `password_hash`.

---

### Opción 3 — SQL directo en PostgreSQL

Útil cuando el API no está disponible (bootstrap inicial, restore de BD, etc.).
Requiere generar el hash argon2id por separado.

**Paso 1** — Generar el hash de la contraseña:

```bash
node -e "
import('argon2').then(argon2 =>
  argon2.hash('TuContraseñaAqui', {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  }).then(h => console.log(h))
);
"
```

**Paso 2** — Insertar en la BD:

```bash
psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco
```

```sql
INSERT INTO admins (
  email, password_hash, full_name, role,
  mfa_enrolled, mfa_required, must_change_password
)
VALUES (
  'admin@tudominio.com',
  '$argon2id$v=19$m=65536,...',  -- pegar el hash del paso 1
  'Nombre Completo',
  'admin',
  false,   -- MFA pendiente de configurar
  true,    -- MFA requerido
  true     -- forzar cambio de contraseña en primer login
);
```

---

## Roles disponibles

| Rol | Permisos |
|-----|---------|
| `admin` | Acceso completo: configuración clínica, odontólogos, kiosks |
| `viewer` | Solo lectura (futuro — actualmente no implementado en el frontend) |

---

## Seguridad

| Mecanismo | Detalle |
|-----------|---------|
| Contraseñas | Argon2id (memory=64MB, time=3, parallelism=4) |
| MFA | TOTP (RFC 6238) — Google Authenticator, Authy, 1Password, etc. |
| Sesión | JWT firmado con `JWT_SECRET`, dura hasta que el admin cierra sesión |
| Bloqueo | Tras N intentos fallidos (configurable en `.env`) → cuenta bloqueada N min |
| Challenge MFA | Token en memoria del proceso, expira en 5 min; se pierde si el API se reinicia |
| Códigos de recuperación | 10 códigos de un solo uso, mostrados **solo durante el enrollment** |

---

## Recuperar acceso si se pierde el autenticador

No hay flujo de reset de MFA en el panel. Hacerlo directamente en la BD:

```bash
psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco
```

```sql
-- Resetear MFA (el admin deberá volver a enrollarlo en su próximo login)
UPDATE admins
SET mfa_enrolled = false,
    totp_secret_encrypted = NULL,
    totp_recovery_codes_encrypted = NULL,
    failed_login_attempts = 0,
    locked_until = NULL
WHERE email = 'admin@tudominio.com';
```

---

## Desbloquear una cuenta bloqueada

```sql
UPDATE admins
SET failed_login_attempts = 0,
    locked_until = NULL
WHERE email = 'admin@tudominio.com';
```

---

## Ver admins existentes

```sql
SELECT id, email, full_name, role,
       mfa_enrolled, is_active,
       last_login_at, last_login_ip,
       failed_login_attempts, locked_until
FROM admins
WHERE deleted_at IS NULL
ORDER BY created_at;
```

---

## Desactivar o eliminar un admin

```sql
-- Desactivar (soft — el email queda reservado)
UPDATE admins SET is_active = false WHERE email = 'admin@tudominio.com';

-- Eliminación lógica
UPDATE admins SET deleted_at = now() WHERE email = 'admin@tudominio.com';
```

---

## Funcionalidades actuales del panel

| Sección | Qué hace |
|---------|---------|
| **Configuración clínica** | Nombre, subtítulo y modo de la pantalla de espera del kiosco (mensaje de texto / GIF / video). Subir o eliminar el archivo de media. |
| **Odontólogos** | Lista todos los odontólogos de Dentalink. Permite subir, reemplazar o eliminar la foto de cada uno (JPEG/PNG/WebP, máx 5 MB). Las fotos aparecen en el kiosco al agendar cita. |

---

## Tokens de aplicación para otros servicios

El panel admin no genera tokens de kiosco directamente (eso está pendiente en
el Hito 9 completo). Para generar un token de kiosco manualmente ver la sección
**"Conectar al kiosco"** en `guia.md`.
