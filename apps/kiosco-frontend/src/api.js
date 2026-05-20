/**
 * Cliente HTTP del kiosco.
 * Maneja kiosk_token (permanente, en sessionStorage) y patient_session_token
 * (efímero, en memoria solo).
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

class ApiClient {
  constructor() {
    // Kiosk token: persiste en sessionStorage para sobrevivir refresh
    // de la pestaña pero no entre cierres de navegador.
    this.kioskToken = sessionStorage.getItem('kiosk_token') || null;
    // Patient session: solo en memoria. Si el usuario cierra/refresca, se pierde
    // (que es lo deseado en un kiosco).
    this.patientToken = null;
  }

  setKioskToken(token) {
    this.kioskToken = token;
    if (token) {
      sessionStorage.setItem('kiosk_token', token);
    } else {
      sessionStorage.removeItem('kiosk_token');
    }
  }

  setPatientToken(token) {
    this.patientToken = token;
  }

  clearPatientSession() {
    this.patientToken = null;
  }

  async _fetch(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    };

    // Prioridad: patient session > kiosk token
    if (opts._usePatient && this.patientToken) {
      headers['Authorization'] = `Bearer ${this.patientToken}`;
    } else if (opts._useKiosk && this.kioskToken) {
      headers['Authorization'] = `Bearer ${this.kioskToken}`;
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

  // ===== Kiosk =====
  async bootstrap() {
    return this._fetch('/kiosk/bootstrap', { _useKiosk: true });
  }

  // ===== Patient auth =====
  async requestOtp({ cedula, phone, policyVersion, policyHash }) {
    return this._fetch('/auth/request-otp', {
      method: 'POST',
      body: {
        cedula,
        phone,
        consent: true,
        policy_version: policyVersion,
        policy_hash: policyHash,
      },
      _useKiosk: true,
    });
  }

  async loginDirect({ cedula, phone, policyVersion, policyHash }) {
    const res = await this._fetch('/auth/login-direct', {
      method: 'POST',
      body: {
        cedula,
        phone,
        consent: true,
        policy_version: policyVersion,
        policy_hash: policyHash,
      },
      _useKiosk: true,
    });
    if (res.session_token) {
      this.setPatientToken(res.session_token);
    }
    return res;
  }

  async verifyOtp({ requestId, code }) {
    const res = await this._fetch('/auth/verify-otp', {
      method: 'POST',
      body: { request_id: requestId, code },
    });
    if (res.session_token) {
      this.setPatientToken(res.session_token);
    }
    return res;
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

  async getSlots({ dentistId, from, to, duration }) {
    const qs = new URLSearchParams({
      dentist_id: dentistId,
      from,
      to,
    });
    if (duration) qs.set('duration', String(duration));
    return this._fetch(`/me/booking/slots?${qs.toString()}`, { _usePatient: true });
  }

  // ===== Hito 9: Registro de paciente nuevo =====
  async registerPatient(data) {
    return this._fetch('/kiosk/register', {
      method: 'POST',
      body: data,
      _useKiosk: true,
    });
  }

  // ===== Hito 9: Standby =====
  async getStandbyConfig() {
    return this._fetch('/kiosk/standby', { _useKiosk: true });
  }

  async downloadStandbyMedia() {
    const headers = {};
    if (this.kioskToken) headers['Authorization'] = `Bearer ${this.kioskToken}`;
    const res = await fetch(`${BASE}/kiosk/standby/media`, { headers });
    if (!res.ok) throw new ApiError(res.status, null);
    return res.blob();
  }

  async createBookingAppointment({ dentistId, branchId, fecha, horaInicio, horaFin, notas }) {
    return this._fetch('/me/booking/appointments', {
      method: 'POST',
      body: {
        dentist_id: dentistId,
        branch_id: branchId,
        fecha,
        hora_inicio: horaInicio,
        hora_fin: horaFin,
        notas,
      },
      _usePatient: true,
    });
  }
}

export const api = new ApiClient();
