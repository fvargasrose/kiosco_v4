# Plan de seguridad por hitos — DentalKiosco

> Plan **incremental y reversible** para endurecer la seguridad **sin romper
> nada funcional**. Cada hito es independiente, con su verificación y rollback.
> Base verificada: código en `064a938` (rama `mejora_17jun` = `main` =
> `para_produccion`, desplegada en prod). Fecha: 2026-06-18.
>
> **Puerta de verificación obligatoria al cerrar cada hito** (CLAUDE.md §5):
> `typecheck` + `test` (287) + builds de ambos frontends. Probar en local contra
> servicios reales antes de subir. Deploy a prod solo tras eso.

---

## Estado actual de riesgos (verificado)

| # | Riesgo | Severidad | Estado hoy |
|---|--------|-----------|-----------|
| R1 | Secretos en disco/repo (`credenciales.md`, `.env.bak.*`) | 🔴 Alta | **Parcialmente mitigado**: `.gitignore` cubre y `credenciales.md` borrado; faltan rotación + sacar `.env.bak.*` |
| R2 | MFA del admin desactivada | 🔴 Alta | **Mitigado interino**: `mfa_required=true` en prod (hoy fuerza **TOTP**; el usuario prefiere código por email → Hito 4b) |
| R3 | Login `cédula + teléfono` sin OTP (`OTP_REQUIRED=false`) | 🟡 Media (latente) | **No activo**: `login-direct` ya fue eliminado del backend; `OTP_REQUIRED=true` en prod. El flag quedó **muerto y engañoso** |
| R4 | `cedula_hash` con SHA256 sin sal (reversible por fuerza bruta) | 🟡 Media | Presente en código y prod |
| R5 | `app.encryption_key` inyectada por interpolación de string | 🟢 Baja | Presente (mitigada con chequeo de comillas) |
| R6 | Gestión de usuarios admin pobre (sin UI, sin cambio de email, sin roles) | 🟡 Media | Solo CLI en server + reset por email |
| R7 | TTL token kiosco 90 días; revisar CSP/CORS en prod | 🟢 Baja | Funcional; revisar |

> **Nota sobre R3:** hoy NO existe el endpoint `login-direct` y el frontend web
> exige OTP siempre (`login-cedula.js` "Opción A"). Poner `OTP_REQUIRED=false`
> hoy NO crea un login inseguro (no hay quién lo implemente), pero el flag sigue
> expuesto en `/kiosk/bootstrap` y `/public` y documentado como si funcionara.
> El riesgo real es que alguien lo **reintroduzca** sin las defensas. El plan lo
> elimina limpiamente (Hito 2).

---

## Hito 1 — Higiene de secretos (cerrar R1)

**Objetivo:** que ningún secreto viva en el repo/disco de trabajo y rotar lo que
pudo quedar expuesto.

**Cambios:**
1. ✅ (hecho) `.gitignore` cubre `credenciales*.md`, `*credencial*`, `.env.bak*`,
   `*.bak*`. Desplegado a prod.
2. Borrar copias en claro de disco:
   - Local: `rm .env.bak.*`
   - Server: `rm /opt/dentalkiosco/.env.bak.*` (quedan `.env` 0600 como fuente única)
3. Mover `credenciales.md` a un gestor de secretos (Bitwarden/1Password/Vault) — NO al repo.
4. **Rotación** (solo si se sospecha exposición previa; rotar en este orden):
   `JWT_SECRET` → invalida sesiones admin/paciente (re-login, sin pérdida de datos);
   llaves Wompi (`WOMPI_PRIVATE_KEY`, `WOMPI_EVENTS_SECRET`) → coordinar con Wompi;
   passwords Postgres/Redis/SMTP. **`ENCRYPTION_KEY` aparte** (ver Hito 5: requiere
   re-cifrado de datos — NO rotar a la ligera).

**Verificación:** `git status` sin secretos untracked (local y server);
`git check-ignore` IGNORED para los archivos sensibles; login admin/paciente OK
tras rotar `JWT_SECRET`; un pago de prueba aprueba (webhook + reconciliador).

**Rollback:** restaurar valores previos del `.env` desde el gestor de secretos.

**No rompe nada:** rotar `JWT_SECRET` solo obliga a re-login. Datos intactos.

---

## Hito 2 — Eliminar el flag muerto `OTP_REQUIRED` (cerrar R3)

**Objetivo:** quitar la superficie engañosa del login sin-OTP. Decidir primero:

> **DECISIÓN REQUERIDA:** ¿se quiere alguna vez el login "cédula + teléfono sin
> OTP"? **Recomendación: NO** (el OTP es la garantía de identidad). Si la respuesta
> es no, ejecutar este hito. Si fuera sí, NO reintroducir `login-direct`: diseñar
> con OTP obligatorio + binding al dispositivo de kiosco.

**Cambios (opción "eliminar"):**
- Quitar `OTP_REQUIRED` de `config.ts` (línea 123).
- Quitar `otp_required` de `public.ts:109` y `kiosk.ts:176`.
- Quitar la bifurcación/menciones en frontend (`login-cedula.js`, `api.js`,
  `kiosk.ts` bootstrap) y la doc obsoleta de CLAUDE.md sobre login-direct.

