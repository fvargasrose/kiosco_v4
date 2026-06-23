# Plan de implementación — 23 jun 2026

> Estado al planear: rama `main`, árbol limpio.
> **Local = GitHub = Producción**, los tres en `ad0f1e3` (verificado en vivo:
> `git rev-parse HEAD`, `git ls-remote origin main`, y SSH a prod
> `/opt/dentalkiosco`). Nota: CLAUDE.md y la memoria todavía mencionan `c072eca`
> como commit desplegado; el HEAD real es `ad0f1e3` (commit de reorganización de
> docs). Actualizar esa nota al cerrar este trabajo.

Este documento es **solo el plan**. No se implementa nada hasta aprobación.

---

## Objetivos

1. **Verificación de alineación git** — ✅ ya hecho (los tres entornos en `ad0f1e3`).
2. **Export del frontend del kiosco** a `docs/frond/` para edición externa por un
   diseñador humano, con guía de re-integración al monorepo.
3. **Nombres de odontólogos bien escritos** (Title Case + tildes) en todas las
   pantallas, corrigiendo el dato crudo de Dentalink.
4. **Dueño primero**: Germán Enrique Fernández Silva (`id_dentista = 1`) encabeza
   las listas de odontólogos (booking y panel admin).

---

## Hallazgo clave — cómo llega el dato de Dentalink

`GET /api/v1/dentistas` devuelve los nombres **en MAYÚSCULAS y SIN tildes**
(solo conserva la `Ñ`). Verificado contra la API real (12 odontólogos):

```
ID    Nombre (crudo Dentalink)            →  Corregido
1     GERMAN ENRIQUE FERNANDEZ SILVA      →  Germán Enrique Fernández Silva   ← dueño
2     LUIS GABRIEL FERNANDEZ VALENCIA     →  Luis Gabriel Fernández Valencia
3     JOHANA ALEXANDRA JIMENEZ ARBELAEZ   →  Johana Alexandra Jiménez Arbeláez
4     MARIA ANDREA GONZALEZ VARONA        →  María Andrea González Varona
5     INDIRA CONSUELO PIMIENTA LOZANO     →  Indira Consuelo Pimienta Lozano
6     CARLOS ARTURO MUÑOZ PINO            →  Carlos Arturo Muñoz Pino
7     DIANA PAOLA RODRIGUEZ MELENDEZ      →  Diana Paola Rodríguez Meléndez
9     ANA ISABEL REALPE CAMELO            →  Ana Isabel Realpe Camelo
10    NIDIA CONSUELO GUAZA URRUTIA        →  Nidia Consuelo Guaza Urrutia
11    MAYRIM MERCEDES ORTIZ ANDRADE       →  Mayrim Mercedes Ortiz Andrade
12    MARIA DEL MAR RUIZ HERRERA          →  María del Mar Ruiz Herrera
13    RODRIGO FERNANDEZ VALENCIA          →  Rodrigo Fernández Valencia
```

Como no hay tildes en origen, **no se puede "pasar tal cual"**: hay que
transformar. Enfoque elegido: **Title Case automático + tabla de tildes**
(diccionario por palabra), aplicado en el **backend** como fuente única.

---

## Tarea A — Export del frontend a `docs/frond/`

### Qué se copia
Código **fuente** de `apps/kiosco-frontend/` (el frontend del paciente), no el
build. Contenido:

```
docs/frond/
├── src/                 # copia de apps/kiosco-frontend/src (screens, components, lib, css, js)
├── index.html
├── vite.config.js       # (o .ts, según exista)
├── package.json
├── .gitignore           # ignora node_modules/ y dist/ dentro de docs/frond
└── REINTEGRACION.md     # guía para el diseñador (ver abajo)
```

- **No** se copian `node_modules/` ni `dist/`.
- El diseñador puede correr `pnpm install && pnpm dev` dentro de `docs/frond/`
  para previsualizar de forma aislada (apuntará al API real o a uno mock según
  configure `VITE_*`; documentar en la guía).
- Es una **copia desacoplada** (snapshot). No es un symlink ni workspace; el
  propósito es que se edite fuera y luego se re-integre manualmente.

### `REINTEGRACION.md` (para diseñador humano)
Contenido de la guía:
1. **Qué es esto**: snapshot del frontend del kiosco para rediseño visual.
2. **Cómo previsualizar**: `pnpm install`, `pnpm dev`, abrir `localhost:5173`.
   Cómo apuntar a un backend (variable de entorno / proxy de Vite).
3. **Mapa de pantallas**: tabla `screen → archivo` (standby, login-cedula,
   login-otp, home, appointments, treatments, profile, payment, booking,
   register, habeas-data, faq; variantes `.apple` = UI nueva).
4. **Qué SÍ tocar**: `src/screens/*`, `src/components/*`, `src/styles*.css`,
   assets.
5. **Qué NO tocar** (rompe la integración con el backend): `src/api.js`
   (contratos HTTP), `src/state.js`, `src/router.js`, `src/idle.js`,
   `src/lib/mode.js`. Si necesita cambios ahí, que los marque en un CHANGELOG.
