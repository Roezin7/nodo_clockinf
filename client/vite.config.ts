import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    allowedHosts: ['guestbook-formula-professionals-rolls.trycloudflare.com'],
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
