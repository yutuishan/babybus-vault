<script setup lang="ts">
/**
 * PDF 预览（pdf.js 本地渲染）
 *
 * 三条约束：
 *   1. 明文只在内存里：数据由父组件从 IPC 拿到后直接传进来，用完即弃，绝不落盘
 *   2. 全程离线：worker / cmaps / 标准字体 / wasm 解码器全部走打包产物，不访问任何远端
 *   3. 交给 pdf.js 的是副本：它内部可能把 Uint8Array 的底层 buffer 转移给 worker，
 *      直接把父组件的引用传过去会让调用方手上的数组变成空
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** 这些资源由 scripts/prepare-pdf-assets.mjs 复制到 public/pdf 下 */
const ASSET_BASE = 'pdf/'

const props = defineProps<{ data: Uint8Array; name: string }>()

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>>

const doc = shallowRef<PdfDoc | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLDivElement | null>(null)

const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const pageNo = ref(1)
const scale = ref(1)
const fitWidth = ref(true)
const rotation = ref(0)
const rendering = ref(false)

/** 当前页渲染任务，切页时必须取消，否则快速翻页会串页 */
let renderTask: { cancel: () => void } | null = null

const percent = computed(() => Math.round(scale.value * 100))

async function closeDoc() {
  renderTask?.cancel()
  renderTask = null
  try {
    await doc.value?.destroy()
  } catch {
    // destroy 失败不影响后续，忽略
  }
  doc.value = null
}

async function open() {
  await closeDoc()
  loading.value = true
  error.value = ''
  pageCount.value = 0
  pageNo.value = 1

  try {
    const copy = new Uint8Array(props.data)
    const task = pdfjs.getDocument({
      data: copy,
      cMapUrl: `${ASSET_BASE}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
      wasmUrl: `${ASSET_BASE}wasm/`,
      // 保险箱里不应有任何外部交互，PDF 里的 JS / 表单 / 签章一律不执行
      isEvalSupported: false,
      enableXfa: false,
    })
    const opened = await task.promise
    doc.value = opened
    pageCount.value = opened.numPages
    await draw()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function draw() {
  const pdf = doc.value
  const el = canvas.value
  if (!pdf || !el) return

  renderTask?.cancel()

  const page = await pdf.getPage(pageNo.value)

  // 适应宽度：按容器可用宽度算缩放，左右各留 16px 余量免得贴边
  if (fitWidth.value && wrap.value) {
    const base = page.getViewport({ scale: 1, rotation: rotation.value })
    const avail = Math.max(240, wrap.value.clientWidth - 32)
    scale.value = Math.min(4, Math.max(0.25, avail / base.width))
  }

  const viewport = page.getViewport({ scale: scale.value, rotation: rotation.value })
  const dpr = Math.min(2, window.devicePixelRatio || 1)

  el.width = Math.floor(viewport.width * dpr)
  el.height = Math.floor(viewport.height * dpr)
  el.style.width = `${Math.floor(viewport.width)}px`
  el.style.height = `${Math.floor(viewport.height)}px`

  const ctx = el.getContext('2d')
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, viewport.width, viewport.height)

  rendering.value = true
  const task = page.render({ canvasContext: ctx, viewport })
  renderTask = task
  try {
    await task.promise
  } catch (err) {
    // 主动取消不算错误，静默即可
    const name = (err as { name?: string } | null)?.name
    if (name !== 'RenderingCancelledException') {
      error.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    renderTask = null
    rendering.value = false
  }
}

function go(delta: number) {
  const next = pageNo.value + delta
  if (next < 1 || next > pageCount.value) return
  pageNo.value = next
  void draw()
}

function jumpTo(value: string) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return
  pageNo.value = Math.min(pageCount.value, Math.max(1, n))
  void draw()
}

function zoom(delta: number) {
  fitWidth.value = false
  scale.value = Math.min(4, Math.max(0.25, Number((scale.value + delta).toFixed(2))))
  void draw()
}

function fit() {
  fitWidth.value = true
  void draw()
}

function rotate() {
  rotation.value = (rotation.value + 90) % 360
  void draw()
}

watch(() => props.data, open, { immediate: true })

onBeforeUnmount(() => {
  void closeDoc()
})
</script>

<template>
  <div class="pdf">
    <div class="pdfbar">
      <button class="tb" :disabled="pageCount === 0 || pageNo <= 1" @click="go(-1)">‹</button>
      <span class="pager">
        <input
          class="pageno"
          :value="pageNo"
          @change="jumpTo(($event.target as HTMLInputElement).value)"
        />
        <span class="total">/ {{ pageCount || '—' }}</span>
      </span>
      <button class="tb" :disabled="pageCount === 0 || pageNo >= pageCount" @click="go(1)">›</button>

      <span class="gap" />

      <button class="tb" :disabled="scale <= 0.25" @click="zoom(-0.25)">−</button>
      <span class="zoom">{{ percent }}%</span>
      <button class="tb" :disabled="scale >= 4" @click="zoom(0.25)">＋</button>
      <button class="tb wide" :class="{ on: fitWidth }" @click="fit">适应宽度</button>
      <button class="tb wide" @click="rotate">旋转</button>
    </div>

    <div ref="wrap" class="stage">
      <div v-if="loading" class="hint">正在解析 PDF…</div>
      <div v-else-if="error" class="hint err">PDF 解析失败：{{ error }}</div>
      <canvas v-show="!loading && !error" ref="canvas" class="page" />
    </div>
  </div>
</template>

<style scoped>
.pdf {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pdfbar {
  flex: 0 0 34px;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line-soft);
  background: #fbfcfd;
}

.tb {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--line);
  background: #fff;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}

.tb.wide {
  min-width: 60px;
}

.tb:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand);
}

.tb:disabled {
  opacity: 0.4;
  cursor: default;
}

.tb.on {
  border-color: var(--brand);
  color: var(--brand);
  background: #eef4ff;
}

.pager {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

.pageno {
  width: 42px;
  height: 24px;
  text-align: center;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 12px;
  color: var(--text);
}

.zoom {
  min-width: 44px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.gap {
  flex: 1;
}

.stage {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #f4f6f9;
  padding: 16px;
  display: flex;
  justify-content: center;
}

.page {
  background: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 14px rgba(20, 26, 40, 0.16);
  align-self: flex-start;
}

.hint {
  margin: auto;
  font-size: 12.5px;
  color: var(--faint);
}

.hint.err {
  color: var(--danger);
}
</style>
