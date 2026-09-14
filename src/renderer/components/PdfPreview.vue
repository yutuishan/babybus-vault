<script setup lang="ts">
/**
 * PDF 预览（pdf.js 本地渲染 · 连续滚动模式）
 *
 * 六条约束：
 *   1. 明文只在内存里：数据由父组件从 IPC 拿到后直接传进来，用完即弃，绝不落盘
 *   2. 全程离线：worker / cmaps / 标准字体 / wasm 解码器全部走打包产物，不访问任何远端
 *   3. 交给 pdf.js 的是副本：它内部可能把 Uint8Array 的底层 buffer 转移给 worker
 *   4. 惰性渲染：只有滚到可视区的页面才画，几百页的 PDF 也不会卡死
 *   5. 两种适应模式：**适应高度（默认）**与适应宽度，用户可切换
 *   6. 容器必须有确定尺寸才画得出来 —— 见下方 `waitForStage()`
 *
 * 为什么默认「适应高度」而不是「适应宽度」：
 *   文档预览的第一诉求是"一屏能读完一整页"，横向预留滚动条反而割裂阅读。
 *   需要看小字时再切到适应宽度，或直接 +缩放。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
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
const rotation = ref(0)

/**
 * 适应模式。默认 fit-height —— 见文件头注释。
 * 两种模式的共同点是"都由容器尺寸推导 scale"，区别只是拿宽还是拿高当基准。
 */
type FitMode = 'height' | 'width'
const fitMode = ref<FitMode>('height')

/** 用户手动缩放系数，作用在当前适应模式的基准之上：1 = 正好铺满那个方向 */
const zoomFactor = ref(1)

/** 当前生效的缩放（相对 PDF 原始尺寸），由 computeScale 计算后写入，用于渲染与占位 */
const currentScale = ref(1)

/** 每页的渲染状态。version 变了说明缩放/旋转变了，旧画布要重画 */
const renderVersion = ref(0)
const pageRendered = new Map<number, number>()

/**
 * 每页实际画上去时用的 (scale, rotation)。key 是页号。
 *
 * 必须单独记，不能只靠 `renderVersion` 判断：缩放或旋转变化后
 * renderVersion 会自增、pageRendered 会被清空，但**旧画布的 width/height 仍然是正值**
 * —— 如果只用 `canvas.width > 0` 当作"画好了"，切换到适应宽度后这一页会被
 * 误判成无需重画，于是停留在旧尺寸上（实测切模式后第 1 页仍是 300×150，
 * 第 2 页却是正确的 822×1096，同一屏里两种尺寸并存）。
 */
const pageDrawnAt = new Map<number, string>()

/** 当前这一代渲染应该用的尺寸指纹 */
function stampOf(): string {
  return `${currentScale.value.toFixed(4)}|${rotation.value}`
}

/** 占位尺寸：打开后取第 1 页的原始宽高，让占位 DIV 提前占住位置，滚动条不跳 */
const pageSize = ref({ width: 595, height: 842 })

const percent = computed(() => Math.round(zoomFactor.value * 100))
const modeLabel = computed(() => (fitMode.value === 'height' ? '适应高度' : '适应宽度'))

let renderTask: { cancel: () => void } | null = null
let observer: IntersectionObserver | null = null
let scrollRaf = 0
const pageWrappers = new Map<number, HTMLDivElement>()
const pageCanvases = new Map<number, HTMLCanvasElement>()

/** 页面四周留白（左右各 H_PAD/2，上下各 V_PAD/2） */
const H_PAD = 48
const V_PAD = 24

/** 旋转 90/270 时，宽高互换 —— 计算基准时必须换过来，否则算出的 scale 差一个数量级 */
function baseSize(): { w: number; h: number } {
  const rot = rotation.value % 180 !== 0
  return rot
    ? { w: pageSize.value.height, h: pageSize.value.width }
    : { w: pageSize.value.width, h: pageSize.value.height }
}

/**
 * 计算缩放。
 *
 * fit-height（默认）：让整页高度正好落进可视区，纵向不滚动、一屏一页。
 *   同时用宽度做上限约束 —— 窄窗口里若只按高度算，页面会横向溢出得厉害，
 *   此时必须先满足"别溢出"，宁可留一点上下白边。
 * fit-width：宽度正好填满，高度自然溢出、纵向滚动（原来的唯一模式）。
 */
