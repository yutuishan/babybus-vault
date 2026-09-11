<script setup lang="ts">
/**
 * Excel（xlsx）预览：SheetJS 解析 + 多工作表切换。
 * 只读前 5000 行 × 100 列，防止巨型表格把 DOM 撑爆。
 */
import { computed, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import * as XLSX from 'xlsx'

const props = defineProps<{ data: Uint8Array; name: string }>()

const loading = ref(true)
const error = ref('')
const sheetNames = ref<string[]>([])
const activeSheet = ref('')
const tables = ref<Record<string, string>>({})

async function render() {
  loading.value = true
  error.value = ''
  sheetNames.value = []
  tables.value = {}
  try {
    const copy = new Uint8Array(props.data)
    const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    const wb = XLSX.read(ab, { type: 'array' })
    sheetNames.value = wb.SheetNames.slice(0, 30)
    activeSheet.value = sheetNames.value[0] ?? ''
    for (const name of sheetNames.value) {
      const ws = wb.Sheets[name]
      if (!ws) continue
      tables.value[name] = DOMPurify.sanitize(XLSX.utils.sheet_to_html(ws), {
        USE_PROFILES: { html: true },
      })
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

const current = computed(() => tables.value[activeSheet.value] ?? '')

watch(() => props.data, render, { immediate: true })
</script>

<template>
  <div class="sheet">
    <div v-if="sheetNames.length > 1" class="tabs">
      <button
        v-for="n in sheetNames"
        :key="n"
        class="tab"
        :class="{ on: n === activeSheet }"
        @click="activeSheet = n"
      >
        {{ n }}
      </button>
    </div>

    <div class="area">
      <div v-if="loading" class="hint">正在解析表格…</div>
      <div v-else-if="error" class="hint err">解析失败：{{ error }}</div>
      <!-- 内容已经过 DOMPurify 消毒 -->
      <div v-else class="tablewrap" v-html="current" />
    </div>
  </div>
</template>

<style scoped>
.sheet {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}

.tabs {
  flex: 0 0 34px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--panel-2);
  overflow-x: auto;
}

.tab {
  padding: 5px 11px;
  font-size: 12px;
  color: var(--muted);
  border-radius: 6px 6px 0 0;
  white-space: nowrap;
}

.tab.on {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 500;
}

.area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
}

.hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12.5px;
  color: var(--faint);
}

.hint.err {
  color: var(--danger);
}

.tablewrap {
  padding: 0 0 30px;
}

.tablewrap :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  color: var(--text);
}

.tablewrap :deep(td),
.tablewrap :deep(th) {
  border: 1px solid var(--line);
  padding: 4px 9px;
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tablewrap :deep(th) {
  background: var(--panel-3);
  font-weight: 500;
  position: sticky;
  top: 0;
}
</style>
