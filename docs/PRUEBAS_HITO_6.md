# Pruebas del Hito 6 — Frontend del kiosco

## Pre-requisitos

- Hitos 1-5 completados y validados.
- Backend corriendo: `docker compose up -d` con migraciones aplicadas y seed.
- Tener un `kiosk_token` válido del kiosco demo (creado por seed).

---

## Resumen

El Hito 6 entrega el **frontend completo del kiosco**:

- **Stack:** Vanilla JS modular + Vite 5 (sin React/Vue, mínimo overhead).
- **9 pantallas:** standby, FAQ, habeas-data, login-cedula, login-otp,
  home, appointments, treatments, profile.
- **Componentes:** modal, toast, spinner reutilizables.
- **Idle timer:** 90s para logout, warning a los 60s.
- **Diseño adaptable** a landscape 1920×1080 y portrait 1080×1920.
- **Bundle:** 31.7 KB JS + 13.3 KB CSS gzipped a ~12 KB.

---

## P1 — Build y arranque

### P1.1 — Build limpio

```bash
cd apps/kiosco-frontend
npm install
npm run build
```

**Validar:**
- [ ] `vite build` termina con `✓ built in XXXms`
- [ ] `dist/index.html` y `dist/assets/index-*.{js,css}` se generan
- [ ] Bundle total (gzipped) < 15 KB

### P1.2 — Servidor dev arranca

```bash
cd apps/kiosco-frontend
npm run dev
```

**Validar:**
- [ ] Vite imprime `Local: http://localhost:5173/`
- [ ] Abriendo el navegador en esa URL, se ve "Iniciando kiosco..."

---

## P2 — Pareo y bootstrap

### P2.1 — Sin kiosk_token muestra "Kiosco no pareado"

Sin `?kiosk_token=...` ni token en sessionStorage:

```
http://localhost:5173/
```

**Validar:**
- [ ] Pantalla "🔒 Kiosco no pareado"
- [ ] Texto: "Este kiosco aún no ha sido asociado a una clínica."

### P2.2 — Pareo vía query string

Obtén un `KIOSK_TOKEN` (ver `PRUEBAS_HITO_4.md` P2.1) y abre:

```
http://localhost:5173/?kiosk_token=<paste>
```

**Validar:**
- [ ] La URL se limpia automáticamente (sin el `?kiosk_token=...`)
- [ ] `sessionStorage.kiosk_token` ahora tiene el token (verificar en DevTools)
- [ ] Aparece la pantalla **standby** con el nombre de la clínica
- [ ] Refrescar (F5) mantiene el token y vuelve a standby

### P2.3 — Token inválido es rechazado

```
http://localhost:5173/?kiosk_token=garbage
```

**Validar:**
- [ ] El bootstrap falla con 401
- [ ] Limpia el token automáticamente
- [ ] Muestra pantalla "Kiosco no pareado" con mensaje "El token fue rechazado por el servidor."

### P2.4 — Backend caído

Detén el API:
```bash
docker compose stop api
```

Refresca el kiosco:

**Validar:**
- [ ] Aparece pantalla "📡 Sin conexión"
- [ ] Botón "Reintentar" recarga
- [ ] Después de 15s, intenta auto-recargar

Vuelve a levantar el API:
```bash
docker compose start api
```

---

## P3 — Pantalla standby

### P3.1 — Atractor

**Validar:**
- [ ] Fondo azul gradiente (primario clínica)
- [ ] Nombre de la clínica grande
- [ ] Texto "Bienvenido a nuestro autoservicio"
- [ ] Botón "Toca para comenzar"
- [ ] Link "Preguntas frecuentes" abajo

### P3.2 — Cualquier toque inicia flujo

**Validar:**
- [ ] Tocar en cualquier área (excepto el link de FAQ) navega a Habeas Data
- [ ] Tocar en "Preguntas frecuentes" abre FAQ sin login

---

## P4 — FAQ (sin login)

### P4.1 — Renderizado

Desde standby, tocar "Preguntas frecuentes".

**Validar:**
- [ ] Header con "Preguntas frecuentes" + botón "Volver"
- [ ] Lista de preguntas (las del bootstrap)
- [ ] Cada pregunta es expandible (acordeón)
- [ ] Si no hay FAQs configuradas, muestra empty state

### P4.2 — Volver

**Validar:**
- [ ] Botón "Volver" regresa a standby

---

## P5 — Habeas Data

### P5.1 — Bloqueo hasta consentimiento

**Validar:**
- [ ] Botón "Aceptar y continuar" está deshabilitado al inicio
- [ ] Se habilita al marcar el checkbox
- [ ] Texto de política es scroll-visible (max 300px alto, scroll interno)
- [ ] Muestra la versión de la política

### P5.2 — Cancelar vuelve a standby

**Validar:**
- [ ] Botón "Cancelar" en header regresa a standby

