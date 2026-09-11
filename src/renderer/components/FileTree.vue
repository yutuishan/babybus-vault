<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVault } from '../composables/useVault'
import { buildTree, pathOf, type TreeNode } from '../utils/tree'
import TreeNodeItem from './TreeNode.vue'

const props = defineProps<{ newFolderAt: string | null }>()
const emit = defineEmits<{
  (e: 'create-folder', name: string): void
  (e: 'cancel-folder'): void
  (e: 'drop-files', parentId: string | null, paths: string[]): void
  (e: 'move-node', id: string, parentId: string | null): void
  (e: 'request-delete', ids: string[]): void
  (e: 'request-new-folder', parentId: string | null): void
  (e: 'request-export', id: string): void
}>()

const { state, rename } = useVault()

const dragMime = 'application/x-vault-node'

const tree = computed(() => buildTree(state.nodes))
const dragOverId = ref<string | null>(null)
const draggingId = ref<string | null>(null)
const rootHover = ref(false)
const editingId = ref<string | null>(null)
const newInputEl = ref<HTMLInputElement | null>(null)

/* ---------------- 搜索结果模式 ---------------- */

const searchMode = computed(() => state.search.trim().length > 0)

const nameMatches = computed(() => {
  if (!searchMode.value) return []
  const kw = state.search.trim().toLowerCase()
  return state.nodes.filter((n) => n.name.toLowerCase().includes(kw))
})

const contentHits = computed(() => {
  if (!searchMode.value) return []
  const kw = state.search.trim().toLowerCase()
  return state.contentMatches.filter((m) => !m.name.toLowerCase().includes(kw))
})

/* ---------------- 选择（含多选） ---------------- */

/** 展开状态下可见节点的顺序，Shift 范围选择按这个顺序算 */
const visibleOrder = computed(() => {
  const order: string[] = []
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      order.push(n.id)
      if (n.type === 'folder' && state.expanded.has(n.id)) walk(n.children)
    }
  }
  walk(tree.value)
  return order
})

function select(node: TreeNode, ev?: MouseEvent) {
  if (ev?.shiftKey && state.selectedId) {
    // 范围选择：从上次点击的节点到当前节点，按可见顺序
    const order = visibleOrder.value
    const from = order.indexOf(state.selectedId)
    const to = order.indexOf(node.id)
    if (from >= 0 && to >= 0) {
      const [a, b] = from <= to ? [from, to] : [to, from]
      state.selectedIds = new Set(order.slice(a, b + 1))
      state.selectedId = node.id
      return
    }
  }
  if (ev?.ctrlKey || ev?.metaKey) {
    // 累加/取消单选
    if (state.selectedIds.has(node.id)) {
      state.selectedIds.delete(node.id)
      if (state.selectedIds.size > 0) {
        state.selectedId = [...state.selectedIds].pop() ?? null
      }
    } else {
      state.selectedIds.add(node.id)
      state.selectedId = node.id
    }
    return
  }
  // 普通点击：单选
  state.selectedId = node.id
  state.selectedIds = new Set([node.id])
  if (node.type === 'folder') toggle(node.id)
}

function selectFromSearch(id: string) {
  state.selectedId = id
  state.selectedIds = new Set([id])
}

function toggle(id: string) {
  if (state.expanded.has(id)) state.expanded.delete(id)
  else state.expanded.add(id)
}

function collapseAll() {
  state.expanded.clear()
}

/* ---------------- 重命名（扩展名保护） ---------------- */

/** 编辑时只给主名，扩展名不可改 */
function editBase(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(0, dot)
  return name
}

function startRename(node: TreeNode) {
  editingId.value = node.id
}

async function commitRename(id: string, base: string) {
  editingId.value = null
  const trimmed = base.trim()
  const current = state.nodes.find((n) => n.id === id)
  if (!trimmed || !current || editBase(current.name) === trimmed) return
  // 扩展名保持原样：用户改的只是主名
  const extPart = current.name.slice(editBase(current.name).length)
  await rename(id, trimmed + extPart)
}

