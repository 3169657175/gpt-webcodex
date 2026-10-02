import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: resolve(root, '../renderer/react-dist'),
    emptyOutDir: true,
    sourcemap: false,
    minify: 'esbuild',
    lib: {
      entry: resolve(root, 'src/manager.tsx'),
      name: 'McpManagerReact',
      formats: ['iife'],
      fileName: () => 'manager-react.js'
    }
  }
});
