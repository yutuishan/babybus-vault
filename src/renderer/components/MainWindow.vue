<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ImportConflictPolicy, ImportScanResult } from '@shared/ipc'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'
import { formatCountdown, formatSize } from '../utils/format'
import FileTree from './FileTree.vue'
import PreviewPane from './PreviewPane.vue'
import SettingsDialog from './SettingsDialog.vue'
import Onboarding from './Onboarding.vue'

const {
  state,
  lock,
  closeVault,
  importPaths,
  scanImport,
  exportNodes,
  remove,
  createFolder,
  move,
  searchContent,
  patchConfig,
  refresh,
} = useVault()
const toast = useToast()

const showSettings = ref(false)
const showGuide = ref(false)
const newFolderAt = ref<string | null>(null)
const treeCollapsed = ref(false)
const refreshing = ref(false)

/** 待删除的节点（单选或多选） */
const pendingDeleteIds = ref<string[] | null>(null)

const selected = computed(() => state.nodes.find((n) => n.id === state.selectedId) ?? null)

/**
 * 新建文件夹的落点：选中文件夹就建在它里面，选中文件就建在它同级，没选就建在根目录。
 * 这是"在当前上下文里新建"的直觉行为。
 */
const newFolderTarget = computed(() => {
  const node = selected.value
  if (!node) return null
  return node.type === 'folder' ? node.id : node.parentId
})

/* ---------------- 导入 ---------------- */

/**
 * 工具栏发起的导入一律落到**根目录**。
 *
 * 之前的规则是"选中文件夹就导进它、选中文件就导到同级"，结果用户常常没留意
 * 自己当前选中的是什么，文件被悄悄导进了某个子目录里，回头找不到。
 * 想导进指定目录，把文件直接拖到那个文件夹上就行（拖拽仍然按落点走，见 handledImport）。
 */
async function runImport(
  parentId: string | null,
  paths: string[],
  policy: ImportConflictPolicy,
): Promise<void> {
  const res = await importPaths(parentId, paths, policy)
  if (!res.ok) {
    toast.error(res.error)
    return
  }
  const { imported, folders, failed } = res.data
  const parts: string[] = []
  if (imported) parts.push(`${imported} 个文件`)
  if (folders) parts.push(`${folders} 个文件夹`)
  let msg = parts.length ? `已导入 ${parts.join('、')}` : '没有导入任何内容'
  if (failed.length) msg += `，${failed.length} 项失败`
  toast.ok(msg + '。原始文件默认保留，不会被删除。')
}

/**
 * 导入的统一入口：先扫描，再决定要不要问用户。
 *
 * 没有重名就直接导入（走 keep-both，不会丢数据）；有重名就把清单摆出来让用户选
 * 「覆盖」还是「保留两者」—— 这两种结果差别很大，不能替用户默默决定。
 */
async function startImport(parentId: string | null, paths: string[]): Promise<void> {
  if (!paths.length) return
  const res = await scanImport(parentId, paths)
  if (!res.ok) {
    toast.error(res.error)
    return
  }
  if (res.data.files === 0 && res.data.folders === 0) {
    toast.warn('没有可导入的内容')
    return
  }
  if (res.data.conflicts.length === 0) {
    await runImport(parentId, paths, 'keep-both')
    return
  }
  pendingImport.value = { parentId, paths, scan: res.data }
}

/**
 * 导入入口。工具栏上只有一个「导入」按钮，文件和文件夹在这个下拉里二选一。
 *
 * 为什么合成一个按钮、却仍然分成两次系统对话框调用：
 * 在 Windows 上，同一次 openFile 里同时带上 openDirectory，对话框会退化成
 * "只能选文件夹"，文件被置灰点不动 —— 用户看到的就是「导入不能选文件」。
 * 所以入口合并，底层仍保持两个独立的 picker，两边都正常。
 */
const importMenuOpen = ref(false)

async function pickImport(what: 'files' | 'folder') {
  importMenuOpen.value = false
  if (what === 'files') {
    const picked = await window.api.pickFiles({ title: '选择要导入的文件（可多选）' })
    if (!picked.length) return
    await startImport(null, picked.map((p) => p.path))
  } else {
    const dir = await window.api.pickDirectory({ title: '选择要导入的文件夹' })
    if (!dir) return
    await startImport(null, [dir])
  }
}

/** 重名冲突对话框：用户选完之后才真正写库 */
const pendingImport = ref<{
  parentId: string | null
  paths: string[]
  scan: ImportScanResult
} | null>(null)

async function onResolveImport(policy: ImportConflictPolicy) {
  const job = pendingImport.value
  pendingImport.value = null
  if (!job) return
  await runImport(job.parentId, job.paths, policy)
}

