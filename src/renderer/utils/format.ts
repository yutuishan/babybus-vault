/** 音视频扩展名表与主进程共用一份，避免"文件树认得、预览说不支持"这类不一致 */
import { AUDIO_EXTS as AUDIO, VIDEO_EXTS as VIDEO, normalizeExt } from '@shared/media'

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 倒计时显示：超过 1 小时显示 HH:MM:SS */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds)) return '从不'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

const IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'avif']
const TEXT = ['txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf']
const MARKDOWN = ['md', 'markdown', 'mdown']
const PDF = ['pdf']
const DOCX = ['docx']
/** 旧版 Word 二进制格式：mammoth 不支持，走主进程 word-extractor 提取纯文本预览 */
const DOC = ['doc']
const SHEET = ['xlsx', 'xls']
const SLIDES = ['pptx']
const OFFICE = ['ppt', 'odt', 'ods', 'odp']

export type PreviewKind =
  | 'image'
  | 'text'
  | 'markdown'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'office'
  | 'unknown'

export function previewKind(ext: string | undefined): PreviewKind {
  // 走共享的 normalizeExt（去前导点 + 转小写），不要自己写 toLowerCase。
  // 目前 manifest 存的 ext 已经是不带点的小写形式，所以两种写法结果一样；
  // 但只要有人传进来一个 ".PDF"，只 toLowerCase 就会判成 unknown —— 静默降级成
  // "不支持预览"，很难查。icons.spec.ts 曾经因为这一点虚报过一次。
  const e = normalizeExt(ext)
  if (IMAGE.includes(e)) return 'image'
  if (MARKDOWN.includes(e)) return 'markdown'
  if (TEXT.includes(e)) return 'text'
  if (AUDIO.includes(e)) return 'audio'
  if (VIDEO.includes(e)) return 'video'
  if (PDF.includes(e)) return 'pdf'
  if (DOCX.includes(e)) return 'docx'
  if (DOC.includes(e)) return 'doc'
  if (SHEET.includes(e)) return 'sheet'
  if (SLIDES.includes(e)) return 'slides'
  if (OFFICE.includes(e)) return 'office'
  return 'unknown'
}

export const PREVIEW_LABEL: Record<PreviewKind, string> = {
  image: '图片',
  text: '文本',
  markdown: 'Markdown',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
  docx: 'Word',
  doc: 'Word 97-2003',
  sheet: 'Excel',
  slides: 'PPT',
  office: '旧版 Office',
  unknown: '文件',
}
