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
    emptyOutDir: true,
    target: 'chrome130',
    // 预览大文件时 source map 没意义，且会把内部路径写进产物
    sourcemap: false,
  },
})
