/**
 * 主界面 UI 探针（仅 `--probe-ui` 时运行）。
 *
 * 为什么需要它：文件树图标、按钮文案、重命名聚焦这三类改动**单测覆盖不到** ——
 * 它们的正确性完全体现在"渲染出来的 DOM 长什么样、点下去之后变成什么样"。
 * 而 `useVault.ts` 里早就为端到端探针留了 `window.__vaultState` 这个入口
 * （见那里的注释），只是一直没有探针真的用它 —— 这个文件就是把那个入口用起来。
 *
 * 两条纪律（都是踩过的坑）：
 *   1. **只驱动应用自身的真实按钮/组件**。绝不往 `document.body` 上挂
 *      `position:fixed` 的自建容器 —— 那种容器不会被自动清理，会盖住整个 UI，
 *      之后所有 `.node` 点击全部失效（计数变 0，看起来像"点击没生效"）。
 *   2. **断言用的期望值必须是硬编码的**，不能调 `fileIcon()` 之类的被测函数来算 ——
 *      那样等于拿实现证明实现，改错了也照样绿。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { makeWav } from './probeFixtures'
import { setVault } from './vault/session'
import { Vault } from './vault/vault'

const PROBE_PASSWORD = 'Probe-Pass-2026'

/**
 * 探针夹具：每种图标一个文件，外加一个目录（目录里再放一个文件，用来验证展开）。
 * 内容是无关紧要的占位串 —— 这里验证的是界面，不是加解密。
 *
 * ⚠️ `演示.mp4` 的内容是**故意不可解码**的假数据。它有两个用途：
 *   1. 验证图标按扩展名区分（只需要扩展名对）；
 *   2. 验证"播不了"时的兜底文案 —— 这条恰好是用户报过的问题：
 *      文案一口咬定"内核无法解码这个文件的编码"，把 CSP 拦截也说成编码问题。
 *      所以这里断言的是**文案必须留有余地**（同时提到"可能被外部改动"），
 *      而不是断言某个具体错误码。别把它换成真 MP4，换了第 2 条就没意义了。
 */
const FILES: [string, string][] = [
  ['年度报告.pdf', '%PDF-1.4 probe'],
  ['照片.png', 'png-probe'],
  ['演示.mp4', 'mp4-probe'],
  ['音乐.mp3', 'mp3-probe'],
  ['笔记.txt', '纯文本'],
  ['脚本.ts', 'export const x = 1'],
  ['归档.zip', 'zip-probe'],
  ['没有扩展名', 'no-ext'],
]

/**
 * 期望的图标。**硬编码**，不从 `fileIcon()` 反推。
 * 这份表同时是"图标要能区分文件类型"这条需求的规格说明。
 */
const EXPECTED_ICONS: Record<string, string> = {
  '年度报告.pdf': '📕',
  '照片.png': '🖼️',
  '演示.mp4': '🎬',
  '音乐.mp3': '🎵',
  '笔记.txt': '📄',
  '脚本.ts': '📜',
  '归档.zip': '🗜️',
  没有扩展名: '📎',
  '探针音频.wav': '🎵',
  子目录: '📁',
}

export async function runUiProbe(win: BrowserWindow): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'bb-probe-ui-'))
  const vault = await Vault.create(dir, PROBE_PASSWORD)

  try {
    setVault(vault)
    for (const [name, body] of FILES) vault.putFile(null, name, Buffer.from(body, 'utf8'))
    // 真能解码的音频：界面里的媒体预览断言需要它（见 probeFixtures.makeWav 的注释）。
    // 30 秒 8kHz 16bit 单声道 = 480044 字节，会跨过内部 256KB 分块边界。
    vault.putFile(null, '探针音频.wav', makeWav(30, 8000))
    const folder = vault.createFolder(null, '子目录')
    vault.putFile(folder.id, '内层.md', Buffer.from('# 内层', 'utf8'))

    // 等 Vue 挂载完
    await new Promise((r) => setTimeout(r, 1500))

    // 重命名那条断言要读 `document.activeElement`，而隐藏窗口里 Chromium 的焦点
    // 行为不可靠，所以先把窗口显示出来并主动聚焦
    win.show()
    win.focus()
    win.webContents.focus()
    await new Promise((r) => setTimeout(r, 300))

    const observed = (await win.webContents.executeJavaScript(rendererScript(dir))) as Record<
      string,
      unknown
    >
    return { observed, checks: evaluate(observed) }
  } finally {
    try {
      vault.lock()
    } catch {
      /* 已经锁了 */
    }
    setVault(null)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发 EPERM，不影响结论 */
    }
  }
}

