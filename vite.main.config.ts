import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { aliases } from './vite.base'

/**
 * 主进程构建。
 *
 * 输出为 CJS（.cjs）而不是 ESM：项目根 package.json 是 "type": "module"，
 * 而 electron/package.json 导出的是 CJS，用 ESM 命名导入 `import { app } from 'electron'`
 * 在 cjs-module-lexer 分析失败时会直接崩。CJS 是最稳的路径。
 */
export default defineConfig({
  resolve: { alias: aliases },
  build: {
    outDir: fileURLToPath(new URL('./dist/main', import.meta.url)),
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: fileURLToPath(new URL('./src/main/index.ts', import.meta.url)),
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
