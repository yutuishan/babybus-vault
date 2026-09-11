<script setup lang="ts">
/**
 * Word（docx）预览：mammoth 转 HTML + DOMPurify 消毒。
 * 明文只在内存（props.data），渲染完即弃。
 */
import { ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import mammoth from 'mammoth/mammoth.browser'

const props = defineProps<{ data: Uint8Array; name: string }>()

const html = ref('')
const loading = ref(true)
const error = ref('')

async function render() {
  loading.value = true
  error.value = ''
  html.value = ''
  try {
    const copy = new Uint8Array(props.data)
    const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    const res = await mammoth.convertToHtml({ arrayBuffer: ab })
    // 文档内容不可信，渲染前必须消毒
    html.value = DOMPurify.sanitize(res.value, { USE_PROFILES: { html: true } })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(() => props.data, render, { immediate: true })
</script>

<template>
  <div class="docx">
    <div v-if="loading" class="hint">正在解析 Word 文档…</div>
    <div v-else-if="error" class="hint err">解析失败：{{ error }}</div>
    <!-- 内容已经过 DOMPurify 消毒 -->
    <article v-else class="doc" v-html="html" />
  </div>
</template>

<style scoped>
.docx {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--panel);
}

.hint {
  margin: auto;
  text-align: center;
  font-size: 12.5px;
  color: var(--faint);
  padding: 40px;
}

.hint.err {
  color: var(--danger);
}

.doc {
  max-width: 860px;
  margin: 0 auto;
  padding: 28px 34px;
  font-size: 13.5px;
  line-height: 1.9;
  color: var(--text);
}

.doc :deep(h1) {
  font-size: 20px;
  margin: 20px 0 10px;
}

.doc :deep(h2) {
  font-size: 17px;
  margin: 16px 0 8px;
}

.doc :deep(h3) {
  font-size: 15px;
  margin: 14px 0 6px;
}

.doc :deep(p) {
  margin: 8px 0;
}

.doc :deep(table) {
  border-collapse: collapse;
  margin: 12px 0;
}

.doc :deep(td),
.doc :deep(th) {
  border: 1px solid var(--line);
  padding: 5px 10px;
  font-size: 12.5px;
}

.doc :deep(img) {
  max-width: 100%;
}

.doc :deep(ul),
.doc :deep(ol) {
  padding-left: 22px;
  margin: 8px 0;
}

.doc :deep(blockquote) {
  border-left: 3px solid var(--line);
  margin: 10px 0;
  padding: 2px 12px;
  color: var(--muted);
}
</style>
