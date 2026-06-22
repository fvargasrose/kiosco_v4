# Bitácora de la conversación y estado del proyecto

> Documento de **traspaso** para retomar el trabajo en otra sesión.
> Proyecto: DentalKiosco → migración a **aplicación web pública** (móvil/tablet/PC).
> Última actualización: **2026-06-03** (fin de jornada).

---

## 1. Qué es este proyecto y dónde está

- Copia aislada en **`/home2/kiosko_v4`** (clon de `kiosco_v3_produccion`), con
  remoto propio `https://github.com/fvargasrose/kiosco_v4.git`.
- Stack: Vanilla JS + Vite 5 (frontends), Fastify 4 + TS (API), PostgreSQL 16,
  Redis 7, Docker Compose + Caddy. Mono-clínica (`clinic id=1`).
- Infra local del clon (puertos alternativos): Postgres `5434`, Redis `6381`.
  `docker compose up -d postgres redis`. La API corre fuera de Docker en dev.
- ⚠️ El clon **comparte volúmenes/contenedores Docker** (`dentalkiosco_*`) con el
  proyecto original → no pueden levantarse ambos stacks a la vez. (Pendiente:
  `COMPOSE_PROJECT_NAME` propio si conviven — se resolverá en el Hito F.)

## 2. Documentos clave (en la raíz)

| Archivo | Contenido |
|---------|-----------|
| `plan_abierto.md` | **Análisis de referencia**: hallazgos, riesgos, tests §6, anti-abuso OTP §7, WAF §8, rollback §9, sesión móvil §10. No se ejecuta directamente. |
| `plan_abierto_v2.md` | **Plan de ejecución** hito por hito (A–G), con casillas de aprobación. Estado de hitos en su tabla resumen. |
| `hito_A.md` | **Reporte de auditoría** de los Hitos A y B (creados/modificados, tests, DoD, desviaciones, evidencia). |
| `hito_conversacion.md` | Este documento (traspaso). |
| `CLONAR_PROYECTO.md` | Doc de clonado original (ya ejecutado). |

> Nota: existe también `hito_A (copy).md` (copia manual del usuario, solo Hito A).
> El contenido vigente y completo está en `hito_A.md`.

## 3. Decisiones de arquitectura ya tomadas (firmes)

- **Modelo de acceso = Opción A:** endpoints **públicos de clínica** (`/public/*`),
  **sin `kiosk_token`**, **sin kioscos físicos**. Control real = rate-limit + OTP +
  Turnstile + anti-enumeración.
- **Turnstile** (Cloudflare, managed/invisible) **desde el inicio** en `request-otp`.
- `kiosk_id` en sesiones/registros web = **NULL** (no sentinel).
- `/kiosk/register` = ruta **pública** gobernada por `FEATURE_REGISTRO`.
- Pendientes de decidir en su hito: standby vs landing (C), routing History/hash
  (D), self-host fuentes apple (C/F), dominio/subdominios (F), convivencia Docker (F).

## 4. Progreso por hito (ver `plan_abierto_v2.md`)

| Hito | Estado |
|------|--------|
| **A — Backend web-ready** | ✅ **Aprobado y fusionado a `main`** (merge `3826f6f`). |
| **B — Seguridad de perímetro** | ✅ **Implementado, NO fusionado.** Pendiente de aprobación. |
| C — Front web del paciente | ⏳ Siguiente. |
| D — Responsive + routing | ⏳ |
| E — Admin responsive | ⏳ (independiente; puede solaparse) |
| F — Producción Hetzner | ⏳ (gate: requiere B cerrado) |
| G — Hardening | ⏳ |

### Hito A (hecho) — resumen
Rutas `/public/*` (bootstrap/standby), `request-otp`/registro públicos,
`signPatientSession` con `kiosk_id` opcional (NULL en web), **`/auth/login-direct`
eliminado**, migración **017** (kiosk_id nullable, idempotente). Auditado: ninguna
lectura downstream asume `kiosk_id` no-nulo (reconciler no lo lee). Suite 262 verde.

