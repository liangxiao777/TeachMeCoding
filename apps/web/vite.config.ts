import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { parsePreviewOrigin, previewFrameAncestors } from '@teach-me-coding/contracts';

const previewOrigin = parsePreviewOrigin(process.env.TMC_PREVIEW_ORIGIN);

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.TMC_WEB_PORT ?? 5173),
    strictPort: true,
    cors: false,
    headers: {
      ...(previewOrigin
        ? { 'Content-Security-Policy': `frame-ancestors ${previewFrameAncestors(previewOrigin)}` }
        : { 'X-Frame-Options': 'DENY' }),
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
