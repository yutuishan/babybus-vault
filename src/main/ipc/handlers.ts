/**
 * 所有 IPC 处理器
 *
 * 三条硬规则：
 *   1. 任何进入这里的文件路径都必须校验，渲染进程的输入一律不可信
 *   2. 主密钥绝不跨 IPC 边界，渲染进程只能拿到解密后的内容或目录树视图
 *   3. 所有异常都转成中文可读提示，不把堆栈抛给前端
 */
import { app, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { CH } from '@shared/ipc'
import type {
  AppConfig,
  ContentMatch,
  ExportResult,
  ImportResult,
  OpenResult,
  PickedEntry,
  ProbeResult,
  Result,
  VaultState,
} from '@shared/ipc'
import type { NodeView } from '@shared/types'
import { Vault, VaultError } from '../vault/vault'
import { isVaultDir, readVaultMeta, verifyPassword } from '../vault/vaultMeta'
import { closeVault, currentVault, requireVault, setVault } from '../vault/session'
import { loadConfig, patchConfig } from '../config'
import { heartbeat, triggerLock } from '../autoLock'
import { wipe } from '../crypto/secureBuffer'
import { passwordIssues } from '../crypto/passwordPolicy'

/** M1 阶段预览走 IPC 整包传输，超过这个体积直接拒绝，避免撑爆内存 */
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
/** 导入单个文件的上限。超过后整文件加密会 OOM，等 M2 的流式写入补齐 */
const MAX_IMPORT_BYTES = 256 * 1024 * 1024

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail(err: unknown): Result<never> {
  if (err instanceof VaultError) return { ok: false, error: err.message, code: err.code }
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: message }
}

function toView(node: {
  id: string
  parentId: string | null
  type: 'folder' | 'file'
  name: string
  ext?: string
  size?: number
  updatedAt: number
}): NodeView {
  return {
    id: node.id,
    parentId: node.parentId,
    type: node.type,
    name: node.name,
    ext: node.ext,
    size: node.size,
    updatedAt: node.updatedAt,
  }
}

function buildState(): VaultState {
  const vault = currentVault()
  if (!vault || vault.isLocked) {
    return {
      open: false,
      dir: null,
      name: null,
      kdf: null,
      kdfImpl: null,
      nodeCount: 0,
      fileCount: 0,
      totalSize: 0,
      recoveredFromBackup: false,
    }
  }
  const nodes = vault.list()
  return {
    open: true,
    dir: vault.vaultDir,
    name: basename(vault.vaultDir),
    kdf: vault.kdfInfo.kdf,
    kdfImpl: vault.kdfInfo.kdfImpl,
    nodeCount: nodes.length,
    fileCount: nodes.filter((n) => n.type === 'file').length,
    totalSize: nodes.reduce((sum, n) => sum + (n.size ?? 0), 0),
    recoveredFromBackup: vault.recoveredFromBackup,
  }
}

/** 目录递归展开为文件列表。文件库自身的管理文件必须排除，否则会把库导进库 */
function collectFiles(paths: string[], out: string[] = []): string[] {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const stat = statSync(path)
    if (stat.isDirectory()) {
      const entries = readdirSync(path)
      collectFiles(
        entries.map((e) => join(path, e)),
        out,
      )
    } else if (stat.isFile()) {
      out.push(path)
    }
  }
  return out
}

