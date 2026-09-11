/**
 * 手写「绿色版」打包
 *
 * electron-builder 在本机反复卡在依赖下载（winCodeSign/nsis 等 502 网关错误），
 * 但「绿色版」不需要任何额外依赖——只要把 Electron 自带的 dist 复制过去，
 * 再把我们的 app.asar 放进 resources/ 就是一份「解压即用」绿色版。
 *
 * 关键细节：app.asar 的根目录里必须有 package.json（Electron 通过它定位入口）。
 * 我们项目根的 package.json 指向 dist/main/index.cjs，所以原样打包即可。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const electronDist = join(root, 'node_modules', 'electron', 'dist')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

if (!existsSync(join(dist, 'main', 'index.cjs'))) {
  console.error('[pack] 缺少 dist/main/index.cjs，请先 npm run build')
  process.exit(1)
}
if (!existsSync(join(electronDist, 'electron.exe'))) {
  console.error('[pack] 缺少 node_modules/electron/dist/electron.exe，请先 npm install')
  process.exit(1)
}

// 输出目录用纯 ASCII 名 + 时间戳后缀，避开 Windows 路径上非 ASCII 字符
// 以及前一次打包残留的文件锁问题
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const out = join(root, 'release', `babybus-${pkg.version}-portable-${ts}`)
console.log('[pack] 输出目录：', out)
try {
  rmSync(out, { recursive: true, force: true })
} catch (err) {
  console.warn(`[pack] 警告：清理上次的 out 失败 (${err.code})，改用新目录`)
}
mkdirSync(out, { recursive: true })

// 1) 复制 Electron 框架
console.log('[pack] 复制 Electron 框架...')
for (const name of readdirSync(electronDist)) {
  cpSync(join(electronDist, name), join(out, name), { recursive: true, dereference: true })
}

// 2) 复制一份带产品名的别名 exe；保留 electron.exe 不动，否则 Electron 找不到 app.asar
const productExe = join(out, `${pkg.build.productName}.exe`)
copyFileSync(join(out, 'electron.exe'), productExe)

// 3) 用 staging 目录把 package.json + dist + 运行时依赖一起打成 app.asar
const staging = join(root, `.asar-staging-${Date.now()}`)
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
copyFileSync(join(root, 'package.json'), join(staging, 'package.json'))
cpSync(dist, join(staging, 'dist'), { recursive: true })

// 3a) 把主进程实际 require 的运行时依赖复制进 asar 的 node_modules
// vite ssr 构建默认把 node_modules external 掉，所以 dist/main/index.cjs 仍用 require('hash-wasm') 等。
// 如果不带这些依赖，绿色版启动会报 Cannot find module。
const mainCjs = join(dist, 'main', 'index.cjs')
const cjsText = await readFile(mainCjs, 'utf8')
const required = new Set([...cjsText.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1]))
const builtins = new Set(['electron', ...builtinModules, ...builtinModules.map(m => `node:${m}`)])
const runtimeDeps = [...required].filter(id => !builtins.has(id) && !id.startsWith('node:'))
if (runtimeDeps.length > 0) {
  const nmStaging = join(staging, 'node_modules')
  mkdirSync(nmStaging, { recursive: true })
  const nmRoot = join(root, 'node_modules')
  for (const dep of runtimeDeps) {
    const src = join(nmRoot, dep)
    if (existsSync(src)) {
      cpSync(src, join(nmStaging, dep), { recursive: true, dereference: true })
      console.log('[pack] 复制运行时依赖：', dep)
    } else {
      console.warn(`[pack] 警告：运行时依赖 ${dep} 在 node_modules 中不存在`)
    }
  }
}

const srcAsar = join(root, `app-${Date.now()}.asar`)
console.log('[pack] 打包 app.asar (含 package.json)...')
const asar = await import('@electron/asar')
await asar.createPackage(staging, srcAsar)
const size = statSync(srcAsar).size
console.log(`[pack] app.asar = ${(size / 1024 / 1024).toFixed(2)} MB`)
// asar 进程可能还握着 staging 里的某些文件，先尝试清掉；失败不影响最终产物
try {
  rmSync(staging, { recursive: true, force: true })
} catch (err) {
  console.warn(`[pack] 警告：清理 staging 失败 (${err.code})，可手动删除 ${staging}`)
}

// 4) 放 resources/app.asar
const resDir = join(out, 'resources')
mkdirSync(resDir, { recursive: true })
copyFileSync(srcAsar, join(resDir, 'app.asar'))

// 5) README
writeFileSync(
  join(out, 'README.txt'),
  [
    `${pkg.build.productName} v${pkg.version}`,
    '',
    '绿色版（解压即用，免安装）',
    '',
    '使用步骤：',
    '  1. 把整个文件夹放到任意位置（U盘、桌面、硬盘均可）',
    `  2. 双击「${pkg.build.productName}.exe」（或 electron.exe）即可启动`,
    '  3. 卸载：直接删除该文件夹即可，无残留',
    '',
    '首次启动会要求选择文件库位置、设置主密码（≥8 位含字母与数字）。',
    '主密码一旦忘记无法找回，请妥善保管。',
  ].join('\r\n'),
  'utf8',
)

console.log('[pack] 完成！')
console.log('[pack] 启动：', productExe)