/**
 * preload：渲染进程与主进程之间唯一的桥。
 *
 * 暴露面被刻意压到最小 —— 只给渲染进程业务方法，不给任何 fs / shell / ipcRenderer 原语。
 * 运行在 sandbox 中，Node 集成关闭。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '@shared/ipc'
import type { VaultBridge } from '@shared/ipc'

const api: VaultBridge = {
  appVersion: () => ipcRenderer.invoke(CH.appVersion),
  configGet: () => ipcRenderer.invoke(CH.appConfigGet),
  configSet: (patch) => ipcRenderer.invoke(CH.appConfigSet, patch),
  pickDirectory: (opts) => ipcRenderer.invoke(CH.appPickDirectory, opts),
  pickFiles: (opts) => ipcRenderer.invoke(CH.appPickFiles, opts),
  openExternal: (url) => ipcRenderer.invoke(CH.appOpenExternal, url),

  probe: (dir) => ipcRenderer.invoke(CH.vaultProbe, dir),
  create: (dir, password) => ipcRenderer.invoke(CH.vaultCreate, dir, password),
  open: (dir, password) => ipcRenderer.invoke(CH.vaultOpen, dir, password),
  lock: () => ipcRenderer.invoke(CH.vaultLock),
  state: () => ipcRenderer.invoke(CH.vaultState),
  list: () => ipcRenderer.invoke(CH.vaultList),
  createFolder: (parentId, name) => ipcRenderer.invoke(CH.vaultCreateFolder, parentId, name),
  rename: (id, name) => ipcRenderer.invoke(CH.vaultRename, id, name),
  remove: (ids) => ipcRenderer.invoke(CH.vaultRemove, ids),
  move: (id, parentId) => ipcRenderer.invoke(CH.vaultMove, id, parentId),
  search: (keyword) => ipcRenderer.invoke(CH.vaultSearch, keyword),
  searchContent: (keyword) => ipcRenderer.invoke(CH.vaultSearchContent, keyword),
  importPaths: (parentId, paths) => ipcRenderer.invoke(CH.vaultImport, parentId, paths),
  exportNodes: (ids) => ipcRenderer.invoke(CH.vaultExport, ids),
  readFile: (id) => ipcRenderer.invoke(CH.vaultReadFile, id),
  changePassword: (oldPassword, newPassword) =>
    ipcRenderer.invoke(CH.vaultChangePassword, oldPassword, newPassword),

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
