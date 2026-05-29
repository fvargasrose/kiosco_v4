# Estado de ramas — 28 mayo 2026

## Situación actual

```
origin/hito9  ──────────────────────────────────────────────────>  (4 commits)
                                                                         |
origin/hito10 ───────────────────────────────────────────────────────── (13 commits atrás de main)
                                                                         |
main (local = origin/main)  ─────────────────────────────────────>  HEAD
```

`main` es la rama más avanzada. Las ramas `hito9` e `hito10` en GitHub están
congeladas en el momento en que se cerró cada hito y **nunca se actualizaron**
con los commits que continuaron en `main`.

---

## ¿Qué significa "commits atrasados"?

Significa que esas ramas remotas apuntan a un commit antiguo del pasado.
No tienen los cambios nuevos que fueron entrando a `main` después de que
se crearon. **No hay conflicto ni problema** — simplemente son snapshots
históricos del proyecto en ese punto del tiempo.

---

## origin/hito10 — 13 commits atrás de main

Estos son los cambios que `main` tiene y `hito10` NO tiene:

| # | Commit | Descripción |
|---|--------|-------------|
| 1 | `df44767` | feat(auth): login solo con teléfono + OTP dual + CLI dk:otp |
| 2 | `9ae48a4` | feat(auth): login solo con teléfono + OTP dual + CLI |
| 3 | `3764d37` | feat(auth): login solo con teléfono + OTP dual + CLI + gates validación |
| 4 | `e6261a1` | fix(booking): usar /api/v1/agendas con filtrado por fecha en cliente |
| 5 | `8c30ee7` | fix(booking): id_estado dinámico para cancelación de citas en Dentalink |
| 6 | `a498d29` | feat(booking): paso de selección de tratamiento con duración variable |
| 7 | `e47bb4a` | feat(branding): logo de clínica en header global del kiosco |
| 8 | `8113ebf` | feat(notifications): comprobante de pago al administrador por email |
| 9 | `20ef70c` | feat(booking): calendario mensual de 2 meses para selección de fecha |
| 10 | `8e9a0e7` | feat(treatments): rediseño de pestaña pagos con estado de cuenta |
| 11 | `bde47cb` | feat(standby): video con sonido configurable desde admin |
| 12 | `75b3a5f` | chore(ui): aumentar tamaño de tarjetas y fotos de dentistas |
| 13 | `0d954bd` | chore(ui): ocultar flujo de registro de paciente (backend intacto) |

---

## origin/hito9 — 17 commits atrás de main

`hito9` tiene los mismos 13 de arriba **más** estos 4 que sí llegaron a `hito10`
pero tampoco están en `hito9`:

| # | Commit | Descripción |
|---|--------|-------------|
| 14 | `d624569` | feat: installer — script de instalación guiada en servidor Ubuntu |
| 15 | `efa0e84` | docs: actualizar guías — local, producción Hetzner y estado Hito 10 |
| 16 | `a747c0c` | fix: detectar error 400 "tope" de Dentalink como CONFLICT al agendar cita |
| 17 | `d962460` | fix: mejorar manejo de slot ocupado al agendar cita |

---

## Resumen por área funcional

| Área | Commits pendientes en hito10 | También pendientes en hito9 |
|------|-----------------------------|-----------------------------|
| Auth (login teléfono/OTP) | 3 | 3 |
| Booking (agenda) | 3 | 3 + 2 fixes |
| UI / Branding | 3 | 3 |
| Notificaciones | 1 | 1 |
| Tratamientos | 1 | 1 |
| Standby | 1 | 1 |
| Installer | — | 1 |
| Docs | — | 1 |

---

## ¿Hay que hacer algo?

**No es urgente.** Las ramas `hito9` y `hito10` son referencias históricas
(cierres de hito). Si se quieren actualizar para que reflejen el estado actual
de `main`, se haría:

```bash
git push origin main:hito9   # actualiza hito9 al estado de main
git push origin main:hito10  # actualiza hito10 al estado de main
```

Pero normalmente estos hitos se dejan como están para poder volver atrás
y ver cómo estaba el proyecto en ese momento exacto.

---

## Pendiente sin commitear (en main local)

Se movieron archivos de documentación a `docs/otros/` pero el commit
no se realizó. Archivos afectados:

- `cambio_vista.md` → `docs/otros/cambio_vista.md`
- `estado.md` → `docs/otros/estado.md`
- `plan_23mayo.txt` → `docs/otros/plan_23mayo.txt`
- `produccion.md` → `docs/otros/produccion.md`
- `docs/otros/apoyo_bokking.md` (nuevo)
- `docs/otros/plan.md` (nuevo)
