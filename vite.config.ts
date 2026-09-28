import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error The filesystem scanner is shared with Node and needs no transpilation.
import { mediaManifestPlugin } from './scripts/media-manifest.mjs';
// @ts-expect-error Shared Node middleware is loaded directly by Vite.
import { contentStorePlugin } from './scripts/content-store.mjs';

export default defineConfig({
  base: './',
  plugins: [mediaManifestPlugin(), contentStorePlugin(), react()],
  build: {
    rollupOptions: { output: { manualChunks: { three: ['three'], react: ['react', 'react-dom'] } } },
  },
});
