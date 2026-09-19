import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `@/` resolves to `src/` in both Vite and Vitest (see tsconfig.json "paths").
const srcDir = new URL('./src', import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': srcDir },
  },
  server: {
    // host: true exposes the dev server on the LAN so a phone can open it later (singer mic, QR tests).
    host: true,
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
