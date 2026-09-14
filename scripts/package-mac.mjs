/**
 * 手写 macOS 打包（在 Windows 上也能产出 .app）
 *
 * 为什么不直接用 electron-builder：
 *   mac 目标在 Windows 上不受支持（打 dmg 要 hdiutil、签名要 codesign，都是 macOS 独有），
 *   而且本机 electron-builder 一直卡在依赖下载（winCodeSign/nsis 502）。项目里本来就有
 *   手写 Windows 绿色版打包的先例，这里沿用同一思路。
 *
 * 为什么不是「解压 → 改 → 重新压缩」：
 *   .app 里有一批**符号链接**，最关键的是
 *     Contents/Frameworks/Electron Framework.framework/Electron Framework
 *       → Versions/Current/Electron Framework
 *   Windows 上 unzip 会把符号链接落成「内容是目标路径的文本文件」（35 字节），
 *   而 ln -s 在没有符号链接权限时又会静默退化成普通文件 —— 结果就是主二进制变成
 *   35 字节的文本，App 根本起不来，而且这种坏法在 Windows 上完全看不出来。
 *
 *   所以这里改成**流式搬运**：用 yauzl 逐条读原 zip，连同 externalFileAttributes 里的
 *   Unix 权限位（含符号链接标志 0xA000）原样写进新 zip，中间不落地成文件。
 *   符号链接因此完全不受影响，我们只做 4 处替换：
 *     1. 顶层 Info.plist  → 改写过的版本
 *     2. Contents/MacOS/Electron → 改名 BabyBus
 *     3. 新增 Contents/Resources/icon.icns
 *     4. 新增 Contents/Resources/app.asar
 *
 * 用法：node scripts/package-mac.mjs <arm64|x64>
 *
 * 产出未签名。macOS 首次打开需要「右键 → 打开」，或先执行
 *   xattr -dr com.apple.quarantine /Applications/BabyBus.app
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import yauzl from 'yauzl'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARCH = process.argv[2] ?? 'arm64'
if (!['arm64', 'x64'].includes(ARCH)) {
  console.error('[mac] 用法：node scripts/package-mac.mjs <arm64|x64>')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const APP = 'BabyBus.app'
const SRC_APP = 'Electron.app'
const PRODUCT = pkg.build.productName
const VERSION = pkg.version

const srcZip = join(ROOT, '.tmp-mac', `electron-darwin-${ARCH}.zip`)

const ELECTRON_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version

/**
 * 拉取对应架构的 Electron 压缩包（已存在就复用）。
 *
 * 走 npmmirror 的二进制镜像，而不是 GitHub Releases：GitHub 的
 * releases/download 在本机代理上是 502，npmmirror 的 CDN 可以正常下载。
 * 用 curl 而不是 Node 的 fetch —— fetch 不认 HTTP_PROXY 这类环境变量，
 * 在这种必须走代理的环境里会直接连不上。
 * 可用 ELECTRON_MIRROR 覆盖镜像地址。
 */
async function ensureElectronZip() {
  if (existsSync(srcZip)) {
    console.log(`[mac] 复用已下载的 Electron ${ELECTRON_VERSION} (${ARCH})`)
    return
  }
  const mirror = process.env.ELECTRON_MIRROR ?? 'https://registry.npmmirror.com/-/binary/electron'
  const url = `${mirror}/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-${ARCH}.zip`
  console.log(`[mac] 下载 ${url}`)
  mkdirSync(dirname(srcZip), { recursive: true })
  execFileSync('curl', ['-sL', '--fail', '--retry', '3', '--retry-delay', '5', '-o', srcZip, url], {
    stdio: 'inherit',
  })
  const got = statSync(srcZip).size
  // Electron 的 mac 包都在 100MB 量级，明显偏小说明下到的是错误页而不是压缩包
  if (got < 50 * 1024 * 1024) throw new Error(`下载不完整，只有 ${got} 字节`)
  console.log(`[mac] 下载完成 ${(got / 1024 / 1024).toFixed(1)} MB`)
}

await ensureElectronZip()

const icnsPath = join(ROOT, 'build', 'icon.icns')
if (!existsSync(icnsPath)) {
  console.error('[mac] 缺少 build/icon.icns，请先执行 node scripts/make-icns.mjs')
  process.exit(1)
}

// app.asar 是纯 JS/HTML/WASM 资源，与平台无关，直接复用 Windows 那次的产物
function findAsar() {
  const explicit = process.argv[3]
  if (explicit && existsSync(explicit)) return explicit
  const releaseDir = join(ROOT, 'release')
  if (existsSync(releaseDir)) {
    const dirs = readdirSync(releaseDir)
      .filter((d) => d.startsWith('babybus-') && d.includes('portable'))
      .sort()
      .reverse()
    for (const d of dirs) {
      const p = join(releaseDir, d, 'resources', 'app.asar')
      if (existsSync(p)) return p
    }
  }
  return null
}

const asarPath = findAsar()
if (!asarPath) {
  console.error('[mac] 找不到 app.asar，请先跑一次 Windows 打包（npm run package）或显式传入路径')
  process.exit(1)
}