const conflictPreview = computed(() => pendingImport.value?.scan.conflicts.slice(0, 8) ?? [])
const conflictMore = computed(() =>
  Math.max(0, (pendingImport.value?.scan.conflicts.length ?? 0) - conflictPreview.value.length),
)

/* ---------------- 刷新 ---------------- */

/** 重新从磁盘读取文件库。与文件树里那个 ⟳ 是同一个动作，这里给一个更好找的入口 */
async function onRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const err = await refresh()
    if (err) toast.error(`刷新失败：${err}`)
    else toast.ok('已从磁盘重新读取文件库')
  } finally {
    refreshing.value = false
  }
}

async function onExport() {
  // 多选优先：批量导出选中的节点
  const ids = state.selectedIds.size > 0 ? [...state.selectedIds] : selected.value ? [selected.value.id] : []
  if (!ids.length) {
    toast.warn('请先在左侧选择要导出的文件或文件夹（可按 Ctrl 多选）')
    return
  }
  const res = await exportNodes(ids)
  if (!res.ok) toast.error(res.error)
  else if (res.data.exported > 0) {
    toast.ok(`已导出 ${res.data.exported} 个文件到 ${res.data.destDir}。导出的文件不再受保护。`)
  }
}

function onNewFolder() {
  newFolderAt.value = newFolderTarget.value ?? '__root__'
}

/** 文件树右键菜单发起的新建子文件夹 */
function onTreeNewFolder(parentId: string | null) {
  newFolderAt.value = parentId ?? '__root__'
}

async function onCreateFolder(name: string) {
  const parentId = newFolderAt.value === '__root__' ? null : newFolderAt.value
  newFolderAt.value = null
  const err = await createFolder(parentId, name)
  if (err) toast.error(err)
}

/** 工具栏删除：多选集合优先 */
function onDelete() {
  const ids = state.selectedIds.size > 0 ? [...state.selectedIds] : selected.value ? [selected.value.id] : []
  if (!ids.length) return
  pendingDeleteIds.value = ids
}

/** 文件树右键删除 */
function onTreeDelete(ids: string[]) {
  pendingDeleteIds.value = ids
}

/** 文件树右键导出 */
async function onTreeExport(id: string) {
  const res = await exportNodes([id])
  if (!res.ok) toast.error(res.error)
  else if (res.data.exported > 0) {
    toast.ok(`已导出 ${res.data.exported} 个文件到 ${res.data.destDir}。导出的文件不再受保护。`)
  }
}

async function onConfirmDelete() {
  const ids = pendingDeleteIds.value
  pendingDeleteIds.value = null
  if (!ids?.length) return
  const err = await remove(ids)
  if (err) toast.error(err)
  else toast.ok(ids.length > 1 ? `已删除 ${ids.length} 项。密文已直接从磁盘移除，不进回收站。` : '已删除。密文已直接从磁盘移除，不进回收站。')
}

const deleteNames = computed(() => {
  const ids = pendingDeleteIds.value
  if (!ids?.length) return []
  return ids
    .map((id) => state.nodes.find((n) => n.id === id)?.name)
    .filter((n): n is string => !!n)
})

function onLock() {
  void lock()
}

async function onSwitchVault() {
  await closeVault()
}

/**
 * 从文件树拖进来的文件/文件夹。
 * 落点决定 parentId（拖到文件夹上就进那个文件夹，拖到空白处就进根目录），
 * 与工具栏导入的"一律进根目录"是两条不同的路径，符合直觉。
 */
async function handledImport(parentId: string | null, paths: string[]) {
  await startImport(parentId, paths)
}

async function handledMove(id: string, parentId: string | null) {
  const err = await move(id, parentId)
  if (err) toast.error(err)
}

/* ---------------- 搜索（防抖 + 内容检索） ---------------- */

let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => state.search,
  (kw) => {
    if (searchTimer) clearTimeout(searchTimer)
    const trimmed = kw.trim()
    if (!trimmed) {
      state.contentMatches = []
      return
    }
    // 文件名过滤是本地的、即时的；内容检索 400ms 防抖后走主进程按需解密
    searchTimer = setTimeout(async () => {
      const err = await searchContent(trimmed)
      if (err) toast.error(err)
    }, 400)
  },
)

onMounted(() => {
  // Esc 清空搜索
  window.addEventListener('keydown', onGlobalKey)
  // 首次解锁后自动弹一次新手引导。写回 guideSeen 是为了不让它每次都跳出来烦人，
  // 之后从工具栏的「新手引导」随时可以再看。
  if (!state.config?.guideSeen) {
    showGuide.value = true
    void patchConfig({ guideSeen: true })
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  if (searchTimer) clearTimeout(searchTimer)
})

function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && state.search) {
    state.search = ''
    state.contentMatches = []
  }
}
</script>

