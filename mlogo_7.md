# mlogo_v7 — Agrandar el logo de la clínica en el kiosco

## Contexto
El logo ya se sube y se muestra (commits b47b136 + 953d5c2, ver [mlogo_v6.md]).
Logo actual en BD: `clinic-logo.png` (248 KB, image/png), `logo_url` se emite OK.

**Queja del usuario:** el logo se ve **muy pequeño y en la parte superior
izquierda**. Quiere que se vea **grande**.

## Diagnóstico — dónde se renderiza el logo hoy

Tema activo: `KIOSK_THEME=apple` (.env). Se cargan ambos CSS: `styles.css`
(siempre) + `styles-apple.css` (tema apple).

| # | Superficie | Pantallas | Clase | Tamaño actual | Archivo |
|---|-----------|-----------|-------|---------------|---------|
| A | Sidebar apple | home, appointments, treatments, booking, payment | `.ak-sidebar-logo` | **36×36 px** al lado del texto del nombre | `styles-apple.css:89` |
| B | Header global | login, login-otp, profile, register, habeas-data | `.clinic-header-logo` | **max-height 60 px** | `styles-apple.css:109` |
| C | Standby | pantalla de descanso | `.standby-logo-img` | max-height 140 px, centrado | `styles.css:164` |

- A es el "pequeño arriba-izquierda" en las pantallas principales.
- B es el "pequeño arriba-izquierda" en las pantallas auxiliares.
- C ya sale grande y centrado (probablemente no necesita cambio).

Estructura HTML relevante:
- Sidebar: `shell.apple.js:53-59` → `.ak-sidebar-header` contiene
  `<img.ak-sidebar-logo>` + `<span.ak-logo-text>` (nombre). El sidebar mide
  230 px de ancho (`styles-apple.css:55`), colapsa a 68 px.
- Header: `clinic-header.js:31-36` → `.clinic-header` con `.clinic-header-brand`.
- Standby: `standby.js:134-136`.

## Decisiones tomadas por el usuario (2026-06-02)

1. **Superficie:** SOLO el sidebar de las pantallas principales (A).
   Header (B) y standby (C) se dejan como están.
2. **Estilo:** **Banner ancho** — el logo ocupa casi todo el ancho del sidebar
   (~190 px), centrado, altura auto. Se **oculta el texto del nombre**
   (`.ak-logo-text`) porque el logo ya identifica la clínica.
3. **Sidebar colapsado (68 px):** el banner debe encogerse para caber.

## Plan propuesto (banner ancho en el sidebar)

### Paso 1 — `styles-apple.css` · `.ak-sidebar-header` (línea ~70)
- Cambiar a `flex-direction: column` y centrar (`justify-content: center`),
  para que el logo ocupe el ancho completo en lugar de ir en fila con el texto.
- Mantener el `border-bottom` y el `padding` inferior.

### Paso 2 — `styles-apple.css` · `.ak-sidebar-logo` (línea ~89)
- De `36×36 px` → `width: 100%; height: auto; max-height: ~96 px;
  object-fit: contain;` centrado.
- Revisar el `background:#fff` + `padding:2px` actuales: si el logo es PNG con
  transparencia conviene mantener un fondo claro o quitarlo según se vea; queda
  como ajuste fino tras ver el resultado.

### Paso 3 — Ocultar el nombre en texto
- Opción CSS (mínima, sin tocar JS): `.ak-sidebar-header .ak-logo-text { display: none; }`.
- (Alternativa: quitar el `<span class="ak-logo-text">` en `shell.apple.js:58`,
  pero se prefiere la vía CSS para no tocar JS.)

### Paso 4 — Sidebar colapsado
- Añadir `.ak-sidebar.collapsed .ak-sidebar-logo { max-height: 40px; }`
  para que el logo no desborde los 68 px.

### Paso 5 — Verificación
- `pnpm --filter @dentalkiosco/kiosco-frontend build`.
- Recorrido manual: recargar `?kiosk_token=...` → home/citas/tratamientos,
  confirmar logo grande centrado en el sidebar; colapsar/expandir el sidebar.

## Alcance / archivos a tocar
- `apps/kiosco-frontend/src/styles-apple.css` (único archivo — solo CSS).
- (Opcionalmente `shell.apple.js` si se decide quitar el span en vez de CSS.)

NO se toca: backend, migraciones, payments, reconciler, licencias, header global,
standby.

## Estado
- [x] Decisiones confirmadas: solo sidebar, banner ancho, ocultar nombre.
- [x] Aplicar Pasos 1-4 — hecho en `styles-apple.css` (2026-06-02):
      `.ak-sidebar-header` → column/centrado; `.ak-logo-text` display:none;
      `.ak-sidebar-logo` → width 100% / max-height 96px / padding 6px;
      regla colapsado max-height 40px.
- [x] Build kiosco OK.
- [ ] Recorrido manual del usuario (recargar `?kiosk_token=...`).
- [ ] Commit `style(kiosco): logo de clínica como banner ancho en el sidebar`.
