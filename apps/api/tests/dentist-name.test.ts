/**
 * =============================================================================
 * Tests unitarios: prettifyDentistName — presentación de nombres de odontólogos
 * =============================================================================
 * Dentalink devuelve los nombres en MAYÚSCULAS y sin tildes. Estos tests fijan
 * la ortografía esperada (Title Case + tildes restauradas) para los 12
 * odontólogos reales de la clínica, además de la idempotencia del formateo.
 */

import { describe, it, expect } from 'vitest';
import { prettifyDentistName } from '../src/lib/dentalink.js';

describe('prettifyDentistName', () => {
  const casos: Array<[string, string]> = [
    ['GERMAN ENRIQUE FERNANDEZ SILVA', 'Germán Enrique Fernández Silva'],
    ['LUIS GABRIEL FERNANDEZ VALENCIA', 'Luis Gabriel Fernández Valencia'],
    ['JOHANA ALEXANDRA JIMENEZ ARBELAEZ', 'Johana Alexandra Jiménez Arbeláez'],
    ['MARIA ANDREA GONZALEZ VARONA', 'María Andrea González Varona'],
    ['INDIRA CONSUELO PIMIENTA LOZANO', 'Indira Consuelo Pimienta Lozano'],
    ['CARLOS ARTURO MUÑOZ PINO', 'Carlos Arturo Muñoz Pino'],
    ['DIANA PAOLA RODRIGUEZ MELENDEZ', 'Diana Paola Rodríguez Meléndez'],
    ['ANA ISABEL REALPE CAMELO', 'Ana Isabel Realpe Camelo'],
    ['NIDIA CONSUELO GUAZA URRUTIA', 'Nidia Consuelo Guaza Urrutia'],
    ['MAYRIM MERCEDES ORTIZ ANDRADE', 'Mayrim Mercedes Ortiz Andrade'],
    ['MARIA DEL MAR RUIZ HERRERA', 'María del Mar Ruiz Herrera'],
    ['RODRIGO FERNANDEZ VALENCIA', 'Rodrigo Fernández Valencia'],
  ];

  it.each(casos)('formatea %s → %s', (crudo, esperado) => {
    expect(prettifyDentistName(crudo)).toBe(esperado);
  });

  it('es idempotente (aplicarla dos veces no cambia el resultado)', () => {
    for (const [crudo, esperado] of casos) {
      expect(prettifyDentistName(esperado)).toBe(esperado);
      expect(prettifyDentistName(prettifyDentistName(crudo))).toBe(esperado);
    }
  });

  it('pone las partículas en minúscula salvo cuando abren el nombre', () => {
    expect(prettifyDentistName('DE LA CRUZ')).toBe('De la Cruz');
  });

  it('maneja vacío / nulo / espacios sobrantes', () => {
    expect(prettifyDentistName('')).toBe('');
    expect(prettifyDentistName(null)).toBe('');
    expect(prettifyDentistName(undefined)).toBe('');
    expect(prettifyDentistName('  GERMAN   SILVA  ')).toBe('Germán Silva');
  });
});
