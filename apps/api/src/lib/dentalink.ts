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

export interface DentalinkSucursal {
  id: number;
  nombre: string;
  direccion?: string;
  telefono?: string;
  horario?: string;
}

/**
 * Slot de disponibilidad de un dentista en una fecha específica.
 * `hora_inicio` y `hora_fin` en formato HH:mm 24h.
 */
export interface DentalinkSlot {
  fecha: string; // YYYY-MM-DD
  hora_inicio: string; // HH:mm
  hora_fin: string; // HH:mm
  id_dentista: string;
  id_sucursal: number;
  duracion_minutos: number;
}

export interface DentalinkCreatePatientParams {
  nombre: string;
  apellidos: string;
  email: string;
  /** Celular con o sin prefijo +57 — se normaliza antes de enviar */
  celular: string;
  fecha_nacimiento: string; // YYYY-MM-DD
  sexo: 'M' | 'F';
  direccion: string;
  ciudad: string;
  comuna?: string;
  rut: string; // cédula
  ocupacion?: string;
}

export interface DentalinkCreatedPatient {
  id: string;
}

const CACHE_TTL_PATIENT_LOOKUP = 60;
const CACHE_TTL_APPOINTMENTS = 30;
const CACHE_TTL_TREATMENTS = 60;
const CACHE_TTL_DENTISTS = 300;
const CACHE_TTL_SUCURSALES = 600; // 10 min — cambia poco
const CACHE_TTL_SLOTS = 60; // 1 min — cambia constantemente
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