### P5.3 — Aceptar pasa a login-cedula

**Validar:**
- [ ] Al marcar checkbox y tocar "Aceptar y continuar" navega a login-cedula
- [ ] El policy_version y policy_hash se pasan correctamente

---

## P6 — Login con cédula y celular

### P6.1 — Validación de inputs

**Validar:**
- [ ] Campo cédula solo acepta dígitos (no letras ni símbolos)
- [ ] Campo celular muestra prefijo "+57" no editable
- [ ] Solo dígitos en celular
- [ ] Cédula < 6 dígitos → error "Cédula inválida"
- [ ] Celular que no inicia con 3 → error "Debe iniciar con 3"
- [ ] Celular con != 10 dígitos → error

### P6.2 — Envío correcto

Con cédula `1061700000` y celular `3001234567`:

**Validar:**
- [ ] Botón pasa a "Enviando..." durante request
- [ ] Si 200, navega a login-otp
- [ ] Pasa request_id, expires_in_seconds, masked_phone correctamente

### P6.3 — Errores de servidor

- Rate limit (429): muestra "Demasiados intentos..."
- Kiosk inválido (403): muestra "Este kiosco no está autorizado..."
- Sin red: toast "Error de conexión..."

---

## P7 — Login OTP (6 dígitos)

### P7.1 — Inputs separados

**Validar:**
- [ ] 6 cajas independientes, una por dígito
- [ ] Solo acepta dígitos (otros caracteres se ignoran)
- [ ] Auto-focus al siguiente al ingresar dígito
- [ ] Backspace en caja vacía mueve al anterior
- [ ] Paste de 6 dígitos llena todas las cajas

### P7.2 — Auto-submit al completar

**Validar:**
- [ ] Al ingresar el 6to dígito, hace verify automáticamente
- [ ] No requiere tocar "Verificar"

### P7.3 — Countdown

**Validar:**
- [ ] Muestra "El código expira en 5:00"
- [ ] Decrementa cada segundo
- [ ] Al llegar a 0:00 muestra "expirado" y deshabilita verify

### P7.4 — Verify exitoso

Obtén el OTP del log del backend (`DEV_LOG_OTP=true`):

```bash
docker compose logs api | grep "MOCK SMS" | tail -1
```

**Validar:**
- [ ] Al ingresar el código correcto, navega a home
- [ ] state.patient queda con los datos del paciente
- [ ] sessionStorage NO guarda el patient_token (solo en memoria)

### P7.5 — Código incorrecto

**Validar:**
- [ ] Muestra "Código incorrecto..."
- [ ] Limpia inputs y vuelve al primero
- [ ] Permite reintentar

### P7.6 — Cancelar

**Validar:**
- [ ] Botón "Cancelar" regresa a standby
- [ ] Detiene el countdown (no sigue corriendo)

---

## P8 — Home (post-login)

### P8.1 — Saludo personalizado

**Validar:**
- [ ] Header muestra "Hola, [primer nombre del paciente] 👋"
- [ ] 3 menu cards: Mis citas, Mis tratamientos, Mi perfil
- [ ] Botón "Cerrar sesión" en header

### P8.2 — Cerrar sesión

**Validar:**
- [ ] Toque en "Cerrar sesión" → POST /auth/logout
- [ ] Limpia patient session
- [ ] Vuelve a standby

---

## P9 — Mis citas

### P9.1 — Tabs

**Validar:**
- [ ] Tab "Próximas" activa por defecto
- [ ] Tab "Pasadas" carga citas pasadas/canceladas/atendidas
- [ ] Cambio de tab refresca el listado

### P9.2 — Cita upcoming muestra acciones

**Validar:**
- [ ] Cada cita upcoming tiene botones "Cancelar" y "Reagendar"
- [ ] Citas pasadas/canceladas NO los tienen
- [ ] Badge de estado: Confirmada → verde, Cancelada → rojo, otros → amarillo

### P9.3 — Cancelar/reagendar abre modal informativo

**Hito 6:** la acción real se delega a recepción.

**Validar:**
- [ ] Modal "Para cancelar... por favor dirígete a recepción"
- [ ] Modal "Para reagendar... próximamente desde el kiosco"
- [ ] El modal se cierra con "Entendido"

### P9.4 — Empty state

Si el paciente no tiene citas:

**Validar:**
- [ ] Muestra icono 📅 + "No tienes citas próximas."

---

## P10 — Mis tratamientos

### P10.1 — Summary card

**Validar:**
- [ ] Card gradient con 3 columnas: Total / Abonado / Saldo pendiente
- [ ] Montos formateados como COP ($1.500.000)
- [ ] Suma cuadra con la suma de los tratamientos

### P10.2 — Banner de pago

Si hay saldo > 0:

**Validar:**
- [ ] Banner info con "💳 Tienes un saldo pendiente de $X. Acércate a recepción..."
- [ ] Disclaimer: "Pago en línea... disponible próximamente."

