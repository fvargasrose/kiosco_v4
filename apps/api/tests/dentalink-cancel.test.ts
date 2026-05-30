/**
 * =============================================================================
 * Tests unit: dentalink.ts — getCancelEstadoId (S4) + filtro de slots por fecha
 * =============================================================================
 *
 * Estos tests NO levantan el servidor ni tocan Postgres: ejercitan directamente
 * el cliente Dentalink mockeando `fetch` y limpiando el caché Redis.
 *
 * Cobertura del fix S4 (ver docs/AUDITORIA.md Etapa 4):
 *   - cancel.resolve_estado_exact_8 — con el set REAL de estados devuelve 8,
 *     nunca 21 ("Anulado vía validación", estado interno).
 *   - cancel.no_substring_match — si no hay "Cancelada" exacta, lanza error
 *     (no elige un "Anulado*").
 *   - cancel.override_env — DENTALINK_CANCEL_ESTADO_ID tiene prioridad.
 *   - slots.filter_ddmmyyyy — /agendas filtra por fecha DD/MM/YYYY exacta.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { dentalink, DentalinkError } from '../src/lib/dentalink.js';
import { config } from '../src/lib/config.js';
import { redis } from '../src/lib/redis.js';

const CANCEL_CACHE_KEY = 'dl:estados:cancel_id';

// Set REAL de estados de la clínica (orden descendente de id, tal como responde
// Dentalink). El primer match de la vieja regex /cancel|anula/ era id=21.
const ESTADOS_REALES = [
  { id: 26, nombre: 'No asistió' },
  { id: 21, nombre: 'Anulado vía validación' },
  { id: 19, nombre: 'Anulado por pcte. via Whatsapp' },
  { id: 17, nombre: 'Anulado por reprogramación' },
  { id: 10, nombre: 'Anulado por pcte. via email' },
  { id: 9, nombre: 'Anulado por sesiones en conflicto' },
  { id: 8, nombre: 'Cancelada' },
  { id: 7, nombre: 'Pendiente' },
  { id: 1, nombre: 'Anulado' },
];

function mockFetchOnceJson(payload: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response);
}

beforeEach(async () => {
  await redis.del(CANCEL_CACHE_KEY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Restaurar flags que algún test pueda haber mutado.
  (config as unknown as Record<string, unknown>).DENTALINK_CANCEL_ESTADO_ID = undefined;
  (config as unknown as Record<string, unknown>).DEV_MOCK_EXTERNAL_SERVICES = true;
});

afterAll(async () => {
  await redis.del(CANCEL_CACHE_KEY);
  await redis.quit();
});

// ─── S4: getCancelEstadoId ────────────────────────────────────────────────────

describe('getCancelEstadoId (S4)', () => {
  it('cancel.resolve_estado_exact_8: devuelve 8 con el set real, nunca 21', async () => {
    const fetchSpy = mockFetchOnceJson({ data: ESTADOS_REALES });

    const id = await dentalink.getCancelEstadoId('real-token');

    expect(id).toBe(8);
    expect(id).not.toBe(21);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Y debe haberse cacheado el id correcto.
    const cached = await redis.get(CANCEL_CACHE_KEY);
    expect(JSON.parse(cached!)).toEqual({ id: 8 });
  });

  it('cancel.no_substring_match: lanza error si no hay "Cancelada" exacta (no elige un "Anulado*")', async () => {
    // Set sin "Cancelada" exacta — solo estados "Anulado*".
    const sinCancelada = ESTADOS_REALES.filter((e) => e.id !== 8);
    mockFetchOnceJson({ data: sinCancelada });

    await expect(dentalink.getCancelEstadoId('real-token')).rejects.toBeInstanceOf(DentalinkError);

    // No debe haber cacheado ningún id (no degrada a un "Anulado*").
    const cached = await redis.get(CANCEL_CACHE_KEY);
    expect(cached).toBeNull();
  });

  it('cancel.exact_match_normaliza_acentos_y_mayusculas', async () => {
    mockFetchOnceJson({ data: [{ id: 99, nombre: '  CANCELADA  ' }] });
    const id = await dentalink.getCancelEstadoId('real-token');
    expect(id).toBe(99);
  });

  it('cancel.override_env: DENTALINK_CANCEL_ESTADO_ID tiene prioridad y no llama a Dentalink', async () => {
    (config as unknown as Record<string, unknown>).DENTALINK_CANCEL_ESTADO_ID = 42;
    const fetchSpy = mockFetchOnceJson({ data: ESTADOS_REALES });

    const id = await dentalink.getCancelEstadoId('real-token');

    expect(id).toBe(42);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── S3/A2: filtro de slots por fecha DD/MM/YYYY ──────────────────────────────

describe('getAvailableSlots filtro DD/MM/YYYY (A2)', () => {
  it('slots.filter_ddmmyyyy: solo devuelve los slots de la fecha pedida (descarta el desborde)', async () => {
    // Forzamos modo real (sin mock) para ejercitar el path de /agendas.
    (config as unknown as Record<string, unknown>).DEV_MOCK_EXTERNAL_SERVICES = false;
    await redis.del('dl:slots:13:1:2026-07-08:2026-07-08:30');

    // /agendas devuelve items de varias fechas (desborde): 3 del 08/07 y 2 del 09/07.
    mockFetchOnceJson({
      data: [
        { id_paciente: 0, hora_inicio: '08:00:00', hora_fin: '08:30:00', duracion: 30, id_dentista: 13, fecha: '08/07/2026' },
        { id_paciente: 0, hora_inicio: '08:30:00', hora_fin: '09:00:00', duracion: 30, id_dentista: 13, fecha: '08/07/2026' },
        { id_paciente: 0, hora_inicio: '09:00:00', hora_fin: '09:30:00', duracion: 30, id_dentista: 13, fecha: '08/07/2026' },
        { id_paciente: 0, hora_inicio: '10:00:00', hora_fin: '10:30:00', duracion: 30, id_dentista: 13, fecha: '09/07/2026' },
        { id_paciente: 0, hora_inicio: '10:30:00', hora_fin: '11:00:00', duracion: 30, id_dentista: 13, fecha: '09/07/2026' },
      ],
    });

    const slots = await dentalink.getAvailableSlots('13', 1, '2026-07-08', '2026-07-08', 30, 'real-token');

    // Solo los 3 del 08/07/2026; el desborde (09/07) se descarta.
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.fecha === '2026-07-08')).toBe(true);
    expect(slots.map((s) => s.hora_inicio)).toEqual(['08:00', '08:30', '09:00']);
    expect(slots[0]!.duracion_minutos).toBe(30);
  });
});
