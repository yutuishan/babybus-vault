<script setup lang="ts">
/**
 * PPT（pptx）预览：pptx-preview 本地渲染。
 *
 * 库的缩放规则（读源码确认）：scale = init 传入的 width / 幻灯片原始宽度，
 * 高度按原始比例推导 —— 所以只要按容器实际尺寸喂对 width，就能整体自适应。
 *
 * 三条约束：
 *   1. 先 load() 拿到幻灯片原始宽高（不渲染），再按「宽度与高度双约束」算出
 *      目标宽度后正式 preview()，保证窗口宽高任何一边变化都不会溢出或留大片空白
 *   2. ResizeObserver 监听容器，窗口拖动/分栏变化时防抖 250ms 重渲染
 *   3. 幻灯片本体保持库给的 margin:0 auto（水平居中）；容器用 margin:auto 0
 *      实现「小了垂直居中、大了可滚动」
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ data: Uint8Array; name: string }>()

const host = ref<HTMLDivElement | null>(null)
const area = ref<HTMLDivElement | null>(null)
const loading = ref(true)
const error = ref('')

let previewer: {
  preview: (ab: ArrayBuffer) => Promise<unknown>
  load?: (ab: ArrayBuffer) => Promise<{ width: number; height: number }>
  destroy?: () => void
  pptx?: { width: number; height: number }
} | null = null

/** 复用同一份 ArrayBuffer，重渲染时不再拷贝明文 */
let buffer: ArrayBuffer | null = null

let resizeObserver: ResizeObserver | null = null
let resizeTimer = 0
/**
 * 渲染代次号。存在三条并发入口（watch immediate / onMounted / ResizeObserver），
 * 每次 render() 开头自增并记下自己的代次；任何一个 await 之后只要发现代次已经不是最新，
 * 就立刻退出 —— 否则后到的渲染会清空 host，把先完成的那次结果抹掉，界面只剩一个空壳。
 */
let renderSeq = 0

function copyToBuffer() {
  if (buffer) return buffer
  const copy = new Uint8Array(props.data)
  buffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
  return buffer
}

/** 容器可用区域：扣掉左右/上下 padding */
function availableSize(): { w: number; h: number } {
  const el = area.value
  if (!el) return { w: 920, h: 518 }
  return { w: Math.max(160, el.clientWidth - 36), h: Math.max(120, el.clientHeight - 36) }
}

/** 双约束：受宽度和高度共同限制，按幻灯片原始比例算目标宽度 */
function computeWidth(natW: number, natH: number): number {
  const { w, h } = availableSize()
  const ratio = natW / natH
  return Math.max(160, Math.min(w, h * ratio))
}

async function render() {
  const hostEl = host.value
  // 组件挂载前 host 还是 null。这里必须直接返回且不能把 loading 留在 true 上，
  // 否则 watch(immediate) 先跑一次、onMounted 又不重试，界面会永远停在"正在解析"。
  if (!hostEl) return

  const seq = ++renderSeq
  /** 代次已过期（有更新的渲染开始了）—— 不能碰 DOM，交给最新那次收尾 */
  const stale = () => seq !== renderSeq

  // 廉价判断：一次渲染要 1~3 秒，如果只是 ResizeObserver 抖动、
  // 目标宽度跟上一次实际用的一致，就没必要重画（避免拖窗口时幻灯片闪成空白）。
  // 需要先知道原生尺寸才能算目标宽度，所以放在 load() 之后判断。
  loading.value = true
  error.value = ''
  try {
    const mod = await import('pptx-preview')
    if (stale()) return
    const ab = copyToBuffer()

    // 第一阶段：只 load 不渲染，拿幻灯片原始尺寸（100px 宽只为触发解析，不影响结果）
    hostEl.innerHTML = ''
    const probe = mod.init(hostEl, { width: 100, mode: 'list' })
    let info: { width?: number; height?: number } | undefined
    try {
      info = (await probe.load?.(ab)) as { width?: number; height?: number } | undefined
    } finally {
      // load 失败或成功都要把探测实例清掉，否则 host 里会残留一层空 wrapper
      try {
        probe.destroy?.()
      } catch {
        /* 忽略清理异常 */
      }
      // destroy() 只解绑 echarts 的全局回调，不会把 wrapper 从 host 里摘掉，
      // 必须手动清一次，否则下一个实例会叠在残留的 wrapper 上
      hostEl.innerHTML = ''
    }
    if (stale()) return
    const natW = info?.width ?? probe.pptx?.width ?? 960
    const natH = info?.height ?? probe.pptx?.height ?? 540

    // 第二阶段：按容器与原始比例算宽度，正式渲染
    const width = Math.floor(computeWidth(natW, natH))
    hostEl.innerHTML = ''
    previewer = mod.init(hostEl, { width, mode: 'list' })
    // 库内部对损坏/超大文件可能既不 resolve 也不 reject，加超时兜底，
    // 避免界面永远停在"正在解析幻灯片…"
    await Promise.race([
      previewer.preview(ab),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('解析超时（文件过大或结构异常）')), 20_000),
      ),
    ])
    if (stale()) return
  } catch (err) {
    if (stale()) return
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    // 只有最新一代才有资格摘掉 loading，否则旧一代结束会把新一代的
    // “正在解析”提前关掉，露出还没画好的空 host
    if (!stale()) loading.value = false
  }
}

function scheduleRerender() {
  clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    if (error.value) return
    // 即使 buffer 还没建立（首帧 host 尚未挂载就触发过 ResizeObserver）也要重试，
    // 否则第一次渲染失败后永远不会再画
    void render()
  }, 250)
}

watch(
  () => props.data,
  () => {
    buffer = null
    void render()
  },
  { immediate: true },
)

onMounted(() => {
  if (!area.value) return
  resizeObserver = new ResizeObserver(() => scheduleRerender())
  resizeObserver.observe(area.value)
  // 补一次首渲染：挂载前那次 watch 因 host 为 null 直接返回了
  if (!previewer) void render()
})

onBeforeUnmount(() => {
  clearTimeout(resizeTimer)
  // 作废所有在途渲染：卸载后它们不能再往 host 里写
  renderSeq++
  resizeObserver?.disconnect()
  resizeObserver = null
  try {
    previewer?.destroy?.()
  } catch {
    // 忽略清理异常
  }
  previewer = null
  buffer = null
})
</script>

<template>
  <div ref="area" class="pptx">
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
  padding: 18px 0;
}

/* 垂直 auto 边距：幻灯片比可视区矮时居中，高时正常滚动（safe center） */
.pptxhost {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 库默认给 wrapper 垫了一层纯黑背景，亮色主题下非常刺眼，改回主题色 */
.pptxhost :deep(.pptx-preview-wrapper) {
  background: transparent !important;
}

.pptxhost :deep(img),
.pptxhost :deep(canvas),
.pptxhost :deep(svg) {
  max-width: 100%;
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
</style>
