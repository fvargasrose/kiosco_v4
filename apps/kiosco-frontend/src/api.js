/**
 * Cliente HTTP del paciente (web pública).
 *
 * Modelo web (Hitos A–C, Opción A): ya NO hay kiosk_token. El arranque usa
 * rutas públicas (/public/*) y el control de acceso recae en rate-limit + OTP +
 * Turnstile + anti-enumeración (backend).
 *
 * Sesión de paciente: el access token (JWT) se persiste en sessionStorage para
 * sobrevivir a refresh de la pestaña y a cambios de app en móvil (§10). Se borra
 * al cerrar la pestaña o al hacer logout. La renovación deslizante usa
 * /auth/refresh.
 */

const BASE = '/api';

const TOKEN_KEY = 'dk_patient_token';
const EXPIRES_KEY = 'dk_patient_expires';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

class ApiClient {
  constructor() {
    // Patient session: persiste en sessionStorage (sobrevive refresh y cambios
    // de app, no al cierre de la pestaña). Antes vivía solo en memoria.
    this.patientToken = sessionStorage.getItem(TOKEN_KEY) || null;
    this.patientExpiresAt = sessionStorage.getItem(EXPIRES_KEY) || null;
  }

  setPatientToken(token, expiresAt = null) {
    this.patientToken = token;
    this.patientExpiresAt = expiresAt;
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (expiresAt) sessionStorage.setItem(EXPIRES_KEY, expiresAt);
      else sessionStorage.removeItem(EXPIRES_KEY);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(EXPIRES_KEY);
    }
  }

  clearPatientSession() {
    this.setPatientToken(null);
  }

  get hasSession() {
    return !!this.patientToken;
  }

  async _fetch(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    };

    if (opts._usePatient && this.patientToken) {
      headers['Authorization'] = `Bearer ${this.patientToken}`;
    }

    const res = await fetch(`${BASE}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      // body no es JSON, ignoramos
    }

    if (!res.ok) {
      throw new ApiError(res.status, body);
    }
    return body;
  }

  // ===== Bootstrap / config pública (sin token) =====
  async bootstrap() {
    return this._fetch('/public/bootstrap');
  }

  // ===== Patient auth =====
  async requestOtp({ phone, policyVersion, policyHash, turnstileToken }) {
    const body = {
      phone,
      consent: true,
      policy_version: policyVersion,
      policy_hash: policyHash,
    };
    // Token de Cloudflare Turnstile (anti-abuso). El backend lo exige cuando
    // está configurado (producción); en dev sin secret se ignora.
    if (turnstileToken) body.turnstile_token = turnstileToken;
    return this._fetch('/auth/request-otp', { method: 'POST', body });
  }

  async verifyOtp({ requestId, code }) {
    const res = await this._fetch('/auth/verify-otp', {
      method: 'POST',
      body: { request_id: requestId, code },
    });
    if (res.session_token) {
      this.setPatientToken(res.session_token, res.expires_at ?? null);
    }
    return res;
  }

  /**
   * Renueva la sesión deslizante (§10). Devuelve true si se renovó, false si la
   * sesión ya no es válida (el llamador debe redirigir a login).
   */
  async refreshSession() {
    if (!this.patientToken) return false;
    try {
      const res = await this._fetch('/auth/refresh', { method: 'POST', _usePatient: true });
      if (res.session_token) {
        this.setPatientToken(res.session_token, res.expires_at ?? null);
        return true;
      }
      return false;
    } catch {
      this.clearPatientSession();
      return false;
    }
  }

  async logout() {
    if (!this.patientToken) return;
    try {
      await this._fetch('/auth/logout', { method: 'POST', _usePatient: true });
    } catch {
      // Ignorar errores en logout
    } finally {
      this.clearPatientSession();
    }
  }

  // ===== Patient data =====
  async getProfile() {
    return this._fetch('/me/profile', { _usePatient: true });
  }

  async getAppointments(status = 'upcoming') {
    return this._fetch(`/me/appointments?status=${encodeURIComponent(status)}`, {
      _usePatient: true,
    });
  }

  async getTreatments(status = 'all') {
    return this._fetch(`/me/treatments?status=${encodeURIComponent(status)}`, {
      _usePatient: true,
    });
  }

  // ===== Hito 7: Cancelar cita =====
  async cancelAppointment(appointmentId, reason) {
    return this._fetch(`/me/appointments/${encodeURIComponent(appointmentId)}/cancel`, {
      method: 'POST',
      body: reason ? { reason } : {},
      _usePatient: true,
    });
  }

  // ===== Hito 7: Pagos =====
  async createPayment({ treatmentId, amountCop, description }) {
    const body = { amount_cop: amountCop, description };
    if (treatmentId) body.treatment_id = treatmentId;
    return this._fetch('/me/payments', {
      method: 'POST',
      body,
      _usePatient: true,
    });
  }

  async getPaymentStatus(reference) {
    return this._fetch(`/me/payments/${encodeURIComponent(reference)}`, {
      _usePatient: true,
    });
  }

  // ===== Hito 8: Booking =====
  async getBranches() {
    return this._fetch('/me/booking/branches', { _usePatient: true });
  }

  async getDentists(branchId) {
    return this._fetch(`/me/booking/dentists?branch_id=${encodeURIComponent(branchId)}`, {
      _usePatient: true,
    });
  }

  async getSlots({ dentistId, branchId, from, to, duration }) {
    const qs = new URLSearchParams({
      dentist_id: dentistId,
      from,
      to,
    });
    if (branchId) qs.set('branch_id', String(branchId));
    if (duration) qs.set('duration', String(duration));
    return this._fetch(`/me/booking/slots?${qs.toString()}`, { _usePatient: true });
  }

  // ===== Hito 9: Registro de paciente nuevo (ruta pública gobernada por FEATURE_REGISTRO) =====
  async registerPatient(data) {
    return this._fetch('/kiosk/register', {
      method: 'POST',
      body: data,
    });
  }

  // ===== Standby (config pública, sin token) =====
  async getStandbyConfig() {
    return this._fetch('/public/standby');
  }

  async downloadStandbyMedia() {
    const res = await fetch(`${BASE}/public/standby/media`);
    if (!res.ok) throw new ApiError(res.status, null);
    return res.blob();
  }

  async createBookingAppointment({
    dentistId,
    branchId,
    fecha,
    horaInicio,
    horaFin,
    notas,
    treatmentName,
  }) {
    const body = {
      dentist_id: dentistId,
      branch_id: branchId,
      fecha,
      hora_inicio: horaInicio,
      hora_fin: horaFin,
    };
    if (notas) body.notas = notas;
    if (treatmentName) body.treatment_name = treatmentName;
    return this._fetch('/me/booking/appointments', {
      method: 'POST',
      body,
      _usePatient: true,
    });
  }
}

export const api = new ApiClient();
