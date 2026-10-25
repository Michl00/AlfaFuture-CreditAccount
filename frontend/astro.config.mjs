import { defineConfig } from 'astro/config';
export default defineConfig({
  output: 'static',
  // API routes have no trailing slash. In production nginx handles the proxy.
  trailingSlash: 'ignore',
  vite: { server: { proxy: { '/api': 'http://127.0.0.1:8000' } } },
  devToolbar: { enabled: false },
});