function computeScale(): number {
  const el = stage.value
  if (!el) return 1
  const { w: baseW, h: baseH } = baseSize()
  if (baseW <= 0 || baseH <= 0) return 1

  const availW = Math.max(80, el.clientWidth - H_PAD)
  const availH = Math.max(80, el.clientHeight - V_PAD)

  let fit: number
  if (fitMode.value === 'width') {
    fit = availW / baseW
  } else {
    // 高度优先，但绝不横向溢出：取两者中更小的那个
    fit = Math.min(availH / baseH, availW / baseW)
  }
  return Math.min(6, Math.max(0.1, fit * zoomFactor.value))
}

/** 重算并写入 currentScale（尺寸变化、缩放、旋转、模式切换都要调） */
function refreshScale() {
  currentScale.value = computeScale()
}

async function closeDoc() {
  renderTask?.cancel()
  renderTask = null
  observer?.disconnect()
  observer = null
  pageWrappers.clear()
  pageCanvases.clear()
  pageRendered.clear()
  pageDrawnAt.clear()
  try {
    await doc.value?.destroy()
  } catch {
    // destroy 失败不影响后续，忽略
  }
  doc.value = null
}

/**
 * 等容器真正拿到尺寸。
 *
 * 这是「PDF 一片空白」最隐蔽的根因：PreviewPane 用 v-if 控制 PdfPreview 的出现，
 * 组件 mounted 时它的父级 flex 链可能还没完成布局，stage.clientWidth 读到 0。
 * 此时 computeScale() 会走 `if (baseW <= 0) return 1`，用 scale=1 去画 ——
 * 页面按 1:1 渲染（A4 约 595px 宽），如果容器此刻还没宽度，
 * IntersectionObserver 的 root 也是 0×0，永远不触发，于是整屏空白。
 * 这里轮询到有尺寸为止（最多约 2 秒），拿不到就带错误退出，不再无限等。
 */
async function waitForStage(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const el = stage.value
    if (el && el.clientWidth > 20 && el.clientHeight > 20) return true
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }
  return false
}

async function open() {
  await closeDoc()
  loading.value = true
  error.value = ''
  pageCount.value = 0
  pageNo.value = 1
  zoomFactor.value = 1
  rotation.value = 0
  // 默认适应高度。每次打开新文件都回到默认，避免上一个文件的临时缩放带过来
  fitMode.value = 'height'
  renderVersion.value++
  pageRendered.clear()
  pageDrawnAt.clear()

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

    // 必须先放行 loading 让 .pages 渲染出来，再挂 IntersectionObserver，
    // 否则 observer 观察到的是空集合，初打开一片空白/尺寸不对
    loading.value = false
    await nextTick()

    if (!(await waitForStage())) {
      error.value = '预览区域未能获得可用尺寸，请调整窗口大小后重试'
      return
    }

    refreshScale()
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
  const root = stage.value
  if (!root) return
  observer?.disconnect()
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
    // 上下各预取一屏，快速滚动时页还没进视口就已经开始解析，
    // 否则滚动速度一快，中间几页会因为"进得快、出得也快"而被整段跳过。
    { root, rootMargin: '150% 0px' },
  )
  for (const el of pageWrappers.values()) observer.observe(el)
}

const renderQueue: number[] = []
let rendering = false

function drawPage(idx: number) {
  const pdf = doc.value
  if (!pdf || idx < 1 || idx > pageCount.value) return
  // 已经在当前这一代排过队，就不重复入队（队列是串行的，重复入队只会拖慢）
  if (pageRendered.get(idx) === renderVersion.value) return
  pageRendered.set(idx, renderVersion.value)
  renderQueue.push(idx)
  void processQueue()
}

/**
 * 串行渲染队列。
 *
 * 关键点：每画完一页都重新检查它是否还在（或接近）视口内。
 * 快速滚动时用户可能早已划过这一页，此时**必须照画不误**，不能因为
 * "已经离开视口"就跳过 —— 跳过就是用户看到的那片空白。
 * 真正该跳过的只有"版本已变，这块画布注定要被重画"的情况。
 */
