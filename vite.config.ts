/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite is configured so that the agent-editable config files (screens.json,
// accounts.json) and the /screenshots directory live at the project root and
// are served as static assets. Editing them triggers HMR.
export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  server: {
    port: 5174,
    strictPort: false,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/lib/__test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'bin/**/*.test.mjs'],
  },
});
