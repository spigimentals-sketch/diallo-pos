import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development, requests to /api are proxied to the backend on :4000,
// so the front-end can call fetch('/api/...') without CORS headaches.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
});
