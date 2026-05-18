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
  },
});
