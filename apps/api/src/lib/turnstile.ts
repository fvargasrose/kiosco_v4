/**
 * =============================================================================
 * Cloudflare Turnstile - Verificación server-side del token (siteverify)
 * =============================================================================
 *
 * Anti-abuso de OTP en web pública (Hito B). El frontend obtiene un token con
 * el widget Turnstile (modo managed/invisible) y lo envía en /auth/request-otp;
 * aquí se valida contra Cloudflare ANTES de cualquier lookup o envío de SMS.
 *
 * - Si TURNSTILE_SECRET no está configurado (dev/test), el enforcement se omite
 *   (isEnforced() === false). En producción es obligatorio (validado en config).
 * - Mockeable en tests vía setTurnstileVerifier().
 */

import { config, features } from './config.js';
import { logger } from './logger.js';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifier {
  /** Devuelve true si el token es válido. */
  verify(token: string | undefined, remoteIp?: string): Promise<boolean>;
}

/** Verificador real contra Cloudflare. */
class CloudflareTurnstileVerifier implements TurnstileVerifier {
  async verify(token: string | undefined, remoteIp?: string): Promise<boolean> {
    if (!token) return false;
    const secret = config.TURNSTILE_SECRET;
    if (!secret) return false; // sin secret no se puede verificar

    try {
      const form = new URLSearchParams();
      form.set('secret', secret);
      form.set('response', token);
      if (remoteIp) form.set('remoteip', remoteIp);

      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(5000),
      });
      const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
      if (!data.success) {
        logger.warn({ errors: data['error-codes'] }, 'Turnstile verification failed');
      }
      return data.success === true;
    } catch (err) {
      // Fail-closed: si no podemos verificar, rechazamos (protege el envío de SMS).
      logger.error({ err }, 'Turnstile siteverify error');
      return false;
    }
  }
}

let _verifier: TurnstileVerifier = new CloudflareTurnstileVerifier();

/**
 * ¿Está activo el enforcement de Turnstile?
 * Solo cuando hay TURNSTILE_SECRET configurado (obligatorio en producción).
 */
export function isEnforced(): boolean {
  return features.turnstileConfigured;
}

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  return _verifier.verify(token, remoteIp);
}

/** Para tests: inyecta un verificador custom. */
export function setTurnstileVerifier(verifier: TurnstileVerifier): void {
  _verifier = verifier;
}