<template>
  <div class="main">
    <div class="toolbar">
      <!--
        工具栏一律用文字标签，不用 « » ⟳ 这类符号：
        符号省下的那点宽度，换来的是"这个按钮到底干嘛的"全靠悬停猜。
      -->
      <button
        class="btn"
        :title="treeCollapsed ? '展开文件库' : '收起文件库'"
        @click="treeCollapsed = !treeCollapsed"
      >
        {{ treeCollapsed ? '展开' : '收起' }}
      </button>

      <!-- 导入：一个入口，文件 / 文件夹在二级菜单里选 -->
      <!-- 透明遮罩：点空白处关掉下拉。比全局 click 监听更省心，不会漏摘监听器 -->
      <div v-if="importMenuOpen" class="menu-backdrop" @click="importMenuOpen = false" />
      <div class="menu-wrap">
        <button
          class="btn"
          :class="{ on: importMenuOpen }"
          title="把文件或整个文件夹导入文件库"
          @click="importMenuOpen = !importMenuOpen"
        >
          导入<span class="caret">▾</span>
        </button>
        <div v-if="importMenuOpen" class="dropdown">
          <button class="ditem" @click="pickImport('files')">导入文件…</button>
          <button class="ditem" @click="pickImport('folder')">导入文件夹…</button>
        </div>
      </div>

      <button class="btn" @click="onExport">导出</button>
      <button class="btn" @click="onNewFolder">新建文件夹</button>
      <button class="btn" :disabled="state.selectedIds.size === 0 && !selected" @click="onDelete">
        删除
      </button>

      <button
        class="btn"
        :disabled="refreshing"
        title="刷新文件库（重新从磁盘读取目录）"
        @click="onRefresh"
      >
        {{ refreshing ? '刷新中…' : '刷新' }}
      </button>

      <div class="spacer" />

      <input v-model="state.search" class="input search" placeholder="搜索文件名或内容，Esc 清空" />

      <div class="spacer" />

      <button class="btn ghost" @click="onSwitchVault">文件库</button>
      <button class="btn ghost" title="打开新手引导" @click="showGuide = true">新手引导</button>
      <button class="btn ghost" @click="showSettings = true">设置</button>
      <button class="btn primary" @click="onLock">锁定</button>
    </div>

    <div class="body">
      <FileTree
        v-show="!treeCollapsed"
        :new-folder-at="newFolderAt"
        @create-folder="onCreateFolder"
        @cancel-folder="newFolderAt = null"
        @drop-files="handledImport"
        @move-node="handledMove"
        @request-delete="onTreeDelete"
        @request-new-folder="onTreeNewFolder"
        @request-export="onTreeExport"
      />
      <button
        v-if="treeCollapsed"
        class="expand-rail"
        title="展开文件库"
        @click="treeCollapsed = false"
      >
        展开文件库
      </button>
      <PreviewPane />
    </div>

    <div class="statusbar">
      <span>{{ state.vault.fileCount }} 个文件</span>
      <span class="sep">·</span>
      <span>{{ formatSize(state.vault.totalSize) }}</span>
      <span class="sep">·</span>
      <span>{{ state.vault.kdf === 'argon2id' ? 'Argon2id' : (state.vault.kdf ?? '—') }}</span>
      <div class="spacer" />
      <span class="path" :title="state.dir">{{ state.dir }}</span>
      <span class="sep">·</span>
      <span class="cd">锁定倒计时 {{ formatCountdown(state.countdown) }}</span>
    </div>

    <SettingsDialog v-model="showSettings" />
    <Onboarding v-model="showGuide" />

    <!-- 导入重名冲突：让用户在"覆盖"和"保留两者"之间选，不替他们决定 -->
    <div v-if="pendingImport" class="modal" @click.self="pendingImport = null">
      <div class="dialog">
        <h3>有 {{ pendingImport.scan.conflicts.length }} 项重名</h3>
        <p>
          即将导入 {{ pendingImport.scan.files }} 个文件<template v-if="pendingImport.scan.folders">、{{
            pendingImport.scan.folders
          }} 个文件夹</template>，其中这些和文件库里已有的重名：
        </p>
        <ul class="dlist">
          <li v-for="c in conflictPreview" :key="c.name">
            {{ c.kind === 'folder' ? '📁' : '📄' }} {{ c.name }}
            <span class="dim">（库中已有{{ c.existingType === 'folder' ? '同名文件夹' : '同名文件' }}）</span>
          </li>
          <li v-if="conflictMore > 0" class="dim">… 还有 {{ conflictMore }} 项</li>
        </ul>
        <p v-if="pendingImport.scan.oversized > 0" class="warn">
          另有 {{ pendingImport.scan.oversized }} 个文件超过 256MB，导入时会跳过。
        </p>

        <div class="choices">
          <button class="choice" @click="onResolveImport('keep-both')">
            <span class="ct">保留两者</span>
            <span class="cd">新导入的自动改名为「名字 (2)」，库里原有的一份不动</span>
          </button>
          <button class="choice danger" @click="onResolveImport('overwrite')">
            <span class="ct">覆盖同名项</span>
            <span class="cd">同名文件用新的替换（旧密文直接删除，无法恢复）；同名文件夹则合并</span>
          </button>
        </div>

        <div class="actions">
          <button class="btn" @click="pendingImport = null">取消</button>
        </div>
      </div>
    </div>

    <div v-if="pendingDeleteIds?.length" class="modal" @click.self="pendingDeleteIds = null">
      <div class="dialog">
        <h3>确认删除</h3>
        <p v-if="pendingDeleteIds.length === 1">
          即将删除「{{ deleteNames[0] ?? '选中项' }}」<template v-if="selected?.type === 'folder'">及其全部内容</template>。
        </p>
        <p v-else>即将删除 {{ pendingDeleteIds.length }} 个选中项（含各自全部内容）：</p>
        <ul v-if="pendingDeleteIds.length > 1" class="dlist">
          <li v-for="n in deleteNames.slice(0, 8)" :key="n">{{ n }}</li>
          <li v-if="deleteNames.length > 8">… 共 {{ pendingDeleteIds.length }} 项</li>
        </ul>
        <p class="warn">密文会直接从磁盘移除，不进入回收站，删除后无法恢复。</p>
        <div class="actions">
          <button class="btn" @click="pendingDeleteIds = null">取消</button>
          <button class="btn danger" @click="onConfirmDelete">确认删除</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.main {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.toolbar {
  height: 46px;
  flex: 0 0 46px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
}

/* ---------------- 导入下拉 ---------------- */

.menu-wrap {
  position: relative;
  /* 抬到遮罩之上：遮罩是全屏 fixed，不这样会被它盖住点不动 */
  z-index: 41;
}

/* 下拉展开时按钮保持高亮。
   写成 `.menu-wrap .btn.on` 是为了压过 global.css 里 `.btn:hover:not(:disabled)`
   （同为 3 个类选择器，靠源码顺序决胜负太脆弱），否则鼠标一悬停高亮就没了。 */
.menu-wrap .btn.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

.caret {
  font-size: 9px;
  opacity: 0.7;
}

/* 点空白处关下拉用的透明遮罩 */
.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 148px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 10px 30px var(--dropdown-shadow);
  animation: pop 0.08s ease-out;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

.ditem {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text);
  border-radius: 5px;
}

