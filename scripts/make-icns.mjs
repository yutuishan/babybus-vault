/**
 * 生成 macOS 应用图标 build/icon.icns
 *
 * icns 容器本质就是「OSType + 条目长度 + 负载」依次串接，PNG 负载从 macOS 10.7 起
 * 原生支持。所以不需要 iconutil（那是 macOS 自带的工具），在 Windows 上也能生成，
 * 这样跨平台打包就不会卡在「没有 Mac 就没法出图标」上。
 *
 * 同一个边长会出现两次：一次给 @1x，一次给 @2x。都塞进去能让 Finder / 程序坞
 * 在任意缩放下都取到原生尺寸的图，而不是把大图缩下来的糊图。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drawIcon, encodePng } from './make-icon.mjs'

/** [OSType, 边长] */
const ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512], // 256@2x
]

// 同尺寸只画一次：16/32/64/256/512 都被复用了两遍
const pngCache = new Map()
function pngFor(size) {
  let buf = pngCache.get(size)
  if (!buf) {
    buf = encodePng(drawIcon(size), size)
    pngCache.set(size, buf)
  }
  return buf
}

const chunks = []
for (const [type, size] of ENTRIES) {
  const png = pngFor(size)
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  // 长度字段含自身 8 字节
  header.writeUInt32BE(8 + png.length, 4)
  chunks.push(header, png)
}

const body = Buffer.concat(chunks)
const head = Buffer.alloc(8)
head.write('icns', 0, 4, 'ascii')
head.writeUInt32BE(8 + body.length, 4)
const icns = Buffer.concat([head, body])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.icns')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, icns)

console.log(`[icns] 已生成 ${out} (${(icns.length / 1024).toFixed(1)} KB)`)
console.log(`[icns] 含 ${ENTRIES.length} 个条目：${ENTRIES.map(([t, s]) => `${t}=${s}`).join(' ')}`)
