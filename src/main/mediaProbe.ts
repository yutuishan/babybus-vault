/**
 * `vault://` 流式协议的端到端探针（仅 `--probe-media` 时运行）。
 *
 * 为什么必须单独做这个：单测只能覆盖 `createPlainStream` 这个纯函数，
 * 而真正容易出错的是它外面那一圈 —— 自定义协议有没有注册成 privileged、
 * CSP 的 media-src 放不放行、`protocol.handle` 接不接受 ReadableStream、
 * Range 头解析完有没有正确回 206。这些全都只在真实的 Electron 进程里才成立。
 *
 * 验证两件事：
 *   1. 主进程侧：用 net.fetch 直接打协议，逐字节比对区间内容（含 Range 与 206）。
 *   2. 渲染进程侧：真的用 <audio> 加载并 seek，证明 CSP 与媒体管线是通的。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { BrowserWindow } from 'electron'
import { makeWav } from './probeFixtures'
import { setVault } from './vault/session'
import { Vault } from './vault/vault'

const PROBE_PASSWORD = 'Probe-Pass-2026'

export async function runMediaProbe(win: BrowserWindow): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'bb-probe-media-'))
  const vault = await Vault.create(dir, PROBE_PASSWORD)

  try {
    setVault(vault)
    // 30 秒 8kHz 16bit 单声道 = 480000 字节，会跨过内部 256KB 分块边界
    const wav = makeWav(30, 8000)
    const node = vault.putFile(null, 'tone.wav', wav)
    const url = `vault://media/${node.id}`

    /*
     * 渲染侧专用的大文件。
     *
     * 为什么必须单独造一个：480KB 的文件 Chromium 会**整份缓冲**，
     * 于是"拖动进度条"根本不产生 Range 请求 —— 探针会在什么都没测到的情况下报成功。
     * 这正是之前漏掉"起点 ≥ 256KB 的区间请求会永久挂死"这个 bug 的原因：
     * 渲染侧那条用例其实一直在空转。
     *
     * 1200 秒 8kHz ≈ 19MB，足以保证 seek 到 99% 时必须真的去请求中后段。
     */
    const longWav = makeWav(1200, 8000)
    const longNode = vault.putFile(null, 'long.wav', longWav)
    const longUrl = `vault://media/${longNode.id}`

    const main = await probeFromMain(url, wav)
    const renderer = await probeFromRenderer(win, longUrl)

    return {
      fileSize: wav.length,
      longFileSize: longWav.length,
      main,
      renderer,
    }
  } finally {
    try {
      vault.lock()
    } catch {
      /* 已经锁了 */
    }
    setVault(null)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发 EPERM，不影响结论 */
    }
  }
}

/** 主进程侧：直接打协议，逐字节比对 —— 这是最硬的证据 */
async function probeFromMain(
  url: string,
  wav: Buffer,
): Promise<Record<string, unknown>> {
  const full = await net.fetch(url)
  const fullBytes = Buffer.from(await full.arrayBuffer())

  // 取中间一段，跨过内部 256KB 分块边界
  const start = 256 * 1024 - 300
  const end = 256 * 1024 + 300
  const ranged = await net.fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  const rangedBytes = Buffer.from(await ranged.arrayBuffer())

  // 最后 100 字节，验证尾部区间
  const tailStart = wav.length - 100
  const tail = await net.fetch(url, { headers: { Range: `bytes=${tailStart}-` } })
  const tailBytes = Buffer.from(await tail.arrayBuffer())

  /*
   * 起点**超过**一个内部块（256KB）的区间 —— 回归用。
   *
   * createPlainStream 的 GCM 必须从 0 顺序推进，取中后段时前若干块"解出来再丢掉"，
   * 一个字节都 enqueue 不出去；而 pull 空手而归时流不会再被调用，请求就永久挂住。
   * 上面那条 ranged 的起点是 256KB-300，恰好卡在阈值下方，所以一直没暴露问题；
   * 这条把起点放到 300KB，真正越过阈值。
   */
  const deepStart = 300 * 1024
  const deep = await net.fetch(url, { headers: { Range: `bytes=${deepStart}-${deepStart + 499}` } })
  const deepBytes = Buffer.from(await deep.arrayBuffer())

  return {
    fullStatus: full.status,
    fullLength: fullBytes.length,
    fullMatches: fullBytes.equals(wav),
    fullContentType: full.headers.get('content-type'),
    acceptRanges: full.headers.get('accept-ranges'),

    rangedStatus: ranged.status,
    rangedLength: rangedBytes.length,
    rangedContentRange: ranged.headers.get('content-range'),
    rangedMatches: rangedBytes.equals(wav.subarray(start, end + 1)),

    tailStatus: tail.status,
    tailLength: tailBytes.length,
    tailMatches: tailBytes.equals(wav.subarray(tailStart)),

    deepStatus: deep.status,
    deepLength: deepBytes.length,
    deepMatches: deepBytes.equals(wav.subarray(deepStart, deepStart + 500)),
  }
}

/** 渲染进程侧：真的用 <audio> 加载并 seek，验证 CSP 与媒体管线 */
async function probeFromRenderer(
  win: BrowserWindow,
  url: string,
): Promise<Record<string, unknown>> {
  // 等 Vue 挂载完，避免在页面还没稳定时做媒体请求
  await new Promise((r) => setTimeout(r, 1500))

  const code = `(async () => {
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.src = ${JSON.stringify(url)}

    const outcome = await new Promise((resolve) => {
      let settled = false
      const finish = (v) => { if (!settled) { settled = true; resolve(v) } }

      audio.addEventListener('loadedmetadata', () => {
        const duration = audio.duration
        // 跳到接近末尾，强制发出一个偏移很大的 Range 请求
        audio.currentTime = Math.max(0, duration - 3)
        audio.addEventListener('seeked', () => {
          finish({ ok: true, duration, seekedTo: audio.currentTime, readyState: audio.readyState })
        }, { once: true })
        setTimeout(() => finish({ ok: true, duration, seekedTo: null, seekTimedOut: true }), 8000)
      }, { once: true })

      audio.addEventListener('error', () => {
        finish({ ok: false, mediaErrorCode: audio.error ? audio.error.code : null,
                 mediaErrorMessage: audio.error ? audio.error.message : null })
      }, { once: true })

      setTimeout(() => finish({ ok: false, timeout: true }), 20000)
    })

    audio.src = ''
    audio.load()
    return outcome
  })()`

  try {
    return (await win.webContents.executeJavaScript(code)) as Record<string, unknown>
  } catch (err) {
    return { ok: false, threw: err instanceof Error ? err.message : String(err) }
  }
}
