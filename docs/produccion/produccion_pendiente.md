# Cambios pendientes de revertir antes de producción

Este archivo documenta modificaciones hechas en desarrollo que **deben revertirse
o revisarse antes de hacer el deploy del Hito F (Hetzner + Cloudflare)**.

---

## 1. CORS del API — `origin: false` → `origin: true`

### Archivo
`apps/api/src/server.ts` · línea ~62

### Estado actual (desarrollo)
```typescript
await app.register(cors, {
  // DEV: reflect origin → permite ngrok y acceso desde red local/celulares.
  // PRODUCCIÓN: revertir a `origin: false` (Caddy filtra orígenes antes de llegar aquí).
  origin: true,
  credentials: true,
});
```

### Por qué se cambió
Para poder usar **ngrok** y acceder al sistema desde celulares y computadores
fuera de la red local durante las pruebas. Con `origin: false` el API rechazaba
cualquier request cuyo `Origin` no fuera el mismo host, bloqueando el túnel ngrok.

`origin: true` = *reflect*: el API devuelve como `Access-Control-Allow-Origin`
el mismo origen que llegó en el header `Origin`. Permite cualquier origen.

### Por qué es aceptable en desarrollo
- En dev el tráfico está en red local controlada o un túnel temporal de ngrok.
- No hay datos de producción reales ni tarjetas de pacientes reales.
- Los 280 tests no se ven afectados (usan `app.inject()`, sin red real).

### Por qué DEBE revertirse en producción
En producción el stack es:

```
Internet → Cloudflare → Caddy → API (localhost, no expuesto)
```

- **Caddy ya controla los orígenes** con `try_files` y las cabeceras de seguridad.
- La API **nunca es accesible directamente desde internet** (solo desde Caddy
  en el mismo contenedor/red Docker).
- Con `origin: true`, si por algún fallo de configuración la API quedara
  expuesta directamente (puerto 3000 abierto), cualquier sitio web podría
  hacer requests autenticados desde el navegador de un paciente logueado.
- `origin: false` es el valor correcto para un servidor detrás de un reverse
  proxy de mismo origen. No hay overhead, no hay riesgo.

### Cómo revertir (1 línea)

```diff
  await app.register(cors, {
-   origin: true,
+   origin: false, // Mismo origen (servido por Caddy)
    credentials: true,
  });
```

O con sed desde la raíz del proyecto:
```bash
sed -i "s/origin: true,/origin: false, \/\/ Mismo origen (servido por Caddy)/" \
  apps/api/src/server.ts
```

### Cuándo revertir
Al iniciar el **Hito F** (deploy Hetzner), antes de construir la imagen Docker
de la API (`docker compose build api`).

### Verificación post-reversión
```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
# Los 280 tests deben seguir verdes
```

---

> Añadir aquí cualquier otro cambio de dev que deba revisarse antes de producción.
