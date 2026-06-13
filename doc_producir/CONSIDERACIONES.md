# Consideraciones críticas de producción — DentalKiosco

> Lecciones aprendidas y trampas reales encontradas al desplegar. **Leer antes de
> tocar producción.** Estos puntos NO son obvios desde el código.

---

## 1. Hetzner bloquea SMTP saliente 465 y 25 → usar 587
El servidor de Hetzner **no puede salir por los puertos 25 ni 465** (timeout). Solo
**587 (STARTTLS)** funciona. Por eso en `.env`: **`SMTP_PORT=587`**.
El código hace `secure = (SMTP_PORT === 465)`, así que con 587 usa STARTTLS automático.
Síntoma si está mal: OTP/correos fallan con `Connection timeout` (command CONN).

## 2. Cloudflare Turnstile es OBLIGATORIO con NODE_ENV=production
`config.ts` aborta el arranque si `NODE_ENV=production` y falta `TURNSTILE_SECRET`.
Hay que tener `TURNSTILE_SECRET` + `TURNSTILE_SITEKEY` en `.env` (widget creado en
Cloudflare para el hostname). El frontend renderiza el widget desde
`/public/bootstrap.turnstile_sitekey`. Sin esto: la API no levanta, o el login de
paciente da "completa la verificación de seguridad" sin mostrar nada.

## 3. La fila `clinic` (singleton id=1) NO se crea sola — hueco de producto
Las migraciones crean la tabla pero **no insertan fila**; `seed` se niega a correr en
prod; `setup.js`/installer solo hacen migrate + create-admin; y el panel admin solo
hace `UPDATE ... WHERE id=1` (nunca INSERT). Resultado en un deploy nuevo:
- `/admin/clinic` → 503 NOT_CONFIGURED → "Error al cargar la configuración".
- Dentistas: sin token en la fila → `isMockMode(null)=true` → muestra **dentistas MOCK**.

**Solución actual:** crear la fila a mano (INSERT mínimo: `legal_name, display_name,
nit, license_key`) o migrar la config desde otro entorno (pg_dump de `clinic` +
`dentist_photos`, reescribiendo rutas a `/app/uploads`). El **token Dentalink** se
guarda cifrado: `SET LOCAL app.encryption_key='<ENCRYPTION_KEY>'; UPDATE clinic SET
dentalink_token_encrypted = fn_encrypt('<token>') WHERE id=1;`
**Mejora pendiente:** comando `setup.js create-clinic` o auto-crear al primer arranque.

## 4. Volumen de uploads (persistencia de fotos/standby)
El servicio `api` necesita un volumen o las fotos de dentistas y el video de standby
se **pierden al reconstruir**. Ya está en `docker-compose.prod.yml`:
`api.volumes: - ./apps/api/uploads:/app/uploads`. Permisos: `chown -R 1001:1001 apps/api/uploads`
(el contenedor corre como uid 1001).

## 5. CSP del Caddyfile: permitir Cloudflare y blob:
La CSP del kiosco (en `Caddyfile.prod`) debe incluir:
- `script-src/connect-src/frame-src https://challenges.cloudflare.com` → si no, el
  widget Turnstile no carga.
- `img-src ... blob:` y `media-src 'self' blob:` → si no, el **video/GIF de standby
  no se reproduce** (el frontend usa `URL.createObjectURL(blob)`).
Ya está aplicado en la rama `para_produccion`.

## 6. Entrega de correos a Gmail (SPF/DKIM) — códigos en spam
El sistema envía bien (mail.2ways.us acepta con `250 OK`), pero Gmail puede mandar los
correos automáticos a **spam** si el dominio `2ways.us` no tiene **SPF/DKIM/DMARC**.
Síntoma: el código de recuperación de contraseña "no llega" (está en spam).
**Acción:** en cPanel → **Email Deliverability** revisar/Reparar SPF y DKIM de
`2ways.us`; agregar/validar registros TXT en el Zone Editor. Mientras tanto, marcar
el remitente como "No es spam". (Verificado: el envío y la entrega funcionan; era spam.)

