/**
 * 音视频格式表 —— 主进程与渲染进程共用同一份。
 *
 * 为什么必须共用：主进程的 `vault://` 流式协议要靠它决定 Content-Type，
 * 渲染进程要靠它决定「这个文件该用 <audio> 还是 <video> 打开」。
 * 两边各写一份的话，一旦有一边漏了某个扩展名，表现就是
 * 「文件树认得它、预览面板却说不支持」，而且极难查。
 *
 * 关于列表的取舍：这里收录的是**容器格式**，不是编码格式。
 * Chromium 能不能真的放出来，取决于容器里的编码（例如 mkv 里塞 H.265 就放不了），
 * 这一点没法在扩展名层面判断 —— 所以列表取宽，遇到解不了的编码由 <video>/<audio>
 * 的 error 事件兜底，界面给出「导出后用本地播放器打开」的提示。
 */

/** 音频扩展名（小写、不带点） */
export const AUDIO_EXTS = [
  'mp3',
  'wav',
  'aac',
  'flac',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'wma',
  'aiff',
  'aif',
  'ape',
  'amr',
]

/** 视频扩展名（小写、不带点） */
export const VIDEO_EXTS = [
  'mp4',
  'm4v',
  'mov',
  'webm',
  'ogv',
  'mkv',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  '3gp',
]

/** 扩展名 → MIME。给 <video>/<audio> 与流式协议响应用 */
const MIME: Record<string, string> = {
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  ape: 'audio/x-ape',
  amr: 'audio/amr',
  // 视频
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  '3gp': 'video/3gpp',
}

export function normalizeExt(ext: string | undefined): string {
  return (ext ?? '').toLowerCase().replace(/^\./, '')
}

export function isAudioExt(ext: string | undefined): boolean {
  return AUDIO_EXTS.includes(normalizeExt(ext))
}

export function isVideoExt(ext: string | undefined): boolean {
  return VIDEO_EXTS.includes(normalizeExt(ext))
}

export function isMediaExt(ext: string | undefined): boolean {
  return isAudioExt(ext) || isVideoExt(ext)
}

/** 未知扩展名退化成 application/octet-stream，让播放器自己嗅探 */
export function mediaMime(ext: string | undefined): string {
  return MIME[normalizeExt(ext)] ?? 'application/octet-stream'
}
