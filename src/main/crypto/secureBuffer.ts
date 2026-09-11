/**
 * 敏感内存处理工具
 *
 * 约定：所有承载主密钥、DEK、明文内容的 Buffer 在用完后必须调用 wipe() 清零。
 * JS 无法保证 GC 前没有其他副本（String 不可变、V8 可能做内部拷贝），因此本项目原则：
 *   1. 密钥与明文一律用 Buffer，不用 String 传递；
 *   2. 用完立即 wipe；
 *   3. 尽量缩短明文在内存中的存活时间。
 */
import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

/** 就地清零一个或多个 Buffer */
export function wipe(...buffers: (Buffer | null | undefined)[]): void {
  for (const buf of buffers) {
    if (buf && Buffer.isBuffer(buf)) buf.fill(0)
  }
}

/** 生成随机 Buffer（统一封装，便于审计随机数来源：一律使用 CSPRNG） */
export function randomBytes(length: number): Buffer {
  return nodeRandomBytes(length)
}

/**
 * 给 Buffer 挂一个 dispose()，便于 try/finally 中显式清零
 *
 *   const g = guard(buf)
 *   try { ... } finally { g.dispose() }
 */
export function guard(buf: Buffer): Buffer & { dispose(): void } {
  const g = buf as Buffer & { dispose(): void }
  g.dispose = () => wipe(buf)
  return g
}

/** 恒定时间比较，避免通过响应时间的侧信道泄露比对结果 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
