/**
 * 把 pdf.js 的运行时资源拷到渲染进程的 public 目录。
 *
 * 需要拷三样：
 *   cmaps           —— 预定义 CJK 编码表。中文 PDF 若没内嵌 ToUnicode，缺了它就是乱码
 *   standard_fonts  —— PDF 标准 14 字体的字形数据，缺了会渲染成空白
 *   wasm            —— JBIG2 / JPEG2000 / 色彩管理的解码器，扫描件类 PDF 会用到
 *
 * 拷进 src/renderer/public 而不是直接引用 node_modules：Vite 的 publicDir 会原样产出，
 * 打包后才能在 app:// 下按相对路径取到。该目录已在 .gitignore 中忽略。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'src', 'renderer', 'public', 'pdf')

if (!existsSync(src)) {
  console.error('[pdf-assets] 未找到 pdfjs-dist，请先执行 npm install')
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const from = join(src, dir)
  if (!existsSync(from)) {
    console.warn(`[pdf-assets] 缺少 ${dir}，跳过`)
    continue
  }
  cpSync(from, join(dest, dir), { recursive: true })
  console.log(`[pdf-assets] 已复制 ${dir}`)
}

console.log('[pdf-assets] 完成 ->', dest)