### Hito B (hecho, sin fusionar) — resumen
- **Rate-limit global por IP** (`@fastify/rate-limit`, store Redis, `nameSpace dk-rl:`)
  en `server.ts`. Techos por ruta (request-otp 10, verify-otp 20, admin/login 10,
  me/payments 15; resto 300/min). **allowList excluye loopback y `/health`.**
- **Turnstile enforced** en `request-otp` (`lib/turnstile.ts`, siteverify,
  fail-closed) antes de lookup/envío; `TURNSTILE_SECRET` obligatorio en prod.
- **Buckets §7.2** en `request-otp`: cooldown 60s, 3/h y 5/día phone, 5/h y 20/día
  IP, 100/h global con alerta (log+audit).
- **Blocklist admin** en Redis (`admin:blocklist:<jti>`): logout revoca de verdad;
  `requireAdmin` la consulta.
- Suite de seguridad `tests/security.test.ts` (12 tests) + cooldown adaptado.
- **274 tests verdes (19 archivos)**, typecheck OK, sin migración nueva.
- Confirmado (test + smoke en vivo): **el rate-limit NO afecta `/health`**.

## 5. Estado de git (al cierre)

- Rama actual: **`hito-b-seguridad-perimetro`** (5 commits sobre `main`).
- `main` contiene el Hito A fusionado.
- Ramas: `main`, `hito-a-backend-web-ready` (fusionada), `hito-b-seguridad-perimetro`.
- Commits del Hito B: `4ec62e4`, `8b93dc7`, `8350a1d`, `e174af1`, `8c91405`.
- Working tree: `docker-compose.override.yml` modificado (puertos del clon, de la
  tarea de clonado; **no** corresponde a ningún hito — dejar sin commitear o
  commitear aparte como chore de entorno).

## 6. Próximos pasos (al retomar)

1. **Aprobar el Hito B** y fusionarlo a `main`:
   ```bash
   cd /home2/kiosko_v4
   # marcar [x] la casilla del Hito B en plan_abierto_v2.md (línea ~157)
   git checkout main
   git merge --no-ff hito-b-seguridad-perimetro
   ```
2. **Iniciar el Hito C** (Front web del paciente, núcleo) según `plan_abierto_v2.md`:
   quitar gate `kiosk_token` en `main.js`/`api.js`, persistir sesión en
   `sessionStorage` + `/auth/refresh`, integrar widget Turnstile en
   `login-cedula.js`, decidir standby→landing, desactivar idle/teclado táctil,
   pago "Pagar ahora" en móvil, crear `playwright.config.ts`.
   - El frontend `kiosco-frontend/api.js` aún tiene `loginDirect` (backend ya
     eliminado): retirarlo en C.
   - El bootstrap del frontend apunta a `/kiosk/bootstrap`; cambiar a
     `/public/bootstrap`.

## 7. Comandos útiles

```bash
cd /home2/kiosko_v4
docker compose up -d postgres redis     # infra (5434/6381)
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test       # 274 tests
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api migrate:status
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev        # API :3000
```

## 8. Problemas conocidos / deuda

- **`pnpm lint` no ejecutable** (preexistente): ESLint 9 sin `eslint.config.js`.
  Gate de calidad efectivo = `typecheck` + tests. Tarea aparte: crear flat config.
- **Convivencia Docker** con el proyecto original (volúmenes/contenedores
  compartidos). Resolver en Hito F si comparten host.
- **Alerta del cap global de OTP** = log+audit; cablear a email/Sentry en F/G.
- Reglas de `CLAUDE.md`: NO tocar `payments.ts`, `reconciler.ts`, `license/*`,
  migraciones 001–011 sin autorización; leer archivos completos antes de editar;
  un commit por tarea; migraciones nuevas y reversibles.
