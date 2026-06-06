import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true,
    // Dev/testing: VITE_ALLOWED_HOSTS="host1,host2" para exponer por ngrok.
    // Vacío (default) = solo localhost → estado correcto de producción.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim())
      : [],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/health': 'http://localhost:3000',
    },
  },
});
