<script setup lang="ts">
/**
 * PDF 预览（pdf.js 本地渲染 · 连续滚动模式）
 *
 * 四条约束：
 *   1. 明文只在内存里：数据由父组件从 IPC 拿到后直接传进来，用完即弃，绝不落盘
 *   2. 全程离线：worker / cmaps / 标准字体 / wasm 解码器全部走打包产物，不访问任何远端
 *   3. 交给 pdf.js 的是副本：它内部可能把 Uint8Array 的底层 buffer 转移给 worker
 *   4. 惰性渲染：只有滚到可视区的页面才画，几百页的 PDF 也不会卡死
 */
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** 这些资源由 scripts/prepare-pdf-assets.mjs 复制到 public/pdf 下 */
const ASSET_BASE = 'pdf/'

const props = defineProps<{ data: Uint8Array; name: string }>()

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>>

const doc = shallowRef<PdfDoc | null>(null)
const stage = ref<HTMLDivElement | null>(null)

const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const pageNo = ref(1)
const scale = ref(1)
const fitWidth = ref(true)
const rotation = ref(0)

/** 每页的渲染状态。version 变了说明缩放/旋转变了，旧画布要重画 */
const renderVersion = ref(0)
const pageRendered = new Map<number, number>()

/** 占位尺寸：打开后取第 1 页的原始宽高，让占位 DIV 提前占住位置，滚动条不跳 */
const pageSize = ref({ width: 595, height: 842 })

const percent = computed(() => Math.round(scale.value * 100))

let renderTask: { cancel: () => void } | null = null
let observer: IntersectionObserver | null = null
let scrollRaf = 0
const pageWrappers = new Map<number, HTMLDivElement>()
const pageCanvases = new Map<number, HTMLCanvasElement>()

async function closeDoc() {
  renderTask?.cancel()
  renderTask = null
  observer?.disconnect()
  observer = null
  pageWrappers.clear()
  pageCanvases.clear()
  pageRendered.clear()
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
  renderVersion.value++
  pageRendered.clear()

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

    const first = await opened.getPage(1)
    const vp = first.getViewport({ scale: 1 })
    pageSize.value = { width: vp.width, height: vp.height }

    await nextTick()
    setupObserver()
    // 初始渲染视口内的页
    void renderVisible()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

/** 可视区检测：进入/离开视口时按需渲染 */
function setupObserver() {
  if (!stage.value) return
  observer = new IntersectionObserver(
    (entries) => {
      let touched = false
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const idx = Number((entry.target as HTMLElement).dataset.page)
        if (pageRendered.get(idx) !== renderVersion.value) {
          void drawPage(idx)
          touched = true
        }
      }
      if (touched) updateCurrentPage()
    },
    { root: stage.value, rootMargin: '120% 0px' },
  )
  for (const el of pageWrappers.values()) observer.observe(el)
}

/** 计算第 idx 页（1 起）的缩放 */
function scaleFor(idx: number): number {
  if (fitWidth.value && stage.value) {
    return Math.min(4, Math.max(0.25, (stage.value.clientWidth - 40) / pageSize.value.width))
  }
  return scale.value
}

const renderQueue: number[] = []
let rendering = false

async function drawPage(idx: number) {
  const pdf = doc.value
  if (!pdf || idx < 1 || idx > pageCount.value) return
  if (pageRendered.get(idx) === renderVersion.value) return
  pageRendered.set(idx, renderVersion.value)
  renderQueue.push(idx)
  void processQueue()
}

async function processQueue() {
  if (rendering) return
  rendering = true
  try {
    while (renderQueue.length) {
      const idx = renderQueue.shift()!
      const version = renderVersion.value
      const canvas = pageCanvases.get(idx)
      const wrap = pageWrappers.get(idx)
      if (!canvas || !wrap) continue
      // 早已滚出视口且版本一致（无需重画）就跳过
      if (!isNearViewport(wrap) && pageRendered.get(idx) === version && canvas.width > 0) continue

      const pdf = doc.value
      if (!pdf) break
      const page = await pdf.getPage(idx)
      const s = scaleFor(idx)
      const viewport = page.getViewport({ scale: s, rotation: rotation.value })

      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      const holder = canvas.parentElement
      if (holder) {
        holder.style.width = `${Math.floor(viewport.width)}px`
        holder.style.height = `${Math.floor(viewport.height)}px`
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, viewport.width, viewport.height)

      renderTask?.cancel()
      const task = page.render({ canvasContext: ctx, viewport })
      renderTask = task
      try {
        await task.promise
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        if (name !== 'RenderingCancelledException') {
          error.value = err instanceof Error ? err.message : String(err)
        }
      } finally {
        renderTask = null
      }
    }
  } finally {
    rendering = false
  }
}

function isNearViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  const root = stage.value?.getBoundingClientRect()
  if (!root) return false
  const margin = root.height * 2
  return rect.bottom > root.top - margin && rect.top < root.bottom + margin
}

