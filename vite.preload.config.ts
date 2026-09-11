import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { aliases } from './vite.base'

/** preload 构建。sandbox 环境下只认 CJS，因此固定输出 .cjs */
export default defineConfig({
  resolve: { alias: aliases },
  build: {
    outDir: fileURLToPath(new URL('./dist/preload', import.meta.url)),
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: (id: string) =>
        id === 'electron' ||
        id.startsWith('node:') ||
        builtinModules.includes(id),
      output: { entryFileNames: 'index.cjs' },
    },
    minify: false,
    sourcemap: false,
  },
})