/* ---------------- 拖拽 ---------------- */

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

/* ---------------- 右键菜单 ---------------- */

const menu = ref<{ x: number; y: number; node: TreeNode | null } | null>(null)

function openMenu(e: MouseEvent, node: TreeNode | null) {
  e.preventDefault()
  e.stopPropagation()
  // 右键未选中的节点时，把选择切过去
  if (node && !state.selectedIds.has(node.id)) {
    state.selectedId = node.id
    state.selectedIds = new Set([node.id])
  }
  menu.value = { x: e.clientX, y: e.clientY, node }
}

function closeMenu() {
  menu.value = null
}

const menuPos = computed(() => {
  if (!menu.value) return { left: '0px', top: '0px' }
  const x = Math.min(menu.value.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 200)
  const y = Math.min(menu.value.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - 200)
  return { left: `${Math.max(0, x)}px`, top: `${Math.max(0, y)}px` }
})

function menuRename() {
  if (menu.value?.node) startRename(menu.value.node)
  closeMenu()
}

function menuDelete() {
  // 删除当前多选集合（菜单针对的节点已在 openMenu 里并入选择）
  const ids = [...state.selectedIds]
  if (!ids.length && state.selectedId) ids.push(state.selectedId)
  if (ids.length) emit('request-delete', ids)
  closeMenu()
}

async function menuExport() {
  const node = menu.value?.node
  closeMenu()
  if (!node) return
  emit('request-export', node.id)
}

function menuNewFolder() {
  const node = menu.value?.node
  closeMenu()
  emit('request-new-folder', node && node.type === 'folder' ? node.id : null)
}

function onScrollerClick(e: MouseEvent) {
  // 点击空白处：清空多选（重命名输入的失焦会自然触发提交）
  if (e.target === e.currentTarget) {
    state.selectedIds.clear()
  }
}

const menuEl = ref<HTMLElement | null>(null)

function onGlobalClick(e: MouseEvent) {
  // 菜单内部点击不关闭（捕获阶段先于按钮处理器，必须放行）
  if (menuEl.value && e.target instanceof Node && menuEl.value.contains(e.target)) return
  closeMenu()
}

onMounted(() => {
  window.addEventListener('click', onGlobalClick, true)
  window.addEventListener('blur', closeMenu)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', onGlobalClick, true)
  window.removeEventListener('blur', closeMenu)
})

watch(
  () => props.newFolderAt,
  async (v) => {
    if (!v) return
    await nextTick()
    newInputEl.value?.focus()
  },
)

function submitNewFolder() {
  const name = (newName.value ?? '').trim()
  newName.value = ''
  if (name) emit('create-folder', name)
  else emit('cancel-folder')
}

const newName = ref('')
</script>

