/**
 * 生成应用图标 build/icon.ico（256×256，PNG 内嵌格式）
 *
 * 不引第三方库：手写 PNG（zlib 用 node:zlib）再包一层 ICO 容器。
 * ICO 从 Vista 起支持直接内嵌 PNG，无需 BMP + AND 掩码。
 * 图标语义：圆角保险柜门 + 锁孔 + 圆盘把手，沿用界面主色 #2f6bff。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const BG = [0x2f, 0x6b, 0xff]
const FG = [0xff, 0xff, 0xff]
const DARK = [0x1b, 0x46, 0xb8]

/** RGBA 像素缓冲，初始全透明 */
const px = Buffer.alloc(SIZE * SIZE * 4, 0)

function blend(x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || alpha <= 0) return
  const i = (y * SIZE + x) * 4
  const a = Math.min(1, alpha)
  const dstA = px[i + 3] / 255
  const outA = a + dstA * (1 - a)
  if (outA === 0) return
  for (let c = 0; c < 3; c++) {
    const src = color[c]
    const dst = px[i + c]
    px[i + c] = Math.round((src * a + dst * dstA * (1 - a)) / outA)
  }
  px[i + 3] = Math.round(outA * 255)
}

/** 4x4 超采样画圆，边缘不锯齿 */
function circle(cx, cy, r, color) {
  const x0 = Math.floor(cx - r) - 1
  const x1 = Math.ceil(cx + r) + 1
  const y0 = Math.floor(cy - r) - 1
  const y1 = Math.ceil(cy + r) + 1
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let cov = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - cx
          const dy = y + (sy + 0.5) / 4 - cy
          if (dx * dx + dy * dy <= r * r) cov++
        }
      }
      if (cov) blend(x, y, color, cov / 16)
    }
  }
}

function rect(x0, y0, x1, y1, color, alpha = 1) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      blend(x, y, color, alpha)
    }
  }
}

function roundRect(x0, y0, x1, y1, r, color, alpha = 1) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const dx = Math.max(x0 + r - x, 0, x - (x1 - r))
      const dy = Math.max(y0 + r - y, 0, y - (y1 - r))
      if (dx * dx + dy * dy <= r * r) blend(x, y, color, alpha)
    }
  }
}

function ring(cx, cy, rOuter, rInner, color) {
  const x0 = Math.floor(cx - rOuter) - 1
  const x1 = Math.ceil(cx + rOuter) + 1
  const y0 = Math.floor(cy - rOuter) - 1
  const y1 = Math.ceil(cy + rOuter) + 1
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let cov = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - cx
          const dy = y + (sy + 0.5) / 4 - cy
          const d2 = dx * dx + dy * dy
          if (d2 <= rOuter * rOuter && d2 >= rInner * rInner) cov++
        }
      }
      if (cov) blend(x, y, color, cov / 16)
    }
  }
}

// 底板：圆角方块
roundRect(24, 24, 232, 232, 44, BG)
// 高光：左上角一层淡白，做出金属反光
roundRect(24, 24, 232, 110, 44, [0x6d, 0x9b, 0xff], 0.34)

// 保险柜门：深色内框 + 白色描边
roundRect(58, 58, 198, 198, 22, DARK, 0.92)
ring(128, 128, 78, 74, FG)

// 圆盘把手
circle(128, 128, 46, FG)
circle(128, 128, 34, BG)
// 三根把手辐条
rect(124, 82, 132, 174, FG)
rect(82, 124, 174, 132, FG)
// 锁孔
circle(128, 122, 11, DARK)
rect(123, 122, 133, 140, DARK)

// ---- PNG 编码 ----
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crcBuf])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let crc = -1
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

// ---- ICO 容器 ----
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count
const entry = Buffer.alloc(16)
entry[0] = SIZE === 256 ? 0 : SIZE
entry[1] = SIZE === 256 ? 0 : SIZE
entry[2] = 0 // palette
entry[3] = 0
entry.writeUInt16LE(1, 4) // color planes
entry.writeUInt16LE(32, 6) // bpp
entry.writeUInt32LE(png.length, 8) // 数据长度
entry.writeUInt32LE(6 + 16, 12) // 数据偏移
const ico = Buffer.concat([header, entry, png])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, ico)
console.log(`[icon] 已生成 ${out} (${(ico.length / 1024).toFixed(1)} KB)`)
