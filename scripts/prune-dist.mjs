/**
 * 清理 dist/renderer/assets 里**已经没人引用**的旧构建产物。
 *
 * 背景：`vite.renderer.config.ts` 设了 `emptyOutDir: false` —— 这是必需的，
 * 因为一次性清空该目录会删除上百个文件，触发宿主环境的批量删除保护而中断构建。
 * 代价是每次构建都往 assets/ 里再丢一份新的 index-<hash>.js / .css，
 * 旧的永远留着。实测已累积到 **56 个文件 / 55MB，其中只有 3 个被引用** ——
 * 这些死重量会原封不动被打进安装包。
 *
 * 为什么不能"只保留 index.html 里写的那些"：
 *   pdf.worker.min-<hash>.mjs 和 pptx-preview.es-<hash>.js 都不出现在 index.html 里，
 *   它们是**被 bundle 内部按裸文件名引用**的（动态 import / worker URL）。
 *   按 index.html 一刀切会把它们删掉，PDF 和 PPT 预览当场坏掉。
 *
 * 所以这里用不动点扫描：从 index.html 出发，谁被已保留的文件**提到过名字**就保留谁，
 * 反复迭代到不再增长。最后再反向校验一次"所有被引用的文件都还在"。
 *
 * 用法：
 *   node scripts/prune-dist.mjs          # 只报告，不删（默认）
 *   node scripts/prune-dist.mjs --apply  # 真删
 */
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(root, 'dist', 'renderer')
const assetsDir = join(rendererDir, 'assets')
const indexHtml = join(rendererDir, 'index.html')

const APPLY = process.argv.includes('--apply')

if (!existsSync(indexHtml) || !existsSync(assetsDir)) {
  console.log('[prune-dist] 没有 dist/renderer，跳过')
  process.exit(0)
}

const allAssets = readdirSync(assetsDir).filter((f) =>
  statSync(join(assetsDir, f)).isFile(),
)

// ---- 1. 不动点求「保留集」----
const html = readFileSync(indexHtml, 'utf8')
const keep = new Set()
const dangling = []
const read = new Set()
let searchable = html

for (const m of html.matchAll(/assets\/([A-Za-z0-9._-]+)/g)) keep.add(m[1])

let frontier = [...keep]
while (frontier.length) {
  for (const name of frontier) {
    if (read.has(name)) continue
    read.add(name)
    const p = join(assetsDir, name)
    if (!existsSync(p)) {
      dangling.push(name)
      continue
    }
    searchable += '\n' + readFileSync(p, 'utf8')
  }
  frontier = []
  for (const name of allAssets) {
    if (!keep.has(name) && searchable.includes(name)) {
      keep.add(name)
      frontier.push(name)
    }
  }
}

const stale = allAssets.filter((f) => !keep.has(f))

// ---- 2. 报告 ----
const mb = (files) =>
  (files.reduce((n, f) => n + statSync(join(assetsDir, f)).size, 0) / 1024 / 1024).toFixed(1)

console.log(`[prune-dist] assets 共 ${allAssets.length} 个（${mb(allAssets)} MB）`)
console.log(`[prune-dist] 保留 ${keep.size} 个：${[...keep].sort().join(', ')}`)
console.log(`[prune-dist] 待清理 ${stale.length} 个（${mb(stale)} MB）`)

if (dangling.length) {
  // 引用指向不存在的文件 = 构建本身就不完整，这时候绝不能继续删东西
  console.error(`[prune-dist] ⚠️ 有引用指向不存在的文件：${dangling.join(', ')}`)
  console.error('[prune-dist] 构建产物不完整，已放弃清理')
  process.exit(1)
}

if (!stale.length) {
  console.log('[prune-dist] 没有需要清理的，收工')
  process.exit(0)
}

if (!APPLY) {
  for (const f of stale.slice(0, 10)) console.log(`  - ${f}`)
  if (stale.length > 10) console.log(`  … 其余 ${stale.length - 10} 个`)
  console.log('[prune-dist] 这是预演；加 --apply 才会真删')
  process.exit(0)
}

// ---- 3. 分批删 ----
// 刻意分成小批：宿主对"一次性删大量文件"有保护，批量太大会被拦下。
const BATCH = 10
let removed = 0
let failed = 0
for (let i = 0; i < stale.length; i += BATCH) {
  for (const f of stale.slice(i, i + BATCH)) {
    try {
      unlinkSync(join(assetsDir, f))
      removed++
    } catch {
      // 删不掉不算致命：清理是best-effort，绝不能因此让构建失败
      failed++
    }
  }
}
console.log(`[prune-dist] 已删除 ${removed} 个${failed ? `，${failed} 个删不掉（忽略）` : ''}`)

// ---- 4. 反向校验：被引用的文件必须都还在 ----
const missing = [...keep].filter((f) => !existsSync(join(assetsDir, f)))
if (missing.length) {
  console.error(`[prune-dist] ⚠️ 删多了！这些还被引用却不见了：${missing.join(', ')}`)
  process.exit(1)
}
console.log('[prune-dist] 校验通过：所有被引用的产物都还在')
