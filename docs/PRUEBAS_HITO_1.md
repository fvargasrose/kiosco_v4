# Pruebas del Hito 1 — Cimientos del proyecto

Este documento contiene el **checklist completo** de pruebas que debes ejecutar para validar que el Hito 1 está terminado correctamente. Si todas pasan, el cimiento está sólido y se puede arrancar el Hito 2.

---

## Pre-requisitos

Antes de empezar:

- [ ] Docker 24+ instalado y corriendo (`docker --version`)
- [ ] Docker Compose v2+ disponible (`docker compose version`)
- [ ] Puerto 80 libre en localhost (o ajustar `HTTP_PORT` en `.env`)
- [ ] Al menos 2 GB RAM libres
- [ ] Acceso a Internet (para pull de imágenes Docker)

---

## P1 — Setup inicial

### P1.1 — Generación de secretos

```bash
cd dentalkiosco
cp .env.example .env
bash scripts/generate-secrets.sh
```

**Validar:**

- [ ] El script imprime 4 valores: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_KEY`
- [ ] Pregunta si crear `.env` con esos valores → responder `y`
- [ ] `.env` existe y contiene los valores generados
- [ ] Los valores no contienen caracteres problemáticos (`=`, `+`, `/`)
- [ ] `JWT_SECRET` tiene al menos 32 caracteres
- [ ] `ENCRYPTION_KEY` tiene al menos 32 caracteres

```bash
# Verificar longitudes
grep -E "JWT_SECRET|ENCRYPTION_KEY|POSTGRES_PASSWORD|REDIS_PASSWORD" .env | \
  awk -F= '{print $1, length($2)}'
```

Salida esperada:
```
POSTGRES_PASSWORD 32
REDIS_PASSWORD 32
JWT_SECRET 64
ENCRYPTION_KEY 44
```

### P1.2 — Validación de config con valores inválidos

Verificar que el sistema rechaza configs inválidas:

```bash
# Test: JWT_SECRET muy corto
cp .env .env.backup
sed -i 's/JWT_SECRET=.*/JWT_SECRET=corto/' .env
docker compose up api 2>&1 | head -30
```

**Validar:**

- [ ] El API NO arranca
- [ ] Muestra mensaje claro: `JWT_SECRET debe ser >= 32 caracteres`
- [ ] El proceso termina con código no-cero

```bash
# Restaurar config válida
mv .env.backup .env
```

---

## P2 — Arranque del stack

### P2.1 — Levantar todo

```bash
docker compose up -d
```

**Validar:**

- [ ] No hay errores en la salida
- [ ] Pull de imágenes completa exitosamente (primera vez)
- [ ] El comando retorna sin errores

### P2.2 — Verificar estado de servicios

```bash
# Esperar ~30s para que healthchecks se estabilicen
sleep 30
docker compose ps
```

**Salida esperada:**

```
NAME           IMAGE                          STATUS              PORTS
dk-api         dentalkiosco-api               Up (healthy)        3000/tcp
dk-caddy       caddy:2-alpine                 Up (healthy)        0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
dk-postgres    postgres:16-alpine             Up (healthy)        5432/tcp
dk-redis       redis:7-alpine                 Up (healthy)        6379/tcp
```

**Validar:**

- [ ] 4 servicios corriendo
- [ ] Los 4 muestran `(healthy)` (no `(unhealthy)` ni `(starting)`)
- [ ] Solo Caddy expone puertos al host (80/443)
- [ ] Postgres y Redis NO exponen puertos al exterior

### P2.3 — Logs limpios al arranque

```bash
docker compose logs api | tail -20
```

**Validar:**

- [ ] Mensaje `Postgres new connection established`
- [ ] Mensaje `Redis ready`
- [ ] Mensaje `Database and Redis connections OK`
- [ ] Mensaje `DentalKiosco API ready`
- [ ] No hay errores ni warnings críticos
- [ ] No aparecen valores de secretos (passwords, JWT_SECRET) en los logs

```bash
# Verificar que los secretos NO se filtran
docker compose logs api | grep -iE "password|secret|key" | grep -v "REDACTED" | grep -v "establishment"
# Debe estar vacío o mostrar solo nombres de variables, nunca valores
```

---

## P3 — Health checks

### P3.1 — Liveness probe

```bash
curl -i http://localhost/health
```

**Validar:**

- [ ] Status: `200 OK`
- [ ] Body: `{"status":"ok","timestamp":"..."}`
- [ ] Timestamp es ISO 8601 válido
- [ ] Headers de seguridad presentes:
  - `Strict-Transport-Security`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`