.ditem:hover {
  background: var(--hover);
}

.spacer {
  flex: 1;
}

.search {
  width: 240px;
  height: 30px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.expand-rail {
  flex: 0 0 26px;
  width: 26px;
  border: none;
  border-right: 1px solid var(--line);
  background: var(--panel-3);
  color: var(--muted);
  font-size: 11.5px;
  letter-spacing: 1px;
  /* 竖排：26px 宽的竖条放不下横排文字，也正好符合"侧栏"的形态 */
  writing-mode: vertical-rl;
  padding: 12px 0;
  white-space: nowrap;
  overflow: hidden;
}

.expand-rail:hover {
  color: var(--accent);
  background: var(--hover);
}

.statusbar {
  height: 26px;
  flex: 0 0 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-top: 1px solid var(--line);
  background: var(--panel-3);
  font-size: 11.5px;
  color: var(--muted);
}

.sep {
  color: var(--faint);
  opacity: 0.6;
}

.path {
  max-width: 460px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}

.cd {
  font-variant-numeric: tabular-nums;
}

.modal {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  width: 420px;
  background: var(--panel);
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 20px 50px var(--dropdown-shadow);
}

.dialog h3 {
  font-size: 15px;
  margin-bottom: 10px;
}

.dialog p {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.7;
}

.dlist {
  margin: 6px 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text);
  max-height: 130px;
  overflow-y: auto;
}

.dialog .warn {
  color: var(--warn);
  margin-top: 6px;
}

.dim {
  color: var(--faint);
}

/* 两个策略做成整块可点的卡片：这不是普通的"确定/取消"，
   而是两种结果差别很大的选择，需要各自的说明文字 */
.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.choice {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-2);
  transition: 0.15s;
}

.choice:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.choice.danger:hover {
  border-color: var(--danger);
  background: var(--danger-soft, var(--panel-2));
}

.choice .ct {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.choice.danger .ct {
  color: var(--danger);
}

.choice .cd {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
