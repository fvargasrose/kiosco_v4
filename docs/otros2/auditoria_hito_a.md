# Auditoría independiente — Hito A (Backend web-ready)

> **Auditor:** rol de verificación independiente (no implementa, no corrige, no fusiona).
> **Fecha:** 2026-06-04
> **Rama auditada:** `hito-a-backend-web-ready` (fusionada a `main`, merge `3826f6f`).
> **Entorno:** Postgres host:5433, Redis host:6380 (contenedores `dk-postgres`/`dk-redis`
> levantados para la verificación), suite en mock. API de smoke arrancada en `:3100`
> apuntando a esa infra.
> **Base real de divergencia de la rama:** `b1c6d80` (padre del primer commit `e0c678c`).
> Todos los diffs "limpios" de Hito A se calculan contra esa base, **no** contra el
> `main` actual (que ya contiene Hitos B–E y contaminaría el diff).

## Metodología
Para cada ítem se contrasta: **(1)** lo que el reporte (`hito_b.md`, sección Hito A)
AFIRMA · **(2)** lo que el código REALMENTE hace · **(3)** el DoD del plan
(`plan_abierto_v2.md` §Hito A y `plan_abierto.md` §6.1 fila A).

---

## A) Rutas públicas

### A.1 — `public.ts` define las 3 rutas SIN `requireKiosk` ✅
`apps/api/src/routes/public.ts`:
- `GET /public/bootstrap` → línea **34**
- `GET /public/standby` → línea **121**
- `GET /public/standby/media` → línea **156**

Ninguna usa `requireKiosk` ni preHandler de kiosco; no hay telemetría
`last_seen_at`/`last_ip` (confirmado leyendo el archivo completo, 1–179). El handler
de `/public/bootstrap` solo hace `SELECT` de columnas no sensibles de `clinic`
(display_name, logo, habeas data, faq, standby) — **no** selecciona `token_encrypted`
ni `dentalink_token`.

### A.2 — Registrada en `server.ts` ✅
- `import { publicRoutes } from './routes/public.js';` → `server.ts:27`
- `await app.register(publicRoutes);` → `server.ts:140`

### A.3 — Smoke real (API `:3100`) ✅
```
GET  /public/bootstrap        (sin Authorization)  → HTTP 200
POST /auth/request-otp        (sin Authorization)  → HTTP 200  {request_id, expires_in_seconds}
POST /auth/login-direct                            → HTTP 404
```
`/public/bootstrap` devuelve claves:
`['clinic','duracion_cita_minutos','faq','feature_registro','habeas_data','otp_required','procedures','server_time','standby','theme','turnstile_sitekey','whatsapp']`
— sin `dentalink_token`/`token_encrypted`/`kiosk_token`/paths internos (grep en vivo: 0 coincidencias).

---

## B) Muro de kiosco eliminado

### B.4 — grep de `requireKiosk`/`kiosk_token`/`signKioskToken`/`verifyKioskToken` ✅ (con 1 matiz menor)
**`patient-auth.ts`:** no queda muro de kiosco vivo.
- `extractBearer` (línea 67) y su uso en línea **449** corresponden al **logout de
  paciente** (`/auth/logout`, extrae el *patient_session_token*), no a kiosk_token. Legítimo.
- ⚠️ **Matiz documental:** el comentario de cabecera (línea **10**) todavía dice
  `Header: Authorization: Bearer <kiosk_token>` para `request-otp` — comentario
  **obsoleto** (el código en líneas 104–107 confirma que ya NO se exige token). No
  afecta comportamiento; es deuda de documentación.

**`patient-register.ts`:** no queda `requireKioskAuth`. Solo aparece `requireFeatureRegistro`.

`login-direct`/`loginDirect`: **0 coincidencias en todo `apps/api/src`** → ruta
eliminada del backend (confirma afirmación del reporte y D4).

### B.5 — `/kiosk/register` público gobernado por `FEATURE_REGISTRO` ✅
`patient-register.ts:28-35` define `requireFeatureRegistro` → `403 { error: 'FEATURE_DISABLED' }`
si `!config.FEATURE_REGISTRO`. Registrado como preHandler en `app.post('/kiosk/register', …)` (línea 130).
**Smoke en vivo** (flag apagado): `POST /kiosk/register` → **HTTP 403** `{"error":"FEATURE_DISABLED"}`.

---

## C) Migración 017 — "aplica Y revierte"

