/**
 * 自动锁屏
 *
 * 基线 §7：闲置超过设定时间自动锁定；系统休眠/睡眠/锁屏时立即锁定；
 * 锁定后主密钥与目录树明文全部清空，渲染进程显示锁屏遮罩。
 *
 * 计时放在主进程：渲染进程可以伪造心跳报文，主进程的时间不能被前端骗过去。
 *
 * 注意：没有「从不」档。autoLockMinutes 恒为 >0（见 config.loadConfig 的归一化），
 * 所以自动上锁永远生效 —— 界面上虽然去掉了该选项，这里也不留后门。
 */
import { powerMonitor } from 'electron'
import type { BrowserWindow } from 'electron'
import { loadConfig } from './config'

const CHECK_INTERVAL_MS = 5_000

let lastActivity = Date.now()
let checkTimer: ReturnType<typeof setInterval> | null = null
let onLockCallback: (() => void) | null = null
let win: BrowserWindow | null = null

export function startAutoLock(window: BrowserWindow, onLock: () => void): void {
  win = window
  onLockCallback = onLock
  lastActivity = Date.now()

  if (checkTimer) clearInterval(checkTimer)
  checkTimer = setInterval(() => {
    const minutes = loadConfig().autoLockMinutes
    if (Date.now() - lastActivity >= minutes * 60_000) {
      triggerLock('idle')
    }
  }, CHECK_INTERVAL_MS)

  // 系统层面的事件：休眠、睡眠、系统锁屏
  powerMonitor.on('suspend', () => triggerLock('suspend'))
  powerMonitor.on('lock-screen', () => triggerLock('system-lock'))
}

export function stopAutoLock(): void {
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = null
  win = null
  onLockCallback = null
}

/** 渲染进程每次用户操作时调用 */
export function heartbeat(): void {
  lastActivity = Date.now()
}

export function secondsUntilLock(): number {
  const minutes = loadConfig().autoLockMinutes
  const elapsed = Date.now() - lastActivity
  return Math.max(0, Math.ceil((minutes * 60_000 - elapsed) / 1000))
}

/** reason 会传给渲染进程，用于提示"因系统休眠已锁定" */
export function triggerLock(reason: 'idle' | 'suspend' | 'system-lock' | 'manual'): void {
  lastActivity = Date.now()
  const cb = onLockCallback
  if (reason !== 'manual' && win && !win.isDestroyed()) {
    win.webContents.send('vault:locked', reason)
  }
  cb?.()
}

export function lockReasonText(reason: string): string {
  switch (reason) {
    case 'suspend':
      return '系统进入休眠，已自动锁定'
    case 'system-lock':
      return '系统已锁定，文件库同步锁定'
    case 'idle':
      return '闲置超时，已自动锁定'
    default:
      return '已锁定'
  }
}
