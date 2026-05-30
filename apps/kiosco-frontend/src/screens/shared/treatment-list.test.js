import { describe, it, expect } from 'vitest';
import { buildTreatmentList, DEFAULT_TREATMENT_ID } from './treatment-list.js';

describe('buildTreatmentList', () => {
  it('treatment.fallback_when_empty: con procedures=[] devuelve 1 tarjeta "Consulta general" con duración por defecto', () => {
    const list = buildTreatmentList([], 30);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: DEFAULT_TREATMENT_ID,
      name: 'Consulta general',
      duration_minutes: 30,
    });
  });

  it('fallback usa 30 min si no se pasa duración por defecto', () => {
    const list = buildTreatmentList(undefined, undefined);
    expect(list).toHaveLength(1);
    expect(list[0].duration_minutes).toBe(30);
  });

  it('fallback respeta la duración por defecto de la clínica', () => {
    const list = buildTreatmentList([], 45);
    expect(list[0].duration_minutes).toBe(45);
  });

  it('con procedimientos configurados los devuelve tal cual (sin fallback)', () => {
    const procedures = [
      { id: 'a', name: 'Limpieza', duration_minutes: 30 },
      { id: 'b', name: 'Ortodoncia', duration_minutes: 45 },
    ];
    const list = buildTreatmentList(procedures, 30);
    expect(list).toBe(procedures);
    expect(list).toHaveLength(2);
    expect(list.some((t) => t.id === DEFAULT_TREATMENT_ID)).toBe(false);
  });
});
