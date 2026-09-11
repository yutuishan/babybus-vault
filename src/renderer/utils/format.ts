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
const AUDIO = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma']
const VIDEO = ['mp4', 'mov', 'mkv', 'avi', 'webm']
const PDF = ['pdf']
const OFFICE = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp']

export type PreviewKind =
  | 'image'
  | 'text'
  | 'markdown'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'office'
  | 'unknown'

export function previewKind(ext: string | undefined): PreviewKind {
  const e = (ext ?? '').toLowerCase()
  if (IMAGE.includes(e)) return 'image'
  if (MARKDOWN.includes(e)) return 'markdown'
  if (TEXT.includes(e)) return 'text'
  if (AUDIO.includes(e)) return 'audio'
  if (VIDEO.includes(e)) return 'video'
  if (PDF.includes(e)) return 'pdf'
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
  office: '文档',
  unknown: '文件',
}
