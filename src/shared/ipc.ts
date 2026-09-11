/** 主进程与渲染进程之间的通道名与载荷类型。两端共用，避免字符串写错。 */
import type { NodeView } from './types'

export const CH = {
  appConfigGet: 'app:config:get',
  appConfigSet: 'app:config:set',
  appPickDirectory: 'app:pick:directory',
  appPickFiles: 'app:pick:files',
  appOpenExternal: 'app:open:external',
  appVersion: 'app:version',

  vaultProbe: 'vault:probe',
  vaultCreate: 'vault:create',
  vaultOpen: 'vault:open',
  vaultLock: 'vault:lock',
  vaultState: 'vault:state',
  vaultList: 'vault:list',
  vaultCreateFolder: 'vault:folder:create',
  vaultRename: 'vault:rename',
  vaultRemove: 'vault:remove',
  vaultMove: 'vault:move',
  vaultSearch: 'vault:search',
  vaultSearchContent: 'vault:search:content',
  vaultImport: 'vault:import',
  vaultExport: 'vault:export',
  vaultReadFile: 'vault:read',
  vaultChangePassword: 'vault:password:change',

  autoLockHeartbeat: 'autolock:heartbeat',
  autoLockTick: 'autolock:tick',
  vaultLockedEvent: 'vault:locked',

  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
} as const

// ---------------------------------------------------------------- 配置

export type ThemeMode = 'light' | 'dark'

export interface AppConfig {
  /** 0 表示从不自动锁定 */
  autoLockMinutes: number
  lockOnSuspend: boolean
  theme: ThemeMode
  /** 界面字体缩放，1 为默认。0.85 / 1 / 1.15 / 1.3 */
  fontScale: number
}

// ---------------------------------------------------------------- 请求/响应

export interface ProbeResult {
  exists: boolean
  isVault: boolean
  writable: boolean
}

export interface VaultState {
  open: boolean
  dir: string | null
  name: string | null
  kdf: string | null
  kdfImpl: string | null
  nodeCount: number
  fileCount: number
  totalSize: number
  recoveredFromBackup: boolean
}

export interface OpenResult {
  ok: true
  state: VaultState
  nodes: NodeView[]
}

export interface ImportResult {
  imported: number
  skipped: number
  failed: { path: string; reason: string }[]
}

export interface ExportResult {
  exported: number
  destDir: string
}

export interface ContentMatch {
  id: string
  name: string
  /** 命中上下文片段（已脱敏为纯文本） */
  snippet: string
  hits: number
}

/** 统一的结果包装。ok=false 时 error 一定是用户可读的中文提示。 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export interface PickDirectoryOptions {
  title?: string
  /** 对话框的起始目录 */
  defaultPath?: string
}

export interface PickFilesOptions {
  title?: string
  /** true 时允许选中文件夹（用于整目录导入） */
  includeDirectories?: boolean
}

export interface PickedEntry {
  path: string
  name: string
  isDirectory: boolean
}

/** preload 暴露给渲染进程的 API 表面 */
export interface VaultBridge {
  appVersion(): Promise<string>
  configGet(): Promise<AppConfig>
  configSet(patch: Partial<AppConfig>): Promise<AppConfig>
  pickDirectory(opts?: PickDirectoryOptions): Promise<string | null>
  pickFiles(opts?: PickFilesOptions): Promise<PickedEntry[]>
  openExternal(url: string): Promise<void>

  probe(dir: string): Promise<ProbeResult>
  create(dir: string, password: string): Promise<Result<{ state: VaultState; nodes: NodeView[] }>>
  open(dir: string, password: string): Promise<Result<{ state: VaultState; nodes: NodeView[] }>>
  lock(): Promise<void>
  state(): Promise<VaultState>
  list(): Promise<NodeView[]>
  createFolder(parentId: string | null, name: string): Promise<Result<NodeView>>
  rename(id: string, name: string): Promise<Result<null>>
  /** 单个或批量删除，返回删除的节点总数 */
  remove(ids: string | string[]): Promise<Result<number>>
  move(id: string, parentId: string | null): Promise<Result<null>>
  search(keyword: string): Promise<NodeView[]>
  /** 全文检索文本类文件内容，仅解锁状态下可用 */
  searchContent(keyword: string): Promise<Result<ContentMatch[]>>
  importPaths(parentId: string | null, paths: string[]): Promise<Result<ImportResult>>
  exportNodes(ids: string[]): Promise<Result<ExportResult>>
  readFile(id: string): Promise<Result<Uint8Array>>
  changePassword(oldPassword: string, newPassword: string): Promise<Result<null>>

  heartbeat(): void
  /** 主进程推送锁定事件，reason 为 idle / suspend / system-lock / manual */
  onLocked(cb: (reason: string) => void): () => void
  /** 主进程推送倒计时（秒），用于状态栏 */
  onCountdown(cb: (secondsLeft: number) => void): () => void
  onMaximizedChange(cb: (maximized: boolean) => void): () => void
  /** 从系统拖入的文件路径（渲染进程拿不到 path，必须由主进程解析） */
  resolveDropPaths(files: File[]): Promise<string[]>

  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>
}

declare global {
  interface Window {
    api: VaultBridge
  }
}