```bash
# Test express:
curl -sI http://localhost/health | grep -iE "strict-transport|x-content|x-frame|referrer-policy"
```

### P3.2 — Readiness probe

```bash
curl -s http://localhost/health/ready | jq .
```

**Salida esperada:**

```json
{
  "status": "ready",
  "timestamp": "2026-05-12T...",
  "checks": {
    "database": { "ok": true, "latencyMs": <100 },
    "redis": { "ok": true, "latencyMs": <50 }
  }
}
```

**Validar:**

- [ ] `status: "ready"`
- [ ] Status code: `200`
- [ ] `database.ok: true`
- [ ] `redis.ok: true`
- [ ] Latencias razonables (DB < 100ms, Redis < 50ms en localhost)

### P3.3 — Info detallada

```bash
curl -s http://localhost/health/info | jq .
```

**Validar:**

- [ ] `app.version: "3.0.0-alpha.1"`
- [ ] `app.environment: "development"`
- [ ] `app.installation: "local-dev"`
- [ ] `app.uptime` presente
- [ ] `runtime.node` empieza con `v20.`
- [ ] `features.wompi: false` (no configurado aún)
- [ ] `features.dentalink: false`
- [ ] `features.twilio: false`
- [ ] `features.resend: false`
- [ ] `database` muestra estadísticas del pool

### P3.4 — Readiness con Redis caído

Simular falla de Redis para verificar que el readiness lo detecta:

```bash
docker compose stop redis
sleep 5
curl -i http://localhost/health/ready
```

**Validar:**

- [ ] Status: `503 Service Unavailable`
- [ ] `checks.redis.ok: false`
- [ ] `checks.redis.error` contiene mensaje descriptivo
- [ ] `checks.database.ok: true` sigue OK

Restaurar:
```bash
docker compose start redis
sleep 10
curl -s http://localhost/health/ready | jq .checks.redis.ok
# debe volver a true
```

### P3.5 — Readiness con Postgres caído

```bash
docker compose stop postgres
sleep 5
curl -i http://localhost/health/ready
```

**Validar:**

- [ ] Status: `503`
- [ ] `checks.database.ok: false`

Restaurar:
```bash
docker compose start postgres
sleep 10
curl -s http://localhost/health/ready | jq .status
# debe volver a "ready"
```

---

## P4 — Seguridad del proxy

### P4.1 — Headers de seguridad

```bash
curl -sI http://localhost/health | tee /tmp/headers.txt
```

**Validar (cada header debe estar presente):**

