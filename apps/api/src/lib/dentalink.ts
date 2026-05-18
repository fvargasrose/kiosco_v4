/**
 * =============================================================================
 * Dentalink client - Implementación completa con caché y manejo de errores
 * =============================================================================
 */

import { config } from './config.js';
import { logger, maskCedula } from './logger.js';
import { redis } from './redis.js';

export interface DentalinkPatient {
  id: string;
  rut: string;
  nombre: string;
  celular: string;
  email?: string;
  fecha_nacimiento?: string;
  direccion?: string;
}

export interface DentalinkAppointment {
  id: string;
  fecha: string;
  hora_inicio: string;
  hora_fin: string;
  estado: string;
  id_paciente: string;
  paciente: string;
  id_dentista: string;
  dentista: string;
  id_sucursal: number;
  sucursal: string;
  id_sillon?: number;
  tratamiento?: string;
  observaciones?: string;
}

export interface DentalinkTreatment {
  id: string;
  nombre: string;
  estado: string;
  fecha_inicio?: string;
  fecha_fin?: string;
  total: number;
  abonado: number;
  saldo_pendiente: number;
  id_paciente: string;
}

export interface DentalinkDentist {
  id: string;
  nombre: string;
  apellido?: string;
  especialidad?: string;
  id_sucursal: number;
}

// Dentalink devuelve celular sin prefijo país (ej: "3206505239").
// El frontend siempre envía "+57XXXXXXXXXX". Normalizamos al leer.
function normalizeCelular(celular: string): string {
  if (!celular) return celular;
  if (celular.startsWith('+')) return celular;
  if (/^3\d{9}$/.test(celular)) return `+57${celular}`;
  return celular;
}

const CACHE_TTL_PATIENT_LOOKUP = 60;
const CACHE_TTL_APPOINTMENTS = 30;
const CACHE_TTL_TREATMENTS = 60;
const CACHE_TTL_DENTISTS = 300;
const REQUEST_TIMEOUT_MS = 10_000;

// ----- Mock data -----

const MOCK_PATIENTS: DentalinkPatient[] = [
  {
    id: '12345',
    rut: '1061700000',
    nombre: 'María Pérez',
    celular: '+573001234567',
    email: 'maria.perez@demo.local',
    fecha_nacimiento: '1990-05-15',
  },
  {
    id: '67890',
    rut: '1061700001',
    nombre: 'Juan Gómez',
    celular: '+573009876543',
    email: 'juan.gomez@demo.local',
    fecha_nacimiento: '1985-08-20',
  },
];

const MOCK_APPOINTMENTS: DentalinkAppointment[] = [
  {
    id: 'apt-001',
    fecha: '2026-05-20',
    hora_inicio: '10:00',
    hora_fin: '10:30',
    estado: 'Reservada',
    id_paciente: '12345',
    paciente: 'María Pérez',
    id_dentista: 'dr-001',
    dentista: 'Dr. Roberto Sánchez',
    id_sucursal: 1,
    sucursal: 'Sucursal Principal',
    tratamiento: 'Limpieza dental',
  },
  {
    id: 'apt-002',
    fecha: '2026-06-15',
    hora_inicio: '15:00',
    hora_fin: '16:00',
    estado: 'Confirmada',
    id_paciente: '12345',
    paciente: 'María Pérez',
    id_dentista: 'dr-002',
    dentista: 'Dra. Laura Méndez',
    id_sucursal: 1,
    sucursal: 'Sucursal Principal',
    tratamiento: 'Control ortodoncia',
  },
];

const MOCK_TREATMENTS: DentalinkTreatment[] = [
  {
    id: 'tx-001',
    nombre: 'Ortodoncia',
    estado: 'En curso',
    fecha_inicio: '2026-01-15',
    total: 3500000,
    abonado: 2000000,
    saldo_pendiente: 1500000,
    id_paciente: '12345',
  },
  {
    id: 'tx-002',
    nombre: 'Endodoncia molar 36',
    estado: 'Finalizado',
    fecha_inicio: '2025-11-10',
    fecha_fin: '2025-11-25',
    total: 800000,
    abonado: 800000,
    saldo_pendiente: 0,
    id_paciente: '12345',
  },
];

