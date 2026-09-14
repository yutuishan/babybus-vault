<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'
import { buildTree, pathOf, type TreeNode } from '../utils/tree'
import { DRAG_MIME, encodeDragIds, filterMovable, parseDragIds } from '../utils/drag'
import { fileIcon } from '../utils/icons'
import TreeNodeItem from './TreeNode.vue'

const props = defineProps<{ newFolderAt: string | null }>()
const emit = defineEmits<{
  (e: 'create-folder', name: string): void
  (e: 'cancel-folder'): void
  (e: 'drop-files', parentId: string | null, paths: string[]): void
  (e: 'move-nodes', ids: string[], parentId: string | null): void
  (e: 'request-delete', ids: string[]): void
  (e: 'request-new-folder', parentId: string | null): void
  (e: 'request-export', id: string): void
}>()

const { state, rename, refresh } = useVault()
const toast = useToast()

/**
 * 拖拽载荷与合法性过滤都在 utils/drag.ts —— 那里能单测，组件里不能。
 * 这里只负责把 DOM 事件和状态接起来。
 */
const dragMime = DRAG_MIME

/** 多选拖拽时跟随光标的计数提示。常驻 DOM（挪到屏幕外），避免 setDragImage 抓不到未渲染的元素 */
const dragGhostEl = ref<HTMLElement | null>(null)

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

/** 库里有没有文件夹 —— 没有的话"全部展开/全部折叠"点了也不会有任何变化，直接置灰 */
const folderCount = computed(() => state.nodes.filter((n) => n.type === 'folder').length)

function collapseAll() {
  state.expanded.clear()
}

/* ---------------- 刷新文件库 ---------------- */

const refreshing = ref(false)

/**
 * 重新从磁盘读取目录树与统计。
 *
 * 存在的意义：文件库目录可能被外部程序改动（同步盘、手动删 blob、杀软隔离），
 * 界面上的树就与磁盘不一致了。这里做一次强制重读，并顺手清掉已失效的选择
 * ——否则选中一个已经不存在的节点，右侧预览会一直停在旧内容上。
 *
 * 加 400ms 冷却只是为了防连点；不做 loading 遮罩，因为读 manifest 是本地毫秒级操作。
 */
let lastRefresh = 0

async function onRefresh() {
  if (refreshing.value) return
  const now = Date.now()
  if (now - lastRefresh < 400) return
  lastRefresh = now
  refreshing.value = true
  try {
    // refresh() 内部会顺手清掉已失效的选择；失败时主进程保持原状态，
    // 界面上什么都不该消失 —— 只提示一下。
    const err = await refresh()
    if (err) toast.error(`刷新失败：${err}`)
  } finally {
    refreshing.value = false
  }
}

