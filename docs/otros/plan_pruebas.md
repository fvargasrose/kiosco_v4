# DentalKiosco — Plan de pruebas locales (Hito 9 + 10)

**Fecha:** 2026-05-21 · **Rama:** `hito10`  
**Objetivo:** validar manualmente cada funcionalidad implementada antes de subir a producción.

---

## Preparación previa

```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco

# 1. Verificar infraestructura
docker compose ps          # postgres y redis deben estar (healthy)
curl -s http://localhost:3000/health/ready | jq .   # debe decir "ready"

# 2. Ver logs de la API en tiempo real (en otra terminal o background)
tail -f /tmp/dk-api.log | grep -E "INFO|ERROR|WARN|otp|OTP|booking|cita"

# 3. Credenciales del kiosco para pruebas
# URL del kiosco con token:
# http://localhost:5173/?kiosk_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyMjIyMjIyMi0yMjIyLTIyMjItMjIyMi0yMjIyMjIyMjIyMjIiLCJhdWQiOiJraW9zayIsImlzcyI6ImRlbnRhbGtpb3NjbyIsImlhdCI6MTc3OTMyMTQwMywiZXhwIjoxNzg3MDk3NDAzfQ.80qt60fqJppK4Gq1nIWgQcRn-uqKEj7CLtKxRyrOVwQ
#
# Paciente real en Dentalink:
#   Cédula: 10697021
#   Teléfono: +573206505239  (OTP_REQUIRED=false → ingresa directo)
#
# Panel admin:
#   URL: http://localhost:5174
#   Email: admin@demo.local
#   Contraseña: Admin@Demo2026
```

---

## Módulo A — Infraestructura y autenticación

### A1. Health check
- [ ] `curl http://localhost:3000/health` devuelve `{"status":"ok",...}`
- [ ] `curl http://localhost:3000/health/ready` devuelve `{"status":"ready","checks":{"db":"ok","redis":"ok"}}`

### A2. Login admin
- [ ] Abrir `http://localhost:5174`
- [ ] Ingresar `admin@demo.local` / `Admin@Demo2026` → entra al dashboard
- [ ] Ver métricas del día (transacciones, citas del día)

### A3. Kiosco — pantalla standby
- [ ] Abrir el kiosco con el `kiosk_token` de arriba
- [ ] Ver pantalla de standby (mensaje de texto o media si está configurado)
- [ ] Tocar la pantalla → avanza a Habeas Data

---

## Módulo B — Flujo completo del paciente

### B1. Login directo (sin OTP)
> Requiere `OTP_REQUIRED=false` en `.env` (ya configurado)

- [ ] Tocar pantalla → Habeas Data → **Aceptar**
- [ ] Ingresar cédula `10697021`
- [ ] Ingresar teléfono `3206505239` (sin +57)
- [ ] Presionar **Ingresar** → llegar al Home del paciente
- [ ] Verificar que aparecen las citas y/o tratamientos reales del paciente

### B2. Citas — ver lista
- [ ] Tocar **Mis citas** → lista de citas próximas
- [ ] Verificar que aparecen las citas del paciente en Dentalink

### B3. Tratamientos — ver lista
- [ ] Tocar **Mis tratamientos** (o volver al home y entrar)
- [ ] Verificar tratamientos activos del paciente

### B4. Agendar cita (booking)
> Este flujo requiere un slot disponible en el horario del dentista

- [ ] Desde Home → **Agendar cita**
- [ ] **Sede** → seleccionar "Odontología" (única sucursal real)
- [ ] **Dentista** → seleccionar cualquier dentista disponible (ej. RODRIGO FERNANDEZ)
- [ ] **Fecha** → seleccionar un día dentro de los próximos 14
- [ ] **Hora** → seleccionar un slot disponible
- [ ] **Confirmar** → presionar "Confirmar y agendar"
- [ ] ✅ Resultado esperado: modal de éxito "¡Cita agendada!"
- [ ] Si hay error "Este horario ya no está disponible" → el slot ya estaba tomado en Dentalink, elegir otro

### B5. Pago (mock Wompi)
- [ ] Desde tratamientos o citas → ver un saldo pendiente → **Pagar**
- [ ] Ver pantalla QR / botón de pago
- [ ] Simular pago aprobado:
  ```bash
  # Obtener referencia del pago pendiente
  PGPASSWORD=$(grep POSTGRES_PASSWORD .env | cut -d= -f2) \
    psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco \
    -c "SELECT reference, status FROM transactions ORDER BY created_at DESC LIMIT 3;"

  # Simular webhook
  curl -X POST http://localhost:3000/webhooks/wompi \
    -H "Content-Type: application/json" \
    -d '{"event":"transaction.updated","data":{"transaction":{"reference":"<REF>","status":"APPROVED","amount_in_cents":100000}},"sent_at":"2026-05-21T00:00:00Z","signature":{"checksum":"mock","properties":[]}}'
  ```
