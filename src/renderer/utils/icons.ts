/**
 * 文件树里节点名前那个小图标。
 *
 * 为什么单独抽一个模块：这个图标要在好几处保持一致（树的节点、搜索结果、
 * 导入冲突列表、预览面板）。之前每处各写各的 `type === 'folder' ? '📁' : '📄'`，
 * 结果是**所有文件长得一模一样**，用户没法一眼区分 PDF、视频和表格。
 *
 * 取值策略：先按"预览分类"（复用 previewKind，保证"图标说的是什么"和
 * "点开能预览什么"永远一致），再补两类 previewKind 不认、但用户经常见的格式
 * —— 代码/配置和压缩包。它们预览时按纯文本走，图标却应该有自己的样子。
 */
import { normalizeExt } from '@shared/media'
import { previewKind } from './format'

/** 代码与配置文件。注意 json/xml/yml 这些在 previewKind 里算 text，这里要抢在它前面判 */
const CODE = [
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'vue',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'lua',
  'pl',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'json',
  'json5',
  'xml',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'env',
]

/** 压缩包 —— 库里很常见，且预览一定打不开，图标上先给个预期 */
const ARCHIVE = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']

/** 预览分类 → 图标。键是 PreviewKind，缺的键落到下面的兜底 */
const BY_KIND: Record<string, string> = {
  image: '🖼️',
  video: '🎬',
  audio: '🎵',
  pdf: '📕',
  docx: '📘',
  doc: '📘',
  sheet: '📗',
  slides: '📙',
  markdown: '📝',
  text: '📄',
  office: '📊',
}

/**
 * 取节点图标。
 *
 * @param node 只需要 type / ext 两个字段，TreeNode 和 NodeView 都能直接传
 */
export function fileIcon(node: { type?: string; ext?: string }): string {
  if (node.type === 'folder') return '📁'
  const ext = normalizeExt(node.ext)
  if (CODE.includes(ext)) return '📜'
  if (ARCHIVE.includes(ext)) return '🗜️'
  return BY_KIND[previewKind(ext)] ?? '📎'
}
