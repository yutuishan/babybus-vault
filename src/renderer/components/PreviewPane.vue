<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { mediaMime } from '@shared/media'
import { useVault } from '../composables/useVault'
import { formatSize, formatTime, previewKind, PREVIEW_LABEL } from '../utils/format'
import { pathOf } from '../utils/tree'
import PdfPreview from './PdfPreview.vue'
import DocxPreview from './DocxPreview.vue'
import SheetPreview from './SheetPreview.vue'
import PptxPreview from './PptxPreview.vue'

const { state } = useVault()

const md = new MarkdownIt({ html: true, linkify: false, breaks: false })

const loading = ref(false)
const error = ref('')
const data = ref<Uint8Array | null>(null)
const objectUrl = ref<string | null>(null)
/**
 * 音视频走 `vault://` 流式协议，而不是把整份文件解密过 IPC。
 * 一个 1GB 的视频整包读进来会让主进程 OOM，且 Blob URL 无法拖动进度条 ——
 * 自定义协议带 Range 支持，Chromium 会自己按需取分片（见主进程 vault/mediaProtocol.ts）。
 */
const mediaUrl = ref('')
/** 容器认得、但内核解不了码（典型：mkv 里塞 H.265）。由元素的 error 事件触发 */
const mediaError = ref('')
/** 旧版 doc 的纯文本（主进程提取，渲染端不解二进制格式） */
const docText = ref('')
/** doc 文本提取中的错误，与 content 预览的 error 分开，避免相互覆盖 */
const docError = ref('')

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
  mediaUrl.value = ''
  mediaError.value = ''
}

