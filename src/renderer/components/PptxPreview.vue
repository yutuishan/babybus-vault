<script setup lang="ts">
/**
 * PPT（pptx）预览：pptx-preview 本地渲染。
 * 该库以 DOM 注入方式渲染幻灯片，容器由我们提供，样式隔离在 .pptxhost 内。
 */
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ data: Uint8Array; name: string }>()

const host = ref<HTMLDivElement | null>(null)
const loading = ref(true)
const error = ref('')
let previewer: {
  preview: (ab: ArrayBuffer) => Promise<unknown>
  destroy?: () => void
} | null = null

async function render() {
  loading.value = true
  error.value = ''
  try {
    const mod = await import('pptx-preview')
    const init = mod.init
    if (!host.value) return
    host.value.innerHTML = ''
    previewer = init(host.value, { width: 920, height: 518, mode: 'list' })
    const copy = new Uint8Array(props.data)
    const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    await previewer.preview(ab)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => props.data, render, { immediate: true })

onBeforeUnmount(() => {
  try {
    previewer?.destroy?.()
  } catch {
    // 忽略清理异常
  }
  previewer = null
})
</script>

<template>
  <div class="pptx">
    <div class="area">
      <div v-if="loading && !error" class="hint">正在解析幻灯片…</div>
      <div v-else-if="error" class="hint err">
        解析失败：{{ error }}<br />
        <span class="sub">可导出后用 PowerPoint / WPS 打开</span>
      </div>
      <div v-show="!error" ref="host" class="pptxhost" />
    </div>
  </div>
</template>

<style scoped>
.pptx {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--stage);
}

.area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding: 18px 0;
}

.hint {
  margin: auto;
  text-align: center;
  font-size: 12.5px;
  color: var(--faint);
}

.hint.err {
  color: var(--danger);
}

.hint .sub {
  font-size: 11.5px;
  color: var(--faint);
}

.pptxhost {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}

.pptxhost :deep(img),
.pptxhost :deep(canvas),
.pptxhost :deep(svg) {
  max-width: 100%;
}
</style>
