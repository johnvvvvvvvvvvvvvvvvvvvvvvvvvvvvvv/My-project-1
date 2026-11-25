import { defineConfig } from 'vite';

/** ترويسات العزل المطلوبة لتفعيل SharedArrayBuffer. */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: 'frontend',
  // يسمح للخادم المحلي بقراءة ../backend
  server: { headers: isolationHeaders, fs: { allow: ['..'] } },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022', sourcemap: true },
});
