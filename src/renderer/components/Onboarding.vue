<script setup lang="ts">
import { computed, ref } from 'vue'

const model = defineModel<boolean>({ default: false })

const step = ref(0)

/**
 * 新手引导做成"应用内的图文走查"而不是录屏视频，原因很实际：
 * 视频一旦功能有改动就过期，而且没法搜索、没法复制其中的文字。
 * 图文走查随代码一起版本化，改功能时顺手改文案即可。
 * 每一步的 shot 用纯 SVG 画，不依赖任何截图资源，深色/浅色主题都跟着 CSS 变量走。
 */
interface Step {
  title: string
  body: string
  tips: string[]
  shot: 'create' | 'import' | 'tree' | 'preview' | 'lock' | 'hint'
}

const STEPS: Step[] = [
  {
    title: '先建一个加密文件库',
    body: '首次启动会看到「新建文件库」和「打开文件库」两个入口。新建时你要指定一个普通文件夹作为文件库的位置，再设置一个主密码。',
    tips: [
      '文件库位置由你指定，软件不会偷偷往系统目录里塞东西',
      '主密码是唯一的钥匙，忘记后没有任何找回途径',
      '新建前会检查目标目录是否已有文件库，避免误覆盖',
    ],
    shot: 'create',
  },
  {
    title: '导入文件与文件夹',
    body: '解锁后，点顶部工具栏的「导入」，在菜单里选「导入文件…」可多选文件，选「导入文件夹…」则整个目录搬进来、内部层级原样保留。也可以直接把文件或文件夹拖进左侧的目录树。',
    tips: [
      '工具栏导入一律落在文件库根目录；想放进某个文件夹，直接拖到那个文件夹上',
      '导入时遇到同名项会让你选「覆盖」还是「保留两者」（自动改名为「名字 (2)」）',
      '原始文件不会被删除，导入相当于复制一份加密副本',
      '文件库里已有的东西在导入过程中不会被误删',
    ],
    shot: 'import',
  },
  {
    title: '管理目录结构',
    body: '左侧是文件树。右键节点可以新建文件夹、重命名、删除。拖动节点可以改变它的位置或调整层级。',
    tips: [
      '文件树顶部有「刷新」「全部展开」「全部折叠」三个按钮，刷新会重新读取磁盘以同步外部改动',
      '双击节点即可重命名，扩展名会被保护，只改主名',
      '文件夹不能拖动到自己的子目录里，软件会拦住这种操作',
      '删除文件夹会连同里面的文件一起进回收站逻辑，请留意确认框',
    ],
    shot: 'tree',
  },
  {
    title: '预览文件',
    body: '点击文件即可在右侧预览。支持 PDF、Word、PPT、Excel、图片、纯文本，以及音频和视频；不支持的格式会提示导出后用系统默认程序打开。',
    tips: [
      'PDF 支持「适应高度」和「适应宽度」两种模式，默认适应高度',
      '工具栏还有缩放、旋转、跳转首末页',
      '音视频是边解密边播放的，可以拖动进度条，不需要等整个文件读完',
      '文件内容在磁盘上始终是密文，预览是在内存里现解现看',
    ],
    shot: 'preview',
  },
  {
    title: '自动上锁与手动锁定',
    body: '文件库解锁后，超过设定的空闲时间会自动上锁；系统休眠或睡眠时也会立刻锁上。你也可以随时点工具栏右侧的「锁定」按钮手动锁定。',
    tips: [
      '自动锁屏时间在「设置 → 常规」里调整，最短 1 分钟',
      '没有「从不」这个档，这是有意的兜底设计',
      '锁定后所有文件名和内容都不再显示',
    ],
    shot: 'lock',
  },
  {
    title: '密码提示（可选）',
    body: '如果你担心忘掉主密码，新建文件库时可以填一条提示语。为了让它在锁屏状态下也能看到，这条提示是明文保存在文件库目录里的。',
    tips: [
      '提示语锁屏时会直接显示 —— 所以它只能是提醒，绝不能写出密码本身',
      '因为它不加密，任何拿到这个文件夹的人都能读到这条提示',
      '在「设置 → 主密码」里可以随时查看、修改或清除',
    ],
    shot: 'hint',
  },
]

