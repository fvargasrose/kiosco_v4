# Deploy a producción — DentalKiosco

## Revertir de Sandbox a Producción

Esta sección lista EXACTAMENTE qué valores del `.env` volver a cambiar cuando la
prueba del flujo de correos pase de **Wompi Sandbox** a **pago real en Producción**.

> **Nota:** estos valores los edita el humano a mano copiándolos del panel de
> Wompi. **No commitear el `.env` con secretos reales.** Aquí solo hay
> placeholders, nunca secretos.

### Variables del `.env`

| Variable | Sandbox (prueba) | Producción (real) | Quién la lee |
|----------|------------------|-------------------|--------------|
| `WOMPI_PUBLIC_KEY` | `pub_test_...` | `pub_prod_...` | backend (`config.ts`) |
| `WOMPI_PRIVATE_KEY` | `prv_test_...` | `prv_prod_...` | backend (`config.ts`) |
| `WOMPI_EVENTS_SECRET` | secreto de eventos **SANDBOX** | secreto de eventos **PRODUCCIÓN** | backend (verifica firma del webhook) |
| `WOMPI_API_URL` | `https://sandbox.wompi.co/v1` | `https://production.wompi.co/v1` | **backend** (es la que usa el cliente Wompi) |
| `WOMPI_BASE_URL` | `https://sandbox.wompi.co/v1` | `https://production.wompi.co/v1` | solo el script de prueba standalone (el backend NO la usa); mantener coherente |
| `DEV_MOCK_WOMPI` | `false` | `false` | backend — **igual en ambos** para esta prueba |

Notas:
- **Estado actual del `.env`:** `DEV_MOCK_WOMPI=true` (mock). Para la prueba (tanto
  sandbox como producción) debe quedar `false`.
- `WOMPI_API_URL` es la que efectivamente usa el backend (`config.ts`); hoy no está
  en el `.env` y cae al default sandbox. Conviene ponerla explícita.
- `WOMPI_INTEGRITY_SECRET` no es necesario para esta prueba (es para el Widget; el
  webhook se valida con el secreto de **Eventos**). Dejar comentado.
- Tras cambiar `.env`, **reiniciar el backend** (tsx no recarga `.env`).

### URL de Eventos en el panel de Wompi
- **Sandbox (prueba local):** se registra la URL temporal del túnel cloudflared,
  p. ej. `https://<algo>.trycloudflare.com/webhooks/wompi`.
- **Producción:** se registra el **dominio público del servidor**, no el túnel:
  `https://<dominio-del-servidor>/webhooks/wompi`.
  (El túnel cloudflared es solo para la prueba local; en prod desaparece.)

### Sin cambios entre sandbox y producción
- `notification_email` de la clínica (en BD, no en `.env`): `notificaciones@2ways.us`.
- SMTP de envío (`SMTP_SERVER`, `SENDER_EMAIL`, etc.): igual en ambos.
- El flujo es idéntico: kiosco → `POST /me/payments` → webhook `/webhooks/wompi`
  → recibo paciente + notificación clínica.

> ⚠️ En producción el cobro es **REAL**. Verificar montos y paciente antes de pagar.