**Verificación:** typecheck + tests + builds. Login web y kiosco siguen pidiendo
OTP (sin cambios de comportamiento, solo se borra código muerto). Smoke test de
login en local.

**Rollback:** revertir el commit (cambio aislado).

**No rompe nada:** se elimina código que hoy no tiene efecto (OTP ya obligatorio).

---

## Hito 3 — Endurecer hash de cédula (cerrar R4)

**Objetivo:** que `cedula_hash` no sea reversible por fuerza bruta si se filtra la BD.

**Cambios:**
- Migración **018**: añadir columna `cedula_hash_v2` (o re-uso con flag de versión).
- Nuevo `CEDULA_PEPPER` (≥32 chars) en `.env` (secreto, fuera del repo).
- `hashCedula()` (`otp.ts:57`) → `HMAC-SHA256(cedula, CEDULA_PEPPER)` (o argon2).
- **Migración de datos progresiva** (sin downtime): escribir ambos hashes en cada
  alta/consulta; backfill por lote; cuando todo esté migrado, quitar el viejo en
  una migración 019.
- Afecta lookups en `otp_codes.patient_cedula_hash` y
  `habeas_data_consents.cedula_hash`.

**Verificación:** tests de OTP y Habeas Data; verificar que un paciente existente
sigue reconociéndose (consentimiento previo) durante la fase de doble escritura.

**Rollback:** mientras haya doble columna, volver a usar la vieja. No borrar la
columna vieja hasta confirmar 100% migrado.

**No rompe nada (si se hace por fases):** la doble escritura mantiene compatibilidad.
⚠️ Es el hito más delicado: NUNCA reemplazar el hash de golpe (rompería el
reconocimiento de pacientes/consentimientos existentes).

---

## Hito 4 — Gestión de usuarios admin + 2FA por email (cerrar R6, ajustar R2)

**Objetivo:** administrar usuarios desde el panel y reemplazar el 2º factor por
**código enviado al correo** (en vez de TOTP/QR, por decisión del usuario).

**Estado actual (verificado):**
- ✅ Cambiar la propia contraseña: `POST /admin/auth/change-password` (pide la actual).
- ✅ Recuperación por email: `forgot-password` → código 6 díg. (15 min) → `reset-password`
  (UI "¿Olvidaste tu contraseña?" en `login.js`; email **configurado en prod**).
- ✅ Crear admin: solo por CLI en el server (`setup.ts create-admin`, idempotente
  `DO NOTHING`) o la función `createAdmin()` (`DO UPDATE` el password).
- ⚠️ El único 2º factor implementado hoy es **TOTP (app autenticadora + QR)**.
- ❌ **No hay UI/endpoint** para crear admins, invitar, asignar roles, desactivar
  ni **cambiar el email/usuario** (eso hoy solo es SQL directo en el server).

### 4a. Pantalla "Usuarios" en `admin-frontend` (CRUD)

Opciones concretas a añadir al frontend admin (confirmadas):
- **Listar** usuarios: email, nombre, rol, activo/inactivo, último login, estado 2FA.
- **Crear** usuario: campos email, nombre, teléfono, rol (`admin` | `viewer`).
  Nace con `must_change_password=true` y se le envía un **código/temporal por email**.
- **Editar**: cambiar rol, activar/desactivar (`is_active`/`deleted_at` = baja lógica).
- **Cambiar email/usuario propio**: con re-autenticación (pide contraseña actual).
- **Resetear contraseña de otro usuario** (acción de admin): dispara el envío de
  código por correo (reusa el flujo `forgot-password`).
- **Restricciones de seguridad**: no auto-desactivarse, no quitarse el último rol
  `admin`, password policy (`validatePasswordStrength`), todo a `audit_log`.

Backend: endpoints protegidos (`requireAdmin` + rol `admin`) para list/create/
update/deactivate/change-role/change-email. Unificar `setup.ts` y `createAdmin()`
(hoy difieren en `ON CONFLICT`: `DO NOTHING` vs `DO UPDATE password`).

### 4b. 2FA por código de email (reemplazo de TOTP)

Por preferencia del usuario, el 2º factor será **un código enviado al correo**,
no TOTP/QR:
- Reusar la infraestructura ya existente de `forgot-password` (código 6 díg.,
  hash SHA256 en Redis, TTL 15 min, rate-limit, máx. intentos).
- Nuevo flujo de login: password OK → enviar código al email → verificar código →
  emitir sesión con `mfa_verified=true`.
- Sustituye el enrolamiento TOTP (`mfa/enroll-start`, `enroll-confirm`,
  `mfa/verify` en `admin-auth.ts`); el QR ya no se usa.
- `mfa_required=true` deja de implicar "enrolar TOTP" y pasa a "exigir código de
  email en cada login" (o cada N días / dispositivo nuevo, configurable).