const current = computed(() => STEPS[step.value])
const isFirst = computed(() => step.value === 0)
const isLast = computed(() => step.value === STEPS.length - 1)

function prev() {
  if (!isFirst.value) step.value--
}

function next() {
  if (isLast.value) {
    model.value = false
    step.value = 0
    return
  }
  step.value++
}

function jump(i: number) {
  step.value = i
}

function close() {
  model.value = false
  step.value = 0
}
</script>

<template>
  <div v-if="model" class="mask" @click.self="close">
    <div class="dialog">
      <div class="head">
        <div class="hl">
          <h3>新手引导</h3>
          <span class="pg">{{ step + 1 }} / {{ STEPS.length }}</span>
        </div>
        <button class="x" title="关闭" @click="close">×</button>
      </div>

      <div class="body">
        <div class="shot">
          <svg viewBox="0 0 320 190">
            <!-- 通用外框：窗口 -->
            <rect x="16" y="14" width="288" height="162" rx="9" class="win" />
            <rect x="16" y="14" width="288" height="22" rx="9" class="bar" />
            <circle cx="28" cy="25" r="3.2" class="dot" />
            <circle cx="39" cy="25" r="3.2" class="dot" />
            <circle cx="50" cy="25" r="3.2" class="dot" />

            <!-- 1 新建文件库 -->
            <g v-if="current.shot === 'create'">
              <rect x="62" y="58" width="96" height="76" rx="7" class="card on" />
              <rect x="78" y="72" width="26" height="26" rx="6" class="ico" />
              <rect x="78" y="106" width="64" height="7" rx="3.5" class="ln" />
              <rect x="78" y="118" width="46" height="6" rx="3" class="ln f" />
              <rect x="170" y="58" width="96" height="76" rx="7" class="card" />
              <rect x="186" y="72" width="26" height="26" rx="6" class="ico" />
              <rect x="186" y="106" width="64" height="7" rx="3.5" class="ln" />
              <rect x="186" y="118" width="46" height="6" rx="3" class="ln f" />
              <circle cx="110" cy="58" r="9" class="badge" />
              <path d="M106 58h8M110 54v8" class="bk" />
            </g>

            <!-- 2 导入文件 -->
            <g v-else-if="current.shot === 'import'">
              <rect x="26" y="44" width="88" height="124" rx="7" class="card on" />
              <rect x="34" y="54" width="60" height="9" rx="4" class="ln" />
              <rect x="34" y="70" width="52" height="9" rx="4" class="ln" />
              <rect x="34" y="86" width="58" height="9" rx="4" class="ln" />
              <rect x="34" y="102" width="44" height="9" rx="4" class="ln f" />
              <rect x="34" y="118" width="54" height="9" rx="4" class="ln f" />
              <rect x="34" y="134" width="40" height="9" rx="4" class="ln f" />
              <rect x="128" y="44" width="164" height="124" rx="7" class="card" />
              <rect x="142" y="58" width="94" height="10" rx="5" class="ln" />
              <rect x="142" y="78" width="136" height="1.4" class="hr" />
              <rect x="142" y="90" width="112" height="9" rx="4" class="ln f" />
              <rect x="142" y="106" width="128" height="9" rx="4" class="ln f" />
              <rect x="142" y="122" width="96" height="9" rx="4" class="ln f" />
              <path d="M96 96h30m0 0-8-8m8 8-8 8" class="arrow" />
            </g>

            <!-- 3 目录树 -->
            <g v-else-if="current.shot === 'tree'">
              <rect x="26" y="44" width="120" height="124" rx="7" class="card on" />
              <circle cx="46" cy="60" r="7" class="fold" />
              <rect x="58" y="56" width="62" height="8" rx="4" class="ln" />
              <circle cx="46" cy="82" r="7" class="fold" />
              <rect x="58" y="78" width="48" height="8" rx="4" class="ln f" />
              <circle cx="60" cy="104" r="7" class="fold" />
              <rect x="72" y="100" width="54" height="8" rx="4" class="ln f" />
              <circle cx="46" cy="126" r="7" class="fold" />
              <rect x="58" y="122" width="56" height="8" rx="4" class="ln f" />
              <circle cx="46" cy="148" r="7" class="fold" />
              <rect x="58" y="144" width="42" height="8" rx="4" class="ln f" />
              <path d="M52 82c0 8 14 8 14 14" class="guide" />
              <rect x="160" y="44" width="132" height="124" rx="7" class="card" />
              <rect x="176" y="58" width="100" height="9" rx="4.5" class="ln" />
              <rect x="176" y="80" width="72" height="7" rx="3.5" class="ln f" />
              <rect x="176" y="94" width="88" height="7" rx="3.5" class="ln f" />
              <rect x="176" y="108" width="64" height="7" rx="3.5" class="ln f" />
            </g>

            <!-- 4 预览 -->
            <g v-else-if="current.shot === 'preview'">
              <rect x="26" y="44" width="76" height="124" rx="7" class="card" />
              <rect x="34" y="56" width="52" height="8" rx="4" class="ln" />
              <rect x="34" y="72" width="44" height="8" rx="4" class="ln f" />
              <rect x="34" y="88" width="48" height="8" rx="4" class="ln f" />
              <rect x="34" y="104" width="36" height="8" rx="4" class="ln f" />
              <rect x="112" y="44" width="180" height="124" rx="7" class="card on" />
              <rect x="120" y="52" width="164" height="14" rx="5" class="tbar" />
              <rect x="126" y="57" width="24" height="5" rx="2.5" class="ln" />
              <rect x="154" y="57" width="24" height="5" rx="2.5" class="ln f" />
              <rect x="182" y="57" width="20" height="5" rx="2.5" class="ln f" />
              <rect x="160" y="76" width="84" height="76" rx="3" class="page" />
              <rect x="170" y="86" width="64" height="5" rx="2.5" class="ln f" />
              <rect x="170" y="96" width="56" height="5" rx="2.5" class="ln f" />
              <rect x="170" y="106" width="62" height="5" rx="2.5" class="ln f" />
              <rect x="170" y="116" width="44" height="5" rx="2.5" class="ln f" />
              <rect x="170" y="126" width="58" height="5" rx="2.5" class="ln f" />
            </g>

            <!-- 5 锁定 -->
            <g v-else-if="current.shot === 'lock'">
              <rect x="26" y="48" width="268" height="122" rx="7" class="card" />
              <path
                d="M150 96v-8a10 10 0 0 1 20 0v8"
                class="lock-sh"
              />
              <rect x="144" y="96" width="32" height="26" rx="5" class="lock-bd" />
              <circle cx="160" cy="108" r="3" class="lock-hole" />
              <rect x="122" y="136" width="76" height="7" rx="3.5" class="ln" />
              <rect x="106" y="150" width="108" height="6" rx="3" class="ln f" />
              <circle cx="279" cy="30" r="11" class="badge" />
              <path d="M275 30v-3a4 4 0 0 1 8 0v3" class="bk-s" />
              <rect x="274" y="30" width="10" height="8" rx="2" class="bk-s" />
            </g>

            <!-- 6 密码提示 -->
            <g v-else>
              <rect x="60" y="46" width="200" height="126" rx="9" class="card on" />
              <rect x="76" y="62" width="70" height="8" rx="4" class="ln" />
              <rect x="76" y="78" width="168" height="20" rx="5" class="input" />
              <rect x="84" y="84" width="52" height="8" rx="4" class="ln f" />
              <rect x="76" y="110" width="56" height="8" rx="4" class="ln" />
              <rect x="76" y="126" width="168" height="20" rx="5" class="input" />
              <path d="M86 136h44" class="dash" />
              <rect x="76" y="154" width="80" height="13" rx="6.5" class="btnfill" />
              <rect x="90" y="158" width="52" height="5" rx="2.5" class="btnln" />
            </g>
          </svg>
        </div>

        <div class="text">
          <h4>{{ current.title }}</h4>
          <p>{{ current.body }}</p>
          <ul>
            <li v-for="t in current.tips" :key="t">{{ t }}</li>
          </ul>
        </div>
      </div>

      <div class="foot">
        <div class="dots">
          <button
            v-for="(s, i) in STEPS"
            :key="s.title"
            class="pdot"
            :class="{ on: i === step }"
            :title="s.title"
            @click="jump(i)"
          />
        </div>
        <div class="acts">
          <button class="btn" :disabled="isFirst" @click="prev">上一步</button>
          <button class="btn primary" @click="next">
            {{ isLast ? '开始使用' : '下一步' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: absolute;
  inset: 0;
  background: rgba(30, 36, 48, 0.26);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
}

.dialog {
  width: 640px;
  max-width: 94%;
  max-height: 88%;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-radius: 12px;
  box-shadow: 0 24px 60px var(--dropdown-shadow);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 18px 10px;
  border-bottom: 1px solid var(--line);
}

.hl {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.head h3 {
  font-size: 15px;
}

.pg {
  font-size: 12px;
  color: var(--faint);
}

.x {
  font-size: 19px;
  color: var(--faint);
  line-height: 1;
}

.x:hover {
  color: var(--text);
}

.body {
  display: flex;
  gap: 16px;
  padding: 16px 18px;
  overflow-y: auto;
}

.shot {
  flex: 0 0 320px;
  border: 1px solid var(--line-soft);
  border-radius: 9px;
  background: var(--panel-3);
  padding: 8px;
}

.shot svg {
  width: 100%;
  height: auto;
  display: block;
}

/* SVG 里的颜色全部走 CSS 变量，这样明暗主题都不用改图 */
.win {
  fill: var(--panel);
  stroke: var(--line);
}

.bar {
  fill: var(--panel-3);
}

.dot {
  fill: var(--line);
}

.card {
  fill: var(--panel);
  stroke: var(--line);
}

.card.on {
  stroke: var(--accent);
  stroke-width: 1.6;
  fill: var(--accent-soft);
}

.ico {
  fill: var(--panel);
  stroke: var(--accent);
}

.ln {
  fill: var(--text);
  opacity: 0.72;
}

.ln.f {
  fill: var(--text);
  opacity: 0.3;
}

.hr {
  fill: var(--line);
}

.badge {
  fill: var(--accent);
}

.bk {
  stroke: #fff;
  stroke-width: 1.7;
  fill: none;
  stroke-linecap: round;
}

.arrow {
  stroke: var(--accent);
  stroke-width: 1.8;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.fold {
  fill: var(--accent-soft);
  stroke: var(--accent);
}

.guide {
  stroke: var(--accent);
  stroke-width: 1.4;
  fill: none;
  stroke-dasharray: 3 3;
}

.tbar {
  fill: var(--panel-3);
  stroke: var(--line-soft);
}

.page {
  fill: var(--panel);
  stroke: var(--line);
}

.lock-sh {
  stroke: var(--accent);
  stroke-width: 2.4;
  fill: none;
  stroke-linecap: round;
}

.lock-bd {
  fill: var(--accent);
}

.lock-hole {
  fill: var(--panel);
}

.bk-s {
  stroke: #fff;
  stroke-width: 1.6;
  fill: none;
}

.input {
  fill: var(--panel);
  stroke: var(--line);
}

.dash {
  stroke: var(--faint);
  stroke-width: 2;
  stroke-dasharray: 4 4;
  stroke-linecap: round;
}

.btnfill {
  fill: var(--accent);
}

.btnln {
  fill: var(--panel);
}

.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.text h4 {
  font-size: 14px;
  font-weight: 600;
}

.text p {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.8;
}

.text ul {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 2px;
}

.text li {
  position: relative;
  padding-left: 16px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}

.text li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 7px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.75;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--line);
}

.dots {
  display: flex;
  gap: 6px;
}

.pdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--line);
  transition: 0.18s;
}

.pdot.on {
  background: var(--accent);
  transform: scale(1.25);
}

.acts {
  display: flex;
  gap: 8px;
}
</style>
