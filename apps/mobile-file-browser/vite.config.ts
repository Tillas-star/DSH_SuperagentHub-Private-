import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('./src/web', import.meta.url));
const outDir = fileURLToPath(new URL('./dist/web', import.meta.url));

export default defineConfig({
  root: webRoot,
  base: '/',
  plugins: [react()],
  publicDir: false,
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
});
