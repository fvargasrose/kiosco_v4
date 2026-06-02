import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks', // Para que cada archivo de test corra en proceso aislado
    poolOptions: {
      forks: { singleFork: true }, // Pero todos los tests del mismo archivo comparten proceso
    },
    // Tests siempre en mock mode — nunca llaman APIs externas reales
    env: {
      DEV_MOCK_EXTERNAL_SERVICES: 'true',
      DEV_MOCK_WOMPI: 'true',
      // Secreto de eventos de test: permite que los tests de webhook (que firman
      // el payload) realmente se ejecuten en vez de saltarse por falta de secreto.
      WOMPI_EVENTS_SECRET: 'test_events_secret',
    },
  },
});
