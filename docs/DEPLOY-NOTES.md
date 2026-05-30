# Notas de despliegue — DentalKiosco

> Acciones manuales obligatorias al desplegar a producción. Cada entrada lleva fecha.
> Revisar este archivo en CADA deploy.

---

## 2026-05-30 — Fix de cancelación (S4): invalidar caché Redis en PRODUCCIÓN

**OBLIGATORIO** tras desplegar a producción: ejecutar UNA vez contra el Redis de **PRODUCCIÓN**:

```bash
redis-cli -a <password_prod> --no-auth-warning DEL dl:estados:cancel_id
```

**Motivo:** el valor viejo `{"id":21}` pudo quedar cacheado en el Redis de prod (TTL hasta
24h). El código corregido **NO lo borra solo**; sin este `DEL`, las cancelaciones seguirán
fallando en prod hasta que el caché expire. El TTL nuevo (1h) solo aplica a cacheos
futuros, no al valor ya guardado.

**Verificación:** `redis-cli GET dl:estados:cancel_id` → `(nil)`. En la siguiente
cancelación, los logs deben mostrar el id elegido = 8 ("Dentalink cancel estado resolved").
