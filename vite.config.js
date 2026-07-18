import { defineConfig } from 'vite';

const DEFAULT_SIGNALING_TARGET = 'ws://127.0.0.1:8787';

export default defineConfig(() => ({
  base: './',
  server: {
    host: true,
    proxy: {
      '/signal': {
        target: process.env.SIGNALING_TARGET?.trim() || DEFAULT_SIGNALING_TARGET,
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1200,
  },
}));
