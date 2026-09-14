import { describe, expect, it } from 'vitest'
import { fileIcon } from '../src/renderer/utils/icons'

describe('fileIcon —— 文件树节点前的类型图标', () => {
  it('文件夹永远用文件夹图标', () => {
    expect(fileIcon({ type: 'folder' })).toBe('📁')
    // 文件夹没有 ext，绝不能因为 ext 为空就掉进"未知文件"分支
    expect(fileIcon({ type: 'folder', ext: undefined })).toBe('📁')
    expect(fileIcon({ type: 'folder', ext: '' })).toBe('📁')
  })

  it('主要文档类型两两不同 —— 这正是这个功能存在的意义', () => {
    const exts = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'mp4', 'mp3', 'md', 'txt']
    const icons = exts.map((ext) => fileIcon({ type: 'file', ext }))
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('同一分类下的不同扩展名共用一个图标', () => {
    expect(fileIcon({ type: 'file', ext: 'jpg' })).toBe(fileIcon({ type: 'file', ext: 'png' }))
    expect(fileIcon({ type: 'file', ext: 'doc' })).toBe(fileIcon({ type: 'file', ext: 'docx' }))
    expect(fileIcon({ type: 'file', ext: 'm4a' })).toBe(fileIcon({ type: 'file', ext: 'mp3' }))
    expect(fileIcon({ type: 'file', ext: 'xls' })).toBe(fileIcon({ type: 'file', ext: 'xlsx' }))
  })

  it('扩展名的大小写与前导点都能吃', () => {
    const pdf = fileIcon({ type: 'file', ext: 'pdf' })
    expect(fileIcon({ type: 'file', ext: '.PDF' })).toBe(pdf)
    expect(fileIcon({ type: 'file', ext: 'Pdf' })).toBe(pdf)
  })

  it('代码/配置与压缩包有独立图标，不和纯文本混淆', () => {
    const code = fileIcon({ type: 'file', ext: 'ts' })
    const archive = fileIcon({ type: 'file', ext: 'zip' })
    const text = fileIcon({ type: 'file', ext: 'txt' })
    expect(code).not.toBe(text)
    expect(archive).not.toBe(text)
    expect(code).not.toBe(archive)
    // json 在 previewKind 里算 text，但图标应当按代码给 —— 顺序不能反
    expect(fileIcon({ type: 'file', ext: 'json' })).toBe(code)
    expect(fileIcon({ type: 'file', ext: 'yaml' })).toBe(code)
  })

  it('未知扩展名和没有扩展名都有兜底图标', () => {
    expect(fileIcon({ type: 'file', ext: 'zzz' })).toBe('📎')
    expect(fileIcon({ type: 'file' })).toBe('📎')
    expect(fileIcon({ type: 'file', ext: '' })).toBe('📎')
  })

  it('图标和"能不能预览"同源：previewKind 认得出的，图标一定不是兜底图标', () => {
    const exts = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'mp4', 'mp3', 'md', 'txt', 'doc', 'ppt']
    for (const ext of exts) {
      expect(fileIcon({ type: 'file', ext }), ext).not.toBe('📎')
    }
  })
})