### C.6 — Idempotente, 4 tablas, cierra con `schema_migrations` ✅
`apps/api/migrations/017_nullable_kiosk_id_web.sql`:
```sql
ALTER TABLE otp_codes            ALTER COLUMN kiosk_id DROP NOT NULL;
ALTER TABLE patient_sessions     ALTER COLUMN kiosk_id DROP NOT NULL;
ALTER TABLE transactions         ALTER COLUMN kiosk_id DROP NOT NULL;
ALTER TABLE habeas_data_consents ALTER COLUMN kiosk_id DROP NOT NULL;
INSERT INTO schema_migrations (version, name)
VALUES ('017', 'nullable_kiosk_id_web') ON CONFLICT (version) DO NOTHING;
```
- Las 4 tablas exigidas ✅. `DROP NOT NULL` es idempotente (no-op sobre columna ya nullable) ✅.
- Cierra con el `INSERT INTO schema_migrations` exigido por la regla del proyecto ✅.

> **Contraste con D2 (reporte) — CONFIRMADO:** estas columnas **ya eran nullable** en el
> esquema original (`004_otp_sessions_consents.sql:10,50,81` y `005_transactions.sql:7`,
> definidas como `UUID REFERENCES kiosks(id) ON DELETE SET NULL`, **sin** `NOT NULL`).
> Por tanto la 017 **no** es un cambio real NOT NULL→NULL: es una formalización
> defensiva. El reporte lo declara honestamente.

### C.7 — Reverso (`down`) ⚠️ NO ejecutable
El "down" **solo existe como comentario** dentro del `.sql` (líneas 14–25: re-imponer
`SET NOT NULL` + `DELETE FROM schema_migrations`). El runner (`migrate.ts`) **solo
implementa `up`** (verificado: scripts `migrate`/`status`/`verify`, no hay `down`).
→ El verbo **"revierte" del DoD NO está respaldado por un down real/ejecutable**.
El reporte ya lo reconoce (D3). Como el `up` es no-op (las columnas ya eran nullable),
el impacto práctico es nulo, pero **frente al texto literal del DoD esto es PARCIAL**.

### C.8 — `migrate:status` ✅
```
Total: 17, Aplicadas: 17, Pendientes: 0
✓ aplicada 017_nullable_kiosk_id_web  2026-06-03T21:07:18.861Z
```

---

## D) Sesión web con `kiosk_id` NULL + `/me/*` (DoD ii)

### D.9 — `signPatientSession.kioskId` opcional, emite `kiosk_id: null` ✅
`lib/jwt.ts`: `kioskId?: string | null` (línea 127); claim `kiosk_id: payload.kioskId ?? null`
(línea 135); tipo `PatientSessionClaims.kiosk_id: string | null` (línea 42).

### D.10 — Sesión `kiosk_id` null → `/me/*` OK ✅ (test + smoke en vivo)
- **Test:** `payments-web-session.test.ts` (5 tests, commit `a396522`) ejercita el
  flujo web con `kiosk_id NULL` de extremo a extremo. `patient-auth.test.ts` añade
  `expect(claims.kiosk_id).toBeNull()` en el happy path.
- **Smoke en vivo** (OTP mock → verify → token):
  - claim decodificado: `{'kiosk_id': None, 'jti': …, 'sub': '12345', 'aud': 'patient', …}`
  - `GET /me/appointments` → **200**
  - `GET /me/treatments`   → **200**
  - `GET /me/profile`      → **200**

### D.11 — AUDITORÍA CRÍTICA: ¿alguien downstream asume `kiosk_id` NO-nulo? ❌ NO (afirmación del reporte CONFIRMADA)
`grep -rn "kiosk_id\|kioskId" apps/api/src` (sin tests) + búsqueda de patrones
peligrosos `WHERE … kiosk_id` / `INNER JOIN`:
- **`reconciler.ts`: 0 coincidencias** → no lee `kiosk_id` (confirma el reporte).
- `payments.ts:181` → escritura `patient.kiosk_id ?? null` (null-safe).
- `patient-auth.ts:397,405` → lectura `otp.kiosk_id` pasada a `kioskId?` opcional.
- `admin-transactions.ts:112` y `admin-dashboard.ts:87` → **`LEFT JOIN kiosks`**
  (devuelve `kiosk_name` NULL, sin error).
- **Cero** `WHERE kiosk_id = …`, **cero** `INNER JOIN` por kiosco, **cero**
  desreferencias que asuman no-nulo.

**Veredicto:** la afirmación "ninguna lectura downstream asume kiosk_id no-nulo" es **correcta**.

---

## E) Aserciones de seguridad NO vaciadas