function vaultInternalName(name: string): boolean {
  return name === 'vault.meta' || name === 'manifest.enc' || name === 'manifest.enc.bak'
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // ------------------------------------------------------------ 应用级

  ipcMain.handle(CH.appVersion, () => app.getVersion())

  ipcMain.handle(CH.appConfigGet, (): AppConfig => loadConfig())

  ipcMain.handle(CH.appConfigSet, (_e, patch: Partial<AppConfig>): AppConfig => patchConfig(patch))

  ipcMain.handle(CH.appPickDirectory, async (_e, opts) => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: opts?.title ?? '选择文件夹',
      defaultPath: opts?.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(CH.appPickFiles, async (_e, opts): Promise<PickedEntry[]> => {
    const win = getWindow()
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      title: opts?.title ?? '选择文件',
      properties: opts?.includeDirectories
        ? ['openFile', 'multiSelections', 'openDirectory']
        : ['openFile', 'multiSelections'],
    })
    if (res.canceled) return []
    return res.filePaths.map((p) => ({
      path: p,
      name: basename(p),
      isDirectory: statSync(p).isDirectory(),
    }))
  })

  ipcMain.handle(CH.appOpenExternal, async (_e, url: string) => {
    // 只放行 https，避免被利用成 file:// 或自定义协议的跳板
    if (typeof url === 'string' && /^https:\/\//i.test(url)) {
      await shell.openExternal(url)
    }
  })

  // ------------------------------------------------------------ 文件库

  ipcMain.handle(CH.vaultProbe, (_e, dir: string): ProbeResult => {
    if (typeof dir !== 'string' || !dir) {
      return { exists: false, isVault: false, writable: false }
    }
    const exists = existsSync(dir)
    let writable = false
    if (exists) {
      try {
        const probe = join(dir, '.write-probe')
        writeFileSync(probe, '')
        const { unlinkSync } = require('node:fs') as typeof import('node:fs')
        unlinkSync(probe)
        writable = true
      } catch {
        writable = false
      }
    }
    return { exists, isVault: isVaultDir(dir), writable }
  })

  ipcMain.handle(CH.vaultCreate, async (_e, dir: string, password: string) => {
    try {
      if (typeof dir !== 'string' || !dir) throw new VaultError('请先选择文件库位置', 'NO_DIR')
      const issues = passwordIssues(password)
      if (issues.length) throw new VaultError(issues[0]!, 'WEAK_PASSWORD')

      closeVault()
      const vault = await Vault.create(dir, password)
      setVault(vault)
      heartbeat()
      const result: OpenResult = { ok: true, state: buildState(), nodes: vault.list() }
      return ok(result)
    } catch (err) {
      closeVault()
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultOpen, async (_e, dir: string, password: string) => {
    try {
      if (typeof dir !== 'string' || !dir) throw new VaultError('请先选择文件库位置', 'NO_DIR')
      if (!isVaultDir(dir)) {
        throw new VaultError(
          '该目录不是有效的加密文件库（未找到 vault.meta）。请重新选择，或在此新建。',
          'NOT_A_VAULT',
        )
      }
      closeVault()
      const vault = await Vault.open(dir, password)
      setVault(vault)
      heartbeat()
      return ok({ ok: true as const, state: buildState(), nodes: vault.list() })
    } catch (err) {
      closeVault()
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultLock, () => {
    triggerLock('manual')
    getWindow()?.webContents.send(CH.vaultLockedEvent, 'manual')
  })

  ipcMain.handle(CH.vaultState, (): VaultState => buildState())

  ipcMain.handle(CH.vaultList, (): NodeView[] => {
    const vault = currentVault()
    return vault && !vault.isLocked ? vault.list() : []
  })

  ipcMain.handle(CH.vaultCreateFolder, (_e, parentId: string | null, name: string) => {
    try {
      const vault = requireVault()
      const node = vault.createFolder(parentId, String(name ?? '').trim())
      heartbeat()
      return ok(toView(node))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultRename, (_e, id: string, name: string) => {
    try {
      const vault = requireVault()
      if (typeof id !== 'string') throw new VaultError('参数不合法', 'BAD_ARG')
      vault.renameNode(id, String(name ?? '').trim())
      heartbeat()
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultRemove, (_e, ids: string | string[]) => {
    try {
      const vault = requireVault()
      const list = Array.isArray(ids) ? ids : [ids]
      if (list.some((id) => typeof id !== 'string')) {
        throw new VaultError('参数不合法', 'BAD_ARG')
      }
      let count = 0
      for (const id of list) count += vault.deleteNode(id)
      heartbeat()
      return ok(count)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultMove, (_e, id: string, parentId: string | null) => {
    try {
      const vault = requireVault()
      vault.moveNode(id, parentId)
      heartbeat()
      return ok(null)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultSearch, (_e, keyword: string): NodeView[] => {
    const vault = currentVault()
    if (!vault || vault.isLocked) return []
    const kw = String(keyword ?? '').trim().toLowerCase()
    if (!kw) return []
    return vault.list().filter((n) => n.name.toLowerCase().includes(kw))
  })

  /**
   * 全文检索：只在解锁状态下、按需解密文本类文件。
   * 不做持久化索引 —— 任何落盘的索引都是明文泄露面，且会与密文内容脱节。
   * 每个文件限制在 1MB / 16 万字符内，超大的文本文件跳过（防卡死）。
   */
  const TEXT_SEARCH_EXTS = new Set(['txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'md', 'markdown', 'mdown', 'html', 'htm', 'js', 'ts', 'css', 'py', 'sh', 'bat', 'sql', 'srt'])
  const MAX_CONTENT_SEARCH_BYTES = 1024 * 1024
  const MAX_CONTENT_SEARCH_FILES = 2000

  ipcMain.handle(CH.vaultSearchContent, (_e, keyword: string): Result<ContentMatch[]> => {
    try {
      const vault = requireVault()
      const kw = String(keyword ?? '').trim()
      if (!kw) return ok([])
      const kwLower = kw.toLowerCase()

      const files = vault
        .list()
        .filter((n) => n.type === 'file' && n.ext && TEXT_SEARCH_EXTS.has(n.ext.toLowerCase()))
        .slice(0, MAX_CONTENT_SEARCH_FILES)

      const matches: ContentMatch[] = []
      for (const file of files) {
        if ((file.size ?? 0) > MAX_CONTENT_SEARCH_BYTES) continue
        let content: Buffer | null = null
        try {
          content = vault.readFile(file.id)
          const text = content.toString('utf8')
          const lower = text.toLowerCase()
          const idx = lower.indexOf(kwLower)
          if (idx < 0) continue
          // 统计命中数（封顶 99 防止极端文本拖慢）
          let hits = 0
          let pos = idx
          while (pos >= 0 && hits < 99) {
            hits++
            pos = lower.indexOf(kwLower, pos + kwLower.length)
          }
          const start = Math.max(0, idx - 24)
          const snippet = text.slice(start, Math.min(text.length, idx + kw.length + 48)).replace(/\s+/g, ' ')
          matches.push({
            id: file.id,
            name: file.name,
            snippet: start > 0 ? '…' + snippet : snippet,
            hits,
          })
        } catch {
          // 单个文件损坏不影响整体搜索
        } finally {
          if (content) wipe(content)
        }
      }
      heartbeat()
      return ok(matches)
    } catch (err) {
      return fail(err)
    }
  })

  // ------------------------------------------------------------ 导入导出

  ipcMain.handle(CH.vaultImport, (_e, parentId: string | null, paths: string[]) => {
    try {
      const vault = requireVault()
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new VaultError('没有选择任何文件', 'EMPTY')
      }
      const vaultRoot = resolve(vault.vaultDir)
      const files = collectFiles(paths)
      const result: ImportResult = { imported: 0, skipped: 0, failed: [] }

      for (const file of files) {
        const name = basename(file)
        if (vaultInternalName(name)) {
          result.skipped++
          continue
        }
        // 防止把整个文件库导进自己，造成无限膨胀
        if (resolve(dirname(file)) === vaultRoot || resolve(file).startsWith(join(vaultRoot, 'blobs'))) {
          result.skipped++
          continue
        }
        try {
          const size = statSync(file).size
          if (size > MAX_IMPORT_BYTES) {
            result.failed.push({ path: file, reason: '文件超过 256MB，当前版本暂不支持' })
            continue
          }
          const content = readFileSync(file)
          try {
            vault.putFile(parentId, name, content)
            result.imported++
          } finally {
            wipe(content)
          }
        } catch (err) {
          result.failed.push({
            path: file,
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }

      heartbeat()
      return ok(result)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(CH.vaultExport, async (_e, ids: string[]) => {
    try {
      const vault = requireVault()
      const win = getWindow()
      if (!win) throw new VaultError('窗口不可用', 'NO_WINDOW')
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new VaultError('请先选择要导出的文件或文件夹', 'EMPTY')
      }
      const res = await dialog.showOpenDialog(win, {
        title: '选择导出位置',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (res.canceled || !res.filePaths[0]) return ok({ exported: 0, destDir: '' } satisfies ExportResult)

      const destDir = res.filePaths[0]
      let exported = 0
      for (const id of ids) {
        exported += exportNodeRecursive(vault, id, destDir)
      }
      heartbeat()
      return ok({ exported, destDir } satisfies ExportResult)
    } catch (err) {
      return fail(err)
    }
  })

  // ------------------------------------------------------------ 预览

  ipcMain.handle(CH.vaultReadFile, (_e, id: string) => {
    try {
      const vault = requireVault()
      if (typeof id !== 'string') throw new VaultError('参数不合法', 'BAD_ARG')
      const node = vault.list().find((n) => n.id === id)
      if (!node || node.type !== 'file') throw new VaultError('文件不存在', 'NOT_FOUND')
      if ((node.size ?? 0) > MAX_PREVIEW_BYTES) {
        throw new VaultError('文件超过 32MB，当前版本暂不支持预览（可导出后查看）', 'TOO_LARGE')
      }
      const content = vault.readFile(id)
      // 结构化克隆会把 Buffer 变成 Uint8Array，这里显式拷贝一次并立刻擦掉原文
      const copy = new Uint8Array(content)
      wipe(content)
      heartbeat()
      return ok(copy)
    } catch (err) {
      return fail(err)
    }
  })

  // ------------------------------------------------------------ 改密码

  ipcMain.handle(CH.vaultChangePassword, async (_e, oldPassword: string, newPassword: string) => {
    let derived: Buffer | null = null
    try {
      const vault = requireVault()
      const issues = passwordIssues(newPassword)
      if (issues.length) throw new VaultError(issues[0]!, 'WEAK_PASSWORD')

      // 已解锁不代表当前操作者是本人，改密码前再验一次旧密码
      const meta = readVaultMeta(vault.vaultDir)
      const check = await verifyPassword(meta, oldPassword)
      derived = check.masterKey ?? null
      if (!check.ok) throw new VaultError('原密码不正确', 'BAD_PASSWORD')

      await vault.changePassword(newPassword)
      heartbeat()
      return ok(null)
    } catch (err) {
      return fail(err)
    } finally {
      if (derived) wipe(derived)
    }
  })

  // ------------------------------------------------------------ 自动锁屏

  ipcMain.on(CH.autoLockHeartbeat, () => heartbeat())

  // ------------------------------------------------------------ 窗口控制（无边框窗口用）

  ipcMain.handle(CH.windowMinimize, () => {
    getWindow()?.minimize()
  })

  ipcMain.handle(CH.windowToggleMaximize, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle(CH.windowClose, () => {
    getWindow()?.close()
  })

  ipcMain.handle(CH.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)
}

/** 递归导出节点，保持原有目录结构 */
function exportNodeRecursive(vault: Vault, id: string, destDir: string): number {
  const nodes = vault.list()
  const node = nodes.find((n) => n.id === id)
  if (!node) return 0

  const target = join(destDir, node.name)

  if (node.type === 'folder') {
    mkdirSync(target, { recursive: true })
    let count = 0
    for (const child of nodes.filter((n) => n.parentId === id)) {
      count += exportNodeRecursive(vault, child.id, target)
    }
    return count
  }

  const content = vault.readFile(id)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    return 1
  } finally {
    wipe(content)
  }
}
