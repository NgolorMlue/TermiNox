import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/__tests__/**/*.test.js'],
  },
  root: 'src',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (normalizedId.includes('/src/assets/novnc/')) return 'novnc';
          if (normalizedId.includes('/node_modules/leaflet/')) return 'leaflet';
          if (
            normalizedId.includes('/node_modules/@xterm/')
            || normalizedId.includes('/node_modules/xterm/')
          ) {
            return 'xterm';
          }
          if (
            normalizedId.includes('/node_modules/@tauri-apps/')
            || normalizedId.includes('/node_modules/pako/')
          ) {
            return 'desktop-vendor';
          }
          return null;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});
