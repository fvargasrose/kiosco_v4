# Informe de seguridad — DentalKiosco (producción)

> **Alcance:** cómo está protegido HOY el sistema en producción
> (`https://sistema.2ways.us`, Hetzner) ante ataques y robo de información.
> **Base:** código en `f984073` (rama `mejora_17jun`, desplegada en prod).
> **Fecha:** 2026-06-18. Las afirmaciones citan el archivo fuente verificado.

---

## 1. Resumen ejecutivo

El sistema tiene una **base de seguridad sólida** en autenticación, cifrado en
reposo y anti-abuso: contraseñas con argon2id, OTP hasheado, JWT con expiración y
revocación, rate-limiting en Redis, cifrado de tokens sensibles con pgcrypto,
redacción de secretos en logs, webhook de pagos con firma HMAC y TLS gestionado
por Caddy.

⚠️ **Pero hay riesgos altos que opacan lo anterior**, todos relacionados con
**manejo de secretos en el repositorio** (ver §7). El más grave: el archivo
`docs/credenciales.md` (con la clave de cifrado de producción, llaves privadas de
Wompi y contraseñas de BD) **no está en `.gitignore`** y podría commitearse por
error. Si eso ocurre, un atacante con acceso al repo puede **descifrar todos los
datos en reposo** y operar pagos. Atender §7 es prioritario.

| Área | Estado |
|------|--------|
| Transporte (TLS) | ✅ Bueno |
| Autenticación (admin/paciente/kiosco) | ✅ Bueno |
| Cifrado en reposo | ✅ Bueno (con matiz, §6) |
| Anti-abuso / rate-limit | ✅ Bueno |
| Integridad de pagos | ✅ Bueno |
| Logging / PII | 🟡 Bueno con un matiz (cédula, §5) |
| **Gestión de secretos** | 🔴 **Riesgo alto** (§7) |
| MFA del admin | 🔴 **Desactivada hoy** (§4) |

---

## 2. Transporte y borde

- **TLS automático** con Caddy 2 + Let's Encrypt (`infra/caddy/Caddyfile.prod`).
- **Cloudflare** delante (DNS + WAF) y **Turnstile** anti-bot en el envío de OTP
  web (`apps/api/src/lib/turnstile.ts`, verificación server-side vía siteverify).
- API detrás de proxy: `trustProxy: true` (`server.ts:48`) → la IP real llega por
  `X-Forwarded-For` para el rate-limit.
- **helmet** activo (`server.ts:58`); CSP delegada a Caddy.
- **CORS** restrictivo en código: `origin: false` (`server.ts:66`) — solo Caddy
  decide orígenes. (Nota: el comentario advierte revertir si en dev se reflejó el
  origin; en prod debe quedar `false`.)

---

## 3. Autenticación y sesiones

| Sujeto | Mecanismo | TTL | Revocación |
|--------|-----------|-----|------------|
| **Admin** | password argon2id + **MFA TOTP** | JWT HS256 **8 h** | blocklist por `jti` en Redis (`auth-middleware.ts:57`) |
| **Paciente** | cédula + OTP (o cédula+tel si `OTP_REQUIRED=false`) | JWT **10 min** | `revoked_at` en `patient_sessions` (`patient-middleware.ts`) |
| **Kiosco** | token de pairing | JWT **90 días** | `is_active` / token_hash en tabla `kiosks` |

- **Contraseñas:** argon2id, 64 MB de memoria, timeCost 3 (`passwords.ts:17`) —
  resistente a GPU y side-channel. Hash self-describing.
- **JWT:** HS256 firmado con `JWT_SECRET` (≥32 chars), `jti` único por sesión
  (`jwt.ts`).
- **Bloqueo por fuerza bruta:** 5 intentos fallidos → lock 15 min
  (`RATE_LIMIT_LOGIN_ATTEMPTS_BEFORE_LOCK=5`, `..._LOCKOUT_MINUTES=15`).
