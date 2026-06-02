# sigue_pagos.md — Prompt para retomar (nueva conversación, desde cero)

> Copia y pega TODO lo que está debajo de la línea como primer mensaje de la
> próxima sesión. Da el contexto necesario para terminar el trabajo de pagos.

---

Estoy retomando el trabajo de pagos de DentalKiosco en una sesión nueva (sin
contexto previo). Antes de actuar, lee en este orden y confírmame que los leíste:

1. `CLAUDE.md` (reglas del proyecto — OJO: no tocar `payments.ts` / webhook Wompi,
   `reconciler.ts`, `license/*` ni migraciones aplicadas sin autorización explícita).
2. `mejoras_pagos.md`, en especial la **§10 (ESTADO ACTUAL / DÓNDE QUEDAMOS)** y la
   **§10.3.A** (issue abierto del correo a la clínica).
3. `DEPLOY_PRODUCCION.md` (revertir sandbox → producción).

## Contexto / dónde quedamos
- Estamos en la rama **`pagos`**. Ya se corrigió un bug crítico de producción:
  el webhook de Wompi para **payment links** no casaba con la transacción (Wompi
  genera su propia `reference` y manda `payment_link_id`). Fix commiteado en
  **`8fd4264`** (matching por `payment_link_id` + fallback; `reconcile` y
  `sendPaymentReceipt` usan nuestra `wompi_reference`; tests de regresión;
  `vitest.config` con `WOMPI_EVENTS_SECRET` de test). Suite: 242/242 verde.
- Prueba e2e en **sandbox** OK para el **recibo al paciente**
  (`fabiavargas@gmail.com`, paciente Dentalink id 4179, login por celular
  `+573206505239`). `receipt_sent_at` se setea bien.

## ISSUE ABIERTO (lo primero a resolver)
El **correo a la clínica NO llega**. `sendAdminPaymentNotification`
(`apps/api/src/lib/notifications.ts`, ~línea 377) se cuelga en el envío SMTP
porque el `notification_email` (`notificaciones@2ways.us`) es **el mismo** que el
`SENDER_EMAIL` del `.env` → auto-envío `from == to`, y `mail.2ways.us` no completa
la entrega a sí mismo. No hay timeout ni log de error → falla en silencio.

Plan (ver §10.3.A):
1. **Fix funcional:** cambiar `notification_email` a una dirección distinta del
   `SENDER_EMAIL` (ej. `recepcion@2ways.us` o un Gmail), vía `PATCH /admin/clinic`
   (admin: `admin@demo.local` / `Admin@Demo2026`) o el panel.
2. **Fix defensivo (código, recomendado):** timeout + log de error al enviar el
   correo admin en `notifications.ts` (NO toca `payments.ts`). Pídeme autorización
   antes de editar y agrega/ajusta test.
3. Revalidar con un pago sandbox: confirmar `Admin payment notification sent` +
   llegada real al buzón.

## Cómo levantar el entorno (está todo apagado; `.env` quedó en SANDBOX, no commiteado)
```bash
# infra
docker compose up -d postgres redis
# backend con log a archivo
DOTENV_CONFIG_PATH=$(pwd)/.env pnpm --filter @dentalkiosco/api dev > backend-prueba.log 2>&1 &
# túnel (URL efímera; re-registrar en panel Wompi sandbox → Eventos → URL de eventos:
#   https://<algo>.trycloudflare.com/webhooks/wompi )
cloudflared tunnel --url http://localhost:3000 &
# frontends (si se necesitan)
pnpm --filter @dentalkiosco/kiosco-frontend dev &   # :5173  (kiosk_token en levantar.md:46)
pnpm --filter @dentalkiosco/admin-frontend dev &    # :5174
```
- Tarjeta de prueba sandbox: `4242 4242 4242 4242`, CVV 3 díg., venc. futuro, 1 cuota.
- Para originar un pago de $5.000 sin tratamiento (no hay saldo en 4179): login por
  API (request-otp → verify-otp; OTP sale en `backend-prueba.log` con `DEV_LOG_OTP`)
  y `POST /me/payments` con `{"amount_cop":5000,"description":"..."}`. El detalle del
  flujo quedó en el historial de `mejoras_pagos.md`.

## Tareas para CERRAR (pendientes)
1. **Resolver el issue del correo a la clínica** (arriba) y revalidar e2e.
2. **Integrar `pagos` → `main`** (decidir conmigo: PR o merge directo).
3. **Revertir `.env` sandbox → producción** (`DEPLOY_PRODUCCION.md`): llaves
   `test_`→`prod_`, `WOMPI_API_URL`/`WOMPI_BASE_URL` a `production.wompi.co`,
   `WOMPI_EVENTS_SECRET` de producción, y registrar la URL de Eventos del dominio
   público (no el túnel). El `.env` lo edito yo (no me pidas secretos por el chat).

## Reglas de trabajo para esta sesión
- Modo plan-y-permiso: propón y pide mi OK antes de tocar código sensible o el
  `.env`; muéstrame `git status`/diffs antes de commitear; NO commitees el `.env`
  ni los `.log` (ya están gitignored).
- Método TDD como en la sesión anterior (test que falla → fix → verde).

Confírmame que leíste los 3 documentos y proponme el plan para el issue del correo
a la clínica antes de tocar nada.
