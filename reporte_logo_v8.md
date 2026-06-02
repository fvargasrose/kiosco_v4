# reporte_logo_v8 — Logo de la clínica en el kiosco (estado actual)

Fecha: 2026-06-02 · Confirmado visualmente por el usuario: "quedó mejor".
Continúa de [mlogo_v6.md] (subida + ruteo del logo) y [mlogo_7.md] (plan banner).

## Resumen
El logo de la clínica se sube desde el admin y se muestra en el kiosco. El último
ajuste lo convirtió en un **banner ancho centrado** en la cabecera del sidebar de
las pantallas principales (tema apple). Cambio puramente CSS.

## Estado actual — dónde se ve el logo

Tema activo: `KIOSK_THEME=apple` (.env). Se cargan `styles.css` (siempre) +
`styles-apple.css` (tema apple).

| Superficie | Pantallas | Clase | Tamaño actual | Archivo |
|-----------|-----------|-------|---------------|---------|
| **Sidebar** (banner) | home, citas, tratamientos, agendar, pago | `.ak-sidebar-logo` | **width 100% · max-height 96px** (40px colapsado), nombre en texto oculto | `styles-apple.css:~92` |
| Header global | login, OTP, perfil, registro, habeas-data | `.clinic-header-logo` | max-height 60px · max-width 200px (SIN cambios) | `styles-apple.css:~112` |
| Standby | descanso | `.standby-logo-img` | max-height 140px centrado (SIN cambios) | `styles.css:164` |

## Qué se hizo en esta iteración (v7→v8)

Único archivo tocado: `apps/kiosco-frontend/src/styles-apple.css`. Solo CSS, sin
backend ni JS.

1. `.ak-sidebar-header`: de fila a **columna centrada**
   (`flex-direction: column; align-items: center; justify-content: center;`)
   para que el logo ocupe el ancho completo en lugar de ir junto al texto.
2. `.ak-sidebar-header .ak-logo-text { display: none; }`: oculta el **nombre de la
   clínica en texto** (el logo ya identifica la clínica).
3. `.ak-sidebar-logo`: de `36×36px` a
   `width: 100%; height: auto; max-height: 96px; object-fit: contain; padding: 6px;`
   (mantiene `background:#fff` y `border-radius:8px`).
4. `.ak-sidebar.collapsed .ak-sidebar-logo { max-height: 40px; padding: 2px; }`:
   encoge el banner cuando el sidebar se colapsa a 68px (no desborda).

Verificado: `pnpm --filter @dentalkiosco/kiosco-frontend build` OK + recorrido
manual del usuario.

## Cómo cambiar cosas en el futuro

Todo se controla desde `apps/kiosco-frontend/src/styles-apple.css`:

- **Logo del sidebar más grande/pequeño:** ajustar `max-height: 96px` en
  `.ak-sidebar-logo` (subir = más grande). El ancho ya es 100% del sidebar
  (sidebar = 230px, `styles-apple.css:55`).
- **Volver a mostrar el nombre debajo del logo:** quitar la regla
  `.ak-sidebar-header .ak-logo-text { display: none; }`. Como el header ya es
  columna, el nombre saldría centrado debajo del logo.
- **Volver al estado anterior (logo chico 36px al lado del nombre):** revertir
  `.ak-sidebar-header` a `flex-direction` por defecto (fila), `.ak-sidebar-logo`
  a `width:36px; height:36px; padding:2px`, y quitar la regla de `.ak-logo-text`
  y la del colapsado. (Ver git diff de este cambio.)
- **Fondo del logo:** si el PNG tiene transparencia y no quieres el recuadro
  blanco, quitar `background:#fff` y `padding` de `.ak-sidebar-logo`.
- **Logo colapsado:** ajustar `max-height: 40px` en
  `.ak-sidebar.collapsed .ak-sidebar-logo`.
- **Header global (pantallas auxiliares):** `.clinic-header-logo` max-height 60 /
  max-width 200 — no se tocó; subir si se quiere grande también ahí.
- **Standby:** `.standby-logo-img` en `styles.css:164`, max-height 140 — no se tocó.

## Cómo cambiar el logo (imagen) en sí
1. Admin (`http://localhost:5174`) → login `admin@demo.local` / `Admin@Demo2026`
   → Configuración de clínica → subir nueva imagen (PNG/JPG).
2. El kiosco usa cache-buster `?v=<hash>`; recargar para ver el nuevo.
3. Sin logo subido → fallback automático: en el sidebar aparece el ícono de
   diente (`.ak-logo-circle`), en standby el emoji 🦷, en header el nombre en texto.

## Cadena técnica (referencia rápida)
- Backend emite `logo_url` en `GET /kiosk/bootstrap` →
  `/api/public/clinic-logo?v=<hash12>` (`apps/api/src/routes/kiosk.ts:152`).
- Ruta real del archivo: `/public/clinic-logo` (`apps/api/src/server.ts:113`);
  el prefijo `/api` lo resuelve Vite (dev) / Caddy `handle_path` (prod).
- Frontend lo usa como `<img src>` directo: sidebar `shell.apple.js:49-51`,
  header `clinic-header.js:23-25`, standby `standby.js:134-136`.
- Estado en BD: `clinic.logo_path / logo_mime / logo_hash / logo_updated_at`
  (migración 014). Logo actual: `apps/api/uploads/clinic-logo.png`.

## Pendiente
- [ ] Commit del cambio CSS:
      `style(kiosco): logo de clínica como banner ancho en el sidebar`.
- [ ] (de mlogo_v6) `git push` de los commits b47b136 + 953d5c2 aún sin pushear.
- [ ] (opcional) Apagar shells de prueba que queden corriendo.