- **MFA TOTP:** soportado con QR y recovery codes (`totp.ts`); el guard exige
  `mfa_verified` cuando aplica (`auth-middleware.ts:91`).

---

## 4. OTP (código de un solo uso)

- Código generado server-side; en la BD se guarda solo `sha256(salt:code)`
  (`otp.ts:31`), nunca en claro. TTL **5 min** (`OTP_TTL_MINUTES`).
- **No se loguea en producción** y **no se cachea en Redis** en prod
  (`patient-auth.ts:292` lo limita a `NODE_ENV !== 'production'`). Solo viaja por
  SMS/email real al paciente.
- Límites anti-abuso: **5/teléfono/hora**, **10/IP/hora**, **60/kiosco/hora**
  (`config.ts:60-62`), además del rate-limit global.

> 🔴 **Hallazgo (operativo):** el único admin de producción
> (`partners2ways@gmail.com`) tiene **MFA desactivada** hoy (`mfa_required=false`,
> `mfa_enrolled=false`). La contraseña es la única barrera para el control total
> del panel. **Recomendación:** enrolar TOTP y poner `mfa_required=true`.

---

## 5. Datos personales (PII) y logging

- **Redacción automática** en logs (Pino): passwords, tokens, secrets, TOTP,
  `authorization`, cédula, y campos `*_encrypted` (`logger.ts`, ~30 paths).
- Helpers de máscara: `maskCedula`, `maskPhone`, `maskEmail` para registrar PII
  parcial.
- **Auditoría inmutable:** toda acción sensible se escribe en `audit_log`
  (`audit.ts`).
- **Habeas Data:** consentimientos versionados por `cedula_hash` + versión.

> 🟡 **Hallazgo (medio):** la cédula se indexa con **SHA256 sin clave/sal**
> (`otp.ts:57` `hashCedula = sha256(cedula)`). El espacio de cédulas colombianas
> es pequeño (8–10 dígitos), así que ese hash es **reversible por fuerza bruta**
> si alguien obtiene la BD. **Recomendación:** usar HMAC-SHA256 con una *pepper*
> secreta del entorno (o argon2) para `cedula_hash`. Requiere migración de datos.

---

## 6. Cifrado en reposo

- Tokens y secretos sensibles (token Dentalink, `wompi_events_secret`, secreto
  TOTP) se guardan **cifrados** con `pgp_sym_encrypt` de **pgcrypto**
  (`crypto.ts` + `fn_encrypt/fn_decrypt`, migración 001). La clave llega por
  `app.encryption_key` de sesión, no se persiste en la BD.
- `ENCRYPTION_KEY` vive solo en el `.env` del servidor (≥32 chars).

> 🟡 **Matiz:** la clave se inyecta con `SET LOCAL app.encryption_key = '<clave>'`
> por interpolación de string (`crypto.ts:37`). Está mitigado con un chequeo que
> rechaza comillas en la clave, pero parametrizar la sentencia sería más robusto.
> Riesgo bajo dado el control de la clave.

---

## 7. 🔴 Gestión de secretos — riesgo ALTO (prioritario)

**Lo bueno:** `.env`, `backup2/ssh/` y `backup2/gh-cli/` **sí** están en
`.gitignore` (verificado: `git check-ignore` → IGNORED). No están en el repo.

**Lo grave — archivos con secretos que NO están ignorados** (verificado con
`git check-ignore` → *NOT ignored*; hoy son *untracked*, pero un `git add -A` los
subiría):

| Archivo | Contiene |
|---------|----------|
| `docs/credenciales.md` | **ENCRYPTION_KEY de producción**, llaves privadas Wompi (`prv_prod_...`), passwords de Postgres/Redis/SMTP, datos de acceso SSH |
| `.env.bak.1780752880` | Copia de variables de entorno (secretos) |
| `.env.bak.wompi.1781664707` | Copia con credenciales Wompi |

