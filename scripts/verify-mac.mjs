/**
 * 校验 package-mac.mjs 产出的 .app.zip
 *
 * 在 Windows 上没法真的启动 .app，所以退而求其次：把产物当成「别人收到的东西」重新读一遍，
 * 逐条核对最容易出问题的几处 —— 符号链接是否还在、主二进制是不是真二进制、
 * Info.plist 有没有改到位、asar 和图标在不在。这几项只要有一项不对，App 就一定起不来。
 *
 * 用法：node scripts/verify-mac.mjs <zip路径>
 */
import { readFileSync, statSync } from 'node:fs'
import yauzl from 'yauzl'

const zipPath = process.argv[2]
if (!zipPath) {
  console.error('用法：node scripts/verify-mac.mjs <zip路径>')
  process.exit(1)
}

const APP = 'BabyBus.app'
const entries = new Map()

await new Promise((resolve, reject) => {
  yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
    if (err) return reject(err)
    zip.on('entry', (entry) => {
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff
      const isLink = (mode & 0xf000) === 0xa000
      const isDir = /\/$/.test(entry.fileName)
      if (isDir) {
        entries.set(entry.fileName, { isDir: true, isLink: false, mode, size: 0 })
        return zip.readEntry()
      }
      zip.openReadStream(entry, (e2, stream) => {
        if (e2) return reject(e2)
        const chunks = []
        stream.on('data', (c) => chunks.push(c))
        stream.on('error', reject)
        stream.on('end', () => {
          entries.set(entry.fileName, {
            isDir: false,
            isLink,
            mode,
            size: entry.uncompressedSize,
            data: Buffer.concat(chunks),
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

let fail = 0
const ok = (msg) => console.log(`  ✓ ${msg}`)
const bad = (msg) => {
  console.log(`  ✗ ${msg}`)
  fail++
}

console.log(`校验 ${zipPath}`)
console.log(`体积 ${(statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB，共 ${entries.size} 个条目\n`)

// 1) 结构
console.log('[1] 目录结构')
for (const p of [
  `${APP}/`,
  `${APP}/Contents/`,
  `${APP}/Contents/MacOS/`,
  `${APP}/Contents/Resources/`,
  `${APP}/Contents/Frameworks/`,
]) {
  entries.has(p) ? ok(p) : bad(`缺少 ${p}`)
}

// 2) 主可执行文件：必须是真二进制，不是 35 字节的符号链接文本
console.log('\n[2] 主可执行文件')
const exe = entries.get(`${APP}/Contents/MacOS/BabyBus`)
if (!exe) {
  bad('缺少 Contents/MacOS/BabyBus')
} else if (exe.isLink) {
  bad('BabyBus 是符号链接，应该是真实文件')
} else if (!exe.data || exe.data.length < 10000) {
  bad(`BabyBus 只有 ${exe.size} 字节，不是可执行文件`)
} else {
  // Mach-O 魔数：64 位小端 = cffaedfe
  const magic = exe.data.subarray(0, 4).toString('hex')
  if (magic === 'cffaedfe') ok(`BabyBus 是 Mach-O 可执行文件 (${(exe.size / 1024).toFixed(0)} KB)`)
  else bad(`BabyBus 魔数 ${magic} 不是 Mach-O（期望 cffaedfe）`)
}
if (entries.has(`${APP}/Contents/MacOS/Electron`)) bad('旧的 Electron 可执行文件还在，会导致入口冲突')
else ok('旧入口 Contents/MacOS/Electron 已移除')

// 3) 符号链接：这是整个打包最容易坏的地方
console.log('\n[3] 符号链接（Windows 上打包最易损坏的部分）')
const links = [...entries.entries()].filter(([, v]) => v.isLink)
console.log(`  共 ${links.length} 个符号链接`)
const mustHave = [
  [`${APP}/Contents/Frameworks/Electron Framework.framework/Electron Framework`, 'Versions/Current/Electron Framework'],
  [`${APP}/Contents/Frameworks/Electron Framework.framework/Resources`, 'Versions/Current/Resources'],
  [`${APP}/Contents/Frameworks/Electron Framework.framework/Versions/Current`, 'A'],
]
for (const [path, expectTarget] of mustHave) {
  const e = entries.get(path)
  if (!e) bad(`缺少符号链接 ${path}`)
  else if (!e.isLink) bad(`${path} 不是符号链接（权限位 ${e.mode.toString(8)}）`)
  else {
    const target = e.data.toString('utf8')
    if (target === expectTarget) ok(`${path.split('/').pop()} → ${target}`)
    else bad(`${path} 目标为 "${target}"，期望 "${expectTarget}"`)
  }
}

// 4) 真正的二进制内容是否还在（符号链接指向的真实文件）
console.log('\n[4] Electron Framework 真实二进制')
const fw = entries.get(`${APP}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`)
if (!fw) bad('缺少 Versions/A/Electron Framework')
else if (!fw.data || fw.data.length < 1000000) bad(`只有 ${fw.size} 字节，内容不完整`)
else ok(`${(fw.size / 1024 / 1024).toFixed(1)} MB`)

// 5) Info.plist 关键键
console.log('\n[5] Info.plist')
const plist = entries.get(`${APP}/Contents/Info.plist`)
if (!plist) bad('缺少 Contents/Info.plist')
else {
  const xml = plist.data.toString('utf8')
  const want = [
    ['CFBundleExecutable', 'BabyBus'],
    ['CFBundleIdentifier', 'com.babybus.vault'],
    ['CFBundleIconFile', 'icon.icns'],
    ['CFBundlePackageType', 'APPL'],
  ]
  for (const [key, val] of want) {
    const re = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`)
    const m = xml.match(re)
    if (!m) bad(`找不到 ${key}`)
    else if (m[1] === val) ok(`${key} = ${val}`)
    else bad(`${key} = "${m[1]}"，期望 "${val}"`)
  }
  // 显示名应为中文产品名
  const dn = xml.match(/<key>CFBundleDisplayName<\/key>\s*<string>([\s\S]*?)<\/string>/)
  if (dn) ok(`CFBundleDisplayName = ${dn[1]}`)
  else bad('找不到 CFBundleDisplayName')
}

// 6) 我们的应用本体与图标
console.log('\n[6] 应用资源')
const asar = entries.get(`${APP}/Contents/Resources/app.asar`)
if (!asar) bad('缺少 Resources/app.asar')
else if (asar.data.length < 1000000) bad(`app.asar 只有 ${asar.size} 字节`)
else ok(`app.asar ${(asar.size / 1024 / 1024).toFixed(2)} MB`)
// asar 头布局（Chromium Pickle）：
//   [0..3]   sizePickle 的载荷长度（恒为 4）
//   [4..7]   headerBuf 总长
//   [8..11]  headerBuf 载荷长度
//   [12..15] 头部 JSON 的字节数
//   [16..]   JSON 本体
// 注意 JSON 是**嵌套树**，所以完整路径不会以连续字符串出现，必须按层级取。
if (asar) {
  const jsonLen = asar.data.readUInt32LE(12)
  const json = asar.data.subarray(16, 16 + jsonLen).toString('utf8')
  let header = null
  try {
    header = JSON.parse(json)
  } catch {
    bad('app.asar 头部 JSON 解析失败')
  }
  if (header) {
    const main = header.files?.dist?.files?.main?.files?.['index.cjs']
    if (main) ok(`app.asar 入口 dist/main/index.cjs 存在（${main.size} 字节）`)
    else bad('app.asar 里找不到 dist/main/index.cjs')

    const pkgEntry = header.files?.['package.json']
    if (pkgEntry) ok('app.asar 根有 package.json（Electron 靠它定位 main）')
    else bad('app.asar 根缺少 package.json')

    const nm = header.files?.node_modules?.files
    if (nm) ok(`app.asar 内含 node_modules（${Object.keys(nm).length} 个包）`)
    else bad('app.asar 里没有 node_modules，主进程 require 会失败')
  }
}

const icns = entries.get(`${APP}/Contents/Resources/icon.icns`)
if (!icns) bad('缺少 Resources/icon.icns')
else if (icns.data.subarray(0, 4).toString('ascii') === 'icns') ok(`icon.icns ${(icns.size / 1024).toFixed(1)} KB`)
else bad('icon.icns 魔数不对')

// 7) 平台正确性：架构不能串
console.log('\n[7] 架构一致性')
if (exe?.data) {
  // Mach-O header: cputype 在偏移 4（小端）
  const cputype = exe.data.readUInt32LE(4)
  const isArm = cputype === 0x0100000c
  const isX64 = cputype === 0x01000007
  const archInName = zipPath.includes('arm64') ? 'arm64' : 'x64'
  const actual = isArm ? 'arm64' : isX64 ? 'x64' : `未知(${cputype.toString(16)})`
  if (actual === archInName) ok(`主二进制架构 ${actual} 与文件名一致`)
  else bad(`文件名说 ${archInName}，主二进制实际是 ${actual}`)
}

console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项未通过 ✗`)
process.exit(fail === 0 ? 0 : 1)