<template>
  <aside
    class="tree"
    :class="{ hover: rootHover }"
    @dragover="allowDrop"
    @dragenter="rootHover = true"
    @dragleave="rootHover = false"
    @drop="onDrop($event, null)"
    @contextmenu="openMenu($event, null)"
  >
    <div class="head">
      <span>文件库</span>
      <span class="head-actions">
        <button class="hbtn" title="全部折叠" @click="collapseAll">⊟</button>
        <span class="count">{{ state.nodes.length }}</span>
      </span>
    </div>

    <!-- 搜索结果模式：扁平列表 -->
    <div v-if="searchMode" class="scroll results">
      <div v-if="!nameMatches.length && !contentHits.length && !state.contentSearching" class="empty">
        <p>没有匹配的结果</p>
        <p class="sub">同时搜索文件名与文本类文件内容</p>
      </div>

      <template v-if="nameMatches.length">
        <div class="rhead">按文件名（{{ nameMatches.length }}）</div>
        <button
          v-for="n in nameMatches"
          :key="n.id"
          class="ritem"
          :class="{ on: state.selectedId === n.id }"
          @click="selectFromSearch(n.id)"
        >
          <span class="icon">{{ n.type === 'folder' ? '📁' : '📄' }}</span>
          <span class="rname">{{ n.name }}</span>
          <span class="rpath">{{
            pathOf(state.nodes, n.id)
              .slice(0, -1)
              .map((p) => p.name)
              .join(' / ')
          }}</span>
        </button>
      </template>

      <template v-if="contentHits.length">
        <div class="rhead">按内容（{{ contentHits.length }}）</div>
        <button
          v-for="m in contentHits"
          :key="m.id"
          class="ritem"
          :class="{ on: state.selectedId === m.id }"
          @click="selectFromSearch(m.id)"
        >
          <span class="icon">🔍</span>
          <span class="rmain">
            <span class="rname">{{ m.name }}</span>
            <span class="snippet">{{ m.snippet }}</span>
          </span>
          <span class="hits">{{ m.hits }} 处</span>
        </button>
      </template>

      <div v-if="state.contentSearching" class="searching">正在检索文件内容…</div>
    </div>

    <!-- 目录树模式 -->
    <div v-else class="scroll" @click.self="onScrollerClick">
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
          @click.stop
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
        :dragging-id="draggingId"
        @select="select"
        @toggle="toggle"
        @rename="startRename"
        @commit="commitRename"
        @cancel-edit="editingId = null"
        @contextmenu-node="openMenu"
        @dragstart-node="
          (e, n) => {
            draggingId = n.id
            e.dataTransfer?.setData(dragMime, n.id)
            // 拖拽即选中，放下后可见反馈
            if (!state.selectedIds.has(n.id)) {
              state.selectedId = n.id
              state.selectedIds = new Set([n.id])
            }
          }
        "
        @dragend-node="draggingId = null"
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

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="menu"
        ref="menuEl"
        class="ctxmenu"
        :style="menuPos"
        @click.stop
        @contextmenu.prevent
      >
        <template v-if="menu.node">
          <button class="mitem" @click="menuRename">重命名</button>
          <button v-if="menu.node.type === 'folder'" class="mitem" @click="menuNewFolder">
            新建子文件夹
          </button>
          <button class="mitem" @click="menuExport">导出…</button>
          <div class="msep" />
          <button class="mitem danger" @click="menuDelete">
            删除{{ state.selectedIds.size > 1 ? `（已选 ${state.selectedIds.size} 项）` : '' }}
          </button>
        </template>
        <template v-else>
          <button class="mitem" @click="collapseAll; closeMenu()">全部折叠</button>
        </template>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.tree {
  width: 300px;
  flex: 0 0 300px;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  background: var(--panel-2);
  overflow: hidden;
  position: relative;
}

.tree.hover {
  background: var(--accent-soft);
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

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.hbtn {
  font-size: 12px;
  color: var(--faint);
  padding: 1px 4px;
  border-radius: 4px;
}

.hbtn:hover {
  color: var(--accent);
  background: var(--hover);
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
  background: var(--panel);
  color: var(--text);
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

/* ---------------- 搜索结果 ---------------- */

.rhead {
  padding: 8px 12px 4px;
  font-size: 11px;
  color: var(--faint);
}

.ritem {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 12px;
  text-align: left;
  border: none;
  background: none;
}

.ritem:hover {
  background: var(--hover);
}

.ritem.on {
  background: var(--accent-soft);
}

.ritem .icon {
  flex: 0 0 auto;
  font-size: 12px;
}

.rname {
  flex: 0 0 auto;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text);
}

.rpath {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--faint);
  direction: rtl;
  text-align: left;
}

.rmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.snippet {
  font-size: 11px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hits {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--accent);
}

.searching {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--faint);
}

/* ---------------- 右键菜单 ---------------- */

.ctxmenu {
  position: fixed;
  z-index: 200;
  min-width: 170px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 10px 30px var(--dropdown-shadow);
  padding: 4px;
  animation: pop 0.08s ease-out;
}

@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

.mitem {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text);
  border-radius: 5px;
}

.mitem:hover {
  background: var(--hover);
}

.mitem.danger {
  color: var(--danger);
}

.msep {
  height: 1px;
  background: var(--line-soft);
  margin: 4px 6px;
}
</style>
