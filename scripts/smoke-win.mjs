/**
 * 打包产物冒烟测试（Windows 绿色版）
 *
 * 绿色版最常见的翻车是「双击没反应」。根因几乎都是 app.asar 里少了主进程 require 的
 * 运行时依赖（vite 的 ssr 构建会把 node_modules 整个 external 掉），启动时
 * Cannot find module 然后静默退出，界面上什么都看不到。
 *
 * 这个脚本就是抓这种情况：把 exe 拉起来，等几秒，看进程还在不在、有没有报错输出。
 *
 * 两个必须注意的点（踩过坑）：
 *   1. 必须删掉 NODE_OPTIONS / ELECTRON_RUN_AS_NODE。宿主注入的 node shim 会让
 *      electron.exe 退化成纯 Node 跑，require('electron') 拿到的是路径字符串，
 *      应用根本起不来。在 shell 里 env -u 不可靠（shim 会重新注入），只能在这里删。
 *   2. 绝不能加 --in-process-gpu：这个 Electron 构建会瞬间 abort，退出码 2147483651。
 *
 * 用法：node scripts/smoke-win.mjs [exe路径]
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function findExe() {
  if (process.argv[2]) return process.argv[2]
  const releaseDir = join(ROOT, 'release')
  const dirs = readdirSync(releaseDir)
    .filter((d) => d.startsWith('babybus-') && d.includes('portable'))
    .sort()
    .reverse()
  for (const d of dirs) {
    const dir = join(releaseDir, d)
    const exe = readdirSync(dir).find((f) => f.endsWith('.exe') && f !== 'electron.exe')
    if (exe) return join(dir, exe)
  }
  return null
}

const exePath = findExe()
if (!exePath || !existsSync(exePath)) {
  console.error('[smoke] 找不到可执行文件')
  process.exit(1)
}

console.log(`[smoke] 目标 ${exePath}`)

const env = { ...process.env }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  exePath,
  ['--disable-gpu', '--disable-software-rasterizer', '--no-sandbox'],
  { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: dirname(exePath) },
)

let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))

let exitedEarly = false
let exitInfo = null
child.on('exit', (code, signal) => {
  exitedEarly = true
  exitInfo = { code, signal }
})

const WAIT_MS = 12000
await new Promise((r) => setTimeout(r, WAIT_MS))

if (exitedEarly) {
  console.log(`[smoke] ✗ 进程在 ${WAIT_MS}ms 内退出了：code=${exitInfo.code} signal=${exitInfo.signal}`)
  if (out.trim()) console.log('[smoke] 输出：\n' + out.trim())
  else console.log('[smoke] 没有任何输出 —— 典型的「静默退出」，多半是缺少运行时依赖')
  process.exit(1)
}

console.log(`[smoke] ✓ 进程存活超过 ${WAIT_MS}ms，主进程启动成功`)
if (out.trim()) console.log('[smoke] 运行输出：\n' + out.trim())

// Electron 在 Windows 上会派生子进程，child.kill 未必能收干净，直接 taskkill 整棵树
try {
  execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  console.log('[smoke] 已结束进程树')
} catch {
  console.log('[smoke] 进程树结束失败（可能已自行退出）')
}
process.exit(0)