> ⚠️ **Trade-off (documentado):** el código por email es más simple de usar pero
> **más débil** que TOTP: si el correo se compromete, se compromete el 2º factor;
> y depende de la entrega de email. TOTP no depende de la red y resiste phishing
> mejor. Aun así, es una opción válida y consistente con la recuperación actual.

> **Interino (R2):** hoy dejé `mfa_required=true`, que con el código actual fuerza
> **enrolar TOTP** en el próximo login. Como no quieres TOTP, hay que decidir el
> puente hasta tener 4b (ver "Decisiones").

**Verificación:** tests de los nuevos endpoints (autorización por rol, no
auto-desactivarse, password policy) y del flujo 2FA por email (código correcto/
incorrecto/expirado, rate-limit); builds; smoke test de login completo en local.

**Rollback:** endpoints aditivos; el 4b se puede activar tras un flag para volver a
TOTP si hiciera falta. Revertir commit.

**No rompe nada:** 4a es funcionalidad nueva. En 4b, mantener TOTP como fallback
detrás de un flag durante la transición evita dejar a nadie sin acceso.

---

## Hito 5 — Cifrado en reposo más robusto (cerrar R5)

**Objetivo:** evitar interpolar la clave en SQL.

**Cambios:** en `crypto.ts`, pasar `app.encryption_key` como parámetro de
`set_config('app.encryption_key', $1, true)` en vez de interpolar en `SET LOCAL`.
Severidad baja; tocar con cuidado (módulo cripto).

**Verificación:** tests que cifran/descifran (tokens Dentalink/Wompi) siguen OK;
typecheck. Probar en local que el panel lee/escribe la config de clínica.

**Rollback:** revertir commit.

**No rompe nada:** mismo algoritmo y misma clave; solo cambia cómo se pasa.
⚠️ NO cambiar `ENCRYPTION_KEY` aquí (eso es rotación, requeriría re-cifrar datos).

---

## Hito 6 — Revisión de sesiones y borde (cerrar R7)

**Objetivo:** ajustes finos de hardening.

**Cambios:**
- Revisar TTL del token de kiosco (90 d): acortar o reforzar revocación/rotación.
- Confirmar que Caddy envía **CSP** estricta en prod y `origin:false` efectivo
  (ya verificado en imagen; validar también la cabecera servida).
- Revisar cabeceras de seguridad (HSTS, X-Frame-Options) en `Caddyfile.prod`.

**Verificación:** `curl -I https://sistema.2ways.us` muestra CSP/HSTS; login de
kiosco sigue funcionando tras ajuste de TTL.

**Rollback:** revertir cambios de Caddyfile (recargar Caddy).

**No rompe nada:** cambios de cabeceras y TTL son reversibles y no tocan datos.

---

## Orden sugerido de ejecución

1. **Hito 1** (rotación + borrar `.env.bak`) — rápido, alto impacto.
2. **Hito 2** (eliminar flag muerto) — rápido, requiere tu decisión.
3. **Hito 4** (gestión de usuarios) — feature útil, aislado.
4. **Hito 6** (cabeceras/TTL) — rápido.
5. **Hito 5** (cripto param) — bajo riesgo.
6. **Hito 3** (hash cédula) — el más delicado, al final y por fases.

## Usuario admin por defecto (verificado)

- **Producción NO tiene un usuario/clave por defecto hardcodeado.** El installer
  (`installer/install.sh`) **pregunta** el email y la contraseña del admin al
  instalar (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, líneas 354/365) y crea esa cuenta con
  `setup.ts create-admin`. En esta instalación el admin es `partners2ways@gmail.com`
  (único admin en la BD de prod).
- La **contraseña** se puede cambiar cuando quieras (panel / recuperación por email).
- El **email/usuario** hoy solo se cambia por SQL directo; tener un botón para
  cambiarlo es parte del **Hito 4a**.
- El admin de demo `admin@demo.local` / `Admin1234!` vive en `apps/api/src/seed.ts`
  y es **solo para desarrollo** — no existe en producción.

## Decisiones que necesito de ti antes de implementar
- **R3/Hito 2:** ¿eliminamos el login sin-OTP para siempre? (recomendado: sí)
- **MFA interino (R2):** hoy `mfa_required=true` fuerza TOTP en el próximo login.
  Como prefieres código por email, ¿cuál de estas opciones para el puente hasta el
  Hito 4b?
  - (a) **Revertir `mfa_required=false`** ahora (sin 2FA temporalmente) y construir
    ya el 2FA por email. *Reabre R2 unos días.*
  - (b) **Dejar TOTP como stopgap** (enrolas una vez con una app tipo Google
    Authenticator) hasta tener el código por email. *Más seguro en el ínterin.*
- **Hito 1:** ¿rotamos secretos ahora (asumiendo posible exposición) o solo
  prevenimos a futuro?
- **Hito 4:** ¿roles necesarios (`admin`/`viewer`) y quién puede crear usuarios?

> Ningún hito se implementa en este documento; es el plan. Al ejecutarlos se
> seguirá la puerta de verificación y se probará en local antes de tocar prod.
