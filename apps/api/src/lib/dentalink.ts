/**
 * =============================================================================
 * Dentalink client - stub mínimo para Hito 4
 * =============================================================================
 *
 * En Hito 5 implementamos los endpoints completos (citas, tratamientos).
 * Por ahora solo necesitamos `lookupPatient(cedula)` para OTP.
 *
 * Modos:
 *   - mock (dev): retorna un paciente fijo si cédula coincide con set de pruebas
 *   - real: llama a Dentalink API con el token de la clínica
 */

import { config } from './config.js';
import { logger, maskCedula } from './logger.js';

export interface DentalinkPatient {
  id: string; // ID en Dentalink
  rut: string; // cédula
  nombre: string;
  celular: string;
  email?: string;
}

const MOCK_PATIENTS: DentalinkPatient[] = [
  {
    id: '12345',
    rut: '1061700000',
    nombre: 'María Pérez',
    celular: '+573001234567',
    email: 'maria.perez@demo.local',
  },
  {
    id: '67890',
    rut: '1061700001',
    nombre: 'Juan Gómez',
    celular: '+573009876543',
    email: 'juan.gomez@demo.local',
  },
];

class DentalinkClient {
  /**
   * Busca un paciente por su cédula. Retorna el paciente o null.
   * IMPORTANTE: este lookup es SERVIDOR-SIDE, no descargamos toda la lista al cliente.
   */
  async lookupPatientByCedula(cedula: string, dentalinkToken: string | null): Promise<DentalinkPatient | null> {
    if (config.DEV_MOCK_EXTERNAL_SERVICES || !dentalinkToken) {
      logger.debug({ cedula: maskCedula(cedula), mock: true }, 'Dentalink lookup (mock)');
      return MOCK_PATIENTS.find((p) => p.rut === cedula) ?? null;
    }

    // Modo real: llamada a Dentalink
    // Formato del filtro Dentalink: q={"rut":{"eq":"..."}}
    const filter = JSON.stringify({ rut: { eq: cedula } });
    const url = `${config.DENTALINK_API_URL}/api/v1/pacientes?q=${encodeURIComponent(filter)}`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Token ${dentalinkToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.error(
          { status: res.status, cedula: maskCedula(cedula) },
          'Dentalink lookup failed',
        );
        return null;
      }

      const data = (await res.json()) as { data?: DentalinkPatient[] };
      const patient = data.data?.[0];
      if (!patient) {
        logger.debug({ cedula: maskCedula(cedula) }, 'Patient not found in Dentalink');
        return null;
      }

      return patient;
    } catch (err) {
      logger.error({ err, cedula: maskCedula(cedula) }, 'Dentalink request error');
      return null;
    }
  }
}

export const dentalink = new DentalinkClient();
