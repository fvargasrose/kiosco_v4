# AUDITORÍA C3 — Estado actual

### Prueba manual

**¿Qué debería pasar con `OTP_REQUIRED=false`?**
El paciente ingresa su celular → el frontend llama `api.loginDirect()` → el backend busca el paciente en Dentalink por celular → si existe, crea sesión directamente → navega a `home`. **Sin OTP, sin email, sin SMS.** Eso es por diseño.

**¿Qué pasó?**
Exactamente lo correcto. El sistema se comportó como se espera con `OTP_REQUIRED=false`.

**Causa raíz de la confusión:**
El `.env` actual tiene `OTP_REQUIRED=false`. Esto hace que `login-cedula.js` llame `loginDirect()` en lugar de `requestOtp()`, saltando la pantalla `login-otp` por completo. El email nunca se envía porque no hay OTP generado. No es un bug — es la configuración activa.

**Problema secundario real:**
`TWILIO_ACCOUNT_SID=` y `TWILIO_AUTH_TOKEN=` están **vacíos** en `.env`. Esto hace que `features.twilioConfigured` sea `false` y el SMS caiga al `MockSmsSender` (solo loguea, no envía). Si se activa `OTP_REQUIRED=true`, el SMS no llegaría al celular real. El email sí llegaría (Resend está configurado con clave real).

---

### Criterios de aceptación

| Criterio | Estado | Evidencia |
|----------|--------|-----------|
| Paciente puede loguearse con solo celular (`OTP_REQUIRED=true`) | ✅ | `RequestOtpBody` solo pide `phone`. Ruta `/auth/request-otp` funcional |
| Paciente puede loguearse con solo celular (`OTP_REQUIRED=false`) | ✅ | `login-direct` existe y funciona — confirmado por prueba manual |
| OTP llega a ambos canales cuando hay email y celular | ⚠️ | Lógica correcta (`sendOtpDual` + `Promise.allSettled`). Email real (Resend). **SMS solo mock** (Twilio sin credenciales) |
| OTP llega a un solo canal cuando falta uno (sin error) | ✅ | `notifications.ts:56-68` — solo agrega tarea si `phone` o `email` no son null |
| `request-otp` NO distingue teléfono existente vs no (anti-enumeración) | ✅ | `patient-auth.ts:228-231` — misma respuesta `{ request_id, expires_in_seconds }` siempre |
| 4º intento en 1h con mismo teléfono → 429 | ✅ | Rate limit bucket `otp:phone:*` con límite 3. Test lo cubre |
| `pnpm dk:otp +573001234567` muestra OTP activo | ✅ | Script `src/scripts/get-otp.ts` existe. `package.json` lo registra como `dk:otp` |
| Mismo comando en `NODE_ENV=production` → error y exit 1 | ✅ | `get-otp.ts:21-26` — `refuseInProduction()` + `process.exit(1)`. Test lo cubre |
| Todos los tests pasan (sin referencias a cédula) | ✅ | Tests usan solo `phone`. Sin campo `cedula`. Suite completa para el flujo OTP |

---

### Restricciones inviolables

| Restricción | Estado | Evidencia |
|-------------|--------|-----------|
| `verify-otp` no fue modificado en su lógica de seguridad | ✅ | Solo trabaja con `request_id` + `code`. No toca cédula. Flujo intacto |
| `get-otp.ts` rechaza `NODE_ENV=production` | ✅ | `get-otp.ts:16-26` — función `refuseInProduction()` exportada y testeada |
| Respuesta de `request-otp` siempre genérica | ✅ | `patient-auth.ts:228` — respuesta idéntica para paciente inexistente |
| Se usa `Promise.allSettled` para envío dual | ✅ | `notifications.ts:85` — `await Promise.allSettled(tasks)` |

---

### Archivos faltantes o incompletos

Solo hay **un problema real** — las credenciales de Twilio:

| Problema | Archivo | Detalle |
|----------|---------|---------|
| Twilio no configurado | `.env` | `TWILIO_ACCOUNT_SID=` y `TWILIO_AUTH_TOKEN=` vacíos → SMS cae a MockSmsSender → **nunca llega al celular real** |

Nada de código falta. Todo el código C3 está implementado y correcto.

---

### Plan de implementación propuesto

No hay nada que implementar en código. El único pendiente es operacional:

**Opción A — Probar flujo OTP real:**
1. Cambiar `.env`: `OTP_REQUIRED=true`
2. Llenar credenciales Twilio reales (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) para SMS real, **o** dejarlas vacías y confiar solo en email (Resend sí funciona)
3. Reiniciar API: `Ctrl+C` y volver a correr `pnpm --filter @dentalkiosco/api dev`
4. Probar con un paciente registrado en Dentalink que tenga celular y email

**Opción B — Probar CLI `dk:otp` sin Twilio:**
Con `OTP_REQUIRED=true` y Twilio sin configurar, el SMS solo aparece en el log de la API. Usar `dk:otp` para ver el código:
```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dk:otp +57XXXXXXXXXX
```

---

### Estimación

- **Código a escribir:** 0 archivos
- **Acción requerida:** Solo configuración en `.env` + credenciales Twilio
- **Estado real de C3:** ✅ Implementación completa y correcta
