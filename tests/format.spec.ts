import { describe, expect, it } from 'vitest'
import { previewKind } from '../src/renderer/utils/format'
import { normalizeExt } from '../src/shared/media'

/**
 * 为什么单独盯 previewKind 的扩展名归一化：
 * 它曾经只做 `toLowerCase()`，于是 ".PDF" 这种带前导点的写法会被判成 unknown，
 * 界面静默降级成"不支持预览"。当时 icons.spec.ts 只测了 fileIcon，
 * 而 fileIcon 自己先归一化了，于是把这个问题遮住了 —— 所以这里必须直接测 previewKind。
 */
describe('previewKind —— 扩展名归一化', () => {
  it('带前导点、大小写混写都能正确分类', () => {
    expect(previewKind('.PDF')).toBe('pdf')
    expect(previewKind('PDF')).toBe('pdf')
    expect(previewKind('Pdf')).toBe('pdf')
    expect(previewKind('.Mp4')).toBe('video')
    expect(previewKind('.PNG')).toBe('image')
  })

  it('归一化结果与共享的 normalizeExt 一致（不许自己另写一套）', () => {
    const samples = ['.PDF', 'PDF', 'Mp4', 'xlsx', 'tar.gz', '', undefined, 'zzz']
    for (const s of samples) {
      // 用归一化后的值去查，结果必须和不归一化时完全一样 —— 即 previewKind 内部
      // 确实走了 normalizeExt，而不是"碰巧"对小写输入正确
      expect(previewKind(s), String(s)).toBe(previewKind(normalizeExt(s)))
    }
  })

  it('缺失或空扩展名一律是 unknown，不能抛异常', () => {
    expect(previewKind(undefined)).toBe('unknown')
    expect(previewKind('')).toBe('unknown')
    expect(previewKind('.')).toBe('unknown')
    expect(previewKind('zzz')).toBe('unknown')
  })

  it('每一类都有代表扩展名，且互不串味', () => {
    const cases: [string, string][] = [
      ['png', 'image'],
      ['txt', 'text'],
      ['md', 'markdown'],
      ['mp3', 'audio'],
      ['mp4', 'video'],
      ['pdf', 'pdf'],
      ['docx', 'docx'],
      ['doc', 'doc'],
      ['xlsx', 'sheet'],
      ['pptx', 'slides'],
      ['ppt', 'office'],
    ]
    for (const [ext, kind] of cases) {
      expect(previewKind(ext), ext).toBe(kind)
    }
  })

  it('json/xml/yml 仍归为 text —— icons.ts 依赖这条契约把代码图标抢在前面', () => {
    // 如果哪天这里变成 code 之类的新分类，icons.ts 里 CODE 必须先判的顺序假设就失效了
    expect(previewKind('json')).toBe('text')
    expect(previewKind('yaml')).toBe('text')
    expect(previewKind('xml')).toBe('text')
  })
})