async function processQueue() {
  if (rendering) return
  rendering = true
  try {
    while (renderQueue.length) {
      const idx = renderQueue.shift()!
      const canvas = pageCanvases.get(idx)
      const wrap = pageWrappers.get(idx)
      if (!canvas || !wrap) continue
      // 缩放/旋转已变，这块画布作废，等新的排队项
      if (pageRendered.get(idx) !== renderVersion.value) continue
      // 只有"用当前尺寸画过"才算真的画好了。用 canvas.width > 0 判断是错的：
      // 切模式后旧画布依然有宽度，会被误判成无需重画，于是这一页永远停在旧尺寸上。
      if (pageDrawnAt.get(idx) === stampOf()) continue

      const pdf = doc.value
      if (!pdf) break
      let page
      try {
        page = await pdf.getPage(idx)
      } catch {
        // 页面解析失败不该拖垮整个文档，标记一下继续下一页
        pageRendered.delete(idx)
        continue
      }
      const s = currentScale.value
      // 记下"这一页是用哪个尺寸画的"。必须在取 viewport 的同时算好，
      // 因为 render 过程中 currentScale 可能又被改掉（用户连点缩放）。
      const stamp = stampOf()
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
        // 只有真正画完才登记尺寸指纹。取消/失败都不登记，
        // 这样它会在下一轮被重新排队（而不是被当成"已画好"永远跳过）。
        pageDrawnAt.set(idx, stamp)
      } catch (err) {
        const name = (err as { name?: string } | null)?.name
        // 被主动取消是正常流程（缩放时旧任务让位），只有真正的渲染错误才提示
        if (name !== 'RenderingCancelledException') {
          error.value = err instanceof Error ? err.message : String(err)
        } else {
          // 取消掉的这一页并没有画上，允许它在下一轮重试
          pageRendered.delete(idx)
        }
        pageDrawnAt.delete(idx)
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
  if (!root || root.height <= 0) return false
  const margin = root.height
  return rect.bottom > root.top - margin && rect.top < root.bottom + margin
}

/**
 * 补渲染所有"该画但没画"的页。
 *
 * 滚动停止后再兜一次底：IntersectionObserver 在高速滚动时可能漏掉监听窗口
 * 之外、但用户刚才确实划过的页，这里按视口就近顺序扫一遍，把漏网的补上。
 */
function renderVisible() {
  for (const [idx, el] of pageWrappers) {
    if (isNearViewport(el)) drawPage(idx)
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

/**
 * 第 idx 页相对 .stage 滚动内容顶部的位置。
 *
 * 必须这样算：.pagewrap 的 offsetParent 是更外层的 .content（PreviewPane 的滚动区），
 * 不是 .stage，所以直接读 offsetTop 会拿到一个大于 stage.maxScrollTop 的值
 * ——跳页会被夹到底部，页码也就永远算不对（实测跳末页停在 12）。
 * 改用「视口矩形差 + 当前滚动量」换算成 stage 坐标系，与 offsetParent 无关。
 */
function pageOffsetInStage(el: HTMLElement): number {
  const root = stage.value
  if (!root) return 0
  const rootRect = root.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  // getBoundingClientRect 已含边框，而 scrollTop 的零点在 border 内侧，
  // 因此要扣掉上边框宽度（root.clientTop），否则整体偏移几个像素
  return elRect.top - rootRect.top - root.clientTop + root.scrollTop
}

/** 按"视口中心最接近哪一页"算出当前页 */
function updateCurrentPage() {
  // 跳页动画期间不做自动计算，否则页码会在途中乱跳、最后停在错误的一页
  if (pinnedPage) {
    pageNo.value = pinnedPage
    return
  }
  const root = stage.value
  if (!root) return
  // 贴到最底部时直接判为最后一页：页面通常比视口高，滚到底时"视口中心"
  // 仍落在倒数第二页上，按距离算会永远显示 N-1，与用户点"最后一页"的预期不符。
  // 容差取 8px：平滑滚动停止时的取整误差实测能让 scrollTop 差 4px。
  const max = root.scrollHeight - root.clientHeight
  if (max > 0 && max - root.scrollTop <= 8) {
    pageNo.value = pageCount.value
    return
  }
  // 同理，贴顶就是第 1 页
  if (root.scrollTop <= 8) {
    pageNo.value = 1
    return
  }
  const mid = root.scrollTop + root.clientHeight / 2
  let best = 1
  let bestDist = Infinity
  for (const [idx, el] of pageWrappers) {
    const top = pageOffsetInStage(el)
    const bottom = top + el.offsetHeight
    const dist = mid < top ? top - mid : mid > bottom ? mid - bottom : 0
    if (dist < bestDist) {
      bestDist = dist
      best = idx
    }
  }
  pageNo.value = best
}

/**
 * 跳页时锁定的目标页。
 *
 * 平滑滚动是异步的，滚动过程中 onScroll 会不断按"视口中心最接近哪一页"重算页码，
 * 于是从第 1 页跳到第 14 页的途中，指示器会先显示 2、3、4… 最后才到 14；
 * 滚动越快、页越多，最终停下的位置越可能被算偏。
 * 因此跳页后先钉住目标页，等滚动真正停下再交还给自动计算。
 */
let pinnedPage = 0
let pinTimer = 0

/**
 * 钉住目标页，直到"连续若干帧滚动位置不再变化"或兜底超时。
 *
 * 不能用固定时长：平滑滚动的时长跟距离成正比，跳 13 页的动画远长于跳 1 页，
 * 固定的 500ms 会在动画还没结束时解锁，页码随即被算成中途的某一页（实测停在 12）。
 */
function pinTo(n: number) {
  pinnedPage = n
  pageNo.value = n
  clearTimeout(pinTimer)
  // 兜底：平滑滚动理论上不会超过 1s，给 1.4s 上限防止永久钉住
  pinTimer = window.setTimeout(releasePin, 1400)
  watchScrollSettle()
}

/** 每帧检查滚动位置；连续 4 帧（约 60ms）没变化就认为动画结束 */
function watchScrollSettle() {
  let last = -1
  let stillFrames = 0
  const tick = () => {
    if (!pinnedPage) return
    const top = stage.value?.scrollTop ?? 0
    if (top === last) {
      stillFrames++
      if (stillFrames >= 4) {
        releasePin()
        return
      }
    } else {
      stillFrames = 0
      last = top
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** 解锁自动页码计算，并以真实滚动位置校正一次 */
function releasePin() {
  clearTimeout(pinTimer)
  pinnedPage = 0
  updateCurrentPage()
}

/** 跳到指定页（1 起，自动夹到合法范围） */
function goToPage(n: number) {
  const target = Math.min(pageCount.value || 1, Math.max(1, n))
  const el = pageWrappers.get(target)
  if (!el || !stage.value) return
  pinTo(target)
  stage.value.scrollTo({ top: Math.max(0, pageOffsetInStage(el) - 12), behavior: 'smooth' })
  // 目标页正好是首页/末页时可能在 observer 预取窗口外，主动排一次
  drawPage(target)
}
function pageDelta(delta: number) {
  goToPage(pageNo.value + delta)
}

/** 输入框回车/失焦时跳页 */
function jumpTo(value: string) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) {
    // 输入非法就回显当前页，别让框里留一个错误数字
    return
  }
  goToPage(n)
}

function firstPage() {
  goToPage(1)
}

function lastPage() {
  goToPage(pageCount.value)
}

/** 缩放/旋转/切模式改变：所有旧画布作废，重画可视区 */
function invalidateAll() {
  renderVersion.value++
  pageRendered.clear()
  // 尺寸指纹也要一起清：否则 processQueue 会拿旧 stamp 比对，
  // 认为"已经用这个尺寸画过了"而跳过重画，页面就停在旧尺寸上
  pageDrawnAt.clear()
  // 队列里可能还压着旧版本的页面，直接清空，避免它们被误画
  renderQueue.length = 0
  refreshScale()
  void nextTick(() => renderVisible())
}

function zoom(delta: number) {
  zoomFactor.value = Math.min(6, Math.max(0.25, Number((zoomFactor.value + delta).toFixed(2))))
  invalidateAll()
}

/** 恢复"正好铺满当前适应方向" */
function resetZoom() {
  zoomFactor.value = 1
  invalidateAll()
}

/** 切换适应高度 / 适应宽度 */
function setFitMode(mode: FitMode) {
  if (fitMode.value === mode) return
  fitMode.value = mode
  zoomFactor.value = 1
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

/**
 * 占位 DIV 的尺寸：按当前缩放与原始比例算出，保证滚动条长度稳定。
 *
 * 适应高度模式下 pages 是居中排列的，占位高度必须和画布严格一致，
 * 否则每次重画都会让滚动位置抖一下。
 */
function placeholderHeight(_idx: number): number {
  const { h } = baseSize()
  return Math.floor(h * currentScale.value)
}

watch(() => props.data, open, { immediate: true })

/**
 * 窗口/容器尺寸变化：两种模式都要重算。
 *
 * 防抖 150ms，避免拖动窗口边框时连环重绘。这里不再只看宽度 ——
 * 适应高度模式下高度变化同样会改变 scale，漏掉就会出现"页面比窗口高一点"
 * 的尴尬状态，用户以为预览坏了。
 */
let resizeObserver: ResizeObserver | null = null
let resizeTimer = 0

onMounted(() => {
  if (!stage.value) return
  resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      if (!pageCount.value) return
      const next = computeScale()
      if (Math.abs(next - currentScale.value) < 0.001) return
      invalidateAll()
    }, 150)
  })
  resizeObserver.observe(stage.value)
})

onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  clearTimeout(resizeTimer)
  clearTimeout(pinTimer)
  // 解除钉住，避免离场后还有 rAF 在跑
  pinnedPage = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  observer?.disconnect()
  observer = null
  void closeDoc()
})
</script>

