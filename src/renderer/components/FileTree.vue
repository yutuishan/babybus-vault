<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useVault } from '../composables/useVault'
import { buildTree, type TreeNode } from '../utils/tree'
import TreeNodeItem from './TreeNode.vue'

const props = defineProps<{ newFolderAt: string | null }>()
const emit = defineEmits<{
  (e: 'create-folder', name: string): void
  (e: 'cancel-folder'): void
  (e: 'drop-files', parentId: string | null, paths: string[]): void
  (e: 'move-node', id: string, parentId: string | null): void
}>()

const { state, rename } = useVault()

const ROOT = '__root__'
const dragMime = 'application/x-vault-node'

const tree = computed(() => buildTree(state.nodes))
const dragOverId = ref<string | null>(null)
const rootHover = ref(false)
const editingId = ref<string | null>(null)
const newName = ref('')
const newInputEl = ref<HTMLInputElement | null>(null)

watch(
  () => props.newFolderAt,
  async (v) => {
    if (!v) return
    newName.value = ''
    await nextTick()
    newInputEl.value?.focus()
  },
)

function toggle(id: string) {
  if (state.expanded.has(id)) state.expanded.delete(id)
  else state.expanded.add(id)
}

function select(node: TreeNode) {
  state.selectedId = node.id
  if (node.type === 'folder') toggle(node.id)
}

function startRename(node: TreeNode) {
  editingId.value = node.id
}

async function commitRename(id: string, name: string) {
  editingId.value = null
  const trimmed = name.trim()
  const current = state.nodes.find((n) => n.id === id)
  if (!trimmed || !current || current.name === trimmed) return
  await rename(id, trimmed)
}

function isExternalDrag(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

function allowDrop(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = isExternalDrag(e) ? 'copy' : 'move'
}

async function onDrop(e: DragEvent, node: TreeNode | null) {
  e.preventDefault()
  e.stopPropagation()
  dragOverId.value = null
  rootHover.value = false
  const parentId = node && node.type === 'folder' ? node.id : (node?.parentId ?? null)

  if (isExternalDrag(e)) {
    const files = Array.from(e.dataTransfer?.files ?? [])
    const paths = await window.api.resolveDropPaths(files)
    if (paths.length) emit('drop-files', parentId, paths)
    return
  }

  const id = e.dataTransfer?.getData(dragMime)
  if (id && id !== node?.id) emit('move-node', id, parentId)
}

function submitNewFolder() {
  const name = newName.value.trim()
  newName.value = ''
  if (name) emit('create-folder', name)
  else emit('cancel-folder')
}

function targetOf(at: string | null): string | null {
  return !at || at === ROOT ? null : at
}
</script>

<template>
  <aside
    class="tree"
    :class="{ hover: rootHover }"
    @dragover="allowDrop"
    @dragenter="rootHover = true"
    @dragleave="rootHover = false"
    @drop="onDrop($event, null)"
  >
    <div class="head">
      <span>文件库</span>
      <span class="count">{{ state.nodes.length }}</span>
    </div>

    <div class="scroll">
      <div v-if="props.newFolderAt" class="newfolder">
        <span class="icon">📁</span>
        <input
          ref="newInputEl"
          v-model="newName"
          class="mini"
          placeholder="文件夹名称，回车确认"
          @keydown.enter="submitNewFolder"
          @keydown.esc="emit('cancel-folder')"
          @blur="submitNewFolder"
        />
      </div>

      <TreeNodeItem
        v-for="node in tree"
        :key="node.id"
        :node="node"
        :depth="0"
        :drag-mime="dragMime"
        :editing-id="editingId"
        :drag-over-id="dragOverId"
        @select="select"
        @toggle="toggle"
        @rename="startRename"
        @commit="commitRename"
        @cancel-edit="editingId = null"
        @dragstart-node="(e, n) => e.dataTransfer?.setData(dragMime, n.id)"
        @dragover-node="allowDrop"
        @enter-node="(id) => (dragOverId = id)"
        @leave-node="dragOverId = null"
        @drop-node="onDrop"
      />

      <div v-if="!tree.length && !props.newFolderAt" class="empty">
        <p>文件库是空的</p>
        <p class="sub">把文件拖到这里，或点击顶部「导入」</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.tree {
  width: 300px;
  flex: 0 0 300px;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  background: #fcfdfe;
  overflow: hidden;
}

.tree.hover {
  background: #f2f6ff;
  box-shadow: inset 0 0 0 2px var(--accent);
}

.head {
  height: 32px;
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 11.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--line-soft);
}

.count {
  background: var(--line-soft);
  border-radius: 8px;
  padding: 1px 7px;
  font-size: 11px;
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.newfolder {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
}

.mini {
  flex: 1;
  height: 24px;
  min-width: 0;
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 12.5px;
  outline: none;
}

.empty {
  padding: 30px 18px;
  text-align: center;
  color: var(--faint);
  font-size: 12.5px;
  line-height: 1.9;
}

.empty .sub {
  font-size: 11.5px;
}
</style>