### P10.3 — Lista de tratamientos

**Validar:**
- [ ] Cada item muestra nombre, periodo, total, abonado, saldo
- [ ] Badge "En curso" / "Finalizado"
- [ ] Saldo > 0 → badge amarillo; saldo = 0 → badge verde

---

## P11 — Mi perfil

### P11.1 — Datos personales

**Validar:**
- [ ] Lista con nombre, cédula, celular, email, fecha de nacimiento
- [ ] Disclaimer info: "Si alguno de estos datos está desactualizado, dirígete a recepción"
- [ ] Datos vienen de Dentalink, no de input local

---

## P12 — Idle timer

### P12.1 — Warning a los 60s

Hacer login, no tocar nada por 60s.

**Validar:**
- [ ] A los 60s aparece modal "⏰ ¿Sigues ahí?"
- [ ] Cuenta regresiva visible (30, 29, 28...)
- [ ] Botón "Sí, sigo aquí" cierra el modal y resetea el timer
- [ ] Botón "Cerrar sesión" cierra inmediatamente

### P12.2 — Auto-logout a los 90s

Hacer login, no tocar nada por 90s.

**Validar:**
- [ ] A los 90s el modal cierra y vuelve a standby
- [ ] Toast "Sesión cerrada por inactividad."
- [ ] Llamó a POST /auth/logout (verificar en audit_log)

### P12.3 — Cualquier toque resetea el timer

**Validar:**
- [ ] Tocar la pantalla extiende la sesión
- [ ] Mover el dedo (pointermove) NO la extiende (intencional)

### P12.4 — Timer solo corre con paciente logueado

**Validar:**
- [ ] En standby, FAQ o habeas-data NO hay timer
- [ ] Después de logout, timer se detiene

---

## P13 — Adaptación a orientación

### P13.1 — Landscape 1920×1080

En DevTools (Chrome), simular `Responsive: 1920x1080`:

**Validar:**
- [ ] Standby: título 5rem, CTA grande
- [ ] Home: 3 cards en grid horizontal
- [ ] Menu cards centrados, anchos

### P13.2 — Portrait 1080×1920

Simular `Responsive: 1080x1920`:

**Validar:**
- [ ] Standby: contenido vertical centrado
- [ ] Home: menu cards en columna única, layout horizontal interno (icono+texto)
- [ ] Summary card en 1 columna
- [ ] Item cards apilan info verticalmente

### P13.3 — Tablet pequeña (preview)

Simular 768x1024:

**Validar:**
- [ ] Layout colapsa correctamente
- [ ] OTP digits 44x60px en lugar de 56x72px
- [ ] Profile rows verticales

---

## P14 — Seguridad

### P14.1 — patient_token NO persiste

**Validar:**
- [ ] Hacer login, abrir DevTools → Application → Session Storage
- [ ] Solo aparece `kiosk_token`, NO `patient_token`
- [ ] Refrescar la pestaña cierra la sesión del paciente (pero kiosk_token persiste)

### P14.2 — CSP estricto

El backend (Caddy) sirve headers CSP que bloquean inline scripts.

**Validar:**
- [ ] DevTools → Console: no hay errores de CSP
- [ ] Todos los scripts/styles vienen del bundle, no inline

### P14.3 — XSS protection

Probar inyectar HTML en cédula y nombre:

**Validar:**
- [ ] Toda salida usa `escapeHtml` (verificar grep en código)
- [ ] Los datos del paciente desde Dentalink se escapan antes de renderizar

### P14.4 — Sin telephone detection

iOS y Android tienden a auto-linkar números de teléfono. El meta tag previene eso:

**Validar:**
- [ ] `index.html` tiene `<meta name="format-detection" content="telephone=no">`

### P14.5 — Sin zoom

**Validar:**
- [ ] `index.html` tiene `user-scalable=no, maximum-scale=1`
- [ ] Pellizcar en la pantalla no hace zoom

---

## Resumen aceptación

**Criterio mínimo:**

- [ ] P1.1 — Build limpia sin errores
- [ ] P2.2 — Pareo por query string funciona
- [ ] P5.1 — Habeas Data requiere checkbox antes de continuar
- [ ] P6, P7 — Flujo de OTP completo funciona
- [ ] P9, P10, P11 — Las 3 pantallas autenticadas cargan datos reales
- [ ] P12 — Idle timer (warning 60s, logout 90s) funciona
- [ ] P13 — Layout adaptable a portrait y landscape
- [ ] P14.1 — patient_token NO persiste entre refrescos
- [ ] P14.3 — Output escapado contra XSS

**Conociendo limitaciones del Hito 6 (intencionales):**

- Cancelar/reagendar muestra modal informativo (acción real en Hito 7)
- Pago muestra banner pero no procesa (procesamiento en Hito 7)
- Idioma solo ES-CO (sin toggle EN en este hito)