<template>
  <div class="pdf">
    <div class="pdfbar">
      <button class="tb" title="第一页" :disabled="pageNo <= 1" @click="firstPage">⏮</button>
      <button class="tb" title="上一页" :disabled="pageNo <= 1" @click="pageDelta(-1)">‹</button>
      <span class="pager">
        <input
          class="pageno"
          :value="pageNo"
          @change="jumpTo(($event.target as HTMLInputElement).value)"
          @keydown.enter="jumpTo(($event.target as HTMLInputElement).value)"
        />
        <span class="total">/ {{ pageCount || '—' }}</span>
      </span>
      <button class="tb" title="下一页" :disabled="pageNo >= pageCount" @click="pageDelta(1)">›</button>
      <button class="tb" title="最后一页" :disabled="pageNo >= pageCount" @click="lastPage">⏭</button>

      <span class="gap" />

      <!-- 适应模式：默认适应高度，一屏一页；切到适应宽度可以横向铺满看小字 -->
      <span class="seg">
        <button
          class="segb"
          :class="{ on: fitMode === 'height' }"
          title="整页高度正好落进窗口，一屏一页"
          @click="setFitMode('height')"
        >
          适应高度
        </button>
        <button
          class="segb"
          :class="{ on: fitMode === 'width' }"
          title="页面宽度填满窗口，超出的高度纵向滚动"
          @click="setFitMode('width')"
        >
          适应宽度
        </button>
      </span>

      <button class="tb" title="缩小" :disabled="zoomFactor <= 0.25" @click="zoom(-0.25)">−</button>
      <button class="tb zoom" title="恢复为正好铺满" @click="resetZoom">{{ percent }}%</button>
      <button class="tb" title="放大" :disabled="zoomFactor >= 6" @click="zoom(0.25)">＋</button>
      <button class="tb wide" title="旋转 90°" @click="rotate">旋转</button>
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
          :data-page="i"
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
  overflow-x: auto;
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
  white-space: nowrap;
  flex: 0 0 auto;
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

/* 适应模式分段控件 */
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  flex: 0 0 auto;
}

.segb {
  height: 24px;
  padding: 0 9px;
  font-size: 12px;
  color: var(--muted);
  background: var(--panel);
  border-right: 1px solid var(--line);
  white-space: nowrap;
}

.segb:last-child {
  border-right: none;
}

.segb:hover {
  color: var(--accent);
}

.segb.on {
  background: var(--accent-soft);
  color: var(--accent-dark);
  font-weight: 500;
}

.pager {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  flex: 0 0 auto;
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
  min-width: 52px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
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

/*
 * 占位容器。position:relative 是为了让绝对定位的 canvas 有个锚点，
 * 但这里 canvas 是普通流式子元素，所以只用 flex 居中即可。
 * 关键：height 由内联 style 给出精确像素（placeholderHeight），
 * 让滚动条长度在画布尚未渲染时就已经正确。
 */
.pagewrap {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  flex: 0 0 auto;
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
