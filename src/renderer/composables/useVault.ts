/**
 * 全局状态。刻意用模块级单例而不是 pinia —— 整个应用只有一份文件库会话，
 * 引入状态管理库只会增加体积和攻击面。
 */
import { computed, reactive } from 'vue'
import type { AppConfig, ContentMatch, VaultState } from '@shared/ipc'
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

  async function patchConfig(patch: Partial<AppConfig>): Promise<void> {
    state.config = await window.api.configSet(patch)
    applyAppearance(state.config)
  }

  /** 新建：选目录。若该目录已是文件库，直接拦下并提示改用「打开」 */
  async function pickForCreate(): Promise<boolean> {
    const dir = await window.api.pickDirectory({ title: '选择新建文件库的位置' })
    if (!dir) return false
    const probe = await window.api.probe(dir)
    if (probe.isVault) {
      return { alreadyVault: true, dir } as unknown as boolean
    }
    state.dir = dir
    state.phase = 'setup'
    return true
  }

  async function pickForOpen(): Promise<boolean> {
    const dir = await window.api.pickDirectory({ title: '选择已有的文件库文件夹' })
    if (!dir) return false
    const probe = await window.api.probe(dir)
    if (!probe.isVault) {
      return { notVault: true, dir } as unknown as boolean
    }
    state.dir = dir
    state.phase = 'unlock'
    return true
  }

  async function createVault(password: string): Promise<string | null> {
    state.busy = true
    try {
      const res = await window.api.create(state.dir, password)
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

  async function refresh(): Promise<void> {
    const [v, nodes] = await Promise.all([window.api.state(), window.api.list()])
    state.vault = v
    setNodes(nodes)
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
    const res = await window.api.remove(ids)
    if (!res.ok) return res.error
    for (const id of ids) {
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

  async function move(id: string, parentId: string | null): Promise<string | null> {
    const res = await window.api.move(id, parentId)
    if (!res.ok) return res.error
    if (parentId) state.expanded.add(parentId)
    await refresh()
    return null
  }

  async function importPaths(parentId: string | null, paths: string[]) {
    const res = await window.api.importPaths(parentId, paths)
    if (res.ok) await refresh()
    return res
  }

  async function exportNodes(ids: string[]) {
    const res = await window.api.exportNodes(ids)
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
    exportNodes,
  }
}
