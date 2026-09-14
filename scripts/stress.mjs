#!/usr/bin/env node
/**
 * 暴力测试入口。
 *
 * 为什么单独写一个启动器，而不是 `"test:stress": "STRESS=1 vitest run ..."`：
 * Windows 上 npm 用 cmd.exe 执行脚本，`VAR=value cmd` 这种内联环境变量语法不生效
 * （会被当成一个叫 "STRESS=1" 的命令）。这里用 Node 显式设置环境变量再拉起 vitest，
 * 三平台都一致。
 *
 * 直接 `npm test` 不会跑暴力测试 —— stress.spec.ts 用 describe.skipIf 自我跳过。
 *
 * 用法：
 *   npm run test:stress          跑全部
 *   npm run test:stress -- -t 超大   只跑名字匹配的用例
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')

if (!existsSync(vitest)) {
  console.error(`找不到 vitest：${vitest}\n请先执行 npm install`)
  process.exit(1)
}

const args = process.argv.slice(2)
const res = spawnSync(
  process.execPath,
  [vitest, 'run', 'tests/stress.spec.ts', '--reporter=verbose', ...args],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, STRESS: '1' },
  },
)

if (res.error) {
  console.error(res.error)
  process.exit(1)
}
process.exit(res.status ?? 1)
