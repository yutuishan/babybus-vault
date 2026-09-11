/**
 * 开发模式：
 *   1. 先用 vite 构建主进程与 preload（它们不走 dev server）
 *   2. 启动渲染进程的 dev server（热更新）
 *   3. 启动 Electron，让它加载 dev server 地址
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log('[dev] 构建主进程与 preload…')
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.main.config.ts'])
run(process.execPath, [
  'node_modules/vite/bin/vite.js',
  'build',
  '--config',
  'vite.preload.config.ts',
])

const server = await createServer({
  configFile: 'vite.renderer.config.ts',
  server: { port: 5173 },
})
await server.listen()
const url = `http://localhost:5173`
console.log(`[dev] 渲染进程已就绪：${url}`)

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})

child.on('exit', () => {
  void server.close()
  process.exit(0)
})