### E.12 — `patient-auth.test.ts` conserva aserciones reales ✅
Sin `expect(true)`, sin `.skip`/`it.todo`/`xit` (grep: 0). Presentes y con `expect` reales:
- **Anti-enumeración:** L215 (misma respuesta: mismas claves + `request_id` en ambos) y
  L246 (`captured.sms`/`captured.email` con `toHaveLength(0)` para teléfono inexistente).
- **Rate-limit por teléfono:** L353-378 → `expect(r4.statusCode).toBe(429)` (límite=3, 4º bloqueado).
- **verify-otp single-use:** L473.
- **5 intentos → 429 `TOO_MANY_ATTEMPTS`:** L490-505.
- **OTP fuera de responses:** L552 (request) y L573-597 (verify, `expect(bodyStr).not.toContain(code)`).
- **Audit NO contiene OTP:** L675-692.

> ⚠️ Matiz menor (pre-existente, no introducido por el hito): el test de "respuesta de
> request-otp NO contiene el código" (L567) envuelve la aserción en `if (captured.sms.length > 0)`;
> si no se capturara SMS pasaría sin aserción. La variante de **verify-otp** (L597) sí
> es incondicional. Robustez: aceptable.

### E.13 — Diff confirma que SOLO se quitaron las 3 aserciones del muro ✅
Diff limpio `b1c6d80..hito-a-backend-web-ready` sobre `patient-auth.test.ts`.
Únicas aserciones `expect(...).toBe()` **eliminadas**:
```
- expect(res.json().error).toBe('KIOSK_TOKEN_REQUIRED');   (401)
- expect(res.json().error).toBe('INVALID_KIOSK_TOKEN');    (401)
- expect(res.json().error).toBe('KIOSK_INACTIVE');         (403)
```
El resto de líneas eliminadas son **transporte** (`headers: Authorization: Bearer ${kioskToken}`)
y el *setup* de kioscos (`signKioskToken`, INSERT de kiosks). **Ninguna** aserción de
anti-enumeración, rate-limit, single-use, 5-intentos, OTP-en-logs ni audit fue eliminada
ni debilitada. (Nota: el diff contra `main` actual aparenta borrar `security.test.ts` y
tocar el rate-limit, pero eso es **contaminación** del diff porque `main` ya tiene Hito B;
en la base correcta esos cambios no pertenecen a Hito A.)

### E.14 — `public.test.ts`: no-exposición de secretos ✅ (test + handler)
`tests/public.test.ts:78-84`:
```js
expect(raw).not.toContain('dentalink_token');
expect(raw).not.toContain('token_encrypted');
expect(raw).not.toContain('kiosk_token');
expect(raw).not.toContain('/var/');
```
Verificado también contra el **handler real** (`public.ts` solo SELECT de columnas
públicas) y contra la **respuesta en vivo** (grep de secretos en bootstrap: 0).

---

## F) Gate y números

### F.15 — Suite y typecheck ✅ (coincide con el total final del reporte)
```
Test Files  18 passed (18)
     Tests  262 passed (262)         (Duración 14.26s)
typecheck (tsc --noEmit)  → EXIT 0
```
El reporte cita **257** (mid-ejecución, antes del anexo) y **262** tras añadir
`payments-web-session.test.ts`. En el **tip de la rama el número real es 262/18** → **coincide**.

### F.16 — GATE LINT ⚠️/❌ (frente al DoD) — el reporte dice la verdad
`pnpm lint` → **EXIT 2**: *"ESLint couldn't find an eslint.config.(js|mjs|cjs) file"* (ESLint 9.39.4).
No existe `eslint.config.*` ni `.eslintrc.*` en el repo. **Preexistente**: tampoco existe
en `main` y la rama hito-a **no** tocó configuración de eslint (`git diff --stat` sin
archivos eslint). → El DoD del plan exige **"lint verdes"**; ese gate **NO es alcanzable**
hoy. El reporte lo clasifica como ⚠️ y como condición preexistente: **exacto, no exagera**.

---

## G) Cobertura del plan

### G.17 — `/kiosk/*` y `admin-kiosks`: "deprecadas, no se borran" ⚠️ parcial
- **Presentes y registradas** ✅: `kiosk.ts` y `admin-kiosks.ts` existen y siguen en
  `server.ts` (`kioskRoutes` L139, `adminKioskRoutes` L146). NO se borraron.
