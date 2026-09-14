/**
 * 全局状态。刻意用模块级单例而不是 pinia —— 整个应用只有一份文件库会话，
 * 引入状态管理库只会增加体积和攻击面。
 */
import { computed, reactive } from 'vue'
import type { AppConfig, ContentMatch, ImportConflictPolicy, VaultState } from '@shared/ipc'
import type { NodeView } from '@shared/types'

export type Phase = 'gate' | 'setup' | 'unlock' | 'main'

export type PickResult =
  | { status: 'cancelled' }
  | { status: 'ok' }
  | { status: 'already-vault'; dir: string }
  | { status: 'not-vault'; dir: string }

const emptyState: VaultState = {
  open: false,
  dir: null,
  name: null,
  kdf: null,
  kdfImpl: null,
  nodeCount: 0,
  fileCount: 0,
  totalSize: 0,
  recoveredFromBackup: false,
  hint: null,
}

const state = reactive({
  phase: 'gate' as Phase,
  /** 用户选中的文件库目录。锁定后仍需保留，解锁时要用 */
  dir: '' as string,
  vault: { ...emptyState } as VaultState,
  nodes: [] as NodeView[],
  locked: false,
  lockReason: '' as string,
  busy: false,
  selectedId: null as string | null,
  /** 多选集合（Ctrl/Shift 点击累积）。selectedId 始终是最后点击的节点 */
  selectedIds: new Set<string>() as Set<string>,
  expanded: new Set<string>() as Set<string>,
  search: '' as string,
  /** 全文搜索结果（文件内容命中） */
  contentMatches: [] as ContentMatch[],
  contentSearching: false,
  countdown: Number.POSITIVE_INFINITY as number,
  config: null as AppConfig | null,
  maximized: false,
})

/** 主题与字体缩放应用在根元素上，所有组件只认变量 */
function applyAppearance(cfg: AppConfig): void {
  document.documentElement.dataset.theme = cfg.theme === 'dark' ? 'dark' : 'light'
  document.documentElement.style.setProperty('--font-scale', String(cfg.fontScale ?? 1))
}

function setNodes(nodes: NodeView[]) {
  state.nodes = nodes
}

function applyOpened(dir: string, v: VaultState, nodes: NodeView[]) {
  state.dir = dir
  state.vault = v
  setNodes(nodes)
  state.locked = false
  state.lockReason = ''
  state.phase = 'main'
  state.selectedId = null
  state.selectedIds.clear()
  state.search = ''
  state.contentMatches = []
}

