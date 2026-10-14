import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

// Every sandbox/*.html is a standalone dev page for one subsystem.
const sandboxPages = Object.fromEntries(
  readdirSync(resolve(__dirname, 'sandbox'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => [`sandbox/${f.replace('.html', '')}`, resolve(__dirname, 'sandbox', f)]),
);

export default defineConfig({
  server: { host: '127.0.0.1', watch: { ignored: ['**/shots/**', '**/.cache/**', '**/previews/**'] } },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), ...sandboxPages } },
  },
  worker: { format: 'es' },
});