const MOCK_DENTISTS: DentalinkDentist[] = [
  { id: 'dr-001', nombre: 'Roberto', apellido: 'Sánchez', especialidad: 'Odontología General', id_sucursal: 1 },
  { id: 'dr-002', nombre: 'Laura', apellido: 'Méndez', especialidad: 'Ortodoncia', id_sucursal: 1 },
  { id: 'dr-003', nombre: 'Carlos', apellido: 'Vargas', especialidad: 'Endodoncia', id_sucursal: 1 },
];

// ----- Errores -----

export class DentalinkError extends Error {
  constructor(
    message: string,
    public readonly code: 'TIMEOUT' | 'UPSTREAM_ERROR' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'NO_TOKEN',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DentalinkError';
  }
}

// ----- Helpers -----

function isMockMode(token: string | null): boolean {
  return config.DEV_MOCK_EXTERNAL_SERVICES || !token;
}

async function getCached<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, key }, 'Cache read error');
    return null;
  }
}

async function setCached<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, 'Cache write error');
  }
}

async function dentalinkRequest<T>(
  path: string,
  token: string,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${config.DENTALINK_API_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      throw new DentalinkError('Token Dentalink inválido o expirado', 'UNAUTHORIZED', res.status);
    }
    if (res.status === 404) {
      throw new DentalinkError('Recurso no encontrado en Dentalink', 'NOT_FOUND', 404);
    }
    if (!res.ok) {
      throw new DentalinkError(
        `Dentalink respondió ${res.status}`,
        'UPSTREAM_ERROR',
        res.status,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DentalinkError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new DentalinkError('Timeout en Dentalink', 'TIMEOUT');
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new DentalinkError('Timeout en Dentalink', 'TIMEOUT');
    }
    logger.error({ err, path }, 'Dentalink request failed');
    throw new DentalinkError('Error de red con Dentalink', 'UPSTREAM_ERROR');
  }
}