const MOCK_PATIENTS_INITIAL: DentalinkPatient[] = [
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

let MOCK_PATIENTS: DentalinkPatient[] = MOCK_PATIENTS_INITIAL.map((p) => ({ ...p }));

const MOCK_APPOINTMENTS_INITIAL: DentalinkAppointment[] = [
  {
    id: 'apt-001',
    fecha: '2026-08-15',
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
  MOCK_PATIENTS = MOCK_PATIENTS_INITIAL.map((p) => ({ ...p }));
  MOCK_APPOINTMENTS = MOCK_APPOINTMENTS_INITIAL.map((a) => ({ ...a }));
  MOCK_TREATMENTS = MOCK_TREATMENTS_INITIAL.map((t) => ({ ...t }));
}

const MOCK_DENTISTS: DentalinkDentist[] = [
  { id: 'dr-001', nombre: 'Roberto', apellido: 'Sánchez', especialidad: 'Odontología General', id_sucursal: 1 },
  { id: 'dr-002', nombre: 'Laura', apellido: 'Méndez', especialidad: 'Ortodoncia', id_sucursal: 1 },
  { id: 'dr-003', nombre: 'Carlos', apellido: 'Vargas', especialidad: 'Endodoncia', id_sucursal: 1 },
  { id: 'dr-004', nombre: 'Ana', apellido: 'Rojas', especialidad: 'Odontopediatría', id_sucursal: 2 },
];

const MOCK_SUCURSALES: DentalinkSucursal[] = [
  {
    id: 1,
    nombre: 'Sede Principal',
    direccion: 'Cra 5 # 4-25, Centro, Popayán',
    telefono: '+57 602 8200000',
    horario: 'Lun-Vie 7am-7pm · Sáb 8am-2pm',
  },
  {
    id: 2,
    nombre: 'Sede Norte',
    direccion: 'Cl 15 N # 32-10, Popayán',
    telefono: '+57 602 8200001',
    horario: 'Lun-Vie 8am-6pm',
  },
];

/**
 * Genera slots disponibles deterministas para mock mode.
 *
 * Lógica:
 *   - Cada dentista trabaja Lun-Sáb, 9:00-12:00 y 14:00-17:00
 *   - Slots de 30 minutos
 *   - Para que parezca real, "ocupa" pseudoaleatoriamente algunos slots
 *     usando un hash determinista del (id_dentista + fecha + hora)
 */
function generateMockSlots(
  idDentista: string,
  fechaDesde: Date,
  fechaHasta: Date,
  duracionMinutos: number,
): DentalinkSlot[] {
  const dentista = MOCK_DENTISTS.find((d) => d.id === idDentista);
  if (!dentista) return [];

  const slots: DentalinkSlot[] = [];
  const cursor = new Date(fechaDesde);
  cursor.setHours(0, 0, 0, 0);
  const hasta = new Date(fechaHasta);
  hasta.setHours(23, 59, 59, 999);

  while (cursor <= hasta) {
    const dow = cursor.getDay(); // 0=domingo
    if (dow !== 0) {
      // Lun-Sáb
      const morningEnd = dow === 6 ? 13 : 12;
      const eveningStart = dow === 6 ? 0 : 14; // sábado solo mañana
      const eveningEnd = dow === 6 ? 0 : 17;

      // Mañana
      for (let h = 9 * 60; h < morningEnd * 60; h += duracionMinutos) {
        addSlotIfAvailable(slots, dentista, cursor, h, duracionMinutos);
      }
      // Tarde
      if (eveningEnd > eveningStart) {
        for (let h = eveningStart * 60; h < eveningEnd * 60; h += duracionMinutos) {
          addSlotIfAvailable(slots, dentista, cursor, h, duracionMinutos);
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

function addSlotIfAvailable(
  slots: DentalinkSlot[],
  dentista: DentalinkDentist,
  date: Date,
  minuteOfDay: number,
  duracion: number,
): void {
  const startMs = new Date(date).setHours(0, 0, 0, 0) + minuteOfDay * 60_000;
  if (startMs < Date.now()) return; // no slots pasados

  // "Ocupación" pseudoaleatoria pero determinista
  const hashKey = `${dentista.id}-${date.toISOString().slice(0, 10)}-${minuteOfDay}`;
  let h = 0;
  for (let i = 0; i < hashKey.length; i++) h = (h * 31 + hashKey.charCodeAt(i)) | 0;
  if (((h % 10) + 10) % 10 < 4) return; // ~40% ocupados

  const fecha = date.toISOString().slice(0, 10);
  const hi = Math.floor(minuteOfDay / 60).toString().padStart(2, '0');
  const mi = (minuteOfDay % 60).toString().padStart(2, '0');
  const endMin = minuteOfDay + duracion;
  const he = Math.floor(endMin / 60).toString().padStart(2, '0');
  const me = (endMin % 60).toString().padStart(2, '0');

  slots.push({
    fecha,
    hora_inicio: `${hi}:${mi}`,
    hora_fin: `${he}:${me}`,
    id_dentista: dentista.id,
    id_sucursal: dentista.id_sucursal,
    duracion_minutos: duracion,
  });
}

// Genera slots a partir del horario real devuelto por Dentalink (/api/v1/horarios).
// No consulta citas ocupadas — si el slot ya está tomado, Dentalink rechaza el POST con 409.
function generateSlotsFromHorario(
  horario: {
    id_dentista: number;
    id_sucursal: number;
    intervalo: number;
    dias: Array<{
      dia: number;
      hora_inicio: string;
      hora_fin: string;
      hora_inicio_break: string;
      hora_fin_break: string;
    }>;
  },
  idDentista: string,
  fechaDesde: string,
  fechaHasta: string,
  duracionMinutos: number,
): DentalinkSlot[] {
  const parseHHMM = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return h! * 60 + m!;
  };

  // Tamaño real del slot = máximo entre el intervalo del dentista y la duración pedida
  const slotMin = Math.max(horario.intervalo ?? 30, duracionMinutos);

  const slots: DentalinkSlot[] = [];
  const cursor = new Date(`${fechaDesde}T00:00:00`);
  const hasta = new Date(`${fechaHasta}T23:59:59`);

  while (cursor <= hasta) {
    // JS: 0=Dom, 1=Lun…6=Sáb → Dentalink: 1=Lun…6=Sáb, 7=Dom
    const jsDow = cursor.getDay();
    const dlDia = jsDow === 0 ? 7 : jsDow;

    const daySchedule = horario.dias.find((d) => d.dia === dlDia);
    if (daySchedule) {
      const start = parseHHMM(daySchedule.hora_inicio);
      const end = parseHHMM(daySchedule.hora_fin);
      const brkStart = parseHHMM(daySchedule.hora_inicio_break);
      const brkEnd = parseHHMM(daySchedule.hora_fin_break);
      const hasBreak = brkStart < brkEnd;

      if (start < end) {
        for (let t = start; t + slotMin <= end; t += slotMin) {
          // Saltar slots que se solapan con el descanso
          if (hasBreak && t < brkEnd && t + slotMin > brkStart) continue;

          // Saltar slots en el pasado
          const slotDate = new Date(cursor);
          slotDate.setHours(Math.floor(t / 60), t % 60, 0, 0);
          if (slotDate.getTime() <= Date.now()) continue;

          const fecha = cursor.toISOString().slice(0, 10);
          const fmtMin = (m: number) =>
            `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

          slots.push({
            fecha,
            hora_inicio: fmtMin(t),
            hora_fin: fmtMin(t + slotMin),
            id_dentista: idDentista,
            id_sucursal: horario.id_sucursal,
            duracion_minutos: slotMin,
          });
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

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

    const data = await dentalinkRequest<{ data?: unknown[] }>(
      `/api/v1/pacientes/${encodeURIComponent(patientId)}/citas`,
      dentalinkToken!,
    );
    // Normalizar campos reales de Dentalink → interfaz interna
    // Dentalink devuelve: estado_cita, nombre_dentista, nombre_sucursal, nombre_tratamiento,
    //                     id como número, hora_inicio con segundos ("HH:MM:SS")
    const list = (data.data ?? []).map((a: any): DentalinkAppointment => ({
      id: String(a.id ?? ''),
      fecha: a.fecha ?? '',
      hora_inicio: (a.hora_inicio ?? '').slice(0, 5),
      hora_fin: (a.hora_fin ?? '').slice(0, 5),
      estado: a.estado_cita ?? a.estado ?? '',
      id_paciente: a.id_paciente,
      paciente: a.nombre_paciente ?? a.paciente ?? '',
      id_dentista: String(a.id_dentista ?? ''),
      dentista: a.nombre_dentista ?? a.dentista ?? '',
      id_sucursal: a.id_sucursal,
      sucursal: a.nombre_sucursal ?? a.sucursal ?? '',
      id_sillon: a.id_sillon,
      tratamiento: a.nombre_tratamiento ?? a.tratamiento ?? '',
      observaciones: a.comentarios ?? a.observaciones ?? '',
    }));
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

    const data = await dentalinkRequest<{ data?: unknown[] }>(
      `/api/v1/pacientes/${encodeURIComponent(patientId)}/tratamientos`,
      dentalinkToken!,
    );
    // Normalizar campos reales de Dentalink → interfaz interna
    // Dentalink devuelve: deuda (en lugar de saldo_pendiente), finalizado (boolean)
    const list = (data.data ?? []).map((t: any): DentalinkTreatment => ({
      id: String(t.id ?? ''),
      nombre: t.nombre ?? '',
      estado: t.finalizado ? 'Finalizado' : 'En curso',
      fecha_inicio: t.fecha ?? '',
      id_paciente: t.id_paciente,
      total: t.total ?? 0,
      abonado: t.abonado ?? 0,
      saldo_pendiente: t.deuda ?? t.saldo_pendiente ?? 0,
    }));
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

    // Dentalink requiere filtros en formato JSON: q={"field":{"op":val}}
    const data = await dentalinkRequest<{
      data?: Array<{
        id: number;
        nombre: string;
        apellidos?: string;
        especialidad?: string;
        id_sucursal: number;
        habilitado: number;
        agenda_online: number;
        intervalo?: number;
      }>;
    }>(
      '/api/v1/dentistas',
      dentalinkToken!,
      { query: { q: JSON.stringify({ id_sucursal: { eq: sucursalId } }) } },
    );
    const list: DentalinkDentist[] = (data.data ?? [])
      .filter((d) => d.habilitado === 1)
      .map((d) => ({
        id: String(d.id),
        nombre: d.nombre,
        apellido: d.apellidos,
        especialidad: d.especialidad,
        id_sucursal: d.id_sucursal,
      }));
    await setCached(cacheKey, list, CACHE_TTL_DENTISTS);
    return list;
  }

  /**
   * Lista TODOS los odontólogos habilitados de la clínica (sin filtro de sucursal).
   * Usado por el panel admin para gestionar fotos de todos los dentistas.
   */
  async getAllDentists(dentalinkToken: string | null): Promise<DentalinkDentist[]> {
    const cacheKey = `dl:dentists:all`;
    const cached = await getCached<DentalinkDentist[]>(cacheKey);
    if (cached) return cached;

    if (isMockMode(dentalinkToken)) {
      await setCached(cacheKey, MOCK_DENTISTS, CACHE_TTL_DENTISTS);
      return MOCK_DENTISTS;
    }

    const data = await dentalinkRequest<{
      data?: Array<{
        id: number;
        nombre: string;
        apellidos?: string;
        especialidad?: string;
        id_sucursal: number;
        habilitado: number;
      }>;
    }>('/api/v1/dentistas', dentalinkToken!);

    const list: DentalinkDentist[] = (data.data ?? [])
      .filter((d) => d.habilitado === 1)
      .map((d) => ({
        id: String(d.id),
        nombre: d.nombre,
        apellido: d.apellidos,
        especialidad: d.especialidad,
        id_sucursal: d.id_sucursal,
      }));
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

  // =========================================================================
  // Hito 8: Booking de nuevas citas
  // =========================================================================

  /**
   * Lista las sucursales activas de la clínica.
   * Cache 10 min en Redis (cambian rara vez).
   */
  async getSucursales(dentalinkToken: string | null): Promise<DentalinkSucursal[]> {
    const cacheKey = `dl:sucursales`;
    const cached = await getCached<DentalinkSucursal[]>(cacheKey);
    if (cached) return cached;

    if (isMockMode(dentalinkToken)) {
      await setCached(cacheKey, MOCK_SUCURSALES, CACHE_TTL_SUCURSALES);
      return MOCK_SUCURSALES;
    }

    const data = await dentalinkRequest<{
      data?: Array<{
        id: number;
        nombre: string;
        direccion?: string;
        telefono?: string;
        habilitada: number;
      }>;
    }>(
      '/api/v1/sucursales',
      dentalinkToken!,
    );
    const list: DentalinkSucursal[] = (data.data ?? [])
      .filter((s) => s.habilitada === 1)
      .map((s) => ({
        id: s.id,
        nombre: s.nombre,
        direccion: s.direccion,
        telefono: s.telefono,
      }));
    await setCached(cacheKey, list, CACHE_TTL_SUCURSALES);
    return list;
  }

  /**
   * Obtiene los slots disponibles de un dentista en un rango de fechas.
   * Cache 1 min en Redis para evitar carga sobre Dentalink en flujos repetitivos
   * de UI (cuando el paciente navega entre días).
   *
   * @param duracionMinutos Duración del procedimiento. Por defecto 30 min.
   *                        Viene de `clinic.duracion_cita_minutos` o el procedimiento.
   */
  async getAvailableSlots(
    idDentista: string,
    fechaDesde: string, // YYYY-MM-DD
    fechaHasta: string, // YYYY-MM-DD
    duracionMinutos: number,
    dentalinkToken: string | null,
  ): Promise<DentalinkSlot[]> {
    const cacheKey = `dl:slots:${idDentista}:${fechaDesde}:${fechaHasta}:${duracionMinutos}`;
    const cached = await getCached<DentalinkSlot[]>(cacheKey);
    if (cached) return cached;

    if (isMockMode(dentalinkToken)) {
      const desde = new Date(`${fechaDesde}T00:00:00`);
      const hasta = new Date(`${fechaHasta}T23:59:59`);
      const list = generateMockSlots(idDentista, desde, hasta, duracionMinutos);
      await setCached(cacheKey, list, CACHE_TTL_SLOTS);
      return list;
    }

    // Dentalink no tiene endpoint de slots disponibles.
    // Usamos el horario del dentista y generamos los slots teóricos.
    // Si un slot ya está ocupado, Dentalink rechazará el POST /citas con 409.
    const horarioData = await dentalinkRequest<{
      data?: Array<{
        id_dentista: number;
        id_sucursal: number;
        intervalo: number;
        dias: Array<{
          dia: number;              // 1=Lunes … 6=Sábado, 7=Domingo
          hora_inicio: string;     // "HH:MM:SS"
          hora_fin: string;
          hora_inicio_break: string;
          hora_fin_break: string;
        }>;
      }>;
    }>(
      '/api/v1/horarios',
      dentalinkToken!,
      { query: { q: JSON.stringify({ id_dentista: { eq: Number(idDentista) } }) } },
    );

    const horario = horarioData.data?.[0];
    if (!horario) {
      await setCached(cacheKey, [], CACHE_TTL_SLOTS);
      return [];
    }

    const list = generateSlotsFromHorario(horario, idDentista, fechaDesde, fechaHasta, duracionMinutos);
    await setCached(cacheKey, list, CACHE_TTL_SLOTS);
    return list;
  }

  /**
   * Crea una cita nueva en Dentalink.
   *
   * Tras crear, invalida la caché de citas del paciente para que la siguiente
   * lectura ya la incluya.
   *
   * @throws DentalinkError CONFLICT si el slot ya fue tomado por otro paciente.
   */
  async createAppointment(params: {
    patientId: string;
    dentistId: string;
    sucursalId: number;
    sillonId?: number;
    fecha: string; // YYYY-MM-DD
    horaInicio: string; // HH:mm
    horaFin: string; // HH:mm
    notas?: string;
    dentalinkToken: string | null;
  }): Promise<DentalinkAppointment> {
    const {
      patientId,
      dentistId,
      sucursalId,
      sillonId,
      fecha,
      horaInicio,
      horaFin,
      notas,
      dentalinkToken,
    } = params;

    if (isMockMode(dentalinkToken)) {
      // Verificar que el slot exista y no esté ya tomado (mocks)
      const dup = MOCK_APPOINTMENTS.find(
        (a) =>
          a.id_dentista === dentistId &&
          a.fecha === fecha &&
          a.hora_inicio === horaInicio &&
          a.estado !== 'Cancelada',
      );
      if (dup) {
        throw new DentalinkError(
          'El horario ya no está disponible',
          'CONFLICT',
          409,
        );
      }

      const dentist = MOCK_DENTISTS.find((d) => d.id === dentistId);
      const patient = MOCK_PATIENTS.find((p) => p.id === patientId);
      const sucursal = MOCK_SUCURSALES.find((s) => s.id === sucursalId);
      if (!dentist || !patient) {
        throw new DentalinkError('Dentista o paciente no encontrado', 'NOT_FOUND', 404);
      }

      const newApt: DentalinkAppointment = {
        id: `apt-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fecha,
        hora_inicio: horaInicio,
        hora_fin: horaFin,
        estado: 'Reservada',
        id_paciente: patientId,
        paciente: patient.nombre,
        id_dentista: dentistId,
        dentista: `${dentist.nombre} ${dentist.apellido ?? ''}`.trim(),
        id_sucursal: sucursalId,
        sucursal: sucursal?.nombre ?? '',
        tratamiento: notas || 'Consulta',
      };
      MOCK_APPOINTMENTS.push(newApt);
      await this.invalidatePatientCache(patientId);
      return newApt;
    }

    // Dentalink real: POST /api/v1/citas — IDs deben ser numéricos
    const parseMin = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h! * 60 + m!;
    };
    const duracion = parseMin(horaFin) - parseMin(horaInicio);
    const body: Record<string, unknown> = {
      id_paciente: Number(patientId),
      id_dentista: Number(dentistId),
      id_sucursal: sucursalId,
      fecha,
      hora_inicio: horaInicio,
      hora_fin: horaFin,
      duracion,
      comentarios: notas,
    };
    if (sillonId !== undefined) body.id_sillon = sillonId;
    logger.info({ body }, 'createAppointment → Dentalink POST /api/v1/citas');
    let data: { data?: DentalinkAppointment };
    try {
      data = await dentalinkRequest<{ data?: DentalinkAppointment }>(
        '/api/v1/citas',
        dentalinkToken!,
        { method: 'POST', body },
      );
    } catch (err) {
      // Dentalink devuelve 400 (no 409) cuando el slot ya está ocupado.
      // Detectamos el mensaje específico y lo convertimos a CONFLICT.
      if (err instanceof DentalinkError && err.code === 'BAD_REQUEST') {
        const upMsg = String(
          (err.upstreamBody as { error?: { message?: string } })?.error?.message ?? '',
        ).toLowerCase();
        if (upMsg.includes('tope') || upMsg.includes('horario solicitado')) {
          throw new DentalinkError(
            'El horario ya no está disponible',
            'CONFLICT',
            409,
            err.upstreamBody,
          );
        }
      }
      throw err;
    }
    if (!data.data) {
      throw new DentalinkError(
        'Respuesta vacía de Dentalink al crear cita',
        'UPSTREAM_ERROR',
      );
    }
    await this.invalidatePatientCache(patientId);
    // Invalidar caché de slots también
    try {
      const keys = await redis.getClient().keys(`dl:slots:${dentistId}:*`);
      if (keys.length > 0) await redis.del(...keys);
    } catch (err) {
      logger.warn({ err, dentistId }, 'Slot cache invalidation failed');
    }
    return data.data;
  }

  /**
   * Busca si ya existe un paciente con el mismo email o celular en Dentalink.
   * Se usan dos consultas independientes (Dentalink no admite OR).
   * Retorna el paciente encontrado o null si no hay coincidencia.
   */
  async checkPatientExistsByEmailOrCelular(
    email: string,
    celular: string,
    dentalinkToken: string | null,
  ): Promise<DentalinkPatient | null> {
    // Normalizar celular al formato que Dentalink almacena (sin +57)
    const dlCelular = celular.startsWith('+57') ? celular.slice(3) : celular;

    if (isMockMode(dentalinkToken)) {
      const byEmail = MOCK_PATIENTS.find(
        (p) => p.email?.toLowerCase() === email.toLowerCase(),
      ) ?? null;
      if (byEmail) return byEmail;
      const byCelular = MOCK_PATIENTS.find((p) => {
        const stored = p.celular.startsWith('+57') ? p.celular.slice(3) : p.celular;
        return stored === dlCelular;
      }) ?? null;
      return byCelular;
    }

    // Buscar por email
    try {
      const emailFilter = JSON.stringify({ email: { eq: email } });
      const emailRes = await dentalinkRequest<{ data?: DentalinkPatient[] }>(
        '/api/v1/pacientes',
        dentalinkToken!,
        { query: { q: emailFilter } },
      );
      const byEmail = emailRes.data?.[0] ?? null;
      if (byEmail) return { ...byEmail, celular: normalizeCelular(byEmail.celular) };
    } catch (err) {
      if (!(err instanceof DentalinkError && err.code === 'NOT_FOUND')) throw err;
    }

    // Buscar por celular (Dentalink almacena sin +57)
    try {
      const celFilter = JSON.stringify({ celular: { eq: dlCelular } });
      const celRes = await dentalinkRequest<{ data?: DentalinkPatient[] }>(
        '/api/v1/pacientes',
        dentalinkToken!,
        { query: { q: celFilter } },
      );
      const byCelular = celRes.data?.[0] ?? null;
      if (byCelular) return { ...byCelular, celular: normalizeCelular(byCelular.celular) };
    } catch (err) {
      if (!(err instanceof DentalinkError && err.code === 'NOT_FOUND')) throw err;
    }

    return null;
  }

  /**
   * Crea un paciente nuevo en Dentalink.
   * No hace verificación de duplicados — llamar checkPatientExistsByEmailOrCelular antes.
   */
  async createPatient(
    params: DentalinkCreatePatientParams,
    dentalinkToken: string | null,
  ): Promise<DentalinkCreatedPatient> {
    const dlCelular = params.celular.startsWith('+57') ? params.celular.slice(3) : params.celular;

    if (isMockMode(dentalinkToken)) {
      const newId = String(Date.now());
      const newPatient: DentalinkPatient = {
        id: newId,
        rut: params.rut,
        nombre: `${params.nombre} ${params.apellidos}`,
        celular: normalizeCelular(dlCelular),
        email: params.email,
        fecha_nacimiento: params.fecha_nacimiento,
      };
      MOCK_PATIENTS.push(newPatient);
      logger.info({ rut: maskCedula(params.rut), id: newId }, '[MOCK] createPatient');
      return { id: newId };
    }

    const body = {
      nombre: params.nombre,
      apellidos: params.apellidos,
      email: params.email,
      celular: dlCelular,
      telefono: dlCelular,
      fecha_nacimiento: params.fecha_nacimiento,
      sexo: params.sexo,
      direccion: params.direccion,
      ciudad: params.ciudad,
      comuna: params.comuna ?? '',
      rut: params.rut,
      prevision: '',
      ocupacion: params.ocupacion ?? '',
      observaciones: '',
    };

    const data = await dentalinkRequest<{ data?: { id: number | string } }>(
      '/api/v1/pacientes',
      dentalinkToken!,
      { method: 'POST', body },
    );

    const id = data.data?.id;
    if (!id) {
      throw new DentalinkError('Dentalink no retornó ID del paciente creado', 'UPSTREAM_ERROR');
    }
    return { id: String(id) };
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