/** 渲染进程里跑的那段脚本。只读 DOM + 驱动真实组件，不注入任何自建节点 */
function rendererScript(dir: string): string {
  return `(async () => {
  const out = {}
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    const s = window.__vaultState
    if (!s) return { fatal: 'window.__vaultState 不存在（useVault 的自动化入口没生效）' }

    const [st, nodes] = await Promise.all([window.api.state(), window.api.list()])

    // 顺序很重要：必须先 config 再 phase。MainWindow 挂载时会读 guideSeen，
    // 为假就弹新手引导遮罩（.mask），会把工具栏整个盖住，后面所有点击都打不中。
    s.config = Object.assign({}, s.config || {}, { guideSeen: true })
    s.dir = ${JSON.stringify(dir)}
    s.nodes = nodes
    s.vault = st
    s.expanded = new Set()
    s.selectedId = null
    s.selectedIds = new Set()
    s.search = ''
    s.locked = false
    s.phase = 'main'

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await wait(250)

    const q = (sel) => document.querySelector(sel)
    const qa = (sel) => Array.from(document.querySelectorAll(sel))
    const txt = (el) => (el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null)

    out.hasFocus = document.hasFocus()
    out.guideMaskOpen = !!q('.mask')
    out.nodeCount = qa('.tree .scroll .node').length

    // ---- 1. 工具栏：一律文字按钮 ----
    out.toolbarBtnLabels = qa('.toolbar .btn').map(txt)
    // « » ⟳ ⊟ 这四个符号一个都不该再出现（▾ 是下拉的指示符，不算）
    out.toolbarGlyphButtons = qa('.toolbar button')
      .map(txt)
      .filter((t) => !!t && /[\\u00ab\\u00bb\\u27f3\\u229f]/.test(t))

    // ---- 2. 文件库头部 ----
    out.treeHeadLabels = qa('.tree .head .hbtn').map(txt)

    // ---- 3. 图标 ----
    out.iconByName = {}
    for (const el of qa('.tree .scroll .node')) {
      const n = txt(el.querySelector('.name'))
      const i = txt(el.querySelector('.icon'))
      if (n) out.iconByName[n] = i
    }

    // ---- 4. 重命名：双击之后输入框必须**自己**拿到焦点 ----
    out.rename = { ran: false }
    const fileNode = qa('.tree .scroll .node').find((el) => !el.classList.contains('folder'))
    if (fileNode) {
      const before = txt(fileNode.querySelector('.name'))
      fileNode.querySelector('.name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await wait(150)
      const input = fileNode.querySelector('input.mini')
      out.rename = {
        ran: true,
        nameBefore: before,
        inputAppeared: !!input,
        // 关键：没有任何点击的前提下，输入框已经是 document.activeElement
        focusedWithoutClick: !!input && document.activeElement === input,
        selectedAll:
          !!input && input.selectionStart === 0 && input.selectionEnd === input.value.length,
      }
      if (input) {
        // 故意改成一个假名字再按 Esc：万一失焦守卫失效，这个名字会被真的提交上去
        input.value = '不应该被提交'
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await wait(250)
        out.rename.closedOnEscape = !fileNode.querySelector('input.mini')
        out.rename.nameAfterEscape = txt(fileNode.querySelector('.name'))
      }
    }

    // ---- 5. 全部展开 / 全部折叠 ----
    const headBtn = (label) => qa('.tree .head .hbtn').find((b) => txt(b) === label)
    const expandBtn = headBtn('全部展开')
    const collapseBtn = headBtn('全部折叠')
    out.expand = {
      hasExpandBtn: !!expandBtn,
      hasCollapseBtn: !!collapseBtn,
      folderCount: s.nodes.filter((n) => n.type === 'folder').length,
      collapsedAtStart: s.expanded.size,
      nodesCollapsedAtStart: qa('.tree .scroll .node').length,
    }
    if (expandBtn && collapseBtn) {
      expandBtn.click()
      await wait(200)
      out.expand.afterExpand = s.expanded.size
      out.expand.nodesAfterExpand = qa('.tree .scroll .node').length
      collapseBtn.click()
      await wait(200)
      out.expand.afterCollapse = s.expanded.size
      out.expand.nodesAfterCollapse = qa('.tree .scroll .node').length
    }

    // ---- 6. 导入：一个入口 + 二级菜单 ----
    out.import = { hasButton: false }
    const importBtn = qa('.toolbar .btn').find((b) => (txt(b) || '').indexOf('导入') === 0)
    if (importBtn) {
      out.import.hasButton = true
      importBtn.click()
      await wait(150)
      out.import.items = qa('.toolbar .dropdown .ditem').map(txt)
      out.import.hasBackdrop = !!q('.menu-backdrop')
      const bd = q('.menu-backdrop')
      if (bd) bd.click()
      await wait(150)
      out.import.closedByBackdrop = !q('.toolbar .dropdown')
    }

    // ---- 7. 媒体预览接线 ----
    // 用**真能解码**的 wav 验证成功路径。<audio> 和 <video> 在 load() 里走的是同一条
    // 分支（kind 为 audio 或 video 时都指向 vault://media/...），
    // 所以验证 audio 就覆盖了 video 的接线；真 MP4 夹具没有编码器造不出来。
    // 另外用故意坏掉的 mp4 验证兜底文案（见 FILES 的注释）。
    const select = async (name) => {
      const n = s.nodes.find((x) => x.name === name)
      if (!n) return false
      s.selectedId = n.id
      s.selectedIds = new Set([n.id])
      await wait(600)
      return true
    }
    out.preview = {}
    if (await select('探针音频.wav')) {
      const a = q('.preview audio')
      out.preview.audioElement = !!a
      out.preview.audioSrc = a ? a.getAttribute('src') : null
      out.preview.audioError = q('.preview .sub.err') ? txt(q('.preview .sub.err')) : null
    }
    if (await select('演示.mp4')) {
      const v = q('.preview video')
      out.preview.videoElement = !!v
      out.preview.videoSrc = v ? v.getAttribute('src') : null
      const errEl = q('.preview .sub.err')
      out.preview.videoErrorText = errEl ? txt(errEl) : null
    }

    // ---- 8. 主题解析结果 ----
    // 用户报过"启动就是暗色"，但代码里默认是亮色（config 默认值、首屏底色、
    // 窗口 backgroundColor 全是亮色）。这里把**运行时真正解析出来的值**记下来，
    // 下次跑探针就能直接看出到底是"主题没应用"还是"应用成了 dark"。
    const rootStyle = getComputedStyle(document.documentElement)
    out.theme = {
      dataset: document.documentElement.dataset.theme || null,
      rootBg: (rootStyle.getPropertyValue('--bg') || '').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      configTheme: s.config ? s.config.theme : null,
      prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    }

    return out
  } catch (err) {
    return { fatal: String((err && err.message) || err), partial: out }
  }
})()`
}

