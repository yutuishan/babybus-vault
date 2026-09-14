/**
 * preload：渲染进程与主进程之间唯一的桥。
 *
 * 暴露面被刻意压到最小 —— 只给渲染进程业务方法，不给任何 fs / shell / ipcRenderer 原语。
 * 运行在 sandbox 中，Node 集成关闭。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '@shared/ipc'
import type { VaultBridge } from '@shared/ipc'
import { toPlain } from '@shared/plain'

const api: VaultBridge = {
  appVersion: () => ipcRenderer.invoke(CH.appVersion),
  configGet: () => ipcRenderer.invoke(CH.appConfigGet),
  configSet: (patch) => ipcRenderer.invoke(CH.appConfigSet, toPlain(patch)),
  pickDirectory: (opts) => ipcRenderer.invoke(CH.appPickDirectory, toPlain(opts)),
  pickFiles: (opts) => ipcRenderer.invoke(CH.appPickFiles, toPlain(opts)),
  openExternal: (url) => ipcRenderer.invoke(CH.appOpenExternal, url),

  probe: (dir) => ipcRenderer.invoke(CH.vaultProbe, dir),
  create: (dir, password, hint) => ipcRenderer.invoke(CH.vaultCreate, dir, password, hint ?? ''),
  open: (dir, password) => ipcRenderer.invoke(CH.vaultOpen, dir, password),
  lock: () => ipcRenderer.invoke(CH.vaultLock),
  state: () => ipcRenderer.invoke(CH.vaultState),
  list: () => ipcRenderer.invoke(CH.vaultList),
  reload: () => ipcRenderer.invoke(CH.vaultReload),
  createFolder: (parentId, name) => ipcRenderer.invoke(CH.vaultCreateFolder, parentId, name),
  rename: (id, name) => ipcRenderer.invoke(CH.vaultRename, id, name),
  remove: (ids) => ipcRenderer.invoke(CH.vaultRemove, toPlain(ids)),
  move: (id, parentId) => ipcRenderer.invoke(CH.vaultMove, id, parentId),
  search: (keyword) => ipcRenderer.invoke(CH.vaultSearch, keyword),
  searchContent: (keyword) => ipcRenderer.invoke(CH.vaultSearchContent, keyword),
  importPaths: (parentId, paths, policy) =>
    ipcRenderer.invoke(CH.vaultImport, parentId, toPlain(paths), policy ?? 'keep-both'),
  scanImport: (parentId, paths) =>
    ipcRenderer.invoke(CH.vaultScanImport, parentId, toPlain(paths)),
  exportNodes: (ids) => ipcRenderer.invoke(CH.vaultExport, toPlain(ids)),
  readFile: (id) => ipcRenderer.invoke(CH.vaultReadFile, id),
  extractText: (id) => ipcRenderer.invoke(CH.vaultExtractText, id),
  changePassword: (oldPassword, newPassword) =>
    ipcRenderer.invoke(CH.vaultChangePassword, oldPassword, newPassword),
  getHint: () => ipcRenderer.invoke(CH.vaultGetHint),
  peekHint: (dir) => ipcRenderer.invoke(CH.vaultPeekHint, dir),
  setHint: (hint) => ipcRenderer.invoke(CH.vaultSetHint, hint),

  heartbeat: () => ipcRenderer.send(CH.autoLockHeartbeat),

  onLocked: (cb) => {
    const handler = (_e: unknown, reason: string) => cb(reason ?? 'manual')
    ipcRenderer.on(CH.vaultLockedEvent, handler)
    return () => ipcRenderer.removeListener(CH.vaultLockedEvent, handler)
  },

  onCountdown: (cb) => {
    const handler = (_e: unknown, seconds: number) => cb(seconds)
    ipcRenderer.on(CH.autoLockTick, handler)
    return () => ipcRenderer.removeListener(CH.autoLockTick, handler)
  },

  onMaximizedChange: (cb) => {
    const handler = (_e: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on('window:maximized', handler)
    return () => ipcRenderer.removeListener('window:maximized', handler)
  },

  windowMinimize: () => ipcRenderer.invoke(CH.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.invoke(CH.windowToggleMaximize),
  windowClose: () => ipcRenderer.invoke(CH.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(CH.windowIsMaximized),

  /**
   * 从系统拖入的 File 对象里取真实路径。
   * 渲染进程拿不到 path（安全限制），必须由 preload 用官方 API 解析。
   *
   * ⚠️ 这里的 `files` **刻意不过 toPlain**：File 的自有可枚举属性是空的，
   * toPlain 会把它拍成 `{}`，webUtils.getPathForFile() 随即拿不到路径，
   * 表现就是"拖进来没反应"。别为了"统一风格"给它套上。
   */
  resolveDropPaths: async (files) => {
    const paths: string[] = []
    for (const file of files) {
      if (file instanceof File) {
        try {
          const p = webUtils.getPathForFile(file)
          if (p) paths.push(p)
        } catch {
          // 拖拽项可能不是真实文件（例如网页里的图片），忽略
        }
      }
    }
    return paths
  },
}

contextBridge.exposeInMainWorld('api', api)
