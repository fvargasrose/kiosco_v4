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

const CACHE_TTL_PATIENT_LOOKUP = 60;
const CACHE_TTL_APPOINTMENTS = 30;
const CACHE_TTL_TREATMENTS = 60;
const CACHE_TTL_DENTISTS = 300;
const REQUEST_TIMEOUT_MS = 10_000;

// Dentalink devuelve celular sin prefijo país (ej: "3206505239").
// El frontend siempre envía "+57XXXXXXXXXX". Normalizamos al leer.
function normalizeCelular(celular: string): string {
  if (!celular) return celular;
  if (celular.startsWith('+')) return celular;
  if (/^3\d{9}$/.test(celular)) return `+57${celular}`;
  return celular;
}

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

const MOCK_APPOINTMENTS_INITIAL: DentalinkAppointment[] = [
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

const MOCK_TREATMENTS_INITIAL: DentalinkTreatment[] = [
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

// Copias mutables (las mutamos en cancelAppointment / registerPaymentInDentalink mock)
let MOCK_APPOINTMENTS: DentalinkAppointment[] = MOCK_APPOINTMENTS_INITIAL.map((a) => ({ ...a }));
let MOCK_TREATMENTS: DentalinkTreatment[] = MOCK_TREATMENTS_INITIAL.map((t) => ({ ...t }));

/**
 * Restaura los datos mock a sus valores iniciales.
 * SOLO para tests — no usar en producción.
 */
export function _resetMockDataForTests(): void {
  MOCK_APPOINTMENTS = MOCK_APPOINTMENTS_INITIAL.map((a) => ({ ...a }));
  MOCK_TREATMENTS = MOCK_TREATMENTS_INITIAL.map((t) => ({ ...t }));
}

const MOCK_DENTISTS: DentalinkDentist[] = [
  { id: 'dr-001', nombre: 'Roberto', apellido: 'Sánchez', especialidad: 'Odontología General', id_sucursal: 1 },
  { id: 'dr-002', nombre: 'Laura', apellido: 'Méndez', especialidad: 'Ortodoncia', id_sucursal: 1 },
  { id: 'dr-003', nombre: 'Carlos', apellido: 'Vargas', especialidad: 'Endodoncia', id_sucursal: 1 },
];

// ----- Errores -----

export type DentalinkErrorCode =
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'NO_TOKEN'
  | 'CONFLICT'
  | 'BAD_REQUEST';

export class DentalinkError extends Error {
  constructor(
    message: string,
    public readonly code: DentalinkErrorCode,
    public readonly status?: number,
    public readonly upstreamBody?: unknown,
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

interface DentalinkRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string>;
  body?: unknown;
}

async function dentalinkRequest<T>(
  path: string,
  token: string,
  opts: DentalinkRequestOptions = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const url = new URL(`${config.DENTALINK_API_URL}${path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      url.searchParams.set(k, v);
    }
  }

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      throw new DentalinkError('Token Dentalink inválido o expirado', 'UNAUTHORIZED', res.status);
    }
    if (res.status === 404) {
      throw new DentalinkError('Recurso no encontrado en Dentalink', 'NOT_FOUND', 404);
    }
    if (res.status === 409) {
      const body = await safeJson(res);
      throw new DentalinkError(
        'Conflicto al modificar recurso en Dentalink',
        'CONFLICT',
        409,
        body,
      );
    }
    if (res.status === 400 || res.status === 422) {
      const body = await safeJson(res);
      throw new DentalinkError(
        'Petición inválida hacia Dentalink',
        'BAD_REQUEST',
        res.status,
        body,
      );
    }
    if (!res.ok) {
      throw new DentalinkError(
        `Dentalink respondió ${res.status}`,
        'UPSTREAM_ERROR',
        res.status,
      );
    }

    // 204 No Content (común en DELETE/PUT) → retornar objeto vacío
    if (res.status === 204) return {} as T;

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DentalinkError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new DentalinkError('Timeout en Dentalink', 'TIMEOUT');
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new DentalinkError('Timeout en Dentalink', 'TIMEOUT');
    }
    logger.error({ err, path, method }, 'Dentalink request failed');
    throw new DentalinkError('Error de red con Dentalink', 'UPSTREAM_ERROR');
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
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

    if (isMockMode(dentalinkToken)) {
      const found = MOCK_PATIENTS.find((p) => p.rut === cedula) ?? null;
      await setCached(cacheKey, found ?? { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
      return found;
    }

    try {
      const filter = JSON.stringify({ rut: { eq: cedula } });
      const data = await dentalinkRequest<{ data?: DentalinkPatient[] }>(
        '/api/v1/pacientes',
        dentalinkToken!,
        { query: { q: filter } },
      );
      const raw = data.data?.[0] ?? null;
      const patient = raw ? { ...raw, celular: normalizeCelular(raw.celular) } : null;
      await setCached(cacheKey, patient ?? { not_found: true }, CACHE_TTL_PATIENT_LOOKUP);
      return patient;
    } catch (err) {
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
      { query: { sucursal_id: String(sucursalId) } },
    );
    const list = data.data ?? [];
    await setCached(cacheKey, list, CACHE_TTL_DENTISTS);
    return list;
  }

  /**
   * Cancela una cita en Dentalink.
   *
   * - En mock mode: muta MOCK_APPOINTMENTS para que reflejos posteriores
   *   muestren la cita como 'Cancelada'.
   * - En real mode: PUT /api/v1/citas/:id con `{ id_estado: <id-cancelada> }`.
   *
   * Después de cancelar, invalida la caché de citas del paciente.
   *
   * @throws DentalinkError con code='NOT_FOUND' si la cita no existe.
   * @throws DentalinkError con code='CONFLICT' si la cita ya está en estado terminal
   *         o si es demasiado tarde para cancelar (depende de las reglas de la clínica).
   */
  async cancelAppointment(
    appointmentId: string,
    patientId: string,
    dentalinkToken: string | null,
    opts: { reason?: string } = {},
  ): Promise<DentalinkAppointment> {
    if (isMockMode(dentalinkToken)) {
      const idx = MOCK_APPOINTMENTS.findIndex((a) => a.id === appointmentId);
      if (idx === -1) {
        throw new DentalinkError('Cita no encontrada', 'NOT_FOUND', 404);
      }
      const apt = MOCK_APPOINTMENTS[idx]!;
      if (apt.id_paciente !== patientId) {
        // Defensa en profundidad: anti-IDOR aunque ya filtramos en la ruta
        throw new DentalinkError('Cita no encontrada', 'NOT_FOUND', 404);
      }
      if (apt.estado === 'Cancelada') {
        throw new DentalinkError('La cita ya está cancelada', 'CONFLICT', 409);
      }
      if (apt.estado === 'Atendida') {
        throw new DentalinkError('No se puede cancelar una cita ya atendida', 'CONFLICT', 409);
      }
      // Marcamos la mutación en mock
      MOCK_APPOINTMENTS[idx] = { ...apt, estado: 'Cancelada' };
      await this.invalidatePatientCache(patientId);
      return MOCK_APPOINTMENTS[idx]!;
    }

    // Dentalink: id_estado=3 suele ser 'Cancelada' (varía por instalación; configurable más adelante)
    const data = await dentalinkRequest<{ data?: DentalinkAppointment }>(
      `/api/v1/citas/${encodeURIComponent(appointmentId)}`,
      dentalinkToken!,
      {
        method: 'PUT',
        body: {
          id_estado: 3,
          comentario_cancelacion: opts.reason ?? 'Cancelada por el paciente desde kiosco',
        },
      },
    );
    if (!data.data) {
      throw new DentalinkError('Respuesta vacía de Dentalink al cancelar', 'UPSTREAM_ERROR');
    }
    await this.invalidatePatientCache(patientId);
    return data.data;
  }

  /**
   * Registra un pago aprobado en Dentalink (reconciliación).
   *
   * Esto se llama desde el job de reconciliación después de que Wompi confirma
   * el pago (vía webhook). No se llama desde el flujo síncrono del kiosco.
   *
   * - En mock mode: solo loguea y retorna un id falso. Esto permite probar el
   *   pipeline completo sin Dentalink real.
   * - En real mode: POST /api/v1/abonos con monto, paciente, tratamiento.
   *
   * @returns El id del abono creado en Dentalink (o un mock id en dev).
   */
  async registerPaymentInDentalink(params: {
    patientId: string;
    treatmentId: string | null;
    amountCop: number;
    reference: string;
    method: string;
    dentalinkToken: string | null;
  }): Promise<{ paymentId: string }> {
    const { patientId, treatmentId, amountCop, reference, method, dentalinkToken } = params;

    if (isMockMode(dentalinkToken)) {
      const mockId = `mock-abono-${reference}`;
      logger.info(
        { patientId, treatmentId, amountCop, reference, method, mockId },
        '[MOCK] Pago registrado en Dentalink',
      );
      // Reflejamos en mock_treatments si hay treatmentId
      if (treatmentId) {
        const idx = MOCK_TREATMENTS.findIndex((t) => t.id === treatmentId);
        if (idx !== -1) {
          const tx = MOCK_TREATMENTS[idx]!;
          MOCK_TREATMENTS[idx] = {
            ...tx,
            abonado: tx.abonado + amountCop,
            saldo_pendiente: Math.max(0, tx.saldo_pendiente - amountCop),
          };
          await this.invalidatePatientCache(patientId);
        }
      }
      return { paymentId: mockId };
    }

    const body: Record<string, unknown> = {
      id_paciente: patientId,
      monto: amountCop,
      metodo_pago: method, // 'NEQUI' | 'PSE' | 'CARD' | etc.
      referencia_externa: reference,
      fecha: new Date().toISOString().slice(0, 10),
      observaciones: `Pago en línea vía kiosco — ref ${reference}`,
    };
    if (treatmentId) body.id_tratamiento = treatmentId;

    const data = await dentalinkRequest<{ data?: { id: string } }>(
      '/api/v1/abonos',
      dentalinkToken!,
      { method: 'POST', body },
    );

    if (!data.data?.id) {
      throw new DentalinkError(
        'Respuesta vacía de Dentalink al registrar abono',
        'UPSTREAM_ERROR',
      );
    }

    await this.invalidatePatientCache(patientId);
    return { paymentId: data.data.id };
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
