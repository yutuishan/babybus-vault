/**
 * 当前打开的文件库会话。
 *
 * 整个进程里只有这一份 Vault 实例，主密钥只存在于它的私有字段中。
 * 渲染进程永远拿不到密钥 —— 只能通过 IPC 拿到目录树视图和解密后的内容。
 */
import { Vault } from './vault'

let current: Vault | null = null

export function currentVault(): Vault | null {
  return current
}

export function setVault(vault: Vault | null): void {
  current = vault
}

/** 锁定并丢弃实例。锁完之后内存里不该再有任何主密钥残留 */
export function closeVault(): void {
  if (!current) return
  try {
    current.lock()
  } finally {
    current = null
  }
}

/** 任何操作前的统一断言，避免每个 handler 都写一遍 */
export function requireVault(): Vault {
  if (!current) throw new Error('当前没有打开的文件库')
  if (current.isLocked) throw new Error('文件库已锁定，请重新输入主密码')
  return current
}
