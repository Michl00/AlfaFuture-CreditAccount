import { defineConfig } from 'astro/config';
export default defineConfig({
  output: 'static',
  // API routes have no trailing slash. In production nginx handles the proxy.
  trailingSlash: 'ignore',
  // Keep the browser's Host (including :4321) for the same-origin login check.
  vite: { server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false } } } },
  devToolbar: { enabled: false },
});
