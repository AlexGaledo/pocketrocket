import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:7788';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // changeOrigin stays off: the hub's origin guard compares Origin with Host, and the string shorthand
    // rewrites Host to the hub's, so every write through the dev server came back 403.
    proxy: {
      '/api': { target: HUB, changeOrigin: false },
      '/auth': { target: HUB, changeOrigin: false },
      '/ws': { target: HUB.replace('http', 'ws'), ws: true, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