// ---------------------------------------------------------------- plist 改写

/** 把 <key>KEY</key><string>…</string> 里的值换掉；找不到就报错，避免静默漏改 */
function patchPlist(xml, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([\\s\\S]*?)(</string>)`)
  if (!re.test(xml)) throw new Error(`Info.plist 里找不到 ${key}`)
  return xml.replace(re, (_m, a, _o, c) => a + value + c)
}

function buildPlist(rawXml) {
  let xml = rawXml
  // 显示名用中文，但**包名与可执行文件名保持 ASCII**：
  // zip 里的非 ASCII 路径一旦 UTF-8 标志位没写对，macOS 解压就会乱码，
  // 而这条路径恰好是 App 的入口，赌不起。中文名靠 CFBundleDisplayName 呈现，
  // Finder 和程序坞里看到的仍然是「宝宝巴士」。
  xml = patchPlist(xml, 'CFBundleDisplayName', PRODUCT)
  xml = patchPlist(xml, 'CFBundleName', PRODUCT)
  xml = patchPlist(xml, 'CFBundleExecutable', 'BabyBus')
  xml = patchPlist(xml, 'CFBundleIdentifier', 'com.babybus.vault')
  xml = patchPlist(xml, 'CFBundleIconFile', 'icon.icns')
  xml = patchPlist(xml, 'CFBundleShortVersionString', VERSION)
  xml = patchPlist(xml, 'CFBundleVersion', VERSION)
  xml = patchPlist(xml, 'LSApplicationCategoryType', 'public.app-category.productivity')
  return Buffer.from(xml, 'utf8')
}

// ---------------------------------------------------------------- 最小 ZIP 写入

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
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** 固定时间戳，让产物可复现。2026-09-14 00:00:00 → DOS 格式 */
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 14
const DOS_TIME = 0

/**
 * @param {string} outPath
 * @param {{name:string, data:Buffer, externalAttrs:number, dosDate?:number, dosTime?:number}[]} entries
 */
function writeZip(outPath, entries) {
  const fd = openSync(outPath, 'w')
  const centralParts = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const isDir = e.name.endsWith('/')
    // 路径含非 ASCII 时置 UTF-8 标志位（general purpose bit 11）
    const flag = /[^\x00-\x7F]/.test(e.name) ? 0x0800 : 0
    const dosDate = e.dosDate ?? DOS_DATE
    const dosTime = e.dosTime ?? DOS_TIME

    let method = 0
    let payload = e.data
    if (!isDir) {
      const deflated = deflateRawSync(e.data, { level: 6 })
      // 压完反而更大就退回存储
      if (deflated.length < e.data.length) {
        method = 8
        payload = deflated
      }
    }
    const crc = isDir ? 0 : crc32(e.data)

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)
    lfh.writeUInt16LE(20, 4) // version needed
    lfh.writeUInt16LE(flag, 6)
    lfh.writeUInt16LE(method, 8)
    lfh.writeUInt16LE(dosTime, 10)
    lfh.writeUInt16LE(dosDate, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(payload.length, 18)
    lfh.writeUInt32LE(e.data.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra field length

    writeSync(fd, lfh)
    writeSync(fd, nameBuf)
    if (payload.length) writeSync(fd, payload)

    const cdr = Buffer.alloc(46)
    cdr.writeUInt32LE(0x02014b50, 0)
    cdr.writeUInt16LE(0x031e, 4) // version made by: 高字节 3 = Unix（外部属性才有意义）
    cdr.writeUInt16LE(20, 6)
    cdr.writeUInt16LE(flag, 8)
    cdr.writeUInt16LE(method, 10)
    cdr.writeUInt16LE(dosTime, 12)
    cdr.writeUInt16LE(dosDate, 14)
    cdr.writeUInt32LE(crc, 16)
    cdr.writeUInt32LE(payload.length, 20)
    cdr.writeUInt32LE(e.data.length, 24)
    cdr.writeUInt16LE(nameBuf.length, 28)
    cdr.writeUInt16LE(0, 30) // extra
    cdr.writeUInt16LE(0, 32) // comment
    cdr.writeUInt16LE(0, 34) // disk number
    cdr.writeUInt16LE(0, 36) // internal attrs
    cdr.writeUInt32LE(e.externalAttrs >>> 0, 38)
    cdr.writeUInt32LE(offset, 42)

    centralParts.push(Buffer.concat([cdr, nameBuf]))
    offset += 30 + nameBuf.length + payload.length
  }

  const cdStart = offset
  const cd = Buffer.concat(centralParts)
  writeSync(fd, cd)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  writeSync(fd, eocd)
  closeSync(fd)
}

// ---------------------------------------------------------------- 主流程

const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const outDir = join(ROOT, 'release', `babybus-${VERSION}-mac-${ARCH}-${ts}`)
mkdirSync(outDir, { recursive: true })
const outZip = join(outDir, `BabyBus-${VERSION}-mac-${ARCH}.zip`)

console.log(`[mac] 架构 ${ARCH}`)
console.log(`[mac] 源   ${srcZip}`)
console.log(`[mac] asar ${asarPath} (${(statSync(asarPath).size / 1024 / 1024).toFixed(2)} MB)`)
console.log(`[mac] 输出 ${outZip}`)

const entries = []
let plistPatched = false
let mainRenamed = false

await new Promise((resolve, reject) => {
  yauzl.open(srcZip, { lazyEntries: true }, (err, zip) => {
    if (err) return reject(err)

    zip.on('entry', (entry) => {
      // 目录条目（以 / 结尾）没有数据流
      if (/\/$/.test(entry.fileName)) {
        const name = entry.fileName.replace(new RegExp(`^${SRC_APP}/`), `${APP}/`)
        entries.push({
          name,
          data: Buffer.alloc(0),
          externalAttrs: entry.externalFileAttributes,
          dosDate: entry.lastModFileDate,
          dosTime: entry.lastModFileTime,
        })
        return zip.readEntry()
      }

      zip.openReadStream(entry, (streamErr, stream) => {
        if (streamErr) return reject(streamErr)
        const chunks = []
        stream.on('data', (c) => chunks.push(c))
        stream.on('error', reject)
        stream.on('end', () => {
          const data = Buffer.concat(chunks)
          let name = entry.fileName.replace(new RegExp(`^${SRC_APP}/`), `${APP}/`)

          // 替换 1：顶层 Info.plist
          if (name === `${APP}/Contents/Info.plist`) {
            entries.push({
              name,
              data: buildPlist(data.toString('utf8')),
              externalAttrs: entry.externalFileAttributes,
              dosDate: entry.lastModFileDate,
              dosTime: entry.lastModFileTime,
            })
            plistPatched = true
            return zip.readEntry()
          }

          // 替换 2：主可执行文件改名（Info.plist 的 CFBundleExecutable 已同步改成 BabyBus）
          if (name === `${APP}/Contents/MacOS/Electron`) {
            name = `${APP}/Contents/MacOS/BabyBus`
            mainRenamed = true
          }

          entries.push({
            name,
            data,
            externalAttrs: entry.externalFileAttributes,
            dosDate: entry.lastModFileDate,
            dosTime: entry.lastModFileTime,
          })
          zip.readEntry()
        })
      })
    })

    zip.on('end', resolve)
    zip.on('error', reject)
    zip.readEntry()
  })
})

if (!plistPatched) throw new Error('源 zip 里没有找到顶层 Info.plist')
if (!mainRenamed) throw new Error('源 zip 里没有找到 Contents/MacOS/Electron')

// 替换 3：图标
entries.push({
  name: `${APP}/Contents/Resources/icon.icns`,
  data: readFileSync(icnsPath),
  externalAttrs: (0o100644 << 16) >>> 0,
})

// 替换 4：应用本体
entries.push({
  name: `${APP}/Contents/Resources/app.asar`,
  data: readFileSync(asarPath),
  externalAttrs: (0o100644 << 16) >>> 0,
})

// 目录条目要排在它们的内容之前，zip 才好看；但顺序不影响解压正确性。
// 这里只保证「目录先于其中文件」这一常见约定：按名字排序时父目录自然在前。
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

console.log(`[mac] 写入 ${entries.length} 个条目…`)
writeZip(outZip, entries)

// 未签名的 App 在 macOS 上双击会被 Gatekeeper 拦下，这一步说明必须跟着产物走，
// 否则用户看到的就是「打不开、说是损坏或来源不明」，很容易误以为包是坏的。
const archHint = ARCH === 'arm64' ? 'Apple 芯片（M1/M2/M3/M4）' : 'Intel 芯片'
writeFileSync(
  join(outDir, 'README.txt'),
  [
    `${PRODUCT} v${VERSION} — macOS (${ARCH})`,
    '',
    '【本版本未签名】',
    `适用机型：${archHint}`,
    '',
    '安装步骤：',
    '  1. 双击本压缩包解压，得到 BabyBus.app',
    '  2. 把 BabyBus.app 拖进「应用程序」文件夹',
    '  3. 首次打开不要双击 —— 在访达里【右键点击】BabyBus.app，选「打开」，',
    '     在弹窗里再点一次「打开」。直接双击会被系统拦下，提示「无法验证开发者」。',
    '     若右键打开仍被拦，在「终端」执行（注意换成你自己的路径）：',
    '       xattr -dr com.apple.quarantine /Applications/BabyBus.app',
    '',
    '为什么没有签名：',
    '  Apple 签名与公证需要开发者账号（99 美元/年）并只能在 macOS 上完成，',
    '  这份包是在 Windows 上构建的，所以跳过签名。App 本身功能完整、',
    '  不联网、不上传任何文件。如果介意，可以在 Mac 上自行临时签名：',
    '     codesign --force --deep --sign - /Applications/BabyBus.app',
    '',
    '首次启动会要求选择文件库位置、设置主密码（≥8 位含字母与数字）。',
    '主密码一旦忘记无法找回，请妥善保管。',
  ].join('\r\n'),
  'utf8',
)

const size = statSync(outZip).size
console.log(`[mac] 完成 ${outZip}`)
console.log(`[mac] 体积 ${(size / 1024 / 1024).toFixed(2)} MB`)
