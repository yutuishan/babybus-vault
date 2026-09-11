<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'
import { formatCountdown, formatSize } from '../utils/format'
import FileTree from './FileTree.vue'
import PreviewPane from './PreviewPane.vue'
import SettingsDialog from './SettingsDialog.vue'

const { state, lock, closeVault, importPaths, exportNodes, remove, createFolder, move } = useVault()
const toast = useToast()

const showSettings = ref(false)
const showConfirm = ref(false)
const newFolderAt = ref<string | null>(null)

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
  if (!selected.value) {
    toast.warn('请先在左侧选择要导出的文件或文件夹')
    return
  }
  const res = await exportNodes([selected.value.id])
  if (!res.ok) toast.error(res.error)
  else if (res.data.exported > 0) {
    toast.ok(`已导出 ${res.data.exported} 个文件到 ${res.data.destDir}。导出的文件不再受保护。`)
  }
}

function onNewFolder() {
  newFolderAt.value = importTarget.value ?? '__root__'
}

async function onCreateFolder(name: string) {
  const parentId = newFolderAt.value === '__root__' ? null : newFolderAt.value
  newFolderAt.value = null
  const err = await createFolder(parentId, name)
  if (err) toast.error(err)
}

async function onDelete() {
  showConfirm.value = false
  if (!selected.value) return
  const err = await remove(selected.value.id)
  if (err) toast.error(err)
  else toast.ok('已删除。密文已直接从磁盘移除，不进回收站。')
}

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
</script>

<template>
  <div class="main">
    <div class="toolbar">
      <button class="btn" @click="onImport">导入</button>
      <button class="btn" @click="onExport">导出</button>
      <button class="btn" @click="onNewFolder">新建文件夹</button>
      <button class="btn" :disabled="!selected" @click="showConfirm = true">删除</button>

      <div class="spacer" />

      <input v-model="state.search" class="input search" placeholder="搜索文件名" />

      <div class="spacer" />

      <button class="btn ghost" @click="onSwitchVault">文件库</button>
      <button class="btn ghost" @click="showSettings = true">设置</button>
      <button class="btn primary" @click="onLock">锁定</button>
    </div>

    <div class="body">
      <FileTree
        :new-folder-at="newFolderAt"
        @create-folder="onCreateFolder"
        @cancel-folder="newFolderAt = null"
        @drop-files="handledImport"
        @move-node="handledMove"
      />
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

    <div v-if="showConfirm" class="modal" @click.self="showConfirm = false">
      <div class="dialog">
        <h3>确认删除</h3>
        <p>
          即将删除「{{ selected?.name }}」<template v-if="selected?.type === 'folder'">及其全部内容</template>。
        </p>
        <p class="warn">密文会直接从磁盘移除，不进入回收站，删除后无法恢复。</p>
        <div class="actions">
          <button class="btn" @click="showConfirm = false">取消</button>
          <button class="btn danger" @click="onDelete">确认删除</button>
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
  background: #fbfcfd;
}

.spacer {
  flex: 1;
}

.search {
  width: 210px;
  height: 30px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.statusbar {
  height: 26px;
  flex: 0 0 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-top: 1px solid var(--line);
  background: #fafbfd;
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
  background: rgba(30, 36, 48, 0.24);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  width: 400px;
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 20px 50px rgba(20, 26, 40, 0.24);
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

.dialog .warn {
  color: #a3450a;
  margin-top: 6px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
