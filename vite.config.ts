import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BUILD = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default defineConfig({
  plugins: [react(), {
    // version.json lets the running web app notice a newer deploy and offer a refresh
    name: 'emit-version',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD }) }); },
  }],
  base: './',
  define: { __BUILD__: JSON.stringify(BUILD) },
  server: { port: 5173, strictPort: true },
});
