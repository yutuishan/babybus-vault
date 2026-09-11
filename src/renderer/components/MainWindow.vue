<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'
import { formatCountdown, formatSize } from '../utils/format'
import FileTree from './FileTree.vue'
import PreviewPane from './PreviewPane.vue'
import SettingsDialog from './SettingsDialog.vue'

const { state, lock, closeVault, importPaths, exportNodes, remove, createFolder, move, searchContent } =
  useVault()
const toast = useToast()

const showSettings = ref(false)
const newFolderAt = ref<string | null>(null)
const treeCollapsed = ref(false)

/** 待删除的节点（单选或多选） */
const pendingDeleteIds = ref<string[] | null>(null)

const selected = computed(() => state.nodes.find((n) => n.id === state.selectedId) ?? null)

/** 导入的目标目录：选中了文件夹就放进去，选中了文件就放它所在目录，没选就放根 */
const importTarget = computed(() => {
  const node = selected.value
  if (!node) return null
  return node.type === 'folder' ? node.id : node.parentId
})

async function onImport() {
  const picked = await window.api.pickFiles({ title: '选择要导入的文件或文件夹', includeDirectories: true })
  if (!picked.length) return
  const res = await importPaths(importTarget.value, picked.map((p) => p.path))
  if (!res.ok) {
    toast.error(res.error)
  } else {
    const { imported, skipped, failed } = res.data
    const parts = [`已导入 ${imported} 个文件`]
    if (skipped) parts.push(`跳过 ${skipped} 个`)
    if (failed.length) parts.push(`失败 ${failed.length} 个`)
    toast.ok(parts.join('，') + '。原始文件默认保留，不会被删除。')
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
  newFolderAt.value = importTarget.value ?? '__root__'
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

async function handledImport(parentId: string | null, paths: string[]) {
  const res = await importPaths(parentId, paths)
  if (!res.ok) toast.error(res.error)
  else toast.ok(`已导入 ${res.data.imported} 个文件。原始文件默认保留。`)
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
      <button class="iconbtn" :title="treeCollapsed ? '展开文件库' : '折叠文件库'" @click="treeCollapsed = !treeCollapsed">
        {{ treeCollapsed ? '»' : '«' }}
      </button>
      <button class="btn" @click="onImport">导入</button>
      <button class="btn" @click="onExport">导出</button>
      <button class="btn" @click="onNewFolder">新建文件夹</button>
      <button class="btn" :disabled="state.selectedIds.size === 0 && !selected" @click="onDelete">删除</button>

      <div class="spacer" />

      <input v-model="state.search" class="input search" placeholder="搜索文件名或内容，Esc 清空" />

      <div class="spacer" />

      <button class="btn ghost" @click="onSwitchVault">文件库</button>
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
      <button v-if="treeCollapsed" class="expand-rail" title="展开文件库" @click="treeCollapsed = false">
        »
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

.iconbtn {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  background: var(--panel);
  font-size: 13px;
}

.iconbtn:hover {
  color: var(--accent);
  border-color: var(--accent);
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
  flex: 0 0 22px;
  width: 22px;
  border: none;
  border-right: 1px solid var(--line);
  background: var(--panel-3);
  color: var(--faint);
  font-size: 13px;
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

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
