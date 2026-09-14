/**
 * 探针 launcher 的公共部分 —— 媒体探针和界面探针共用。
 *
 * 抽出来是为了不让「看到结果就收工」「必须删 NODE_OPTIONS」这些约束
 * 在两个文件里各写一遍然后慢慢漂移。
 *
 * 约束（都是踩过的坑，别改）：
 *   - 必须删 NODE_OPTIONS / ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成纯 Node 跑，
 *     protocol / app 全是 undefined。在 shell 里 env -u 没用，shim 会被重新注入。
 *   - 不能加 --in-process-gpu：这个 Electron 构建会瞬间 abort（退出码 2147483651）。
 *   - **构建还没写完就启动，也是同一个退出码 `2147483651`**，零输出、看起来像代码坏了。
 *     所以调用方必须把构建和探针串行（`build && probe`），不能并行。
 *   - 必须用 run_in_background 跑，前台会被发 SIGTERM。
 *   - 沙箱可能拦 Electron（报 `C:\Users\...\.ssh 读·拒绝`）；解法是把
 *     HOME/USERPROFILE/APPDATA/LOCALAPPDATA 全指到一个干净目录，四个都要设。
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXE = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')

export function runProbe({ flag, outFile, timeoutMs = 180_000 }) {
  const OUT = join(process.cwd(), outFile)

  if (!existsSync(EXE)) {
    console.error(`找不到 Electron 可执行文件：${EXE}`)
    process.exit(1)
  }

  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(
    EXE,
    ['.', flag, '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let log = ''
  let finished = false

  /**
   * 探针自己报的通过/失败决定 code。
   *
   * 只看"进程有没有崩"是不够的：断言失败时进程照样正常退出，
   * 于是 out.json 里会写一个 OK，看起来一切正常 —— 这正是最坏的一种假绿。
   */
  function codeFor(result) {
    const failed = result && Array.isArray(result.failed) ? result.failed : []
    return failed.length ? `CHECKS_FAILED(${failed.length})` : 'OK'
  }

  /**
   * 落盘并退出。
   * 成功和超时两条路都要走它 —— 只写在 exit 回调里的话，
   * 「探针其实成功了、只是 app 没退出」会被报成 TIMEOUT + result: null，看起来像失败。
   */
  function collect(code, timedOut) {
    const m = /__PROBE__(.+)/.exec(log)
    let result = null
    if (m) {
      try {
        result = JSON.parse(m[1])
      } catch (err) {
        result = { parseError: String(err), raw: m[1] }
      }
    }
    if (result && (Array.isArray(result.passed) || Array.isArray(result.failed))) {
      const passed = result.passed ?? []
      const failed = result.failed ?? []
      console.log(`\n[探针] 通过 ${passed.length} 项，失败 ${failed.length} 项`)
      for (const p of passed) console.log(`  ✓ ${p}`)
      for (const f of failed) console.log(`  ✗ ${f}`)
    }
    writeFileSync(OUT, JSON.stringify({ flag, code, timedOut: !!timedOut, result, log }, null, 2))
    process.exit(0)
  }

  /**
   * 一旦日志里出现**完整可解析**的结果就立刻收工，不等子进程自己退出。
   * app.exit() 不保证能终止进程，傻等只会把 30 秒的探针拖成几分钟。
   * 必须"试解析成功"而不是只判 `__PROBE__` 出现：stdout 会分块到达，半截 JSON 必然失败。
   */
  function finishIfReady() {
    if (finished) return
    const m = /__PROBE__(.+)/.exec(log)
    if (!m) return
    let parsed
    try {
      parsed = JSON.parse(m[1])
    } catch {
      return // 还没收全，等下一块
    }
    finished = true
    setTimeout(() => {
      child.kill()
      collect(codeFor(parsed), false)
    }, 150)
  }

  const onData = (d) => {
    log += d
    finishIfReady()
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  child.on('exit', (code) => collect(code, false))

  setTimeout(() => {
    child.kill()
    collect('TIMEOUT', true)
  }, timeoutMs)
}
