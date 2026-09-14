/**
 * CSP 有**两份**：src/renderer/index.html 里的 <meta http-equiv>，
 * 和 src/main/index.ts 里 applySecurityHeaders() 写进响应头的那份。
 * 浏览器对同一个文档会同时执行两份策略，任何一份不通过就拒绝加载。
 *
 * 2026-09-14 踩过这个坑：`vault:` 只加进了响应头那份，meta 那份没跟上，
 * 于是所有音视频（连 mp3/mp4 这种铁定支持的格式）全被拦下，播放器只报
 * "Media load rejected by URL safety check"，看起来像"内核不支持编码"。
 *
 * 这个测试把两份策略钉在一起：只改一份而另一份没跟上，测试立刻红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** 把 "a x y; b z" 解析成 { a: [x,y], b: [z] }，token 排序以便稳定比较 */
function parse(policy: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const name = tokens.shift()
    if (!name) continue
    map.set(name, tokens.sort())
  }
  return map
}

/** 取自 src/renderer/index.html 的 CSP meta */
function htmlCsp(): string {
  const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')
  const m = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html)
  if (!m?.[1]) throw new Error('index.html 里找不到 CSP meta')
  return m[1]
}

/** 取自 src/main/index.ts 的 `const CSP = [ ... ].join('; ')` */
function headerCsp(): string {
  const ts = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const block = /const CSP = \[([\s\S]*?)\]\.join/.exec(ts)
  if (!block?.[1]) throw new Error('index.ts 里找不到 CSP 数组')
  const parts = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  if (!parts.length) throw new Error('CSP 数组解析出来是空的')
  return parts.join('; ')
}

describe('两份 CSP 必须保持同步', () => {
  it('index.html 的 meta 与 index.ts 的响应头逐条相同', () => {
    expect(parse(htmlCsp())).toEqual(parse(headerCsp()))
  })

  it('两份都放行 vault: 音视频通道', () => {
    for (const [label, policy] of [
      ['index.html', htmlCsp()],
      ['index.ts', headerCsp()],
    ] as const) {
      const media = parse(policy).get('media-src') ?? []
      expect(media, `${label} 的 media-src`).toContain('vault:')
      expect(media, `${label} 的 media-src`).toContain("'self'")
      expect(media, `${label} 的 media-src`).toContain('blob:')
    }
  })

  it('connect-src 不含 vault: —— 音视频只该走媒体通道，不该能被 fetch 读走', () => {
    for (const policy of [htmlCsp(), headerCsp()]) {
      expect(parse(policy).get('connect-src') ?? []).not.toContain('vault:')
    }
  })

  it('零网络约束仍然成立：没有任何 http/https 来源被放行', () => {
    for (const policy of [htmlCsp(), headerCsp()]) {
      for (const [, sources] of parse(policy)) {
        for (const src of sources) {
          expect(src).not.toMatch(/^https?:/)
        }
      }
    }
  })
})