class DentalinkClient {
  async lookupPatientByCedula(
    cedula: string,
    dentalinkToken: string | null,
  ): Promise<DentalinkPatient | null> {
    const cacheKey = `dl:patient:cedula:${cedula}`;
    const cached = await getCached<DentalinkPatient | { not_found: true }>(cacheKey);
    if (cached) {
      if ('not_found' in cached) return null;
      logger.debug({ cedula: maskCedula(cedula), cached: true }, 'Patient lookup');
      return cached;
    }

    logger.info(
      { cedula: maskCedula(cedula), hasToken: !!dentalinkToken, mock: isMockMode(dentalinkToken) },
      'DL lookup start',
    );

    if (isMockMode(dentalinkToken)) {
      const found = MOCK_PATIENTS.find((p) => p.rut === cedula) ?? null;
      logger.info({ cedula: maskCedula(cedula), found: !!found }, 'DL lookup mock result');
      await setCached(cacheKey, found ?? { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
      return found;
    }

    try {
      const filter = JSON.stringify({ rut: { eq: cedula } });
      const data = await dentalinkRequest<{ data?: DentalinkPatient[] }>(
        '/api/v1/pacientes',
        dentalinkToken!,
        { q: filter },
      );
      const raw = data.data?.[0] ?? null;
      logger.info(
        { cedula: maskCedula(cedula), apiFound: !!raw, celular: raw?.celular ?? null },
        'DL lookup API result',
      );
      const patient = raw ? { ...raw, celular: normalizeCelular(raw.celular) } : null;
      await setCached(cacheKey, patient ?? { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
      return patient;
    } catch (err) {
      logger.error({ err, cedula: maskCedula(cedula) }, 'DL lookup API error');
      if (err instanceof DentalinkError && err.code === 'NOT_FOUND') {
        await setCached(cacheKey, { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
        return null;
      }
      throw err;
    }
  }

  async getPatientAppointments(
    patientId: string,
    dentalinkToken: string | null,
  ): Promise<DentalinkAppointment[]> {
    const cacheKey = `dl:patient:${patientId}:appointments`;
    const cached = await getCached<DentalinkAppointment[]>(cacheKey);
    if (cached) return cached;

    if (isMockMode(dentalinkToken)) {
      const list = MOCK_APPOINTMENTS.filter((a) => a.id_paciente === patientId);
      await setCached(cacheKey, list, CACHE_TTL_APPOINTMENTS);
      return list;
    }

    const data = await dentalinkRequest<{ data?: DentalinkAppointment[] }>(
      `/api/v1/pacientes/${encodeURIComponent(patientId)}/citas`,
      dentalinkToken!,
    );
    const list = data.data ?? [];
    await setCached(cacheKey, list, CACHE_TTL_APPOINTMENTS);
    return list;
  }

  async getPatientTreatments(
    patientId: string,
    dentalinkToken: string | null,
  ): Promise<DentalinkTreatment[]> {
    const cacheKey = `dl:patient:${patientId}:treatments`;
    const cached = await getCached<DentalinkTreatment[]>(cacheKey);
    if (cached) return cached;

    if (isMockMode(dentalinkToken)) {
      const list = MOCK_TREATMENTS.filter((t) => t.id_paciente === patientId);
      await setCached(cacheKey, list, CACHE_TTL_TREATMENTS);
      return list;
    }

    const data = await dentalinkRequest<{ data?: DentalinkTreatment[] }>(
      `/api/v1/pacientes/${encodeURIComponent(patientId)}/tratamientos`,
      dentalinkToken!,
    );
    const list = data.data ?? [];
    await setCached(cacheKey, list, CACHE_TTL_TREATMENTS);
    return list;
  }

  async getPatientProfile(
    patientId: string,
    dentalinkToken: string | null,
  ): Promise<DentalinkPatient | null> {
    const cacheKey = `dl:patient:${patientId}:profile`;
    const cached = await getCached<DentalinkPatient | { not_found: true }>(cacheKey);
    if (cached) {
      if ('not_found' in cached) return null;
      return cached;
    }

    if (isMockMode(dentalinkToken)) {
      const found = MOCK_PATIENTS.find((p) => p.id === patientId) ?? null;
      await setCached(cacheKey, found ?? { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
      return found;
    }

    try {
      const data = await dentalinkRequest<{ data?: DentalinkPatient }>(
        `/api/v1/pacientes/${encodeURIComponent(patientId)}`,
        dentalinkToken!,
      );
      const profile = data.data ?? null;
      await setCached(cacheKey, profile ?? { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
      return profile;
    } catch (err) {
      if (err instanceof DentalinkError && err.code === 'NOT_FOUND') {
        await setCached(cacheKey, { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
        return null;
      }
      throw err;
    }
  }

  async getDentists(
    sucursalId: number,
    dentalinkToken: string | null,
  ): Promise<DentalinkDentist[]> {
    const cacheKey = `dl:dentists:${sucursalId}`;
    const cached = await getCached<DentalinkDentist[]>(cacheKey);
    if (cached) return cached;

    if (isMockMode(dentalinkToken)) {
      const list = MOCK_DENTISTS.filter((d) => d.id_sucursal === sucursalId);
      await setCached(cacheKey, list, CACHE_TTL_DENTISTS);
      return list;
    }

    const data = await dentalinkRequest<{ data?: DentalinkDentist[] }>(
      '/api/v1/dentistas',
      dentalinkToken!,
      { sucursal_id: String(sucursalId) },
    );
    const list = data.data ?? [];
    await setCached(cacheKey, list, CACHE_TTL_DENTISTS);
    return list;
  }

  async invalidatePatientCache(patientId: string): Promise<void> {
    try {
      await redis.del(
        `dl:patient:${patientId}:appointments`,
        `dl:patient:${patientId}:treatments`,
        `dl:patient:${patientId}:profile`,
      );
    } catch (err) {
      logger.warn({ err, patientId }, 'Cache invalidation failed');
    }
  }
}

export const dentalink = new DentalinkClient();
