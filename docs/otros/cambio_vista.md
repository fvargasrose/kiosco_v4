# DentalKiosco — Plan de cambio de vista (estilo Apple/Inter)

**Referencia:** `docs/dental_kiosco_apple.html`  
**Alcance:** solo presentación — sin cambios de lógica, API, router ni estado  
**Pantallas afectadas:** todas las pantallas post-login del kiosco frontend  
**Eliminación:** opción "Mi perfil" removida del menú  
**Responsive:** sí, para kiosco táctil grande y pantallas más pequeñas

---

## 1. Resumen del cambio visual

| Aspecto | Antes | Después |
|---------|-------|---------|
| Fuente | `system-ui` / `-apple-system` | `Inter` (Google Fonts) |
| Iconos | Emojis (`📅`, `🦷`, `👤`) | Tabler Icons (`ti ti-*`) |
| Layout home | Pantalla completa, botones en grilla | Sidebar lateral + área de contenido |
| Colores primarios | `#0369a1` (azul oscuro) | `#0071e3` (azul Apple) |
| Fondo | `#f8fafc` plano | `#f5f5f7` con frosted glass en cards |
| Hero de bienvenida | Header `<h1>Hola, Fabian 👋` | Banner gradiente azul con reloj en vivo |
| Tarjetas de acción | Botones con emoji + texto plano | `action-card`: icono coloreado + título + descripción |
| Lista de citas | Filas simples | `cita-card`: cuadro fecha grande (día+mes) + badge estado |
| Paso a paso booking | Barra de puntos numerados | Píldora `step-bar` estilo segmented control |
| Selección de dentista | Lista de botones | `doctor-option`: avatar circular + radio dot animado |
| Selección de hora | Botones en columna | Grid de píldoras 4 columnas |
| Tratamientos/Pagos | Lista básica | `stat-card` de resumen + `payment-row` por ítem |
| Sidebar | No existe | Colapsable 240px → 72px, con íconos y labels |
| Responsive | Parcial | Sidebar colapsa en pantallas < 900px; bottom-bar en < 600px |

---

## 2. Dependencias externas a agregar

Solo en `index.html` — no requieren npm ni cambios al build:

```html
<!-- Fuente Inter (reemplaza system-ui) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

<!-- Tabler Icons (reemplaza emojis) -->
<link rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.x/dist/tabler-icons.min.css">
```

> Si el kiosco opera sin internet: descargar ambas fuentes y servirlas localmente desde `apps/kiosco-frontend/public/fonts/`.

---

## 3. Archivos a modificar

| Archivo | Tipo de cambio |
|---------|---------------|
| `index.html` | Agregar `<link>` de Inter + Tabler Icons |
| `src/styles.css` | Reemplazar variables CSS + agregar todas las clases nuevas del sistema de diseño |
| `src/screens/home.js` | Rediseño completo: sidebar + hero + action-grid. Eliminar tarjeta de perfil |
| `src/screens/appointments.js` | Aplicar `cita-card` con `cita-date-box` y badges de estado |
| `src/screens/treatments.js` | Aplicar `stat-card` de resumen + `payment-row` por tratamiento |
| `src/screens/booking.js` | Aplicar `step-bar` pill, `doctor-option` con radio, grid de slots |
| `src/screens/payment.js` | Aplicar estilo pagos con `stat-card` + botón de pago primario |
| `src/screens/login-cedula.js` | Aplicar `login-wrap`, `input-field`, `btn-primary` |
| `src/screens/login-otp.js` | Aplicar mismos estilos que login-cedula |

**No se modifican:**
- `api.js`, `state.js`, `router.js`, `idle.js`
- `screens/standby.js`, `screens/habeas-data.js`, `screens/register.js`
- `screens/profile.js` — el archivo permanece, solo se elimina del menú
- `components/keyboard.js`, `modal.js`, `spinner.js`, `toast.js`

---

## 4. Sistema de diseño — tokens CSS nuevos

En `styles.css` se reemplazan las variables `:root` actuales por:

```css
:root {
  /* Tipografía */
  --sf: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

  /* Colores */
  --bg:          #f5f5f7;
  --sidebar-bg:  rgba(255, 255, 255, 0.72);
  --card-bg:     rgba(255, 255, 255, 0.85);
  --accent:      #0071e3;
  --accent-hover:#0077ed;
  --text1:       #1d1d1f;
  --text2:       #6e6e73;
  --text3:       #aeaeb2;
  --border:      rgba(0, 0, 0, 0.08);

  /* Semánticos (mantener compatibilidad con componentes existentes) */
  --color-primary:      var(--accent);
  --color-success:      #34c759;
  --color-danger:       #ff3b30;
  --color-warning:      #ff9500;
  --color-text:         var(--text1);
  --color-text-muted:   var(--text2);
  --color-border:       var(--border);
  --color-surface:      var(--card-bg);

  /* Radio */
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-xl: 28px;

  /* Tamaño base — reducir de 18px a 15px para el nuevo layout */
  --font-size-base: 15px;
}
```

