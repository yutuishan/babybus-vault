/**
 * 音视频扩展名表的回归测试。
 *
 * 用户报「支持流媒体文件（视频和音频）」，但当时其实只有一部分能用：
 *   - AUDIO/VIDEO 列表里写了 mkv / avi / mov / wma，`guessMime` 里却没有对应的 MIME，
 *     于是这些格式会拿到 application/octet-stream，播放器拒绝打开；
 *   - 两处列表还是分开维护的（渲染端一份、MIME 表一份），漏一个就出这种"认得但放不了"。
 *
 * 现在两边共用 src/shared/media.ts 这一份，这里钉住它们的一致性。
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_EXTS,
  VIDEO_EXTS,
  isAudioExt,
  isMediaExt,
  isVideoExt,
  mediaMime,
  normalizeExt,
} from '../src/shared/media'
import { previewKind } from '../src/renderer/utils/format'

describe('扩展名归一化', () => {
  it('大小写与前导点都能处理', () => {
    expect(normalizeExt('MP4')).toBe('mp4')
    expect(normalizeExt('.mkv')).toBe('mkv')
    expect(normalizeExt(undefined)).toBe('')
  })
})

describe('音视频判定', () => {
  it('常见音频被识别', () => {
    for (const ext of ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus']) {
      expect(isAudioExt(ext)).toBe(true)
    }
  })

  it('常见视频被识别（含以前漏掉的 mkv / avi / mov / wmv）', () => {
    for (const ext of ['mp4', 'mov', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'mpg', 'ts', '3gp']) {
      expect(isVideoExt(ext)).toBe(true)
    }
  })

  it('大小写不敏感', () => {
    expect(isVideoExt('MKV')).toBe(true)
    expect(isAudioExt('MP3')).toBe(true)
  })

  it('非音视频扩展名不会被误判', () => {
    for (const ext of ['txt', 'pdf', 'docx', 'xlsx', 'jpg', '']) {
      expect(isMediaExt(ext)).toBe(false)
    }
  })

  it('两个列表没有交集（同一个扩展名不能既算音频又算视频）', () => {
    const overlap = AUDIO_EXTS.filter((e) => VIDEO_EXTS.includes(e))
    expect(overlap).toEqual([])
  })
})

describe('MIME 映射', () => {
  it('列表里的每一个扩展名都有对应的 MIME，不会退化成 octet-stream', () => {
    // 这条是核心：以前 mkv / avi / mov / wma 就漏在这里
    const missing = [...AUDIO_EXTS, ...VIDEO_EXTS].filter(
      (ext) => mediaMime(ext) === 'application/octet-stream',
    )
    expect(missing).toEqual([])
  })

  it('MIME 前缀与分类一致', () => {
    for (const ext of AUDIO_EXTS) {
      expect(mediaMime(ext).startsWith('audio/')).toBe(true)
    }
    for (const ext of VIDEO_EXTS) {
      expect(mediaMime(ext).startsWith('video/')).toBe(true)
    }
  })

  it('未知扩展名退化成 octet-stream，交给播放器自己嗅探', () => {
    expect(mediaMime('xyz')).toBe('application/octet-stream')
    expect(mediaMime(undefined)).toBe('application/octet-stream')
  })

  it('几个关键格式的具体 MIME 正确', () => {
    expect(mediaMime('mp4')).toBe('video/mp4')
    expect(mediaMime('mkv')).toBe('video/x-matroska')
    expect(mediaMime('mov')).toBe('video/quicktime')
    expect(mediaMime('avi')).toBe('video/x-msvideo')
    expect(mediaMime('mp3')).toBe('audio/mpeg')
    expect(mediaMime('m4a')).toBe('audio/mp4')
    expect(mediaMime('wma')).toBe('audio/x-ms-wma')
  })
})

describe('预览分类与媒体表一致', () => {
  it('共享表里的音频扩展名，previewKind 都判成 audio', () => {
    for (const ext of AUDIO_EXTS) {
      expect(previewKind(ext)).toBe('audio')
    }
  })

  it('共享表里的视频扩展名，previewKind 都判成 video', () => {
    for (const ext of VIDEO_EXTS) {
      expect(previewKind(ext)).toBe('video')
    }
  })

  it('previewKind 对其他格式的判定没有被影响', () => {
    expect(previewKind('pdf')).toBe('pdf')
    expect(previewKind('xlsx')).toBe('sheet')
    expect(previewKind('xls')).toBe('sheet')
    expect(previewKind('docx')).toBe('docx')
    expect(previewKind('pptx')).toBe('slides')
    expect(previewKind('png')).toBe('image')
    expect(previewKind('md')).toBe('markdown')
  })
})
