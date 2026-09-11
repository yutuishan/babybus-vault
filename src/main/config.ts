/**
 * 应用配置读写（config.json）
 *
 * 定位规则（基线 §3）：
 *   1. 优先程序所在目录（保持绿色便携，文件库可以整个跟着 U 盘走）
 *   2. 不可写时回退系统应用数据目录（Program Files、只读介质等场景）
 *
 * 这个文件只存界面偏好和最近打开过的文件库路径 —— 绝不存密码、密钥、文件名。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AppConfig } from '@shared/ipc'

const CONFIG_NAME = 'config.json'

export const DEFAULT_CONFIG: AppConfig = {
  autoLockMinutes: 5,
  lockOnSuspend: true,
  rememberRecentVaults: true,
  recentVaults: [],
}

/** 程序所在目录。开发环境用 cwd，打包后用 exe 所在目录 */
function programDir(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : process.cwd()
}

function fallbackDir(): string {
  return join(app.getPath('userData'), '..', '宝宝巴士')
}

function canWrite(dir: string): boolean {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.write-probe')
    writeFileSync(probe, '')
    const { unlinkSync } = require('node:fs') as typeof import('node:fs')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

let resolvedDir: string | null = null

/** 惰性解析并缓存配置目录 */
function configDir(): string {
  if (resolvedDir) return resolvedDir
  const preferred = programDir()
  resolvedDir = canWrite(preferred) ? preferred : fallbackDir()
  return resolvedDir
}

export function configPath(): string {
  return join(configDir(), CONFIG_NAME)
}

export function loadConfig(): AppConfig {
  const file = configPath()
  if (!existsSync(file)) return { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      recentVaults: Array.isArray(raw.recentVaults) ? raw.recentVaults : [],
    }
  } catch {
    // 配置文件损坏不能让应用起不来，直接用默认值
    return { ...DEFAULT_CONFIG }
  }
}

/** 原子写：临时文件 + rename，避免写一半断电把配置搞坏 */
export function saveConfig(config: AppConfig): AppConfig {
  const file = configPath()
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  renameSync(tmp, file)
  return config
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  return saveConfig({ ...loadConfig(), ...patch })
}

const MAX_RECENT = 10

/** 记录最近打开的文件库。用户关掉「记住最近的文件库」时传 null 清空 */
export function touchRecentVault(path: string, name: string): AppConfig {
  const config = loadConfig()
  if (!config.rememberRecentVaults) return config
  const rest = config.recentVaults.filter((v) => v.path !== path)
  rest.unshift({ path, name, lastOpened: Date.now() })
  return saveConfig({ ...config, recentVaults: rest.slice(0, MAX_RECENT) })
}

export function forgetRecentVault(path: string): AppConfig {
  const config = loadConfig()
  return saveConfig({ ...config, recentVaults: config.recentVaults.filter((v) => v.path !== path) })
}
