<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { useVault } from '../composables/useVault'
import { formatSize, formatTime, previewKind, PREVIEW_LABEL } from '../utils/format'
import { pathOf } from '../utils/tree'
import PdfPreview from './PdfPreview.vue'

const { state } = useVault()

const md = new MarkdownIt({ html: true, linkify: false, breaks: false })

const loading = ref(false)
const error = ref('')
const data = ref<Uint8Array | null>(null)
const objectUrl = ref<string | null>(null)

const node = computed(() => state.nodes.find((n) => n.id === state.selectedId) ?? null)
const kind = computed(() => (node.value ? previewKind(node.value.ext) : 'unknown'))
const crumbs = computed(() => (node.value ? pathOf(state.nodes, node.value.id) : []))

const text = computed(() => {
  if (!data.value || kind.value !== 'text') return ''
  // 超大文本只渲染前 512KB，避免把渲染进程卡死
  const slice = data.value.length > 512 * 1024 ? data.value.subarray(0, 512 * 1024) : data.value
  return new TextDecoder('utf-8').decode(slice)
})

const markdownHtml = computed(() => {
  if (!data.value || kind.value !== 'markdown') return ''
  const raw = new TextDecoder('utf-8').decode(data.value)
  // 文件内容不可信，渲染前必须消毒：否则一个恶意 md 就能执行脚本
  return DOMPurify.sanitize(md.render(raw), { USE_PROFILES: { html: true } })
})

function revoke() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = null
  }
}

async function load() {
  revoke()
  data.value = null
  error.value = ''
  const target = node.value
  if (!target || target.type !== 'file') return

  loading.value = true
  try {
    const res = await window.api.readFile(target.id)
    if (!res.ok) {
      error.value = res.error
      return
    }
    data.value = res.data
    if (kind.value === 'image' || kind.value === 'audio' || kind.value === 'video') {
      const mime = guessMime(target.ext ?? '')
      objectUrl.value = URL.createObjectURL(new Blob([res.data], { type: mime }))
    }
  } finally {
    loading.value = false
  }
}

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
  }
  return map[ext] ?? 'application/octet-stream'
}

watch(() => state.selectedId, load, { immediate: true })

// 切换文件时擦掉上一份明文，锁定时由主进程清空密钥、这里清空渲染侧副本
watch(
  () => state.locked,
  (locked) => {
    if (locked) {
      revoke()
      data.value = null
    }
  },
)

onUnmounted(revoke)
</script>

