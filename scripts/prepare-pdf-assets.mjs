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
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'src', 'renderer', 'public', 'pdf')

if (!existsSync(src)) {
  console.error('[pdf-assets] 未找到 pdfjs-dist，请先执行 npm install')
  process.exit(1)
}

mkdirSync(dest, { recursive: true })

/**
 * 增量拷贝：目标文件已存在则跳过。
 *
 * 这里刻意不用 rmSync 清空重建 —— 一次性删除上百个受管文件会触发宿主环境的
 * 批量删除保护而直接失败。资源本身来自 node_modules、版本固定，覆盖式拷贝
 * 没有任何额外收益，增量同步即可幂等。
 */
let copied = 0

for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const from = join(src, dir)
  if (!existsSync(from)) {
    console.warn(`[pdf-assets] 缺少 ${dir}，跳过`)
    continue
  }
  cpSync(from, join(dest, dir), {
    recursive: true,
    force: false,
    errorOnExist: false,
  })
  copied++
}
console.log(`[pdf-assets] 已同步 ${copied} 组运行时资源 ->`, dest)