/** 把观测结果变成一组"通过/失败"，期望值全部硬编码 */
function evaluate(o: Record<string, unknown>): {
  passed: string[]
  failed: string[]
  info: Record<string, unknown>
} {
  const passed: string[] = []
  const failed: string[] = []
  const info: Record<string, unknown> = {}

  const ok = (cond: boolean, label: string, detail?: unknown) => {
    if (cond) passed.push(label)
    else failed.push(detail === undefined ? label : `${label}（实际：${JSON.stringify(detail)}）`)
  }

  if (typeof o.fatal === 'string') {
    failed.push(`渲染进程探针抛错：${o.fatal}`)
    return { passed, failed, info }
  }

  info.hasFocus = o.hasFocus
  info.guideMaskOpen = o.guideMaskOpen
  info.theme = o.theme

  /*
   * 主题：断言的是"**被显式应用过**"，而不是"等于 light"。
   * 用户可能自己在设置里选了暗色，那时 dark 也是对的 —— 断言 light 会误报。
   * 真正的不变量是：config 载入后 data-theme 一定被设成 light 或 dark 之一，
   * 绝不会停在空值（空值说明 applyAppearance 没跑到，那才是 bug）。
   */
  const theme = (o.theme ?? {}) as Record<string, unknown>
  ok(
    theme.dataset === 'light' || theme.dataset === 'dark',
    '主题已显式应用到根元素（data-theme 不是空值）',
    theme.dataset,
  )

  // 前置条件：引导遮罩不能盖着界面，否则后面所有点击都不算数
  ok(o.guideMaskOpen === false, '新手引导遮罩没有挡住主界面', o.guideMaskOpen)
  ok(o.hasFocus === true, '窗口处于可聚焦状态（重命名焦点断言的前提）', o.hasFocus)

  const labels = (o.toolbarBtnLabels as string[]) ?? []
  const glyphs = (o.toolbarGlyphButtons as string[]) ?? []

  // ---- 1 ----
  ok(glyphs.length === 0, '工具栏里已经没有 « » ⟳ ⊟ 这类符号按钮', glyphs)
  ok(
    labels.filter((l) => l === '导入' || l.indexOf('导入') === 0).length === 1,
    '「导入」只有一个入口（文件和文件夹已合并）',
    labels,
  )
  ok(
    !labels.some((l) => l === '导入文件' || l === '导入文件夹'),
    '工具栏上不再有并列的「导入文件」/「导入文件夹」',
    labels,
  )
  ok(labels.includes('刷新'), '工具栏的刷新按钮是文字「刷新」', labels)
  ok(
    labels.some((l) => l === '收起' || l === '展开'),
    '工具栏的折叠按钮是文字「收起」/「展开」',
    labels,
  )

  const imp = (o.import as Record<string, unknown>) ?? {}
  ok(imp.hasButton === true, '「导入」按钮存在')
  const items = (imp.items as string[]) ?? []
  ok(
    items.length === 2 && items.some((i) => i.indexOf('导入文件') === 0) && items.some((i) => i.indexOf('导入文件夹') === 0),
    '下拉里有「导入文件…」和「导入文件夹…」两项',
    items,
  )
  ok(imp.closedByBackdrop === true, '点空白遮罩能关掉下拉', imp.closedByBackdrop)

  // ---- 2 ----
  const head = (o.treeHeadLabels as string[]) ?? []
  ok(head.includes('刷新'), '文件库头部有「刷新」', head)
  ok(head.includes('全部展开'), '文件库头部新增了「全部展开」', head)
  ok(head.includes('全部折叠'), '文件库头部有「全部折叠」', head)

  const exp = (o.expand as Record<string, unknown>) ?? {}
  const folders = Number(exp.folderCount ?? 0)
  ok(Number(exp.collapsedAtStart) === 0, '初始状态是全部折叠', exp.collapsedAtStart)
  ok(Number(exp.afterExpand) === folders, `「全部展开」把所有 ${folders} 个文件夹都展开了`, exp.afterExpand)
  ok(
    Number(exp.nodesAfterExpand) > Number(exp.nodesCollapsedAtStart),
    '展开后可见节点变多了（子文件真的显示出来了）',
    { before: exp.nodesCollapsedAtStart, after: exp.nodesAfterExpand },
  )
  ok(Number(exp.afterCollapse) === 0, '「全部折叠」把展开集合清空了', exp.afterCollapse)
  ok(
    Number(exp.nodesAfterCollapse) === Number(exp.nodesCollapsedAtStart),
    '折叠后回到初始可见节点数',
    { before: exp.nodesCollapsedAtStart, after: exp.nodesAfterCollapse },
  )

  // ---- 3 ----
  const icons = (o.iconByName as Record<string, string>) ?? {}
  for (const [name, want] of Object.entries(EXPECTED_ICONS)) {
    ok(icons[name] === want, `图标 ${name} → ${want}`, icons[name])
  }
  const distinct = new Set(Object.values(icons))
  ok(
    distinct.size >= 8,
    `文件图标确实被区分开了（${distinct.size} 种不同图标）`,
    Object.entries(icons),
  )

  // ---- 4 ----
  const ren = (o.rename as Record<string, unknown>) ?? {}
  ok(ren.ran === true, '重命名用例跑起来了')
  ok(ren.inputAppeared === true, '双击节点后出现了重命名输入框', ren.inputAppeared)
  ok(
    ren.focusedWithoutClick === true,
    '输入框**未经点击**就已获得焦点（这条就是「要聚焦再失焦才能关闭」的回归断言）',
    ren.focusedWithoutClick,
  )
  ok(ren.selectedAll === true, '输入框里的主名被全选，可直接覆盖输入', ren.selectedAll)
  ok(ren.closedOnEscape === true, '按 Esc 能关掉重命名', ren.closedOnEscape)
  ok(
    ren.nameAfterEscape === ren.nameBefore,
    '按 Esc 取消后文件名没有被改动（失焦守卫没让"取消"变成"提交"）',
    { before: ren.nameBefore, after: ren.nameAfterEscape },
  )

  // ---- 7. 媒体预览接线 ----
  const pv = (o.preview as Record<string, unknown>) ?? {}
  if (pv.audioElement !== undefined) {
    ok(pv.audioElement === true, '选中 wav 时渲染出 <audio> 元素', pv.audioElement)
    ok(
      typeof pv.audioSrc === 'string' && pv.audioSrc.indexOf('vault://media/') === 0,
      '音频 src 指向 vault:// 流式协议（不是整份读进内存的 Blob）',
      pv.audioSrc,
    )
    ok(
      pv.audioError === null,
      '真音频没有落进错误分支（说明流式取数这条路真的通了）',
      pv.audioError,
    )
  }
  if (pv.videoErrorText !== undefined) {
    ok(
      typeof pv.videoErrorText === 'string' && pv.videoErrorText.length > 0,
      '播不了的视频会落到错误分支并给出提示',
      pv.videoErrorText,
    )
    // 文案回归断言：以前不管什么原因都说"当前内核无法解码这个文件的音视频编码"，
    // 把 CSP 拦截、文件被外部改动这类原因也一口咬定成编码问题，把排查方向带偏。
    // 所以这里要求文案必须留有余地。
    ok(
      typeof pv.videoErrorText === 'string' && pv.videoErrorText.indexOf('可能') >= 0,
      '错误文案留有余地（同时提到"可能被外部改动"），没有一口咬定是编码问题',
      pv.videoErrorText,
    )
  }

  info.iconByName = icons
  return { passed, failed, info }
}
