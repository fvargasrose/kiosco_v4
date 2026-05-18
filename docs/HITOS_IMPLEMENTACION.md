# Hitos de Implementación — DentalKiosco v3

## Filosofía de hitos

Cada hito cumple **tres criterios**:
1. **Valor demostrable**: al terminarlo, se puede mostrar algo funcional (no es solo código interno).
2. **Testeable de forma independiente**: se puede probar sin depender del siguiente hito.
3. **Reversible**: si descubrimos algo, se puede ajustar sin tirar todo.

Los hitos van de **infraestructura → backend → frontend → integraciones → producción**. Cada uno construye sobre el anterior.

---

## Visión general — 10 hitos

| # | Hito | Duración | Valor al final |
|---|---|---|---|
| **H1** | Cimientos del proyecto | 3-5 días | Repositorio + Docker Compose levanta servicios vacíos |
| **H2** | Base de datos + migraciones | 2-3 días | BD con esquema completo, scripts de seed |
| **H3** | API base + health + auth admin | 4-5 días | Login admin con TOTP funciona end-to-end |
| **H4** | Auth de pacientes (OTP) | 5-7 días | Paciente puede autenticarse desde un cliente de prueba |
| **H5** | Integración Dentalink (lectura) | 4-5 días | Paciente ve sus citas reales desde Dentalink |
| **H6** | Frontend kiosco básico | 5-7 días | Pantallas standby + Habeas + OTP + Home funcionando |
| **H7** | Pagos Wompi (sandbox) | 7-10 días | Pago de prueba en Wompi sandbox completo, con webhook |
| **H8** | Admin clínica (panel web) | 7-10 días | Admin configura todo desde panel propio |
| **H9** | License server + installer | 5-7 días | Una instalación nueva funciona en VPS limpio en <30min |
| **H10** | Hardening + piloto producción | 5-7 días | Sistema listo para primera clínica real |

**Total:** ~50-70 días hábiles = 10-14 semanas según ritmo.

---

## Hito 1 — Cimientos del proyecto

**Objetivo:** Tener el monorepo, Docker Compose, y servicios vacíos pero levantados.

**Entregables:**
- Repositorio Git con estructura monorepo (pnpm workspaces)
- `docker-compose.yml` con todos los servicios definidos
- Servicios arrancan sin errores (aunque API no haga nada útil)
- README con instrucciones de setup local
- `.env.example` con todas las variables documentadas

