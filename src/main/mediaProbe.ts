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

    /*
     * 超大媒体文件。
     *
     * 2400 秒 @48kHz 单声道 16bit ≈ 220MB —— 故意贴着应用自己的导入上限（256MB）来，
     * 因为用户真正会遇到的极端情况就是"能导进来的最大那个文件"。
     * 它验证的是：流式解密在 200MB 量级上不会退化成"整份读进内存再切片"。
     * 判据不是"能不能播"，而是**取 1KB 区间时 RSS 不该涨一个文件那么大**。
     */
    const hugeWav = makeWav(2400, 48000)
    const hugeNode = vault.putFile(null, 'huge.wav', hugeWav)
    const hugeUrl = `vault://media/${hugeNode.id}`

    const main = await probeFromMain(url, wav)
    const renderer = await probeFromRenderer(win, longUrl)
    const huge = await probeHugeFromMain(hugeUrl, hugeWav)
    const hugeRenderer = await probeFromRenderer(win, hugeUrl)

    const observed: Record<string, unknown> = {
      fileSize: wav.length,
      longFileSize: longWav.length,
      hugeFileSize: hugeWav.length,
      main,
      renderer,
      huge,
      hugeRenderer,
    }
    return { ...evaluate(observed), ...observed }
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

/**
 * 超大媒体文件：只取末尾附近的 1KB，逐字节比对，并量一下 RSS 涨了多少。
 *
 * 这里刻意**不做**整份 net.fetch —— 那会把 220MB 全读进内存，正是要证明"没发生"的事。
 */
async function probeHugeFromMain(
  url: string,
  wav: Buffer,
): Promise<Record<string, unknown>> {
  const size = wav.length
  // 90% 处：离起点足够远，任何"从 0 解到末尾再切片"的实现都会在这里暴露成内存/耗时问题
  const start = Math.floor(size * 0.9)
  const end = start + 1023

  const rssBefore = process.memoryUsage().rss
  const t0 = Date.now()
  const res = await net.fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  const bytes = Buffer.from(await res.arrayBuffer())
  const ms = Date.now() - t0
  const rssDelta = process.memoryUsage().rss - rssBefore

  return {
    size,
    status: res.status,
    length: bytes.length,
    contentRange: res.headers.get('content-range'),
    matches: bytes.equals(wav.subarray(start, end + 1)),
    ms,
    rssDeltaMB: +(rssDelta / 1048576).toFixed(1),
    // 取 1KB 却让 RSS 涨了半个文件 → 说明被整份缓冲了
    streamedNotBuffered: rssDelta < size / 2,
  }
}

/** 把观测结果变成一组"通过/失败"，期望值全部硬编码 */
function evaluate(o: Record<string, unknown>): { passed: string[]; failed: string[] } {
  const passed: string[] = []
  const failed: string[] = []

  const ok = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) passed.push(label)
    else failed.push(detail === undefined ? label : `${label}（实际：${JSON.stringify(detail)}）`)
  }

  const main = o.main as Record<string, unknown>
  const renderer = o.renderer as Record<string, unknown>
  const huge = o.huge as Record<string, unknown>
  const hugeRenderer = o.hugeRenderer as Record<string, unknown>

  // ---- 主进程侧：协议的字节级正确性 ----
  ok(main.fullStatus === 200, '整份请求返回 200', main.fullStatus)
  ok(main.fullMatches === true, '整份内容逐字节一致', main.fullLength)
  ok(main.acceptRanges === 'bytes', '响应声明支持 Range', main.acceptRanges)
  ok(main.rangedStatus === 206, '区间请求返回 206', main.rangedStatus)
  ok(main.rangedMatches === true, '区间内容逐字节一致（跨 256KB 分块边界）', main.rangedContentRange)
  ok(main.tailMatches === true, '末尾区间逐字节一致', main.tailLength)
  // 回归：起点超过一个内部分块（256KB）的区间曾经永久挂死
  ok(main.deepStatus === 206, '起点 300KB 的区间返回 206（回归：曾永久挂死）', main.deepStatus)
  ok(main.deepMatches === true, '起点 300KB 的区间内容一致', main.deepLength)

  // ---- 渲染进程侧：CSP + 媒体管线 ----
  ok(renderer.ok === true, '渲染进程 <audio> 能加载并 seek', renderer)
  ok(
    typeof renderer.seekedTo === 'number' && (renderer.seekedTo as number) > 0,
    'seek 后 currentTime 落在预期位置',
    renderer.seekedTo,
  )
  ok(renderer.readyState === 4, 'seek 后 readyState 达到 4（HAVE_ENOUGH_DATA）', renderer.readyState)

  // ---- 超大媒体文件（≈220MB）----
  ok(huge.status === 206, '超大文件区间请求返回 206', huge.status)
  ok(huge.length === 1024, '超大文件区间返回 1024 字节', huge.length)
  ok(huge.matches === true, '超大文件 90% 处的内容逐字节一致', huge.contentRange)
  ok(huge.streamedNotBuffered === true, '超大文件是流式的（RSS 未随文件大小膨胀）', huge.rssDeltaMB)
  ok(hugeRenderer.ok === true, '超大文件在渲染进程能加载并 seek 到末尾附近', hugeRenderer)
  ok(
    typeof hugeRenderer.seekedTo === 'number' && (hugeRenderer.seekedTo as number) > 0,
    '超大文件 seek 后 currentTime 落在预期位置',
    hugeRenderer.seekedTo,
  )

  return { passed, failed }
}