---

## 5. Layout post-login — estructura HTML nueva

El layout envuelve TODAS las pantallas post-login. Se implementa en `home.js` como contenedor persistente con sidebar + slot de contenido:

```
┌─────────────────────────────────────────────┐
│  sidebar (240px)  │  main content (flex:1)  │
│  ───────────────  │  ─────────────────────  │
│  logo + nombre    │  <pantalla activa>       │
│  clínica          │  (home / citas /         │
│  ───────────────  │   tratamientos /         │
│  • Inicio         │   booking / pagos)       │
│  • Mis Citas      │                          │
│  • Tratamientos   │                          │
│  • Agendar Cita   │                          │
│  ───────────────  │                          │
│  [Cerrar sesión]  │                          │
└─────────────────────────────────────────────┘
```

El botón de colapso (`toggle-btn`) reduce el sidebar a 72px mostrando solo íconos.

### Opciones de nav del sidebar (post-login)

| Ícono Tabler | Label | `navigate()` target |
|---|---|---|
| `ti-home-2` | Inicio | `home` |
| `ti-calendar` | Mis Citas | `appointments` |
| `ti-tooth` | Mis Tratamientos | `treatments` |
| `ti-calendar-plus` | Agendar Cita | `booking` |

Footer del sidebar:
| `ti-logout` | Cerrar sesión | llama a `api.logout()` + `navigate('standby')` |

> **Perfil eliminado:** la opción `ti-user` / "Mi perfil" NO aparece en el sidebar ni en el action-grid.

---

## 6. Cambios pantalla por pantalla

### 6.1 `home.js` — Pantalla de inicio (la más importante)

**Estructura:**
1. **Hero banner** — gradiente azul `135deg #007aff → #00c7ff`, borde redondeado grande (`radius-xl`), con:
   - Texto "Bienvenido de vuelta"
   - Nombre completo del paciente (de `state.patient.name`)
   - Reloj en vivo (`setInterval` cada segundo, `HH:MM`)
2. **Action grid** — 3 columnas, cada tarjeta con:
   - Ícono en cuadrado redondeado con color de fondo semitransparente
   - Título en negrita
   - Descripción breve

**Tarjetas del action-grid** (sin "Mi perfil"):

| Ícono | Color | Título | Descripción | Target |
|---|---|---|---|---|
| `ti-calendar-plus` | verde `#34c759` | Agendar cita | Reserva tu próxima visita | `booking` |
| `ti-calendar` | azul `#0071e3` | Mis citas | Consulta o cancela tus visitas | `appointments` |
| `ti-tooth` | naranja `#ff9500` | Mis tratamientos | Historial y saldos pendientes | `treatments` |

> Tres tarjetas en vez de cuatro — se elimina "Mi perfil".

---

### 6.2 `appointments.js` — Mis citas

**Estructura:**
- Encabezado con título + botón "Nueva cita" (outline azul, navega a `booking`)
- Por cada cita: `cita-card` horizontal con:
  - `cita-date-box`: cuadrado azul translúcido, día en número grande + mes en mayúscula pequeña
  - `cita-info`: nombre del tratamiento en negrita, nombre del doctor + hora, badge de estado
  - Flecha `ti-chevron-right` al extremo derecho (si la cita es cancelable, el click abre el confirm de cancelación igual que ahora)
- Sección "Anteriores" con citas pasadas en `opacity: 0.6` y date-box gris

**Badges de estado:**

| Estado Dentalink | Clase CSS | Color |
|---|---|---|
| Reservada / Confirmada | `badge-green` | verde `#34c759` |
| Pendiente | `badge-orange` | naranja `#ff9500` |
| Cancelada / Completada | `badge-gray` | gris `var(--text3)` |

---

### 6.3 `treatments.js` — Mis tratamientos

**Estructura:**
- Fila de 3 `stat-card` en grid:
  - **Saldo total pendiente** (suma de todos los tratamientos con saldo > 0) en naranja
  - **Total pagado** en verde
  - **Tratamientos activos** (count) en azul
- Por cada tratamiento: `cita-card` adaptado con:
  - Nombre del tratamiento y estado en badge
  - Saldo pendiente / total en la parte derecha
  - Si tiene saldo > 0: botón "Pagar" azul (navega a `payment` igual que ahora)

---

### 6.4 `booking.js` — Agendar cita (5 pasos)

**Paso 1 — Sede:**
- Mantiene `option-card` pero con el nuevo estilo (frosted glass, radius-md, hover con elevación)

**Paso 2 — Dentista:**
- Reemplazar la grilla de tarjetas por `doctor-option` rows:
  - Avatar circular con iniciales (gradiente azul) o foto si existe
  - Nombre en negrita + especialidad en gris
  - `radio-dot` al extremo derecho con animación de selección