async function load() {
  revoke()
  data.value = null
  error.value = ''
  docText.value = ''
  docError.value = ''
  const target = node.value
  if (!target || target.type !== 'file') return

  // 音视频不读整份，直接交给 vault:// 流式协议（带 Range，可拖动进度条，内存与文件大小无关）
  if (kind.value === 'audio' || kind.value === 'video') {
    mediaUrl.value = `vault://media/${encodeURIComponent(target.id)}`
    return
  }

  // 旧版 .doc 是二进制格式，浏览器侧无法解析：走主进程 word-extractor 提取纯文本
  if (previewKind(target.ext) === 'doc') {
    loading.value = true
    try {
      const res = await window.api.extractText(target.id)
      if (!res.ok) {
        docError.value = res.error
        return
      }
      docText.value = res.data
    } catch (err) {
      docError.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
    return
  }

  loading.value = true
  try {
    const res = await window.api.readFile(target.id)
    if (!res.ok) {
      error.value = res.error
      return
    }
    data.value = res.data
    if (kind.value === 'image') {
      objectUrl.value = URL.createObjectURL(new Blob([res.data], { type: mediaMime(target.ext) }))
    }
  } finally {
    loading.value = false
  }
}

/**
 * 播放失败的回调。
 *
 * error 事件有两类完全不同的成因，出路也不一样，不能混为一谈：
 *   1. 解不了码（典型：mkv 里塞 H.265）→ 导出后用本地播放器；
 *   2. 根本读不到（协议被 CSP 拦下、库已锁、文件被外部改动）→ 先排查环境。
 *
 * 之前不管哪种情况都说"内核无法解码这个文件的音视频编码"，把第 2 类也说成第 1 类。
 * 这个误导性很强：mp3/mp4 是 Chromium 铁定支持的格式，它们报这句话就说明
 * 问题根本不在编码上 —— 实际上当时是 CSP 把 vault:// 拦掉了（见 index.html 的注释）。
 * 现在按 MediaError.code 分流，并把原始信息打到控制台备查。
 */
function onMediaError(e: Event) {
  const el = e.target as HTMLMediaElement | null
  const err = el?.error
  const code = err?.code ?? 0
  const detail = (err as { message?: string } | null)?.message ?? ''
  // 留在控制台：用户截图反馈时能直接看到底层原因
  console.warn('[preview] media error', code, detail)

  if (code === 1 || code === 2) {
    // MEDIA_ERR_ABORTED / MEDIA_ERR_NETWORK：数据没拿到
    mediaError.value =
      '读取这个文件失败：可能是文件库已锁定，或文件被外部程序改动过。刷新文件库后重试，或导出后用本地播放器打开'
  } else if (code === 3) {
    // MEDIA_ERR_DECODE：拿到了数据但解不开
    mediaError.value = '这个文件的音视频编码当前内核解不了，可导出后使用本地播放器打开'
  } else {
    // MEDIA_ERR_SRC_NOT_SUPPORTED：既可能是编码不支持，也可能是加载被策略拦下
    mediaError.value =
      '无法播放这个文件：可能是编码当前内核不支持，也可能是文件已被外部改动。可导出后使用本地播放器打开'
  }
}

watch(() => state.selectedId, load, { immediate: true })

// 切换文件时擦掉上一份明文，锁定时由主进程清空密钥、这里清空渲染侧副本
watch(
  () => state.locked,
  (locked) => {
    if (locked) {
      revoke()
      data.value = null
      docText.value = ''
      docError.value = ''
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
      <p class="sub">支持 PDF / Word / Excel / PPT / TXT / Markdown / 图片 / 音频 / 视频</p>
    </div>

    <div v-else-if="node.type === 'folder'" class="center muted">
      <div class="big">📁</div>
      <p class="name">{{ node.name }}</p>
      <p class="sub">
        共 {{ state.nodes.filter((n) => n.parentId === node.id).length }} 个直接子项
      </p>
    </div>

    <div v-else class="content" :class="{ pdfmode: kind === 'pdf' }">      <div v-if="loading" class="center muted">正在解密…</div>

      <div v-else-if="error" class="center">
        <p class="err">{{ error }}</p>
      </div>

      <div v-else-if="kind === 'image'" class="center imgwrap">
        <img v-if="objectUrl" :src="objectUrl" :alt="node.name" />
      </div>

      <div v-else-if="kind === 'audio'" class="center">
        <template v-if="mediaError">
          <div class="big">🎵</div>
          <p class="name">{{ node.name }}</p>
          <p class="sub err">{{ mediaError }}</p>
        </template>
        <template v-else>
          <!--
            播放器控件刻意关掉下载与投屏：
            - nodownload：Chromium 原生控件的 ⋮ 菜单里有「下载」，会绕开文件库直接落盘明文；
              右键菜单的「另存音频为…」同理，所以一并拦掉 contextmenu。
            - noremoteplayback：投屏会把解密后的明文送到外部设备，和「明文不落盘」直接冲突。
          -->
          <audio
            :src="mediaUrl"
            controls
            controlslist="nodownload noremoteplayback"
            class="player"
            @error="onMediaError"
            @contextmenu.prevent
          />
          <p class="name">{{ node.name }}</p>
          <p class="sub">边解密边播放，明文只在内存中经过</p>
        </template>
      </div>

      <pre v-else-if="kind === 'text'" class="text">{{ text }}</pre>

      <!-- 旧版 .doc：主进程已提取为纯文本，按不可信文本原样展示 -->
      <div v-else-if="kind === 'doc'" class="doc-text">
        <div class="doc-note">
          旧版 Word 97-2003 格式，仅提取文字内容预览（不含排版与图片），可导出后用 Word / WPS 打开查看完整效果
        </div>
        <p v-if="docError" class="err doc-err">{{ docError }}</p>
        <pre v-else class="text">{{ docText }}</pre>
      </div>

      <!-- 内容已在上一步经 DOMPurify 消毒 -->
      <article v-else-if="kind === 'markdown'" class="markdown" v-html="markdownHtml" />

      <PdfPreview
        v-else-if="kind === 'pdf' && data"
        :data="data"
        :name="node.name"
      />

      <DocxPreview
        v-else-if="kind === 'docx' && data"
        :data="data"
        :name="node.name"
      />

      <SheetPreview
        v-else-if="kind === 'sheet' && data"
        :data="data"
        :name="node.name"
      />

      <PptxPreview
        v-else-if="kind === 'slides' && data"
        :data="data"
        :name="node.name"
      />

      <div v-else-if="kind === 'office'" class="center">
        <div class="big">📊</div>
        <p class="name">{{ node.name }}</p>
        <p class="sub">
          该 Office 格式（ppt / odt / ods / odp）暂不支持预览，<br />可导出后用 Office / WPS 打开
        </p>
      </div>

      <div v-else-if="kind === 'video'" class="center">
        <template v-if="mediaError">
          <div class="big">🎬</div>
          <p class="name">{{ node.name }}</p>
          <p class="sub err">{{ mediaError }}</p>
        </template>
        <template v-else>
          <!-- 同音频：关掉下载与投屏，理由见上面 audio 处的注释 -->
          <video
            :src="mediaUrl"
            controls
            controlslist="nodownload noremoteplayback"
            class="video"
            @error="onMediaError"
            @contextmenu.prevent
          />
          <p class="name">{{ node.name }}</p>
          <p class="sub">边解密边播放，可拖动进度条；明文只在内存中经过</p>
        </template>
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
  background: var(--panel);
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
  background: var(--ok-soft);
  border: 1px solid var(--ok-line);
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

/*
 * PDF 自带翻页滚动区，外层不能再滚一次，否则会出现双滚动条。
 * min-width/min-height 归零很关键：flex 子项的默认 min-height:auto 会让
 * PdfPreview 的 .stage 撑到内容高度，clientHeight 就读不到真实的可视高度，
 * 「适应高度」会算出一个偏大的 scale，页面被裁掉一截。
 */
.content.pdfmode {
  overflow: hidden;
}

.content.pdfmode > * {
  min-height: 0;
  min-width: 0;
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
  background: var(--panel-3);
}

.imgwrap img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 2px 12px var(--dropdown-shadow);
}

.player {
  width: 420px;
  max-width: 100%;
}

.video {
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  background: #000;
  border-radius: 6px;
  box-shadow: 0 2px 14px var(--dropdown-shadow);
}

.sub.err {
  color: var(--danger);
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

.doc-text {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.doc-note {
  padding: 8px 16px;
  font-size: 11.5px;
  color: var(--faint);
  border-bottom: 1px solid var(--line-soft);
}

.doc-err {
  padding: 16px;
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
  background: var(--panel-3);
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
