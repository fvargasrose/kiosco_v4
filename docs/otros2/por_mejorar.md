# Por mejorar

> Lista de mejoras pendientes (informes y propuestas). No implementadas todavía.

---

## 1. Auto-cierre por inactividad a 7 minutos

**Fecha:** 2026-06-07
**Estado:** 📋 Propuesto — pendiente de implementar
**Pedido:** Si el usuario no tiene actividad en **7 minutos** en la página, la sesión debe cerrarse automáticamente.

### Cómo está hoy
En `apps/kiosco-frontend/src/idle.js`:
- **28 min** sin actividad → modal *"¿Sigues ahí?"* (aviso)
- **30 min** sin actividad → cierra sesión y vuelve a la landing (standby)

Detalle importante (`apps/kiosco-frontend/src/main.js`): el temporizador **solo corre
cuando hay sesión de paciente iniciada** (después del login). En standby o en las
pantallas de login no hay auto-cierre — lo cual tiene sentido, porque standby ya es
el estado "cerrado".

Actividad considerada = toques/teclas (`pointerdown`, `touchstart`, `keydown`).

### Lo que habría que cambiar
Bajar el cierre a **7 minutos** de inactividad. Es un cambio chico en `idle.js`
(las dos constantes `WARN_AT_MS` y `LOGOUT_AT_MS`). El cierre seguiría haciendo:
`logout()` + volver a standby.

La duda pendiente es **el aviso previo**. Hoy hay un modal 2 min antes del cierre.
Con 7 min hay que decidir:
- **Con aviso**: ej. modal a los **6 min** con cuenta regresiva de 1 min → cierra a los 7.
- **Sin aviso**: cierra directo a los 7 min, sin modal.

### Preguntas abiertas (a confirmar antes de implementar)
1. ¿El cierre es exactamente a los **7 minutos** de inactividad?
2. ¿Mantener el aviso *"¿Sigues ahí?"* antes de cerrar, o cierre directo sin modal?
3. ¿Aplica solo a la sesión iniciada (comportamiento actual), o también en otras pantallas?

### Nota
Existe un pendiente relacionado (#2 en `docs/produccion_pendiente.md`) para hacer
este tiempo **configurable por variable de entorno**. En vez de fijar "7" en el
código, se podría dejar configurable con default 7 min. Por ahora lo más simple es
fijar 7.