**Paso 3 — Fecha:**
- Mantiene la grilla de `date-card` pero con nuevo estilo: borde redondeado más grande, número de día más prominente

**Paso 4 — Hora:**
- Reemplazar la lista de botones de slots por grid de 4 columnas de píldoras:
  - Estado normal: borde `var(--border)`, fondo blanco
  - Estado activo (seleccionado): borde `var(--accent)`, fondo `rgba(0,113,227,0.08)`, texto azul

**Paso 5 — Confirmar:**
- Mantiene el resumen en `booking-summary` pero con el nuevo estilo de card frosted glass
- `confirm-box` verde con ícono de check al éxito (ya existe, solo restyling)

**Step bar:**
- Reemplazar la barra de puntos actuales por el `step-bar` estilo segmented control (fondo gris suave, ítem activo en blanco con sombra)

---

### 6.5 `payment.js` — Pago

**Estructura:**
- `stat-card` con el monto a pagar en naranja prominente
- Nombre del tratamiento y fecha de vencimiento
- Botón "Pagar ahora" primario grande (igual que ahora, solo restyling)
- QR en card centrada con borde suave

---

### 6.6 `login-cedula.js` y `login-otp.js` — Login

**Estructura:**
- `login-wrap` centrado (max-width 360px)
- `input-field` con borde sutil y glow azul en focus
- `btn-primary` de ancho completo
- Texto auxiliar en `--text2`
- Sin cambios en lógica ni en el teclado táctil custom (`keyboard.js`) — el teclado sigue apareciendo sobre el input igual que ahora

---

## 7. Responsive

| Breakpoint | Comportamiento |
|---|---|
| `≥ 900px` | Sidebar completo 240px + main content |
| `600px – 899px` | Sidebar colapsado a 72px (solo íconos) por defecto |
| `< 600px` | Sidebar se oculta; aparece barra de navegación inferior (bottom tab bar) con los mismos 4 íconos |

La barra inferior en mobile usa `position: fixed; bottom: 0` con las mismas acciones del sidebar. En kiosco táctil grande esto no aplica, pero garantiza que el sistema funcione en pantallas de demo.

---

## 8. Qué NO cambia

- Toda la lógica de `router.js` — la navegación entre pantallas funciona igual
- `api.js` — ninguna llamada a la API cambia
- `state.js` — el estado global no cambia
- `idle.js` — el detector de inactividad no cambia
- `standby.js` — pantalla de standby no cambia (pre-login, separada)
- `habeas-data.js` — cambio mínimo de estilos si acaso
- `profile.js` — el archivo permanece en disco, solo se elimina el enlace en el menú
- `components/keyboard.js` — el teclado táctil custom no cambia
- `components/modal.js`, `spinner.js`, `toast.js` — se adaptan los colores vía variables CSS, sin tocar la lógica

---

## 9. Orden de implementación recomendado

1. **`index.html`** — agregar Inter + Tabler Icons (2 líneas, sin riesgo)
2. **`styles.css`** — redefinir tokens CSS + agregar clases nuevas del sistema de diseño (sidebar, action-card, cita-card, step-bar, doctor-option, stat-card, badges). Los componentes existentes siguen funcionando porque se mantienen los alias semánticos (`--color-primary`, etc.)
3. **`home.js`** — sidebar + hero + action-grid sin perfil. Es el cambio más visible y permite validar el layout general
4. **`appointments.js`** — `cita-card` con date-box y badges
5. **`treatments.js`** — stat-cards + payment-rows
6. **`booking.js`** — step-bar + doctor-option + slots grid (cambio más extenso)
7. **`payment.js`** — stat-card + botón pago
8. **`login-cedula.js`** + **`login-otp.js`** — `login-wrap` + input-field

> Cada paso es independiente y testeable — si `home.js` queda bien, los demás siguen el mismo patrón.

---

## 10. Criterios de aceptación

- [ ] Fuente Inter cargada y aplicada en toda la app post-login
- [ ] Sidebar visible con los 4 ítems de navegación + logout; sin opción de perfil
- [ ] Sidebar colapsa/expande con botón toggle
- [ ] Hero banner muestra nombre del paciente y reloj en vivo
- [ ] Action-grid de 3 tarjetas (sin perfil) con íconos Tabler
- [ ] Citas muestran date-box con día grande + badge de estado correcto
- [ ] Tratamientos muestran stat-cards de resumen
- [ ] Step-bar de booking es estilo píldora, no puntos
- [ ] Selección de dentista usa `doctor-option` con radio animado
- [ ] Slots de hora en grid de 4 columnas
- [ ] En pantalla ≤ 600px aparece bottom tab bar en vez de sidebar
- [ ] Toda la lógica existente (cancelar cita, pagar, booking, logout, idle) funciona sin cambios
- [ ] `profile.js` no aparece en ningún punto de navegación