## 7. Wompi en PRODUCCIÓN = pagos reales
`.env` tiene `WOMPI_ENVIRONMENT=production`, `WOMPI_API_URL=https://production.wompi.co/v1`,
`DEV_MOCK_WOMPI=false` y llaves `pub_prod_`/`prv_prod_`. Cualquier pago de prueba
**cobra dinero real**. El token Dentalink y Wompi viven distinto: **Dentalink se lee de
la fila `clinic` (DB), no del `.env`**; Wompi se lee del `.env`.

## 8. Cambio y recuperación de contraseña admin
- Panel: sección **"Cambiar contraseña"** + **"¿Olvidaste tu contraseña?"** (código de
  6 dígitos por correo; en Redis hasheado, TTL 15 min, máx 5 intentos, rate-limit IP).
- Requisitos de contraseña: ≥10, con mayúscula, minúscula, dígito y carácter especial.
- **Reset manual** (si se pierde acceso), ejecutando dentro del contenedor:
  ```bash
  # script de un solo uso en /app/uploads/resetpw.mjs (importa hashPassword + db)
  $CP exec -T -e NEWPASS="<nueva>" -e ADMINEMAIL="<correo>" api node /app/uploads/resetpw.mjs
  ```
  (hashea con argon2id y hace UPDATE admins; ver historial de la sesión.)
- NO se fuerza el cambio en el primer login (decisión de diseño).

## 9. ENCRYPTION_KEY — no cambiar
Cifra datos en reposo (token Dentalink, etc.) con pgcrypto. Si se cambia, lo ya
cifrado deja de descifrarse. No tocar salvo migración planificada.

## 10. CORS
En producción `apps/api/src/server.ts` usa `origin: false` (los frontends son
mismo-origen vía Caddy). Ya aplicado en `para_produccion`.

## 11. Fixes de build/Docker ya incluidos en `para_produccion`
- `tsconfig.base.json` copiado a `apps/api/` + `extends` local + `COPY` en Dockerfile
  (el contexto de build `./apps/api` no veía `../../tsconfig.base.json`).
- `COPY migrations ./migrations` en el stage runtime del Dockerfile
  (si no, `migrate.js` falla con `ENOENT /app/migrations`).
- `vite.config.js` admin con `base: '/admin/'`.
- Caddyfile admin: `root /srv` + `try_files {path} /admin/index.html`.

## 12. Aviso de privacidad (Habeas Data) — vive en la fila `clinic`, no en código
El texto del aviso está en `clinic.habeas_data_policy_text` (no lo gestiona el panel
admin). Al cambiar el texto hay que **recalcular el hash** `sha256(texto)` en
`clinic.habeas_data_policy_hash` (el login de paciente valida que el hash enviado por
el frontend coincida con este; además se guarda en cada `habeas_data_consents` como
prueba de qué texto aceptó el paciente) y **subir la versión** en
`clinic.habeas_data_policy_version` (así los pacientes reconsienten el texto nuevo).

Texto legal vigente en producción (aplicado 2026-06-13, versión `v1.0`):
> En cumplimiento de la Ley Estatutaria 1581 de 2012 (Régimen General de Protección de
> Datos Personales), el Decreto 1377 de 2013 y demás normas concordantes vigentes en
> Colombia, los datos aquí recolectados serán tratados de forma segura y confidencial
> para la gestión de su atención.

Para reaplicarlo en un deploy nuevo (el hash debe ser el sha256 exacto del texto):
```bash
CP="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
TXT="En cumplimiento de la Ley Estatutaria 1581 de 2012 (Régimen General de Protección de Datos Personales), el Decreto 1377 de 2013 y demás normas concordantes vigentes en Colombia, los datos aquí recolectados serán tratados de forma segura y confidencial para la gestión de su atención."
HASH=$(printf '%s' "$TXT" | sha256sum | cut -d' ' -f1)
$CP exec -T postgres psql -U dentalkiosco -d dentalkiosco <<SQL
UPDATE clinic SET
  habeas_data_policy_text = '$TXT',
  habeas_data_policy_hash = '$HASH',
  habeas_data_policy_version = 'v1.0'
WHERE id = 1;
SQL
```
(hash vigente: `b0a39df1982ca1473814092870b24328bef18b58609351ac5e56e7ae758691e0`).
