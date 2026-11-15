import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 产物固定文件名，无 hash：lib/studio-web.js 的 renderStudioHtml 直接内联这两个文件。
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../lib/web-dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'studio.js',
        chunkFileNames: 'studio-[name].js',
        assetFileNames: (a) => (a.names?.[0]?.endsWith('.css') ? 'studio.css' : '[name][extname]'),
        manualChunks: undefined,
      },
    },
  },
});
