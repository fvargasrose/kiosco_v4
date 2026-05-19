/**
 * Cliente HTTP del panel admin.
 * El token de sesión se guarda en localStorage (sesiones de larga duración).
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

class AdminApiClient {
  constructor() {
    this.token = localStorage.getItem('admin_token') || null;
  }

  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('admin_token', token);
    else localStorage.removeItem('admin_token');
  }

  clearToken() { this.setToken(null); }

  async _fetch(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(`${BASE}${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body instanceof FormData
        ? opts.body
        : opts.body ? JSON.stringify(opts.body) : undefined,
    });

    let body = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try { body = await res.json(); } catch { /* empty */ }
    }

    if (!res.ok) throw new ApiError(res.status, body);
    return body;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async login(email, password) {
    return this._fetch('/admin/auth/login', { method: 'POST', body: { email, password } });
  }

  async verifyMfa(mfaChallengeToken, code) {
    return this._fetch('/admin/auth/mfa/verify', {
      method: 'POST',
      body: { mfa_challenge_token: mfaChallengeToken, code },
    });
  }

  async getMe() {
    return this._fetch('/admin/auth/me');
  }

  async logout() {
    try { await this._fetch('/admin/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    this.clearToken();
  }

  // ── Clinic config ─────────────────────────────────────────────────────────
  async getClinic() {
    return this._fetch('/admin/clinic');
  }

  async patchClinic(data) {
    return this._fetch('/admin/clinic', { method: 'PATCH', body: data });
  }

  async uploadStandbyMedia(file) {
    const form = new FormData();
    form.append('file', file);
    return this._fetch('/admin/clinic/standby-media', { method: 'POST', body: form });
  }

  async deleteStandbyMedia() {
    return this._fetch('/admin/clinic/standby-media', { method: 'DELETE' });
  }

  // ── Dentists ──────────────────────────────────────────────────────────────
  async getDentists() {
    return this._fetch('/admin/dentists');
  }

  async uploadDentistPhoto(dentistId, file) {
    const form = new FormData();
    form.append('file', file);
    return this._fetch(`/admin/dentists/${encodeURIComponent(dentistId)}/photo`, {
      method: 'POST',
      body: form,
    });
  }

  async deleteDentistPhoto(dentistId) {
    return this._fetch(`/admin/dentists/${encodeURIComponent(dentistId)}/photo`, {
      method: 'DELETE',
    });
  }

  // ── Transactions ─────────────────────────────────────────────────────────
  async getTransactions(params = {}) {
    const qs = new URLSearchParams();
    if (params.status)    qs.set('status', params.status);
    if (params.date_from) qs.set('date_from', params.date_from);
    if (params.date_to)   qs.set('date_to', params.date_to);
    if (params.page)      qs.set('page', String(params.page));
    if (params.per_page)  qs.set('per_page', String(params.per_page));
    const query = qs.toString() ? `?${qs}` : '';
    return this._fetch(`/admin/transactions${query}`);
  }

  // ── Kiosks ────────────────────────────────────────────────────────────────
  async getKiosks() {
    return this._fetch('/admin/kiosks');
  }

  async createKiosk(data) {
    return this._fetch('/admin/kiosks', { method: 'POST', body: data });
  }

  async patchKiosk(id, data) {
    return this._fetch(`/admin/kiosks/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });
  }

  async deleteKiosk(id) {
    return this._fetch(`/admin/kiosks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

export const api = new AdminApiClient();
