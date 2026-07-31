import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';
import { fileURLToPath, URL } from 'node:url';

// GitHub Pages serves project sites from a sub-path, so the playable build is
// emitted under `<repo>/play/`. Local builds keep `/` unless BASE_PATH is set.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [glsl({ compress: false, watch: true })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    headers: {
      // Enable SharedArrayBuffer for future worker-based physics/streaming.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@dimforge/rapier3d')) return 'rapier';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  worker: { format: 'es' },
});