export function useVault() {
  async function loadConfig(): Promise<AppConfig> {
    state.config = await window.api.configGet()
    applyAppearance(state.config)
    return state.config
  }

  /**
   * 自动化测试用的状态入口。
   *
   * 端到端探针需要把界面直接推到「已解锁的主界面」，而真实路径上
   * 「打开文件库」会弹一个原生目录对话框（无法自动化点击）。
   * 这里只暴露 state 本身，不暴露任何密钥或文件内容 ——
   * 拿到它也只能改相位，造不出一个能解密的会话。
   */
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __vaultState?: typeof state }).__vaultState = state
  }

  async function patchConfig(patch: Partial<AppConfig>): Promise<void> {
    // 展开成普通对象：patch 可能来自模板表达式或响应式对象，Proxy 无法跨 IPC 克隆
    state.config = await window.api.configSet({ ...patch })
    applyAppearance(state.config)
  }

  /** 新建：选目录。若该目录已是文件库，直接拦下并提示改用「打开」 */
  async function pickForCreate(): Promise<PickResult> {
    const dir = await window.api.pickDirectory({ title: '选择新建文件库的位置' })
    if (!dir) return { status: 'cancelled' }
    const probe = await window.api.probe(dir)
    if (probe.isVault) {
      // 放在这里拦下：在这个目录新建会覆盖 vault.meta，原数据将永久解不开
      return { status: 'already-vault', dir }
    }
    state.dir = dir
    state.phase = 'setup'
    return { status: 'ok' }
  }

  async function pickForOpen(): Promise<PickResult> {
    const dir = await window.api.pickDirectory({ title: '选择已有的文件库文件夹' })
    if (!dir) return { status: 'cancelled' }
    const probe = await window.api.probe(dir)
    if (!probe.isVault) {
      return { status: 'not-vault', dir }
    }
    state.dir = dir
    state.phase = 'unlock'
    return { status: 'ok' }
  }

  async function createVault(password: string, hint = ''): Promise<string | null> {
    state.busy = true
    try {
      const res = await window.api.create(state.dir, password, hint)
      if (!res.ok) return res.error
      applyOpened(state.dir, res.data.state, res.data.nodes)
      await loadConfig()
      return null
    } finally {
      state.busy = false
    }
  }

  async function openVault(password: string): Promise<string | null> {
    state.busy = true
    try {
      const res = await window.api.open(state.dir, password)
      if (!res.ok) return res.error
      applyOpened(state.dir, res.data.state, res.data.nodes)
      await loadConfig()
      if (res.data.state.recoveredFromBackup) {
        // 交给调用方提示，避免这里耦合 UI
        return 'RECOVERED'
      }
      return null
    } finally {
      state.busy = false
    }
  }

  async function lock(): Promise<void> {
    await window.api.lock()
    state.locked = true
    state.nodes = []
    state.vault = { ...emptyState }
    state.selectedId = null
    state.selectedIds.clear()
    state.contentMatches = []
    window.api.heartbeat()
  }

  /** 剔除已经不存在的选择。不清的话右侧预览会一直停在旧内容上 */
  function pruneSelection(): void {
    const alive = new Set(state.nodes.map((n) => n.id))
    for (const id of [...state.selectedIds]) {
      if (!alive.has(id)) state.selectedIds.delete(id)
    }
    if (state.selectedId && !alive.has(state.selectedId)) {
      state.selectedId = null
    }
  }

  /**
   * 刷新文件库。
   *
   * 走 reload 而不是 state+list：后两者只是把主进程内存里那份目录树再取一遍，
   * 磁盘被外部改动（同步盘回写、手动替换 manifest）时永远看不到变化。
   * reload 会真的重读 manifest.enc；读失败时主进程保持原状态，这里把错误交给调用方。
   */
  async function refresh(): Promise<string | null> {
    const res = await window.api.reload()
    if (!res.ok) return res.error
    state.vault = res.data.state
    setNodes(res.data.nodes)
    pruneSelection()
    return null
  }

  function markLocked(reason: string): void {
    state.locked = true
    state.lockReason = reason
    state.nodes = []
    state.vault = { ...emptyState }
    state.selectedId = null
    state.selectedIds.clear()
    state.contentMatches = []
  }

  /** 回到文件库选择界面（不锁定，先锁后切） */
  async function closeVault(): Promise<void> {
    if (state.vault.open) await window.api.lock()
    state.phase = 'gate'
    state.dir = ''
    state.locked = false
    state.nodes = []
    state.vault = { ...emptyState }
    state.selectedId = null
    state.selectedIds.clear()
    state.contentMatches = []
  }

  async function createFolder(parentId: string | null, name: string): Promise<string | null> {
    const res = await window.api.createFolder(parentId, name)
    if (!res.ok) return res.error
    if (parentId) state.expanded.add(parentId)
    await refresh()
    return null
  }

  async function rename(id: string, name: string): Promise<string | null> {
    const res = await window.api.rename(id, name)
    if (!res.ok) return res.error
    await refresh()
    return null
  }

  async function remove(ids: string[]): Promise<string | null> {
    if (!ids.length) return null
    // 关键：Vue 的响应式数组是 Proxy，跨 contextBridge 时无法结构化克隆
    //（报 "An object could not be cloned."，表现为「删除点了没反应」）。
    // 必须在这里还原成普通数组再送 IPC。
    const plain = Array.from(ids, (id) => String(id))
    const res = await window.api.remove(plain)
    if (!res.ok) return res.error
    for (const id of plain) {
      if (state.selectedId === id) state.selectedId = null
      state.selectedIds.delete(id)
    }
    await refresh()
    return null
  }

  /** 全文检索：搜索文本类文件的内容。失败返回错误文案 */
  async function searchContent(keyword: string): Promise<string | null> {
    const kw = keyword.trim()
    if (!kw) {
      state.contentMatches = []
      return null
    }
    state.contentSearching = true
    try {
      const res = await window.api.searchContent(kw)
      if (!res.ok) return res.error
      state.contentMatches = res.data
      return null
    } finally {
      state.contentSearching = false
    }
  }

  /**
   * 移动一个或多个节点到目标目录（null = 根目录）。
   * 批量时主进程用 runBatch 合并成一次落盘，见 handlers 的 vaultMove。
   */
  async function move(ids: string | string[], parentId: string | null): Promise<string | null> {
    // 同 remove：响应式数组是 Proxy，过 contextBridge 会抛 "could not be cloned"
    const list = Array.from(Array.isArray(ids) ? ids : [ids], (id) => String(id))
    const res = await window.api.move(list, parentId)
    if (parentId) state.expanded.add(parentId)
    // 失败也刷新：批量移动可能只应用了一部分（主进程 runBatch 会把已应用的改动落盘），
    // 不刷新界面就会和磁盘上的真实状态对不上。
    const refreshErr = await refresh()
    if (!res.ok) return res.error
    return refreshErr
  }

  /**
   * 导入文件与文件夹。
   *
   * policy 决定同名项怎么处理：overwrite 覆盖、keep-both 改名保留两者。
   * 缺省 keep-both —— 不会丢数据的那一侧。
   */
  async function importPaths(
    parentId: string | null,
    paths: string[],
    policy: ImportConflictPolicy = 'keep-both',
  ) {
    // 同 remove：路径数组可能来自响应式上下文，先还原成普通数组
    const res = await window.api.importPaths(
      parentId,
      Array.from(paths, (p) => String(p)),
      policy,
    )
    if (res.ok) await refresh()
    return res
  }

  /** 导入前预扫描：统计规模并列出与库中重名的条目 */
  async function scanImport(parentId: string | null, paths: string[]) {
    return window.api.scanImport(parentId, Array.from(paths, (p) => String(p)))
  }

  async function exportNodes(ids: string[]) {
    // 导出走的是多选集合，同样是响应式来源，必须去代理
    const res = await window.api.exportNodes(Array.from(ids, (id) => String(id)))
    return res
  }

  const tree = computed(() => state.nodes)
  const selected = computed(() => state.nodes.find((n) => n.id === state.selectedId) ?? null)
  const filtered = computed(() => {
    const kw = state.search.trim().toLowerCase()
    if (!kw) return []
    return state.nodes.filter((n) => n.name.toLowerCase().includes(kw))
  })

  return {
    state,
    tree,
    selected,
    filtered,
    loadConfig,
    patchConfig,
    pickForCreate,
    pickForOpen,
    createVault,
    openVault,
    lock,
    refresh,
    markLocked,
    closeVault,
    createFolder,
    rename,
    remove,
    move,
    searchContent,
    importPaths,
    scanImport,
    exportNodes,
  }
}
