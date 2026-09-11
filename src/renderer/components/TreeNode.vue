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
}>()

const emit = defineEmits<{
  (e: 'select', node: TreeNodeData): void
  (e: 'toggle', id: string): void
  (e: 'rename', node: TreeNodeData): void
  (e: 'commit', id: string, name: string): void
  (e: 'cancel-edit'): void
  (e: 'dragstart-node', event: DragEvent, node: TreeNode): void
  (e: 'dragover-node', event: DragEvent): void
  (e: 'enter-node', id: string): void
  (e: 'leave-node'): void
  (e: 'drop-node', event: DragEvent, node: TreeNode | null): void
}>()

// SFC 允许组件按文件名自引用，递归树就靠这一行
const { state } = useVault()

const expanded = computed(() => state.expanded.has(props.node.id))
const selected = computed(() => state.selectedId === props.node.id)
const over = computed(() => props.dragOverId === props.node.id)
const editing = computed(() => props.editingId === props.node.id)
</script>

<template>
  <div class="wrap">
    <div
      class="node"
      :class="{ selected, over, folder: node.type === 'folder' }"
      :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
      draggable="true"
      @click="emit('select', node)"
      @dblclick="emit('rename', node)"
      @dragstart="emit('dragstart-node', $event, node)"
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
        :value="node.name"
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
        @select="(n) => emit('select', n)"
        @toggle="(id) => emit('toggle', id)"
        @rename="(n) => emit('rename', n)"
        @commit="(id, name) => emit('commit', id, name)"
        @cancel-edit="emit('cancel-edit')"
        @dragstart-node="(e, n) => emit('dragstart-node', e, n)"
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

.node.selected {
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.node.over {
  background: #dfe9ff;
  box-shadow: inset 0 0 0 1px var(--accent);
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
}
</style>
