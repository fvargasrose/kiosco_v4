# doc_producir — Documentación de despliegue de DentalKiosco

Todo lo necesario para desplegar y mantener el sistema en producción.

| Archivo | Contenido |
|---|---|
| [DESPLIEGUE.md](DESPLIEGUE.md) | Guía paso a paso: desde cero + actualizar + comandos de operación |
| [CONSIDERACIONES.md](CONSIDERACIONES.md) | Trampas/consideraciones críticas (SMTP 587, Turnstile, fila clinic, CSP, SPF/DKIM, etc.) |
| [RESUMEN_Y_PENDIENTES.md](RESUMEN_Y_PENDIENTES.md) | Resumen de la sesión + estado actual + pendientes |
| [env.ejemplo](env.ejemplo) | Plantilla del `.env` de producción (sin secretos) |

**Producción:** `https://sistema.2ways.us` · servidor `ssh root@5.78.110.152` ·
repo `/opt/dentalkiosco` · rama **`para_produccion`**.

> ⚠️ Este repo es público: aquí NO van secretos. El `.env` real vive en el servidor (chmod 600).
