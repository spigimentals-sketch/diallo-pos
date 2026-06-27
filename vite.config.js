import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

// During development, requests to /api are proxied to the backend on :4000,
// so the front-end can call fetch('/api/...') without CORS headaches.
export default defineConfig({
  plugins: [
    react(),
    // Without this, the production build is a single <script type="module">
    // with no fallback — on any browser without native ES module support
    // (older Android System WebViews, some budget-phone browsers, certain
    // in-app browsers), that tag is just silently ignored and the page
    // renders completely blank with no visible error. This adds a
    // nomodule-compatible legacy bundle + polyfills for those browsers,
    // while modern browsers keep loading the normal modern bundle.
    legacy({ targets: ['defaults', 'not IE 11'] }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
});