**Impacto si se filtran o se commitean:** con `ENCRYPTION_KEY` + un dump de la BD
se **descifran todos los datos en reposo**; con las llaves privadas de Wompi se
puede operar contra la pasarela de pagos; con las contraseñas de BD se accede
directo a los datos.

**Recomendaciones (en orden):**
1. **Añadir a `.gitignore` ya:** `docs/credenciales.md`, `.env.bak.*`,
   `*.bak`, y cualquier `*credencial*`. Verificar que nunca entraron al historial
   (`git log --all -- docs/credenciales.md`).
2. **Sacar los secretos del repo de trabajo**: mover `credenciales.md` y los
   `.env.bak.*` a un gestor de secretos o a almacenamiento cifrado fuera del repo.
3. **Rotar** lo que pudo quedar expuesto (especialmente si alguna vez se commiteó):
   `ENCRYPTION_KEY` (implica re-cifrar datos), llaves Wompi, `JWT_SECRET`,
   passwords de BD/Redis/SMTP. *Nota:* rotar `ENCRYPTION_KEY` requiere migración
   de los datos cifrados; planificar con cuidado.
4. **Llave SSH:** la privada vive en `backup2/ssh/` (ignorada, ✅) pero está en el
   disco del repo. Mantenerla solo en `~/.ssh` con permisos 600 y considerar una
   passphrase.

---

## 8. Integridad de pagos

- El **webhook de Wompi** se valida con **firma HMAC SHA256**:
  `sha256(concat(valores) + timestamp + WOMPI_EVENTS_SECRET)` comparada con
  `timingSafeEqual` (`wompi.ts:321-352`). Firma inválida → se registra y rechaza
  (`payments.ts:321`).
- **Defensa en profundidad:** además del webhook, el **reconciliador** (cron 1 min)
  consulta el estado real de las transacciones PENDING contra la API de Wompi
  (`reconciler.ts`). Un webhook perdido o falsificado no descuadra el estado.

---

## 9. Disponibilidad / anti-DoS de aplicación

- **Rate-limit global** en Redis: 300 req/min/IP de backstop, con techos más bajos
  en rutas sensibles (`server.ts:88-108`): `request-otp` 10, `verify-otp` 20,
  `admin/login` 10, `me/payments` 15 (por minuto/IP). `/health` siempre exento.
- **Rate-limit por modo** (kiosco vs web) introducido en `mejora_17jun`
  (`patient-auth.ts`): el modo kiosco —físicamente controlado— tiene límites más
  laxos que el modo web público.
- Límite de subida de archivos: tamaño máx + 1 archivo (`server.ts:71`).
- El rate-limit persiste en Redis (sobrevive reinicios) y en tabla `rate_limits`.

---

## 10. Licencia / control del software

- `licenseMiddleware` como `onRequest` global (`server.ts:112`). Sin heartbeat
  válido el sistema se degrada: normal → restrictivo (escrituras 503) → shutdown
  (todo 503). Limita el uso no autorizado del software.

---

## 11. Plan de acción priorizado

| # | Acción | Severidad | Esfuerzo |
|---|--------|-----------|----------|
| 1 | `.gitignore` para `credenciales.md` + `.env.bak.*`; verificar que no estén en el historial | 🔴 Alta | Bajo |
| 2 | Reactivar **MFA TOTP** del admin de producción | 🔴 Alta | Bajo |
| 3 | Sacar secretos del repo a un vault; rotar lo expuesto | 🔴 Alta | Medio |
| 4 | `cedula_hash` → HMAC con *pepper* (migración) | 🟡 Media | Medio |
| 5 | Parametrizar `app.encryption_key` en vez de interpolar | 🟢 Baja | Bajo |
| 6 | Acortar TTL del token de kiosco (90 d) o reforzar revocación | 🟢 Baja | Bajo |
| 7 | Confirmar CSP servida por Caddy y `origin:false` en prod | 🟢 Baja | Bajo |

---

> Este informe describe el estado observado; no se realizaron cambios en
> producción ni en la base de datos al generarlo (todo fue lectura).
