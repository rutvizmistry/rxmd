import { defineConfig } from 'vite';

// In development the client runs on Vite's dev server and proxies API calls to the
// RxMD Node server (npm run server). In production the Node server serves the built
// dist/ directly, so this proxy is dev-only.
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true }
    }
  },
  build: {
    // pdf.js worker + epub.js pull in largish chunks; silence the size warning.
    chunkSizeWarningLimit: 2000
  }
});
