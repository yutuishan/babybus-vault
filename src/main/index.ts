/**
 * 应用入口（主进程）
 *
 * 安全基线 §10：contextIsolation / nodeIntegration=false / sandbox=true / 禁止外部导航 / CSP 禁止联网。
 * 这里刻意不引入任何网络能力，也不注册任何自定义协议以外的 URL scheme。
 */
import { app, BrowserWindow, protocol, session } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { registerIpc } from './ipc/handlers'
import { heartbeat, secondsUntilLock, startAutoLock, triggerLock } from './autoLock'
import { closeVault } from './vault/session'
import { runSelfTest, runUiTest } from './selftest'
import { CH } from '@shared/ipc'

const APP_NAME = '宝宝巴士'

/** 无网络、无 eval、无外部框架 —— 预览用的 Blob URL 走 data:/blob: 特例 */
const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval'：pdf.js v6 的部分图像解码器走 WebAssembly
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  // 'self' 只指 app:// 自身，不含任何网络地址，零网络约束仍然成立。
  // 放开它是因为 pdf.js 要用 fetch 取 cmaps / 标准字体 / wasm 解码器。
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

let mainWindow: BrowserWindow | null = null

/**
 * 渲染进程改用 app:// 而不是 file://
 *
 * 原因：file:// 是不透明源（opaque origin），Chromium 会拒绝从它加载 Web Worker，
 * pdf.js 的解码线程因此起不来。同时自定义协议能拿到真实源，CSP 也才能真正生效。
 * 后续 vault:// 流式协议复用同一套注册方式。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      bypassCSP: false,
      stream: true,
    },
  },
])

/** 自定义协议不会自动猜 MIME，猜错会导致 ES module / worker 被直接拒绝加载 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
}

function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function rendererDir(): string {
  const candidate = join(__dirname, '../../renderer')
  const fallback = join(__dirname, '../renderer')
  return existsSync(join(candidate, 'index.html')) ? candidate : fallback
}

function rendererEntry(): string {
  // 开发模式下指向 vite dev server
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) return devUrl
  return join(rendererDir(), 'index.html')
}

/**
 * app:// 的静态文件服务。
 * 只允许访问 rendererDir 内的文件：pathname 归一化后必须仍在根目录之内，
 * 否则 app://./../../package.json 这类请求就能把磁盘内容读出去。
 */
function registerAppProtocol(): void {
  const root = resolve(rendererDir())

  protocol.handle('app', async (request) => {
    try {
      const { pathname } = new URL(request.url)
      const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.[/\\])+/, '')
      const full = resolve(root, rel)
      if (full !== root && !full.startsWith(root + sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!existsSync(full) || !statSync(full).isFile()) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(readFileSync(full), {
        status: 200,
        headers: { 'Content-Type': mimeOf(full) },
      })
    } catch {
      return new Response('Bad Request', { status: 400 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#eef0f4',
    show: false,
    // 完全去掉系统标题栏，否则自绘的 min/max/close 会和系统的叠在一起变成两套按钮
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 无边框窗口需要把最大化状态同步给渲染进程，红黄绿灯才能画对
  const notifyMaximized = (maximized: boolean) =>
    mainWindow?.webContents.send('window:maximized', maximized)
  mainWindow.on('maximize', () => notifyMaximized(true))
  mainWindow.on('unmaximize', () => notifyMaximized(false))

  // 禁止外部导航：任何跳转一律拦掉
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (!current || !url.startsWith(current.split('#')[0]!)) event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.argv.includes('--uitest')) {
    // 超时兜底：页面加载失败时也要退出，不能把进程挂死
    const guard = setTimeout(() => {
      console.error('[uitest] 超时：页面未在 15 秒内完成加载')
      app.exit(1)
    }, 15_000)
    mainWindow.webContents.once('did-finish-load', () => {
      void runUiTest(mainWindow!)
        .then(() => {
          clearTimeout(guard)
          app.exit(0)
        })
        .catch((err: unknown) => {
          clearTimeout(guard)
          console.error('[uitest] FAILED:', err)
          app.exit(1)
        })
    })
  }

  const entry = rendererEntry()
  if (entry.startsWith('http')) {
    void mainWindow.loadURL(entry)
  } else {
    // 生产构建走 app://（见 registerAppProtocol），不用 file://
    void mainWindow.loadURL('app://./index.html')
  }
}

function applySecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
        'X-Content-Type-Options': ['nosniff'],
        'Referrer-Policy': ['no-referrer'],
      },
    })
  })
}

/** 每秒把剩余秒数推给渲染进程，用于状态栏倒计时 */
function startCountdownBroadcast(): void {
  setInterval(() => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.send(CH.autoLockTick, secondsUntilLock())
  }, 1000)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // 自检模式：不建窗口，跑完端到端校验直接退出
    if (process.argv.includes('--selftest')) {
      try {
        await runSelfTest()
        app.exit(0)
      } catch (err) {
        console.error('[selftest] FAILED:', err)
        app.exit(1)
      }
      return
    }

    applySecurityHeaders()
    registerAppProtocol()
    createWindow()

    registerIpc(() => mainWindow)
    startAutoLock(mainWindow!, () => {
      closeVault()
    })
    startCountdownBroadcast()

    // 所有前台操作都算活动，避免用户一直在操作时被误锁
    app.on('browser-window-focus', () => heartbeat())

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      closeVault()
      app.quit()
    }
  })

  // 退出前必须锁库：主密钥随进程消亡，但显式清空能避免崩溃转储里残留
  app.on('before-quit', () => {
    triggerLock('manual')
    closeVault()
  })
}

/** 供打包后定位资源。__dirname 在 CJS 下可用 */
export const resourceDir = dirname(fileURLToPath(import.meta.url ?? `file://${__filename}`))
