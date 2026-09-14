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
  vaultReload: 'vault:reload',
  vaultCreateFolder: 'vault:folder:create',
  vaultRename: 'vault:rename',
  vaultRemove: 'vault:remove',
  vaultMove: 'vault:move',
  vaultSearch: 'vault:search',
  vaultSearchContent: 'vault:search:content',
  vaultImport: 'vault:import',
  vaultScanImport: 'vault:import:scan',
  vaultExport: 'vault:export',
  vaultReadFile: 'vault:read',
  vaultExtractText: 'vault:text:extract',
  vaultChangePassword: 'vault:password:change',
  vaultGetHint: 'vault:hint:get',
  vaultSetHint: 'vault:hint:set',
  /** 读提示语，不需要解锁 —— 锁屏界面用 */
  vaultPeekHint: 'vault:hint:peek',

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
  /** 自动锁定分钟数。恒 > 0 —— 没有「从不」这一档，见 config.ts 的归一化逻辑 */
  autoLockMinutes: number
  lockOnSuspend: boolean
  theme: ThemeMode
  /** 界面字体缩放，1 为默认。0.85 / 1 / 1.15 / 1.3 */
  fontScale: number
  /** 是否已经看过新手引导。仅首次启动自动弹出，之后只从工具栏进入 */
  guideSeen: boolean
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
  /**
   * 主密码提示语。仅解锁状态下有值 —— 它存在加密的 manifest 里，
   * 锁着的时候主进程自己也读不出来（密钥已清空）。
   */
  hint: string | null
}

export interface OpenResult {
  ok: true
  state: VaultState
  nodes: NodeView[]
}

export interface ImportResult {
  imported: number
  /** 新建的文件夹数量（合并进已有同名目录的不算） */
  folders: number
  failed: { path: string; reason: string }[]
}

/**
 * 导入重名时的处理策略。
 *
 * - `overwrite`：同名文件用新的替换掉旧的（旧密文直接从磁盘删除）；同名文件夹则合并进去。
 * - `keep-both`：保留两者，新来的自动改名成 `名字 (2).ext` / `名字 (2)`，两边都能找到。
 *
 * 刻意不做成"自动选一个"：这两种语义差别很大（一种是丢数据、一种是留冗余），
 * 只能由用户在看清冲突清单后决定。
 */
export type ImportConflictPolicy = 'overwrite' | 'keep-both'

export interface ImportConflict {
  /** 带相对路径的显示名，便于分辨是哪一个，如 "照片/2024" */
  name: string
  /** 即将导入的是文件还是文件夹 */
  kind: 'file' | 'folder'
  /** 文件库里已存在的是文件还是文件夹（类型不同也属于冲突） */
  existingType: 'file' | 'folder'
}

/** 导入前的预扫描结果：让用户在动手之前就知道会发生什么 */
export interface ImportScanResult {
  /** 将要导入的文件总数 */
  files: number
  /** 将要导入的文件夹总数 */
  folders: number
  /** 与库里已有项重名的条目（含嵌套层级） */
  conflicts: ImportConflict[]
  /** 因为超过大小上限等原因注定失败的条目数，提前告知 */
  oversized: number
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
  create(
    dir: string,
    password: string,
    hint?: string,
  ): Promise<Result<{ state: VaultState; nodes: NodeView[] }>>
  open(dir: string, password: string): Promise<Result<{ state: VaultState; nodes: NodeView[] }>>
  lock(): Promise<void>
  state(): Promise<VaultState>
  list(): Promise<NodeView[]>
  /** 重新从磁盘读 manifest 并返回最新状态与目录树（「刷新文件库」） */
  reload(): Promise<Result<{ state: VaultState; nodes: NodeView[] }>>
  createFolder(parentId: string | null, name: string): Promise<Result<NodeView>>
  rename(id: string, name: string): Promise<Result<null>>
  /** 单个或批量删除，返回删除的节点总数 */
  remove(ids: string | string[]): Promise<Result<number>>
  move(id: string, parentId: string | null): Promise<Result<null>>
  search(keyword: string): Promise<NodeView[]>
  /** 全文检索文本类文件内容，仅解锁状态下可用 */
  searchContent(keyword: string): Promise<Result<ContentMatch[]>>
  importPaths(
    parentId: string | null,
    paths: string[],
    policy?: ImportConflictPolicy,
  ): Promise<Result<ImportResult>>
  /** 导入前预扫描：统计文件/文件夹数量，并列出与库中重名的条目 */
  scanImport(parentId: string | null, paths: string[]): Promise<Result<ImportScanResult>>
  exportNodes(ids: string[]): Promise<Result<ExportResult>>
  readFile(id: string): Promise<Result<Uint8Array>>
  /** 旧版 doc 的文本提取预览：解密与解析都在主进程，渲染端只拿纯文本 */
  extractText(id: string): Promise<Result<string>>
  changePassword(oldPassword: string, newPassword: string): Promise<Result<null>>
  /** 读取主密码提示语（仅解锁状态可用） */
  getHint(): Promise<Result<string>>
  /** 读取主密码提示语（**不需要解锁**）—— 锁屏界面与解锁界面用 */
  peekHint(dir: string): Promise<Result<string>>
  /** 设置/清除主密码提示语（仅解锁状态可用） */
  setHint(hint: string): Promise<Result<null>>

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