- [ ] ✅ Resultado esperado: comprobante enviado por email/SMS

### B6. Inactividad (idle)
- [ ] Dejar el kiosco sin tocar 5 minutos
- [ ] ✅ Resultado esperado: vuelve automáticamente a pantalla standby

---

## Módulo C — Panel admin

### C1. Dashboard
- [ ] `http://localhost:5174` → dashboard con métricas del día
- [ ] Ver gráficos o contadores de transacciones y citas

### C2. Configuración clínica
- [ ] Sidebar → **Configuración** → ver nombre, NIT, textos de Habeas Data
- [ ] Cambiar el mensaje de standby → guardar → verificar en el kiosco

### C3. Standby multimodal
- [ ] Panel admin → Configuración → pestaña Standby
- [ ] Probar modo **Mensaje** (texto + botón)
- [ ] Probar modo **GIF** (subir imagen)
- [ ] Probar modo **Video** (subir video corto)
- [ ] Verificar que el kiosco refleja el cambio (puede tardar ~1 min por caché)

### C4. Fotos de odontólogos
- [ ] Sidebar → **Odontólogos** → lista de dentistas reales de Dentalink
- [ ] Subir foto para un dentista
- [ ] Ir al kiosco → Agendar cita → paso dentista → ✅ debe verse la foto

### C5. Kioscos
- [ ] Sidebar → **Kioscos** → ver el kiosco registrado
- [ ] Crear un nuevo kiosco → copiar token → probar en nueva ventana

### C6. Transacciones
- [ ] Sidebar → **Transacciones** → lista paginada
- [ ] Filtrar por fecha o estado
- [ ] Verificar que aparece la transacción del pago simulado en B5

---

## Módulo D — Sistemas de infraestructura

### D1. License server (local)
```bash
# Arrancar el license server en otra terminal
cd central/license-server
pnpm install
export PORT=3001 POSTGRES_HOST=localhost POSTGRES_PORT=5433 \
  POSTGRES_DB=dentalkiosco POSTGRES_USER=dentalkiosco \
  POSTGRES_PASSWORD=$(grep POSTGRES_PASSWORD /home2/kiosco_v3_produccion_18_05_26/dentalkiosco/.env | cut -d= -f2) \
  SUPERADMIN_API_KEY=superadmin-clave-local-32chars-minimo
pnpm dev
```
- [ ] License server arranca en `:3001`
- [ ] Crear licencia de prueba:
  ```bash
  curl -X POST http://localhost:3001/licenses \
    -H "Content-Type: application/json" \
    -H "X-Superadmin-Key: superadmin-clave-local-32chars-minimo" \
    -d '{"clinic_name":"Clínica Demo","plan":"basic","expires_at":"2027-12-31T00:00:00Z"}'
  ```
- [ ] ✅ Resultado: licencia con clave `DK-XXXXXXXX-...`

### D2. Update manager (firma GPG)
```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco

# Generar claves GPG de prueba
bash updater/update.sh --generate-test-keys

# Simulación en seco (no aplica cambios)
bash updater/update.sh --dry-run
```
- [ ] `--generate-test-keys` genera par de claves GPG temporales
- [ ] `--dry-run` muestra las fases sin ejecutar nada real

### D3. Tests automatizados
```bash
cd /home2/kiosco_v3_produccion_18_05_26/dentalkiosco
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
```
- [ ] ✅ 195/195 tests pasando

### D4. Type-check
```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
```
- [ ] ✅ 0 errores TypeScript

---

## Comandos de diagnóstico rápido

```bash
# Ver últimas entradas del log de la API
tail -50 /tmp/dk-api.log | jq -r '. | "\(.time) [\(.level)] \(.msg)"' 2>/dev/null \
  || tail -50 /tmp/dk-api.log

# Ver logs de booking en tiempo real
tail -f /tmp/dk-api.log | grep -E "booking|cita|appointment|ERROR"

# Ver logs de errores recientes
grep -E "ERROR|WARN" /tmp/dk-api.log | tail -20

# Ver OTP generado (si OTP_REQUIRED=true)
grep "otp" /tmp/dk-api.log | tail -5

# Estado de la base de datos
PGPASSWORD=$(grep POSTGRES_PASSWORD .env | cut -d= -f2) \
  psql -h localhost -p 5433 -U dentalkiosco -d dentalkiosco \
  -c "SELECT * FROM transactions ORDER BY created_at DESC LIMIT 5;"

# Reiniciar la API (si hace falta)
kill $(ps aux | grep "tsx.*server.ts" | grep -v grep | awk '{print $2}') 2>/dev/null || true
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev 2>&1 | tee /tmp/dk-api.log &
```

---

## Resultado esperado al completar

| Módulo | Estado |
|--------|--------|
| A — Infraestructura | ✅ |
| B — Flujo paciente | ✅ |
| C — Panel admin | ✅ |
| D — Infraestructura | ✅ |