<template>
  <section class="preview">
    <div class="bar">
      <div class="crumbs">
        <template v-if="crumbs.length">
          <span v-for="(c, i) in crumbs" :key="c.id">
            <span :class="{ last: i === crumbs.length - 1 }">{{ c.name }}</span>
            <span v-if="i < crumbs.length - 1" class="sep">/</span>
          </span>
        </template>
        <span v-else class="ph">未选择文件</span>
      </div>
      <div class="spacer" />
      <span class="badge">内存中解密 · 不落盘</span>
    </div>

    <div v-if="!node" class="center muted">
      <div class="big">📄</div>
      <p>在左侧选择一个文件查看内容</p>
      <p class="sub">支持 PDF / TXT / Markdown / 图片 / 音频，Office 文档可导出后打开</p>
    </div>

    <div v-else-if="node.type === 'folder'" class="center muted">
      <div class="big">📁</div>
      <p class="name">{{ node.name }}</p>
      <p class="sub">
        共 {{ state.nodes.filter((n) => n.parentId === node.id).length }} 个直接子项
      </p>
    </div>

    <div v-else class="content" :class="{ pdfmode: kind === 'pdf' }">
      <div v-if="loading" class="center muted">正在解密…</div>

      <div v-else-if="error" class="center">
        <p class="err">{{ error }}</p>
      </div>

      <div v-else-if="kind === 'image'" class="center imgwrap">
        <img v-if="objectUrl" :src="objectUrl" :alt="node.name" />
      </div>

      <div v-else-if="kind === 'audio'" class="center">
        <audio v-if="objectUrl" :src="objectUrl" controls class="player" />
        <p class="sub">{{ node.name }}</p>
      </div>

      <pre v-else-if="kind === 'text'" class="text">{{ text }}</pre>

      <!-- 内容已在上一步经 DOMPurify 消毒 -->
      <article v-else-if="kind === 'markdown'" class="markdown" v-html="markdownHtml" />

      <PdfPreview
        v-else-if="kind === 'pdf' && data"
        :data="data"
        :name="node.name"
      />

      <div v-else-if="kind === 'office'" class="center">
        <div class="big">📊</div>
        <p class="name">{{ node.name }}</p>
        <p class="sub">
          {{ PREVIEW_LABEL.office }}预览将在下一版本接入本地渲染引擎，<br />当前可先导出后用 Office /
          WPS 打开
        </p>
      </div>

      <div v-else-if="kind === 'video'" class="center">
        <div class="big">🎬</div>
        <p class="name">{{ node.name }}</p>
        <p class="sub">视频预览将在下一版本接入流式解密后支持</p>
      </div>

      <div v-else class="center">
        <div class="big">🗂</div>
        <p class="name">{{ node.name }}</p>
        <p class="sub">该格式暂不支持预览，可导出后使用其他程序打开</p>
      </div>
    </div>

    <div v-if="node && node.type === 'file'" class="meta">
      <span>{{ PREVIEW_LABEL[kind] }}</span>
      <span class="dot">·</span>
      <span>{{ formatSize(node.size) }}</span>
      <span class="dot">·</span>
      <span>{{ formatTime(node.updatedAt) }}</span>
    </div>
  </section>
</template>

<style scoped>
.preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.bar {
  height: 32px;
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line-soft);
}

.crumbs {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumbs .last {
  color: var(--text);
  font-weight: 500;
}

.crumbs .sep {
  margin: 0 5px;
  color: var(--faint);
}

.ph {
  color: var(--faint);
}

.spacer {
  flex: 1;
}

.badge {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--ok);
  background: #eefaf1;
  border: 1px solid #cdeed8;
  border-radius: 10px;
  padding: 1px 8px;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

/* PDF 自带翻页滚动区，外层不能再滚一次，否则会出现双滚动条 */
.content.pdfmode {
  overflow: hidden;
}

.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.big {
  font-size: 40px;
  opacity: 0.5;
}

.muted {
  color: var(--faint);
}

.name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}

.sub {
  font-size: 12px;
  color: var(--faint);
  line-height: 1.8;
}

.err {
  color: var(--danger);
  font-size: 12.5px;
}

.imgwrap {
  padding: 16px;
  background: #fafbfd;
}

.imgwrap img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(20, 26, 40, 0.12);
}

.player {
  width: 420px;
  max-width: 100%;
}

.text {
  flex: 1;
  margin: 0;
  padding: 14px 16px;
  font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
}

.markdown {
  padding: 20px 26px;
  font-size: 13.5px;
  line-height: 1.85;
  max-width: 860px;
}

.markdown :deep(h1) {
  font-size: 21px;
  margin: 18px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}

.markdown :deep(h2) {
  font-size: 17px;
  margin: 16px 0 8px;
}

.markdown :deep(h3) {
  font-size: 15px;
  margin: 14px 0 6px;
}

.markdown :deep(p) {
  margin: 8px 0;
}

.markdown :deep(code) {
  background: var(--line-soft);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12.5px;
}

.markdown :deep(pre) {
  background: #f7f8fb;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 11px 13px;
  overflow: auto;
}

.markdown :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown :deep(blockquote) {
  border-left: 3px solid var(--line);
  margin: 10px 0;
  padding: 2px 12px;
  color: var(--muted);
}

.markdown :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
}

.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--line);
  padding: 5px 10px;
}

.markdown :deep(img) {
  max-width: 100%;
}

.meta {
  flex: 0 0 24px;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 12px;
  border-top: 1px solid var(--line-soft);
  font-size: 11px;
  color: var(--faint);
}

.dot {
  opacity: 0.5;
}
</style>