- [ ] `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- [ ] `X-Content-Type-Options: nosniff`
- [ ] `X-Frame-Options: DENY`
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] `Permissions-Policy` presente con `camera=()`
- [ ] **NO** debe aparecer header `Server` (debe estar oculto)

### P4.2 — Caddy oculta versión del backend

```bash
curl -sI http://localhost/health | grep -i "server\|x-powered-by"
```

**Validar:**

- [ ] No aparece `X-Powered-By: Express` o similar
- [ ] No aparece versión específica del servidor

### P4.3 — Endpoints inexistentes retornan 404

```bash
curl -i http://localhost/api/nonexistent
curl -i http://localhost/api/admin/secret
curl -i http://localhost/.env
curl -i http://localhost/admin/secrets
```

**Validar:**

- [ ] Todos retornan `404`
- [ ] No filtran información del backend
- [ ] No exponen stack traces

### P4.4 — Postgres no es accesible desde fuera

```bash
# Desde tu máquina (fuera de Docker)
nc -zv localhost 5432 2>&1 | grep -i "succeeded\|connected"
```

**Validar:**

- [ ] La conexión **falla** (puerto no expuesto al host)
- [ ] Salida muestra "Connection refused" o equivalente

### P4.5 — Redis no es accesible desde fuera

```bash
nc -zv localhost 6379 2>&1 | grep -i "succeeded\|connected"
```

**Validar:**

- [ ] La conexión **falla**

---

## P5 — Pool y resiliencia

### P5.1 — API maneja restart de Redis

```bash
# Hacer una request OK
curl -s http://localhost/health/ready | jq .status

# Reiniciar Redis
docker compose restart redis

# Esperar reconexión
sleep 5

# Verificar que vuelve a estar OK
curl -s http://localhost/health/ready | jq .status
# Debe volver a "ready" sin reiniciar el API
```

**Validar:**

- [ ] El API NO se cae cuando Redis se reinicia
- [ ] Reconecta automáticamente
- [ ] Logs muestran mensajes de reconnect, no de crash

### P5.2 — API maneja restart de Postgres

```bash
docker compose restart postgres
sleep 10
curl -s http://localhost/health/ready | jq .status
```

**Validar:**

- [ ] Vuelve a "ready" en < 30 segundos
- [ ] API no entró en crash loop

### P5.3 — Shutdown graceful del API

```bash
# Enviar SIGTERM
docker compose stop api

# Verificar logs del shutdown
docker compose logs api | tail -10
```

**Validar (en los últimos logs):**

- [ ] Mensaje `Shutting down...` con `signal: "SIGTERM"`
- [ ] Mensaje `Closing Postgres pool`
- [ ] Mensaje `Closing Redis connection`
- [ ] Mensaje `Shutdown complete`
- [ ] Proceso terminó en < 10 segundos

Reiniciar:
```bash
docker compose start api
sleep 10
curl -s http://localhost/health/ready | jq .status
```

---

## P6 — Validación de privacidad en logs

### P6.1 — Redacción de campos sensibles

```bash
# Generar tráfico
for i in {1..5}; do
  curl -s -H "Authorization: Bearer SECRET_TOKEN_TEST" \
       -H "Cookie: session=ABC123" \
       http://localhost/health > /dev/null
done

# Inspeccionar logs
docker compose logs api | tail -30 | grep -iE "secret_token|abc123"
```

**Validar:**

- [ ] El valor literal `SECRET_TOKEN_TEST` NO aparece en logs
- [ ] El valor literal `ABC123` NO aparece en logs
- [ ] En su lugar debe aparecer `[REDACTED]`

### P6.2 — Errores no filtran detalles internos en producción

```bash
# Forzar un error (en dev sí muestra detalle)
curl -s -X POST http://localhost/api/auth/whatever | jq .
```

**Validar (en development):**

- [ ] El response incluye `error`
- [ ] Puede incluir `message` con detalle

Para verificar producción, cambiar `NODE_ENV=production` temporalmente:
```bash
docker compose exec api sh -c 'NODE_ENV=production node -e "console.log(process.env.NODE_ENV)"'
```

---

## P7 — Persistencia de datos

### P7.1 — Volúmenes Docker creados

```bash
docker volume ls | grep dentalkiosco
```

**Validar:**

- [ ] `dentalkiosco_postgres_data` existe
- [ ] `dentalkiosco_redis_data` existe
- [ ] `dentalkiosco_caddy_data` existe
- [ ] `dentalkiosco_caddy_config` existe

### P7.2 — Postgres persiste data entre restarts

```bash
# Crear una tabla y datos temporales
docker compose exec postgres psql -U dentalkiosco -c \
  "CREATE TABLE test_persist (n int); INSERT INTO test_persist VALUES (42);"

