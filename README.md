# DentalKiosco v3 — Self-Hosted

Sistema de kiosco dental con autoservicio para pacientes, integración con Dentalink y Wompi, licenciamiento centralizado y actualizaciones gestionadas.

**Versión:** 3.0.0-alpha.4 (Hitos 1-4 completos)
**Proveedor:** ALL CREATIVE (Dr. Hermes Vargas Rosero)
**Estado:** En desarrollo — no apto para producción aún.

---

## Estado de hitos

| Hito | Estado | Descripción |
|------|--------|-------------|
| 1 | ✅ COMPLETO | Cimientos del proyecto (monorepo + Docker Compose + health checks) |
| 2 | ✅ COMPLETO | Base de datos (8 migraciones, esquema completo, triggers críticos) |
| 3 | ✅ COMPLETO | Auth admin con argon2 + TOTP (17 tests passing) |
| 4 | ✅ COMPLETO | Auth paciente con OTP SMS+Email (29 tests passing) |
| 5 | ⏳ Pendiente | Integración Dentalink (lectura citas y tratamientos) |
| 6 | ⏳ Pendiente | Frontend kiosco básico |
| 7 | ⏳ Pendiente | Pagos Wompi (sandbox) |
| 8 | ⏳ Pendiente | Admin clínica (panel web) |
| 9 | ⏳ Pendiente | License server + installer |
| 10 | ⏳ Pendiente | Hardening + piloto producción |

**Tests totales actuales:** 46 (Hitos 3+4)

---

## Setup rápido

```bash
# 1. Configurar entorno
cp .env.example .env
bash scripts/generate-secrets.sh   # Genera y aplica secretos

# 2. Levantar stack
docker compose up -d

# 3. Aplicar migraciones de BD
docker compose exec api npm run migrate

# 4. Cargar datos de prueba
docker compose exec api npm run seed

# 5. Validar
curl http://localhost/health
```

---

## Estructura

```
dentalkiosco/
├── apps/
│   ├── api/                    # Backend Fastify
│   │   ├── src/
│   │   │   ├── server.ts       # Entry point
│   │   │   ├── migrate.ts      # Runner de migraciones
│   │   │   ├── seed.ts         # Datos de desarrollo
│   │   │   ├── lib/            # Utilidades comunes
│   │   │   └── routes/
│   │   │       ├── health.ts          # Health checks
│   │   │       ├── admin-auth.ts      # Auth admin (Hito 3)
│   │   │       └── patient-auth.ts    # Auth paciente OTP (Hito 4)
│   │   ├── migrations/
│   │   │   ├── 001_extensions_and_base.sql
│   │   │   ├── 002_clinic.sql
│   │   │   ├── 003_admins_and_kiosks.sql
│   │   │   ├── 004_otp_sessions_consents.sql
│   │   │   ├── 005_transactions.sql
│   │   │   ├── 006_audit_log.sql
│   │   │   ├── 007_rate_limits.sql
│   │   │   └── 008_otp_dentalink_patient_id.sql
│   │   ├── tests/
│   │   │   ├── admin-auth.test.ts     # 17 tests
│   │   │   └── patient-auth.test.ts   # 29 tests
│   │   └── package.json
│   ├── kiosco-frontend/        # (Hito 6) Frontend del kiosco
│   └── admin-frontend/         # (Hito 8) Panel admin clínica
│
├── central/                    # (Hito 9) Infraestructura central
│   ├── license-server/
│   └── fleet-manager/
│
├── installer/                  # (Hito 9) Script de instalación
├── infra/caddy/Caddyfile       # Reverse proxy
├── docs/
│   ├── HITOS_IMPLEMENTACION.md
│   ├── PRUEBAS_HITO_1.md
│   ├── PRUEBAS_HITO_2.md
│   ├── PRUEBAS_HITO_3.md
│   └── PRUEBAS_HITO_4.md
├── scripts/generate-secrets.sh
├── docker-compose.yml
└── README.md
```

---

## Comandos útiles

```bash
# Stack
docker compose up -d              # Levantar
docker compose ps                 # Estado
docker compose logs -f api        # Logs del API
docker compose down               # Detener

# BD
docker compose exec api npm run migrate         # Aplicar migraciones
docker compose exec api npm run migrate:status  # Ver estado
docker compose exec api npm run migrate:verify  # Verificar checksums
docker compose exec api npm run seed            # Datos de prueba

# Tests
docker compose exec api npm test                # Todos los tests
docker compose exec api npx vitest run tests/admin-auth.test.ts
docker compose exec api npx vitest run tests/patient-auth.test.ts
```

---

## API endpoints disponibles

### Health
- `GET /health` — Liveness probe
- `GET /health/ready` — Readiness probe (verifica BD y Redis)
- `GET /health/info` — Info detallada

### Auth admin (Hito 3)
- `POST /admin/auth/login` — Login con email+password
- `POST /admin/auth/mfa/verify` — Verificar TOTP
- `POST /admin/auth/mfa/enroll-start` — Generar QR para enrollment
- `POST /admin/auth/mfa/enroll-confirm` — Confirmar enrollment
- `GET /admin/auth/me` — Info de sesión actual
- `POST /admin/auth/logout` — Cerrar sesión

### Auth paciente (Hito 4)
- `POST /auth/request-otp` — Solicitar OTP (requiere kiosk_token + consent Habeas Data)
- `POST /auth/verify-otp` — Verificar código
- `POST /auth/logout` — Cerrar sesión paciente

---

## Documentación

- **Pruebas:** ver `docs/PRUEBAS_HITO_N.md` para cada hito
- **Roadmap completo:** `docs/HITOS_IMPLEMENTACION.md`
- **Plan de arquitectura:** documentos `PLAN_KIOSCO_v3_SELFHOSTED.md` separados
