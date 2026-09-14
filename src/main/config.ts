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

/** 默认亮色：首次启动、配置损坏、字段非法时一律回到这里 */
export const DEFAULT_CONFIG: AppConfig = {
  autoLockMinutes: 5,
  lockOnSuspend: true,
  theme: 'light',
  fontScale: 1,
  guideSeen: false,
}

/**
 * 配置目录的首选位置。
 *
 * Windows 绿色版：优先程序所在目录，这样整个文件夹（含 config.json）能跟着 U 盘走，
 *   插到别的机器上直接就能用 —— 这正是「绿色版」的意义所在。
 *
 * macOS：**绝不能写进 .app**。.app 是一个会被整体替换的包，往 Contents/MacOS 里写
 *   config.json 有三个后果：弄脏包体、让签名失效（README 里还教了用户自己 codesign，
 *   一写就废）、用户重装或更新一次配置就丢。所以 macOS 直接返回 null，
 *   落到系统标准的 Application Support。
 *
 * @returns 首选目录；null 表示该平台不适用「程序所在目录」这套
 */
function preferredDir(): string | null {
  if (!app.isPackaged) return process.cwd()
  if (process.platform === 'darwin') return null
  return dirname(app.getPath('exe'))
}

/** 系统标准配置目录：Windows 是 %APPDATA%\宝宝巴士，macOS 是 ~/Library/Application Support/宝宝巴士 */
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
  const preferred = preferredDir()
  resolvedDir = preferred && canWrite(preferred) ? preferred : fallbackDir()
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
    const cfg = { ...DEFAULT_CONFIG, ...raw }
    if (cfg.theme !== 'dark') cfg.theme = 'light'
    if (typeof cfg.fontScale !== 'number' || !Number.isFinite(cfg.fontScale)) cfg.fontScale = 1
    if (typeof cfg.guideSeen !== 'boolean') cfg.guideSeen = false
    // 自动上锁没有「从不」这一档 —— 界面已经去掉，这里再兜一道：
    // 旧配置或手改的 config.json 若写成 0/负数，会把兜底锁整个关掉。
    if (typeof cfg.autoLockMinutes !== 'number' || !Number.isFinite(cfg.autoLockMinutes) || cfg.autoLockMinutes <= 0) {
      cfg.autoLockMinutes = DEFAULT_CONFIG.autoLockMinutes
    }
    return cfg
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