6. **Cómo re-integrar**: entregar la carpeta modificada; un dev hará `diff`
   contra `apps/kiosco-frontend/` y aplicará los cambios de presentación,
   revisando que no se hayan tocado contratos.

### Notas
- Decidir si `docs/frond/` se **commitea** o se añade a `.gitignore`. Propuesta:
  commitearlo (es el artefacto a compartir), pero con su propio `.gitignore`
  para `node_modules`/`dist`.
- Riesgo de divergencia: al ser snapshot, quedará desactualizado respecto a
  `apps/kiosco-frontend`. La guía debe indicar la fecha/commit del snapshot.

---

## Tarea B — Corrección de nombres de odontólogos (backend)

**Archivo único:** `apps/api/src/lib/dentalink.ts` (leer completo antes de editar,
regla 2 de CLAUDE.md). No es archivo prohibido.

### B.1 Helper de formateo
Añadir una función pura `prettifyDentistName(raw: string): string`:
- Title Case por palabra (primera letra mayúscula, resto minúscula), respetando
  ya-acentuadas e idempotente (aplicarla dos veces da lo mismo).
- Partículas en minúscula: `del`, `de`, `la`, `los`, `las`, `y`.
- **Tabla de tildes** (diccionario palabra-cruda-en-mayúscula → forma acentuada),
  aplicada token a token tras el Title Case:
  ```
  GERMAN→Germán  FERNANDEZ→Fernández  JIMENEZ→Jiménez  ARBELAEZ→Arbeláez
  MARIA→María    GONZALEZ→González    RODRIGUEZ→Rodríguez  MELENDEZ→Meléndez
  ```
  (`MUÑOZ` ya trae Ñ → Title Case da `Muñoz`, no necesita entrada.)
- El diccionario por palabra **generaliza** a odontólogos nuevos que compartan
  apellidos comunes; los que no estén en la tabla quedan en Title Case sin tilde
  (aceptable y fácilmente ampliable).

### B.2 Aplicar en las tres fuentes de datos
1. `getDentists()` (~líneas 760-768): al mapear, `nombre: prettify(d.nombre)`,
   `apellido: prettify(d.apellidos)`.
2. `getAllDentists()` (~líneas 798-806): igual.
3. Mapeo de citas (~línea 632-636): `dentista: prettify(a.nombre_dentista ?? …)`
   — esto cubre la pantalla de **citas del paciente** (el nombre viene embebido
   en la cita, no de la lista de dentistas).

`MOCK_DENTISTS` ya está en Title Case con tildes → `prettify` debe ser idempotente
sobre ellos (verificar en tests).

### B.3 Orden dueño-primero
- Constante `OWNER_DENTIST_ID` (default `'1'`), **override por env**
  `DENTALINK_OWNER_DENTIST_ID` para robustez si cambia la instalación.
- En `getDentists()` y `getAllDentists()`, ordenar la lista resultante: el
  `id === OWNER_DENTIST_ID` primero; el resto conserva el orden actual de
  Dentalink (o por `id` — definir; propuesta: dueño primero, resto tal cual).
- **No** aplica a la pantalla de citas (no es una lista ordenable de dentistas).

### Alcance confirmado
| Pantalla | Nombre corregido | Dueño primero |
|----------|:---:|:---:|
| Booking (elegir dentista) | ✅ | ✅ |
| Citas del paciente | ✅ | n/a |
| Panel admin (fotos) | ✅ | ✅ |

El frontend **no requiere cambios** para nombres/orden: renderiza lo que entrega
el backend (`booking.js`, `appointments*.js`, admin `dentists`). Verificar que
así sea (no haya re-ordenamiento en cliente).

---

## Verificación (puertas reales, CLAUDE.md regla 5)

```bash
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api typecheck
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api test
pnpm --filter @dentalkiosco/kiosco-frontend build
pnpm --filter @dentalkiosco/admin-frontend build
```
(`pnpm lint` sigue roto por falta de flat config — no es puerta.)

- Revisar tests que asserten nombres u orden de dentistas (`apps/api/tests/`);
  ajustar expectativas si `prettify`/orden las afecta. Documentar cambios.
- Smoke manual opcional: levantar API + kiosco y revisar lista de booking
  (Germán primero, nombres con tilde) y una cita.

---

## Commits propuestos (uno por tarea, convencional)

1. `chore(docs): export del frontend del kiosco a docs/frond + guía de re-integración`
2. `fix(dentistas): nombres con Title Case + tildes y dueño (id=1) primero`
3. `docs: actualizar nota de commit desplegado (c072eca → ad0f1e3) en CLAUDE.md`

---

## Preguntas / supuestos abiertos

- **Tildes propuestas a confirmar**: ver tabla del hallazgo. `Mayrim`, `Guaza`,
  `Realpe`, `Camelo`, `Urrutia`, `Varona` se asumen **sin** tilde. Corregir si
  alguno lleva.
- **`docs/frond` ¿se commitea?** Propuesta: sí, con su `.gitignore`.
- **Despliegue**: ¿este cambio va a producción tras verificar, o queda en local
  hasta tu visto bueno? (cambios de nombres tocan datos que ve el paciente.)
