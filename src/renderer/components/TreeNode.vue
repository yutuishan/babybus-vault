<script setup lang="ts">
import { computed } from 'vue'
import { useVault } from '../composables/useVault'
import { formatSize } from '../utils/format'
import type { TreeNode as TreeNodeData } from '../utils/tree'

// 组件按文件名自引用；类型别名避免与自引用组件名撞车
const props = defineProps<{
  node: TreeNodeData
  depth: number
  dragMime: string
  editingId: string | null
  dragOverId: string | null
  draggingId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', node: TreeNodeData, ev?: MouseEvent): void
  (e: 'toggle', id: string): void
  (e: 'rename', node: TreeNodeData): void
  (e: 'commit', id: string, base: string): void
  (e: 'cancel-edit'): void
  (e: 'contextmenu-node', event: MouseEvent, node: TreeNodeData | null): void
  (e: 'dragstart-node', event: DragEvent, node: TreeNodeData): void
  (e: 'dragend-node'): void
  (e: 'dragover-node', event: DragEvent): void
  (e: 'enter-node', id: string): void
  (e: 'leave-node'): void
  (e: 'drop-node', event: DragEvent, node: TreeNodeData | null): void
}>()

// SFC 允许组件按文件名自引用，递归树就靠这一行
const { state } = useVault()

const expanded = computed(() => state.expanded.has(props.node.id))
const selected = computed(
  () => state.selectedId === props.node.id || state.selectedIds.has(props.node.id),
)
const primary = computed(() => state.selectedId === props.node.id)
const over = computed(() => props.dragOverId === props.node.id)
const dragging = computed(() => props.draggingId === props.node.id)
const editing = computed(() => props.editingId === props.node.id)

/** 编辑时只显示主名，扩展名不可改（提交时由父组件补回） */
const editBase = computed(() => {
  const name = props.node.name
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(0, dot)
  return name
})
</script>

<template>
  <div class="wrap">
    <div
      class="node"
      :class="{ selected, primary, over, dragging, folder: node.type === 'folder' }"
      :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
      draggable="true"
      @click="emit('select', node, $event)"
      @dblclick="emit('rename', node)"
      @contextmenu="emit('contextmenu-node', $event, node)"
      @dragstart="emit('dragstart-node', $event, node)"
      @dragend="emit('dragend-node')"
      @dragover="emit('dragover-node', $event)"
      @dragenter="emit('enter-node', node.id)"
      @dragleave="emit('leave-node')"
      @drop="emit('drop-node', $event, node)"
    >
      <span
        v-if="node.type === 'folder'"
        class="arrow"
        :class="{ open: expanded }"
        @click.stop="emit('toggle', node.id)"
        >▸</span
      >
      <span v-else class="arrow placeholder" />

      <span class="icon">{{ node.type === 'folder' ? '📁' : '📄' }}</span>

      <input
        v-if="editing"
        class="mini"
        :value="editBase"
        autofocus
        @click.stop
        @keydown.enter="emit('commit', node.id, ($event.target as HTMLInputElement).value)"
        @keydown.esc="emit('cancel-edit')"
        @blur="emit('commit', node.id, ($event.target as HTMLInputElement).value)"
      />
      <span v-else class="name" :title="node.name">{{ node.name }}</span>

      <span v-if="node.type === 'file'" class="size">{{ formatSize(node.size) }}</span>
    </div>

    <template v-if="node.type === 'folder' && expanded">
      <TreeNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :drag-mime="dragMime"
        :editing-id="editingId"
        :drag-over-id="dragOverId"
        :dragging-id="draggingId"
        @select="(n, ev) => emit('select', n, ev)"
        @toggle="(id) => emit('toggle', id)"
        @rename="(n) => emit('rename', n)"
        @commit="(id, base) => emit('commit', id, base)"
        @cancel-edit="emit('cancel-edit')"
        @contextmenu-node="(ev, n) => emit('contextmenu-node', ev, n)"
        @dragstart-node="(e, n) => emit('dragstart-node', e, n)"
        @dragend-node="emit('dragend-node')"
        @dragover-node="(e) => emit('dragover-node', e)"
        @enter-node="(id) => emit('enter-node', id)"
        @leave-node="emit('leave-node')"
        @drop-node="(e, n) => emit('drop-node', e, n)"
      />
    </template>
  </div>
</template>

<style scoped>
.node {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding-right: 10px;
  cursor: default;
  user-select: none;
  font-size: 12.5px;
}

.node:hover {
  background: var(--hover);
}

/* 多选集合 */
.node.selected {
  background: var(--accent-soft);
}

/* 当前焦点节点（最后点击的） */
.node.primary {
  color: var(--accent-dark);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}

/* 拖拽中的节点保持选中视觉 */
.node.dragging {
  opacity: 0.55;
  background: var(--accent-soft);
}

/* 放置目标高亮 */
.node.over {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent);
}

.arrow {
  width: 12px;
  flex: 0 0 12px;
  font-size: 9px;
  color: var(--faint);
  transition: transform 0.15s;
  text-align: center;
}

.arrow.open {
  transform: rotate(90deg);
}

.arrow.placeholder {
  visibility: hidden;
}

.icon {
  font-size: 12px;
  flex: 0 0 auto;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  color: var(--faint);
  font-size: 11px;
  flex: 0 0 auto;
}

.mini {
  flex: 1;
  height: 22px;
  min-width: 0;
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 0 5px;
  font-size: 12.5px;
  outline: none;
  background: var(--panel);
  color: var(--text);
}
</style>
