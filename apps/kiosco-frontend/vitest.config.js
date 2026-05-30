import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // lógica pura, sin DOM
    include: ['src/**/*.test.js'],
  },
});