/** 初始渲染当前视口内的页 */
function renderVisible() {
  for (const [idx, el] of pageWrappers) {
    if (isNearViewport(el)) void drawPage(idx)
  }
  updateCurrentPage()
}

/** 滚动时更新页码指示 + 惰性渲染（rAF 节流） */
function onScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    renderVisible()
    updateCurrentPage()
  })
}

function updateCurrentPage() {
  const root = stage.value
  if (!root) return
  const mid = root.scrollTop + root.clientHeight / 2
  let best = 1
  let bestDist = Infinity
  for (const [idx, el] of pageWrappers) {
    const top = el.offsetTop
    const bottom = top + el.offsetHeight
    const dist = mid < top ? top - mid : mid > bottom ? mid - bottom : 0
    if (dist < bestDist) {
      bestDist = dist
      best = idx
    }
  }
  pageNo.value = best
}

/** 滚到指定页 */
function jumpTo(value: string) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return
  goToPage(Math.min(pageCount.value, Math.max(1, n)))
}

function goToPage(n: number) {
  const el = pageWrappers.get(n)
  if (el && stage.value) {
    stage.value.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
    pageNo.value = n
  }
}

function pageDelta(delta: number) {
  goToPage(Math.min(pageCount.value, Math.max(1, pageNo.value + delta)))
}

/** 缩放/旋转改变：所有旧画布作废，重画可视区 */
function invalidateAll() {
  renderVersion.value++
  pageRendered.clear()
  void nextTick(() => renderVisible())
}

function zoom(delta: number) {
  fitWidth.value = false
  scale.value = Math.min(4, Math.max(0.25, Number((scale.value + delta).toFixed(2))))
  invalidateAll()
}

function fit() {
  fitWidth.value = true
  invalidateAll()
}

function rotate() {
  rotation.value = (rotation.value + 90) % 360
  invalidateAll()
}

function setWrapper(el: unknown, idx: number) {
  if (el instanceof HTMLDivElement) pageWrappers.set(idx, el)
  else pageWrappers.delete(idx)
}

function setCanvas(el: unknown, idx: number) {
  if (el instanceof HTMLCanvasElement) pageCanvases.set(idx, el)
  else pageCanvases.delete(idx)
}

/** 适应宽度模式下占位 DIV 的高度估算 */
function placeholderHeight(idx: number): number {
  const s = scaleFor(idx)
  // 旋转 90/270 时宽高对调
  const rot = rotation.value % 180 !== 0
  const h = rot ? pageSize.value.width : pageSize.value.height
  return Math.floor(h * s)
}

watch(() => props.data, open, { immediate: true })

onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  observer?.disconnect()
  observer = null
  void closeDoc()
})
</script>

<template>
  <div class="pdf">
    <div class="pdfbar">
      <button class="tb" :disabled="pageNo <= 1" @click="pageDelta(-1)">‹</button>
      <span class="pager">
        <input
          class="pageno"
          :value="pageNo"
          @change="jumpTo(($event.target as HTMLInputElement).value)"
          @keydown.enter="jumpTo(($event.target as HTMLInputElement).value)"
        />
        <span class="total">/ {{ pageCount || '—' }}</span>
      </span>
      <button class="tb" :disabled="pageNo >= pageCount" @click="pageDelta(1)">›</button>

      <span class="gap" />

      <button class="tb" :disabled="!fitWidth && scale <= 0.25" @click="zoom(-0.25)">−</button>
      <span class="zoom">{{ fitWidth ? '适应' : percent + '%' }}</span>
      <button class="tb" :disabled="!fitWidth && scale >= 4" @click="zoom(0.25)">＋</button>
      <button class="tb wide" :class="{ on: fitWidth }" @click="fit">适应宽度</button>
      <button class="tb wide" @click="rotate">旋转</button>
    </div>

    <div ref="stage" class="stage" @scroll.passive="onScroll">
      <div v-if="loading" class="hint">正在解析 PDF…</div>
      <div v-else-if="error" class="hint err">PDF 解析失败：{{ error }}</div>
      <div v-else class="pages">
        <div
          v-for="i in pageCount"
          :key="i"
          :ref="(el) => setWrapper(el, i)"
          class="pagewrap"
          :style="{ height: placeholderHeight(i) + 'px' }"
        >
          <canvas :ref="(el) => setCanvas(el, i)" class="page" />
        </div>
      </div>
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
  background: var(--panel-2);
}

.tb {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 5px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}

.tb.wide {
  min-width: 60px;
}

.tb:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.tb:disabled {
  opacity: 0.4;
  cursor: default;
}

.tb.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
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
  background: var(--panel);
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
  overflow-y: auto;
  overflow-x: auto;
  background: var(--stage);
  padding: 16px 0;
  display: flex;
  justify-content: safe center;
}

.pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  min-width: 100%;
  width: fit-content;
  padding: 0 16px;
}

.pagewrap {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.page {
  background: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 14px var(--dropdown-shadow);
  display: block;
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
