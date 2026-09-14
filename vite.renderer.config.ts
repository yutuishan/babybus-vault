import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { aliases } from './vite.base'

/** 渲染进程：普通 web 构建，输出 dist/renderer */
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [vue()],
  resolve: { alias: aliases },
  server: { port: 5173 },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    // public/ 下是 pdf.js 的 cmaps / standard_fonts / wasm，合计数百个文件。
    // Vite 清空 outDir 时会把它们连同目录一次性删掉，会触发宿主的批量删除保护而构建失败；
    // 资源本身由 scripts/prepare-pdf-assets.mjs 增量同步（同名不覆盖），
    // 这里关掉自动清空即可，产物依旧是最新的。
    emptyOutDir: false,
    target: 'chrome130',
    // 预览大文件时 source map 没意义，且会把内部路径写进产物
    sourcemap: false,
  },
})
