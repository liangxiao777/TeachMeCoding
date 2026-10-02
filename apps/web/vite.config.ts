import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    headers: {
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
    proxy: { '/api': {
      target: `http://127.0.0.1:${process.env.PORT ?? '4310'}`,
      changeOrigin: false,
      ws: true,
    } },
  },
});