# Restart de TODO el stack (sin -v, no borra volúmenes)
docker compose down
docker compose up -d
sleep 20

# Verificar que los datos siguen ahí
docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT * FROM test_persist;"

# Esperado: muestra "42"

# Limpiar
docker compose exec postgres psql -U dentalkiosco -c "DROP TABLE test_persist;"
```

**Validar:**

- [ ] El dato `42` está después del restart

### P7.3 — `down -v` borra los volúmenes

```bash
# Crear marca
docker compose exec postgres psql -U dentalkiosco -c \
  "CREATE TABLE test_volume_wipe (n int);"

# Bajar con -v
docker compose down -v

# Subir y verificar
docker compose up -d
sleep 20

docker compose exec postgres psql -U dentalkiosco -c \
  "SELECT * FROM test_volume_wipe;" 2>&1 | grep -i "does not exist"
```

**Validar:**

- [ ] La tabla NO existe (volumen fue borrado)
- [ ] Mensaje: `relation "test_volume_wipe" does not exist`

---

## P8 — Performance básica

### P8.1 — Latencia del health check

```bash
# 100 requests, medir tiempos
for i in {1..100}; do
  curl -s -w "%{time_total}\n" -o /dev/null http://localhost/health
done | sort -n | awk '
  BEGIN { c=0 }
  { v[c++] = $1; sum += $1 }
  END {
    print "min:", v[0]
    print "p50:", v[int(c*0.5)]
    print "p95:", v[int(c*0.95)]
    print "p99:", v[int(c*0.99)]
    print "max:", v[c-1]
    print "avg:", sum/c
  }
'
```

**Validar:**

- [ ] p50 < 20 ms
- [ ] p95 < 50 ms
- [ ] p99 < 100 ms
- [ ] No hay errores

### P8.2 — Memoria del API en idle

```bash
docker stats --no-stream dk-api
```

**Validar:**

- [ ] Memoria < 150 MB en idle
- [ ] CPU < 5% en idle

---

## P9 — Limpieza y resumen

### P9.1 — Stop limpio

```bash
docker compose down
```

**Validar:**

- [ ] Todos los contenedores se detienen sin errores
- [ ] No quedan procesos zombi
- [ ] Volúmenes persisten (no se borran)

### P9.2 — Documentación legible

- [ ] `README.md` se lee bien y las instrucciones funcionan paso a paso
- [ ] `.env.example` tiene comentarios claros en cada variable
- [ ] `docker-compose.yml` es legible y comentado
- [ ] No hay TODOs críticos sin resolver

---

## Resumen de aceptación del Hito 1

Si **todas** las pruebas anteriores pasan, el Hito 1 está completo.

**Criterio mínimo (must-pass):**

- [ ] P2.2 — 4 servicios healthy
- [ ] P3.1, P3.2, P3.3 — Los 3 health checks responden correctamente
- [ ] P3.4, P3.5 — Readiness detecta fallas
- [ ] P4.1 — Todos los headers de seguridad presentes
- [ ] P4.4, P4.5 — Postgres y Redis NO expuestos
- [ ] P5.3 — Shutdown graceful funciona
- [ ] P6.1 — Logs redactan datos sensibles
- [ ] P7.2 — Postgres persiste data entre restarts

**Si alguna falla:** identificar el problema, corregir, re-ejecutar el set completo de pruebas.

---

## Reporte de pruebas (plantilla)

Al terminar, completar este reporte:

```
Fecha: ___________
Hora de inicio: ___________
Hora de fin: ___________
Ejecutor: ___________

Hardware:
  - SO: ___________
  - RAM: ___________
  - Docker version: ___________

Resultados:
  P1.1 [PASS/FAIL]
  P1.2 [PASS/FAIL]
  P2.1 [PASS/FAIL]
  ...

Notas / observaciones:
  ___________

Aprobado para avanzar a Hito 2: [SÍ / NO]
```