- ⚠️ **"marcadas como deprecadas" — débil:** la única anotación de deprecación está en
  el comentario de cabecera de `public.ts` (L13-14). Los propios `kiosk.ts`/`admin-kiosks.ts`
  **no** llevan marca textual (`@deprecated`/comentario), y la cabecera de `kiosk.ts`
  todavía se describe como ruta activa. Funcionalmente coherente con el plan ("no se
  borran"), pero la "marca de deprecación" es nominal, no explícita en los archivos.

### G.18 — Tabla DoD del plan (i, ii, iii)

| # | Criterio DoD (`plan_abierto_v2` §Hito A) | Estado | Evidencia |
|---|------------------------------------------|--------|-----------|
| i | Endpoints públicos responden sin `kiosk_token`; `login-direct` bloqueado | ✅ | `/public/*` sin `requireKiosk` (A.1) + smoke 200 (A.3); `login-direct` 0 refs y 404 en vivo (B.4) |
| ii | Sesión de paciente con `kiosk_id` nulo; todo `/me/*` operativo | ✅ | claim `kiosk_id:null` + `/me/{appointments,treatments,profile}` → 200 en vivo (D.9-D.10); ninguna lectura asume no-nulo (D.11) |
| iii | Migración aplica **y revierte**; suite + typecheck + **lint** verdes | ⚠️ | Aplica ✅ (17/17). **Revierte: solo documentado, sin `down` ejecutable** ⚠️ (C.7). Suite 262 ✅ + typecheck ✅. **Lint NO ejecutable** ⚠️ (F.16, preexistente) |

---

## Discrepancias entre las fuentes de verdad

1. **Código de estado de `login-direct`:** `plan_abierto.md` §6.1 fila A dice **403**;
   `plan_abierto_v2.md` dice "**410/404 o eliminar la ruta**"; el reporte y la realidad =
   **404 (ruta eliminada)**. Las fuentes no concuerdan entre sí; la implementación elige
   una opción válida del v2 (eliminar → 404) pero **contradice el 403 del §6.1**.
2. **Conteo de tests del gate:** `plan_abierto.md` §6.1 dice "**253** (adaptados)";
   `plan_abierto_v2` "253" en la regla de oro; el reporte 257→262; realidad **262**.
   El DoD numérico del plan quedó desactualizado (se superó, no se incumplió).
3. **"Reversible (`down`)":** el plan_v2 (sub-tareas) pide migración "**Reversible (`down`)**";
   el runner no soporta `down`. El reporte reinterpreta "reversible" como
   "reverso documentado en el `.sql`" — **suavización del DoD**, declarada aquí como hallazgo.

---

## CIERRE

### Conteo
- ✅ **Confirmados:** A.1, A.2, A.3, B.4(core), B.5, C.6, C.8, D.9, D.10, D.11, E.12, E.13, E.14, F.15, DoD (i), DoD (ii) → **16**
- ⚠️ **Parciales / matices:** C.7 (down no ejecutable), F.16 (lint no ejecutable), G.17 (deprecación nominal), DoD (iii), comentario obsoleto en patient-auth.ts:10, condicional en test L567 → **6**
- ❌ **No se cumple / reporte exagera:** **0** — el reporte es honesto en todas sus desviaciones (D1–D6).
- 🔭 **No verificable en dev:** ninguno relevante (todo verificable; Turnstile/enforcement es Hito B, fuera de alcance).

### Los 3 hallazgos más importantes
1. **El "revierte" del DoD (iii) NO está respaldado por un `down` ejecutable** (C.7).
   El reverso es solo un comentario en el `.sql` y el runner únicamente hace `up`.
   Atenuante real: la migración 017 es un no-op (las columnas ya eran nullable desde 004/005),
   así que no hay nada que revertir en la práctica — pero **literalmente el DoD no se cumple**.
2. **El gate "lint verde" del DoD es inalcanzable** (F.16): ESLint 9 sin `eslint.config.js`
   (`pnpm lint` → exit 2). Es **preexistente** (igual en `main`, la rama no lo tocó), no un
   defecto introducido por Hito A, pero invalida un criterio explícito de cierre. El gate
   efectivo real fue typecheck + 262 tests.
3. **El núcleo funcional del Hito A está sólido y el reporte NO exagera:** rutas públicas
   sin token (smoke 200), `login-direct` eliminado (404), sesión web con `kiosk_id NULL` →
   `/me/*` 200 verificado en vivo, y **ninguna** lectura downstream asume `kiosk_id` no-nulo
   (reconciler no lo lee; todo es `LEFT JOIN` o `?? null`). Las aserciones de seguridad se
   conservaron intactas: el diff limpio prueba que solo se quitaron las 3 aserciones del muro
   `kiosk_token`. Hallazgos menores: comentario obsoleto en `patient-auth.ts:10` y la
   deprecación de `/kiosk/*` es nominal (anotada solo en `public.ts`).

**FIN DE LA AUDITORÍA DEL HITO A. El auditor se detiene aquí — no avanza al Hito B, no
propone ni aplica correcciones.**