**Pruebas que se ejecutan al terminar:**
1. `docker compose up -d` arranca sin errores
2. `docker compose ps` muestra todos los servicios "healthy"
3. `curl http://localhost/health` devuelve 200 (placeholder)
4. `curl https://localhost` carga (con cert self-signed o staging Let's Encrypt)
5. Postgres acepta conexiones
6. Redis responde a PING

**Lo que NO incluye:** lógica de negocio, autenticación, datos reales.

---

## Hito 2 — Base de datos + migraciones

**Objetivo:** Esquema completo de Postgres con sistema de migraciones versionado.

**Entregables:**
- Sistema de migraciones (node-pg-migrate o similar)
- Migraciones 001-010 con todas las tablas
- Funciones, triggers, índices, constraints
- Script de seed para desarrollo
- Tests de integridad (verificar que migraciones bajan y suben sin errores)

**Pruebas:**
1. `npm run migrate up` aplica todas las migraciones desde cero
2. `npm run migrate down` revierte sin errores
3. Test de inserción singleton de `clinic` (solo permite 1 fila)
4. Test de inmutabilidad de `audit_log` (UPDATE y DELETE fallan)
5. Test de cifrado: insertar token, recuperar, comparar
6. Seed crea: 1 clínica de prueba, 1 admin, 1 kiosco

---

## Hito 3 — API base + health + auth admin

**Objetivo:** Servidor Fastify funcionando con autenticación de admin (sin TOTP aún, lo agregamos al final del hito).

**Entregables:**
- Servidor Fastify con estructura de routes
- Endpoint `/health` con info real (DB, Redis, versión)
- Endpoints `/admin/auth/login`, `/admin/auth/logout`, `/admin/auth/me`
- Password hashing con argon2id
- Middleware de auth con JWT
- TOTP enrollment + verification
- Audit log de logins
- Tests unitarios + integración

**Pruebas E2E:**
1. POST `/admin/auth/login` con credenciales correctas → JWT
2. POST con credenciales incorrectas → 401 + incremento de `failed_login_attempts`
3. 5 intentos fallidos → cuenta bloqueada 15 min
4. Enrollment TOTP: generar secret, mostrar QR, verificar primer código
5. Login con TOTP requerido → flujo de 2 pasos
6. JWT expirado → 401
7. Audit log refleja todos los eventos

---

## Hito 4 — Auth de pacientes (OTP)

**Objetivo:** Sistema completo de OTP por SMS + email para pacientes.

**Entregables:**
- Endpoint `/auth/request-otp`
- Endpoint `/auth/verify-otp`
- Integración Twilio (con cuenta de prueba) — adaptador con interface
- Integración Resend (cuenta gratis)
- Generación de OTPs seguros con bcrypt
- Rate limiting (IP, teléfono, kiosco)
- Aviso de Habeas Data + registro de consentimientos
- Tests con mocks de SMS/email

**Pruebas:**
1. Request-otp con consent=false → 400
2. Request-otp con celular válido → 200 + SMS + email enviados (mocked)
3. Rate limit: 4to intento en 1h → 429
4. Verify-otp con código correcto → JWT de sesión paciente
5. Verify-otp con código incorrecto 5 veces → 429
6. OTP expirado → 400
7. Consent queda registrado con IP y user agent
8. OTP nunca aparece en logs

---

## Hito 5 — Integración Dentalink (lectura)

**Objetivo:** Cliente Dentalink funcional + endpoints para que el paciente vea sus datos.

**Entregables:**
- Cliente `lib/dentalink/client.ts` con todas las llamadas necesarias
- Endpoint `/me/appointments`
- Endpoint `/me/treatments`
- Endpoint `/me/profile`
- Lookup de paciente por cédula (servidor-side, sin descargar lista)
- Caché breve en Redis (60s) para reducir llamadas
- Manejo de errores upstream (Dentalink caído)
- Tests con sandbox de Dentalink

**Pruebas:**
1. Lookup paciente por cédula → datos correctos
2. Lookup cédula inexistente → respuesta time-constant (anti-enumeración)
3. GET /me/appointments con JWT → solo citas del paciente del JWT
4. Manipular JWT para ver otro paciente → 403
5. Dentalink caído → 503 con mensaje claro
6. Caché funciona (segundo request en <60s no llama a Dentalink)

---

## Hito 6 — Frontend kiosco básico

**Objetivo:** Pantallas del kiosco funcionando contra el API real, hasta home.

**Entregables:**
- Estructura modular del frontend kiosco
- Pantalla standby
- Pantalla aviso Habeas Data + checkbox
- Pantalla auth (cédula + celular)
- Pantalla OTP de 6 dígitos
- Pantalla home (citas + tratamientos)
- Pantalla detalle de cita
- Auto-logout por inactividad
- CSP estricto

**Pruebas E2E con Playwright:**
1. Standby → toca pantalla → aviso Habeas
2. Sin marcar checkbox → botón disabled
3. Marca checkbox → continúa a auth
4. Auth → ingresa cédula+celular → recibe OTP (revisar mailbox sandbox)
5. Ingresa OTP → entra al home
6. Ve sus citas reales
7. Inactividad 5 min → vuelve a standby
8. Resize PC vs tablet → layout correcto

---

## Hito 7 — Pagos Wompi (sandbox)

**Objetivo:** Flujo completo de pago contra Wompi sandbox, con webhook.

**Entregables:**
- Cliente Wompi
- Endpoint `/payments/create-link`
- Endpoint `/payments/:reference/status`
- Webhook receiver `/webhooks/wompi` con verificación X-Event-Checksum
- Generación de QR
- Pantalla de pago en kiosco con QR + opciones SMS/email
- Polling de estado
- Tabla transactions con auditoría completa
- Reconciliación con Dentalink (configurable)
- BullMQ jobs para reconciliación con reintentos

**Pruebas:**
1. Crear payment link con tarjeta sandbox → URL Wompi válida
2. Pago aprobado en Wompi sandbox → webhook llega → tx en estado approved
3. Webhook con firma inválida → 401, audit log
4. Webhook con timestamp viejo → 401
5. Webhook duplicado → idempotente
6. Polling detecta cambio de estado
7. Auto-register en Dentalink funciona
8. Reintentos automáticos si Dentalink falla

---

## Hito 8 — Admin clínica (panel web)

**Objetivo:** Panel Next.js completo para que la clínica administre su instalación.

**Entregables:**
- Next.js app con auth + TOTP
- Dashboard con KPIs
- Editor de procedimientos
- Editor de FAQ
- Configuración general
- Vista de kioscos + provisión de tokens
- Vista de transacciones con filtros y export Excel
- Vista de auditoría
- Mi cuenta (cambio password, sesiones recientes)

**Pruebas E2E:**
1. Login + TOTP enrollment funciona
2. Editar procedimiento → kiosco refresca y lo ve
3. Provisión de kiosco → QR generado → kiosco se configura
4. Export Excel de transacciones → archivo correcto
5. Auditoría muestra cambios recientes
6. Sin TOTP → no se puede entrar

---

## Hito 9 — License server + installer

**Objetivo:** Sistema de licencias funcionando + installer que monta todo en 30 min.

**Entregables:**
- License server en infraestructura central
- API: validate, heartbeat, issue, revoke
- License client dentro del API de clínica
- Modos: normal, grace, restrictive, shutdown
- Script `install.sh` completo
- Documentación de instalación

**Pruebas:**
1. Provisionar licencia desde fleet manager → archivo `.env` listo
2. Ejecutar `install.sh` en VPS Hetzner CX22 limpio → todo arriba en <30 min
3. License válida → sistema arranca normal
4. Sin conectividad 1 día → modo normal con warning
5. Sin conectividad 8 días → modo restrictivo
6. Revocar licencia → shutdown
7. Reactivar → recovery automático

---

## Hito 10 — Hardening + piloto producción

**Objetivo:** Listo para primera clínica real.

**Entregables:**
- Update manager con backup + rollback
- Backups remotos (Restic + B2)
- Monitoring central (Grafana + Prometheus)
- Helpdesk configurado
- Documentación: runbook, installer guide, contratos
- Pentesting interno completado
- OWASP ZAP scan 0 high/medium
- Contratos legales redactados

**Pruebas:**
1. Update real en staging → rollback si falla
2. Restore desde backup → datos íntegros
3. Pentesting checklist completo
4. Carga: 100 OTP/s sostenido 5 min sin degradación
5. SLA medido: alertas funcionando

---

## Empezamos con Hito 1

Voy a implementar el Hito 1 ahora. Al terminar tendrás:
- Estructura completa del repositorio
- Docker Compose funcional
- Servicios placeholder corriendo
- README con instrucciones claras
- Scripts de bootstrap para desarrollo local
