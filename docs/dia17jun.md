# Punto de continuidad — 17 de junio 2026

> Documento de **handoff** para retomar en una conversación nueva.
> Al iniciar: "revisa `docs/dia17jun.md` y continuemos".

---

## 1. Estado de los entornos

### Producción (Hetzner) — FUNCIONANDO
- Servidor `5.78.110.152` → `https://sistema.2ways.us`.
- Rama desplegada: **`para_produccion`** en commit **`ef0dd59`**.
- Contenedores: `dk-api` healthy, `dk-postgres` healthy, `dk-redis` healthy.
  `dk-caddy` aparece `unhealthy` pero es **FALSA alarma conocida** (su healthcheck interno
  hace `wget` a localhost:80→308; Caddy sirve tráfico 200 normal).
- Salud real: `https://sistema.2ways.us/api/health/ready` → `ready` (db+redis ok).
  Nota: `/health/ready` "pelado" devuelve el HTML del SPA; el JSON vive bajo `/api/*`.
- Deploy se hace por: `git pull` en `/opt/dentalkiosco` + `docker compose -f docker-compose.yml -f docker-compose.prod.yml build api && up -d api`.

### Local (dev) — mismo PC tras reinstalar Ubuntu 22
- Node 22 vive en **nvm**: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22` antes de node/pnpm.
- Postgres host **5434**, Redis host **6381** (override). Proyecto compose = `dentalkiosco`.
- Volúmenes dev restaurados desde `backup2/local/` (datos de prueba).
- **Al cerrar hoy quedaron los contenedores postgres/redis LEVANTADOS** (se encendieron para correr tests).
  Para bajarlos: `docker compose stop postgres redis`. Para levantarlos: `docker compose start postgres redis`.
- Política **TODO REAL**: `DEV_MOCK_EXTERNAL_SERVICES=false`, `DEV_MOCK_WOMPI=false`.
  SMS real (LabsMobile), Dentalink real, email real, Wompi real (creds = prod). Los **tests** siguen en mock (vitest lo fuerza).

### Git — TODO ALINEADO
- Solo existen **2 ramas** (local y remoto): `main` y `para_produccion`, ambas en **`ef0dd59`**.
- Producción corre `para_produccion @ ef0dd59`. Local, `origin/main`, `origin/para_produccion` también en `ef0dd59`.
- Rama actual de trabajo: `para_produccion`.
- Se borraron hoy todas las ramas viejas (hito-*, sistema_abierto, pagos, pagos2_wompi, test_gravity, hito9, hito10)
  tras confirmar que no aportaban commits fuera de `para_produccion`.

---

## 2. Trabajo completado hoy (17 jun)

1. **Fix celular +57 (commit `ef0dd59`)** — desplegado en local, git y producción.
   - Problema: el login por celular no enviaba ni SMS ni correo.
   - Causa: `lookupPatientByCelular` recortaba el `+57` y buscaba en Dentalink con 10 dígitos,
     pero los registros vigentes se guardan **con `+57`** → lookup `null` → rama anti-enumeración
     (`patient-auth.ts:205`) que **no genera ni envía OTP**.
   - Solución (en `apps/api/src/lib/dentalink.ts`): buscar/crear **siempre con `+57`** (vía `normalizeCelular`)
     en `lookupPatientByCelular`, `checkPatientExistsByEmailOrCelular` y `createPatient`.
   - Verificado: typecheck OK, 287/287 tests OK, prod healthy.
   - **Pendiente opcional:** prueba end-to-end real (un `request-otp` que envía SMS/correo reales) con un número conocido.
2. Limpieza de ramas git (ver arriba).

---

## 3. Plan pendiente — `docs/plan_17junio.md`

Mejoras del PDF `docs/lista de aspectos a mejorar.pdf`. Resumen:

- **① Icono "Mis tratamientos" faltante** — causa: `home.apple.js` usa `ti-tooth` que no existe en Tabler v3.44.0
  (es `ti-dental`). Fix de 1 línea. **Fase 1, riesgo nulo.**
- **④ Resumen de agendamiento muy separado** — causa: `.ak-summary-row { justify-content: space-between }`
  en `styles-apple.css`. Fix CSS (pasar a columna). **Fase 1, riesgo bajo.**
- **②③ Modo kiosco vs web** — **MODELO DECIDIDO:**
  - **Modo kiosco** = link generado en el admin con token (`https://sistema.2ways.us/?k=<token>`):
    teclado en pantalla + restricciones de kiosco.
  - **Modo web** = `https://sistema.2ways.us/` sin token: personal (PC/celular), menos restricciones,
    mensaje de intentos suavizado, **+ ajustes responsive para celular**.
  - Hecho técnico clave: el backend YA genera el token (`POST /admin/kiosks`) pero el **frontend lo ignora**.
    Falta: admin muestre el link completo + frontend lea el token de la URL y cambie de modo.
  - `keyboard.js` existe pero **no está cableado** a ninguna pantalla.
- **⑤ Botón "ya estoy aquí en la recepción" (check-in)** — feature nueva; cambia `estado_cita` en Dentalink.
  Necesita saber el `id_estado` de "en recepción" de esta clínica.
- **⑥ Recordatorios desde Dentalink** — ya hay plan detallado en `plan_recordatorios.md` (raíz): T-1 día, SMS+correo, worker.
- ⑦ vacío en el PDF.

### Fases propuestas
1. Visual rápido (① + ④) — listo para arrancar, sin bloqueos.
2. Modo kiosco/web (token en link + ② mensaje/límites + ③ teclado).
3. Responsive web móvil (ajustes `.apple.js`).
4. Check-in (⑤).
5. Recordatorios (⑥).

### Decisiones pendientes del usuario
1. Esquema del link de kiosco (`?k=<token>` u otro).
2. Números de rate-limit por modo (web y kiosco).
3. `id_estado` de Dentalink para "en recepción" (check-in).
4. Qué pantallas se ven mal en celular hoy.
5. Hora de envío de recordatorios (p. ej. 06:00 COT) y alcance.

**Siguiente acción sugerida:** arrancar **Fase 1** (① + ④) mientras se deciden las demás.

---

## 4. Recordatorios / pendientes administrativos

- **Borrar `backup2/credenciales.md`** cuando se confirme todo OK (ya está cubierto por `backup2/produccion/.env.prod`
  y los dumps). El usuario aún no confirmó el borrado.
- `CLAUDE.md` y reorganización de docs siguen como cambios locales **sin commitear** (no afectan lo desplegado).

---

## 5. Reglas del proyecto (recordatorio)
- No tocar sin autorización: `payments.ts`, `reconciler.ts`, `license/*`, migraciones `001-017`.
- Migraciones nuevas: versión nueva + `INSERT … ON CONFLICT DO NOTHING`.
- Verificación obligatoria: typecheck + test (287) + builds de frontend. (`pnpm lint` raíz está ROTO preexistente — falta `eslint.config.js`.)
- Probar en local contra servicios reales ANTES de subir a git.
- Nunca pedir/usar la contraseña sudo del usuario. No tocar producción sin autorización explícita.
- No cambiar `JWT_SECRET` ni `ENCRYPTION_KEY` de prod (descifran datos en reposo).
