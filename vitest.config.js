import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate config from vite.config.js on purpose: we only need the React
// transform + jsdom for component tests. We deliberately do NOT load the
// @tailwindcss/vite plugin here so Tailwind CSS processing never runs during
// tests (class names are asserted as plain strings, no CSS needed).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.jsx'],
    setupFiles: ['./vitest.setup.js'],
    css: false,
  },
});
