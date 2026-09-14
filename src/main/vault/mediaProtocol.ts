/**
 * `vault://` 流式协议 —— 音视频预览的取数通道。
 *
 * 为什么不能继续走 IPC + Blob URL：
 *   1. IPC 传的是结构化克隆的整块字节。一个 1GB 的视频要先在主进程解密成 1GB 明文、
 *      再克隆一份过桥，渲染进程再持有一份 —— 峰值内存直接爆掉。
 *   2. Blob URL 没有"部分读取"的概念。浏览器必须等整个 Blob 就绪才能开始播，
 *      进度条拖动基本不可用。
 *
 * 自定义协议 + Range 是唯一能让 <video>/<audio> 正常工作、且内存占用与文件大小
 * 无关的做法：Chromium 会自己按需发起 `Range: bytes=...` 请求，我们解出那一段就返回。
 *
 * 安全约束：
 *   - 只有解锁状态才响应，锁库后立即返回 423，正在播放的流也会在下一次 Range 请求时断掉；
 *   - 只认 `vault://media/<节点id>`，节点 id 必须能在当前 manifest 里找到，
 *     不接受任何路径参数，因此不存在目录穿越；
 *   - 不解密到磁盘，所有明文只存在于内存里的那一段分片。
 */
import { protocol } from 'electron'
import { mediaMime } from '@shared/media'
import { heartbeat } from '../autoLock'
import { currentVault } from './session'

export const VAULT_SCHEME = 'vault'

/**
 * 解析单段 Range 头。
 *
 * 只支持 `bytes=a-b` / `bytes=a-` / `bytes=-n` 三种标准形式。
 * 多段 Range（`bytes=0-99,200-299`）不实现 —— 浏览器播媒体从不用它，
 * 而实现它意味着要拼 multipart/byteranges 响应，复杂度与收益完全不成比例。
 *
 * @returns null 表示"没有 Range 或语法不可识别"，调用方应按整份返回 200
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const rawStart = m[1] ?? ''
  const rawEnd = m[2] ?? ''
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    // bytes=-N：最后 N 个字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return null
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}

export function registerVaultProtocol(): void {
  protocol.handle(VAULT_SCHEME, async (request) => {
    try {
      const vault = currentVault()
      if (!vault || vault.isLocked) {
        return new Response('文件库已锁定', { status: 423 })
      }

      const url = new URL(request.url)
      if (url.hostname !== 'media') return new Response('Not Found', { status: 404 })

      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const node = vault.list().find((n) => n.id === id)
      if (!node || node.type !== 'file') return new Response('Not Found', { status: 404 })

      const size = node.size ?? 0
      const type = mediaMime(node.ext)

      if (size <= 0) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'Content-Type': type, 'Content-Length': '0', 'Accept-Ranges': 'bytes' },
        })
      }

      const range = parseRange(request.headers.get('range'), size)
      const start = range ? range.start : 0
      const end = range ? range.end : size - 1
      const length = end - start + 1

      const headers: Record<string, string> = {
        'Content-Type': type,
        'Content-Length': String(length),
        // 声明支持 Range，Chromium 才会用分片请求，拖动进度条才有效
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

      const body = vault.createPlainStream(id, start, end)
      heartbeat()
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 500 })
    }
  })
}