function expandAll() {
  for (const n of state.nodes) {
    if (n.type === 'folder') state.expanded.add(n.id)
  }
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

/**
 * 拖拽开始 —— 多选拖拽能否成立全看这里。
 *
 * 如果被按住的节点**已经在多选集合里**，就把整批 id 一起放进 dataTransfer；
 * 否则只拖它自己（并把选择切过去）。只写单个 id 的话，选中 5 个再拖也只有 1 个会移动。
 */
function onDragStart(e: DragEvent, n: TreeNode) {
  const inSelection = state.selectedIds.has(n.id)
  const ids = inSelection && state.selectedIds.size > 1 ? [...state.selectedIds] : [n.id]

  if (!inSelection) {
    // 拖拽即选中，放下后才有可见反馈
    state.selectedId = n.id
    state.selectedIds = new Set([n.id])
  }

  draggingId.value = n.id
  e.dataTransfer?.setData(dragMime, encodeDragIds(ids))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'

  // 多选时给个「移动 N 项」的跟随提示，否则看不出拖的是一批还是一个
  const ghost = dragGhostEl.value
  if (ghost && ids.length > 1) {
    ghost.textContent = `移动 ${ids.length} 项`
    e.dataTransfer?.setDragImage(ghost, 8, 8)
  }
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

  const raw = parseDragIds(e.dataTransfer?.getData(dragMime) ?? '')
  const ids = filterMovable(state.nodes, raw, parentId)
  if (!ids.length) {
    // 有载荷却一个都不能动 → 是「拖进了自己/自己的子目录」，要说清楚，不能静默无反应
    if (raw.length) toast.warn('不能把文件夹移动到它自己或它的子目录里')
    return
  }
  emit('move-nodes', ids, parentId)
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

/** 新建框标题右侧的"将建在哪"，让用户在输入前就知道目标位置 */
const newFolderLocation = computed(() => {
  const at = props.newFolderAt
  if (!at || at === '__root__') return '文件库根目录'
  const node = state.nodes.find((n) => n.id === at)
  return node ? node.name : '文件库根目录'
})

function cancelNewFolder() {
  newName.value = ''
  emit('cancel-folder')
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
    @contextmenu="openMenu($event, null)"
  >
    <!--
      多选拖拽时跟随光标的计数提示。
      必须常驻 DOM 才能被 setDragImage 抓到（临时 append 再移除会赶在浏览器截图之前）。
      用绝对定位挪到可视区外，而不是 display:none —— 隐藏元素截不出图。
    -->
    <div ref="dragGhostEl" class="drag-ghost" aria-hidden="true" />

    <div class="head">
      <span class="head-title">
        <span>文件库</span>
        <span class="count">{{ state.nodes.length }}</span>
      </span>
      <!--
        一律用文字，不用 ⟳ / ⊟ 这类符号：
        符号的含义全靠猜，中文用户看到 ⟳ 不一定想到"刷新"，看到 ⊟ 更不知道是折叠。
        展开和折叠都给出来（之前只有"全部折叠"，库是折叠状态时没有一键展开的入口）。
      -->
      <span class="head-actions">
        <button
          class="hbtn"
          :disabled="refreshing"
          title="刷新文件库（重新读取磁盘上的目录）"
          @click="onRefresh"
        >
          {{ refreshing ? '刷新中' : '刷新' }}
        </button>
        <button class="hbtn" :disabled="!folderCount" title="展开全部文件夹" @click="expandAll">
          全部展开
        </button>
        <button
          class="hbtn"
          :disabled="!folderCount || !state.expanded.size"
          title="折叠全部文件夹"
          @click="collapseAll"
        >
          全部折叠
        </button>
      </span>
    </div>

    <!--
      新建文件夹的输入区。
      刻意做成独立的一条，放在文件树滚动区之外 —— 之前它跟树节点长在同一个列表里，
      只靠一个 accent 色的边框区分，用户很难判断"这里是在输入"还是"这里多了一个文件夹"。
      现在它有自己的底色、边框、阴影和标题，与下面的树是两片区域。
      另外不再用失焦提交：那样点「取消」会先触发失焦、把文件夹真的建出来。
    -->
    <div v-if="props.newFolderAt" class="newbar">
      <div class="newbar-head">
        <span class="newbar-title">新建文件夹</span>
        <span class="newbar-where" :title="newFolderLocation">{{ newFolderLocation }}</span>
      </div>
      <div class="newbar-row">
        <span class="icon">📁</span>
        <input
          ref="newInputEl"
          v-model="newName"
          class="mini"
          placeholder="输入名称，回车确认"
          @keydown.enter="submitNewFolder"
          @keydown.esc="cancelNewFolder"
          @click.stop
        />
        <button class="minibtn ok" :disabled="!newName.trim()" @click="submitNewFolder">创建</button>
        <button class="minibtn" @click="cancelNewFolder">取消</button>
      </div>
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
        @dragstart-node="onDragStart"
        @dragend-node="draggingId = null"
        @dragover-node="allowDrop"
        @enter-node="(id) => (dragOverId = id)"
        @leave-node="dragOverId = null"
        @drop-node="onDrop"
      />

      <div v-if="!tree.length" class="empty">
        <p>文件库是空的</p>
        <p class="sub">把文件拖到这里，或点击顶部「导入文件」</p>
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
          <button class="mitem" @click="expandAll(); closeMenu()">全部展开</button>
          <button class="mitem" @click="collapseAll(); closeMenu()">全部折叠</button>
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

/*
 * 多选拖拽的计数提示。
 * fixed + 屏幕外定位：既不会被 .tree 的 overflow:hidden 裁掉，也不影响布局。
 * 不能用 display:none / visibility:hidden —— 那样 setDragImage 截出来是空白。
 */
.drag-ghost {
  position: fixed;
  top: -1000px;
  left: -1000px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: 6px;
  box-shadow: 0 3px 10px var(--dropdown-shadow);
  pointer-events: none;
  white-space: nowrap;
}

.head {
  height: 32px;
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 0 12px;
  font-size: 11.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--line-soft);
}

.head-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

/* 文字按钮。以前这里是 ⟳ / ⊟ 两个符号，含义全靠猜 */
.hbtn {
  font-size: 11.5px;
  color: var(--muted);
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.hbtn:hover:not(:disabled) {
  color: var(--accent);
  background: var(--hover);
}

.hbtn:disabled {
  color: var(--faint);
  opacity: 0.4;
  cursor: default;
}

.count {
  background: var(--line-soft);
  border-radius: 8px;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--muted);
}

.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

/*
 * 新建文件夹输入区。
 * 用 accent 色的左描边 + 独立底色把它和下面的树明确分开：
 * 树是"已有的东西"，这里是"正在输入的东西"，两者视觉上不能长得一样。
 */
.newbar {
  flex: 0 0 auto;
  margin: 6px 8px;
  padding: 8px 10px 9px;
  border: 1px solid var(--accent);
  border-left-width: 3px;
  border-radius: 7px;
  background: var(--accent-soft);
  box-shadow: 0 3px 10px var(--dropdown-shadow);
}

.newbar-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.newbar-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent);
}

.newbar-where {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  max-width: 150px;
}

.newbar-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.newbar-row .icon {
  flex: 0 0 auto;
  font-size: 12px;
}

.mini {
  flex: 1;
  height: 26px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0 7px;
  font-size: 12.5px;
  outline: none;
  background: var(--panel);
  color: var(--text);
}

.mini:focus {
  border-color: var(--accent);
}

.minibtn {
  flex: 0 0 auto;
  height: 26px;
  padding: 0 9px;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel);
  color: var(--muted);
}

.minibtn:hover {
  color: var(--text);
  border-color: var(--faint);
}

.minibtn.ok {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.minibtn.ok:disabled {
  opacity: 0.45;
  cursor: default;
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
