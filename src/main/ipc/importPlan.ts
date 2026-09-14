/**
 * 目录导入的规划与执行。
 *
 * 两件事：
 *   1. 把磁盘上的路径**原样**读成一棵导入树 —— 保留目录层级，不再把文件夹拍平成一堆文件。
 *      这是「支持导入文件夹，并不破坏内部结构」的实现要点。
 *   2. 按策略把这棵树写进文件库：同名时要么覆盖、要么改名保留两者。
 *
 * 拆成"扫描"和"执行"两步是为了让界面能在动手之前把冲突清单摆给用户看。
 * 覆盖和保留两者的语义差别很大（一个丢数据、一个留冗余），不能替用户默默选。
 *
 * 全程只读磁盘、只通过 Vault 的公开方法写库，不直接碰 manifest 或 blobs。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type {
  ImportConflict,
  ImportConflictPolicy,
  ImportResult,
  ImportScanResult,
} from '@shared/ipc'
import { wipe } from '../crypto/secureBuffer'
import type { Vault } from '../vault/vault'

/** 导入单个文件的上限。超过后整文件加密会 OOM，等流式写入补齐 */
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024

/** 递归深度上限。正常目录不会这么深，超过基本可以断定是符号链接绕圈了 */
const MAX_DEPTH = 32

/** 冲突清单最多报这么多条，再多界面也没法看 */
const MAX_REPORTED_CONFLICTS = 200

export interface ImportNode {
  name: string
  kind: 'file' | 'folder'
  /** 源文件系统路径 */
  path: string
  size?: number
  children?: ImportNode[]
}

/** 文件库自身的管理文件不能导进来，否则会把库导进库 */
function vaultInternalName(name: string): boolean {
  return name === 'vault.meta' || name === 'manifest.enc' || name === 'manifest.enc.bak'
}

/**
 * 把一个磁盘路径读成导入节点。
 *
 * 三类东西会被跳过：
 *   - 文件库自身的管理文件（vault.meta / manifest.enc*）；
 *   - 文件库根目录本身，以及它下面的 blobs/ —— 把密文再复制一份进库，
 *     库会随着每次导入无限膨胀，而且复制的密文用的是旧 blobId，解密必然失败；
 *   - 符号链接绕圈（用 realpath 去重 + 深度上限兜底）。
 */
function buildImportNode(
  path: string,
  vaultRoot: string,
  depth: number,
  seen: Set<string>,
): ImportNode | null {
  if (depth > MAX_DEPTH) return null

  let stat
  try {
    stat = statSync(path)
  } catch {
    // 断链的符号链接、权限不足等，静默跳过
    return null
  }

  const name = basename(path)
  if (vaultInternalName(name)) return null

  const abs = resolve(path)
  if (abs === vaultRoot) return null
  const blobsDir = join(vaultRoot, 'blobs')
  if (abs === blobsDir || abs.startsWith(blobsDir + sep)) return null

  if (stat.isDirectory()) {
    let real = abs
    try {
      real = realpathSync(path)
    } catch {
      /* 拿不到真实路径就用绝对路径兜底 */
    }
    // 已经走过这个目录：符号链接指回祖先，停在这里，否则会无限递归
    if (seen.has(real)) return { name, kind: 'folder', path, children: [] }

    const nextSeen = new Set(seen)
    nextSeen.add(real)

    let entries: string[] = []
    try {
      entries = readdirSync(path)
    } catch {
      return { name, kind: 'folder', path, children: [] }
    }

    const children: ImportNode[] = []
    for (const entry of entries) {
      const child = buildImportNode(join(path, entry), vaultRoot, depth + 1, nextSeen)
      if (child) children.push(child)
    }
    return { name, kind: 'folder', path, children }
  }

  if (stat.isFile()) {
    return { name, kind: 'file', path, size: stat.size }
  }

  // 设备文件、FIFO 之类，没有导入的意义
  return null
}

function buildImportTree(paths: string[], vaultRoot: string): ImportNode[] {
  const out: ImportNode[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || !path) continue
    const node = buildImportNode(path, vaultRoot, 0, new Set())
    if (node) out.push(node)
  }
  return out
}

/** 目录树 → 同级"名字 → 节点"索引。用来 O(1) 判断重名，避免每个文件都扫一遍全库 */
interface Sibling {
  id: string
  parentId: string | null
  type: 'file' | 'folder'
  name: string
}

class SiblingIndex {
  private map = new Map<string | null, Map<string, Sibling>>()

  constructor(nodes: readonly Sibling[]) {
    for (const node of nodes) this.add(node)
  }

  add(node: Sibling): void {
    let bucket = this.map.get(node.parentId)
    if (!bucket) {
      bucket = new Map()
      this.map.set(node.parentId, bucket)
    }
    bucket.set(node.name, node)
  }

  bucket(parentId: string | null): Map<string, Sibling> | undefined {
    return this.map.get(parentId)
  }

  find(parentId: string | null, name: string): Sibling | undefined {
    return this.map.get(parentId)?.get(name)
  }
}

/**
 * 生成一个在当前目录下不重名的名字：`报告.docx` → `报告 (2).docx`。
 *
 * 注意扩展名的判定用 `dot > 0`：`.gitignore` 这类隐藏文件没有扩展名，
 * 否则会被拆成空主名 + `.gitignore`，改出来变成 " (2).gitignore"。
 */
function uniqueName(index: SiblingIndex, parentId: string | null, base: string): string {
  const bucket = index.bucket(parentId)
  if (!bucket || !bucket.has(base)) return base

  const dot = base.lastIndexOf('.')
  const hasExt = dot > 0 && dot < base.length - 1
  const stem = hasExt ? base.slice(0, dot) : base
  const ext = hasExt ? base.slice(dot) : ''

  for (let i = 2; i < 100_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!bucket.has(candidate)) return candidate
  }
  // 理论上到不了这里；真到了就用时间戳保证唯一，宁可名字难看也不能覆盖
  return `${stem} (${Date.now()})${ext}`
}

function countTree(tree: ImportNode[]): { files: number; folders: number } {
  let files = 0
  let folders = 0
  const walk = (list: ImportNode[]): void => {
    for (const node of list) {
      if (node.kind === 'folder') {
        folders++
        walk(node.children ?? [])
      } else {
        files++
      }
    }
  }
  walk(tree)
  return { files, folders }
}

function countOversized(tree: ImportNode[]): number {
  let n = 0
  const walk = (list: ImportNode[]): void => {
    for (const node of list) {
      if (node.kind === 'folder') walk(node.children ?? [])
      else if ((node.size ?? 0) > MAX_IMPORT_BYTES) n++
    }
  }
  walk(tree)
  return n
}

function collectConflicts(
  index: SiblingIndex,
  parentId: string | null,
  tree: ImportNode[],
  prefix: string,
  out: ImportConflict[],
): void {
  if (out.length >= MAX_REPORTED_CONFLICTS) return
  for (const node of tree) {
    const existing = index.find(parentId, node.name)
    if (!existing) continue
    out.push({ name: prefix + node.name, kind: node.kind, existingType: existing.type })
    // 同名文件夹在"覆盖"策略下会合并进已有目录，里面的子项也可能重名，继续往下看
    if (existing.type === 'folder' && node.kind === 'folder' && node.children?.length) {
      collectConflicts(index, existing.id, node.children, `${prefix}${node.name}/`, out)
    }
  }
}

/** 预扫描：统计规模并列出重名条目，供界面在导入前询问用户 */
export function scanImport(
  vault: Vault,
  parentId: string | null,
  paths: string[],
): ImportScanResult {
  const tree = buildImportTree(paths, resolve(vault.vaultDir))
  const counts = countTree(tree)
  const index = new SiblingIndex(vault.list())
  const conflicts: ImportConflict[] = []
  collectConflicts(index, parentId, tree, '', conflicts)

  return {
    files: counts.files,
    folders: counts.folders,
    conflicts,
    oversized: countOversized(tree),
  }
}

/**
 * 执行导入。
 *
 * 整批包在 runBatch 里：期间所有写操作只标脏，最后统一落盘一次。
 * 否则导入 500 个文件就要把整棵 manifest 序列化 + 原子写 500 遍。
 */
export function executeImport(
  vault: Vault,
  parentId: string | null,
  paths: string[],
  policy: ImportConflictPolicy,
): ImportResult {
  const tree = buildImportTree(paths, resolve(vault.vaultDir))
  const result: ImportResult = { imported: 0, folders: 0, failed: [] }
  let index = new SiblingIndex(vault.list())

  /** 删除已有节点后索引会失效（子树一起没了），重建一次最省心 */
  const dropExisting = (id: string): void => {
    vault.deleteNode(id)
    index = new SiblingIndex(vault.list())
  }

  const place = (parent: string | null, node: ImportNode): void => {
    const existing = index.find(parent, node.name)

    if (node.kind === 'folder') {
      let targetId: string
      if (existing && policy === 'overwrite' && existing.type === 'folder') {
        // 覆盖同名文件夹 = 合并进去，不删除里面已有的内容
        targetId = existing.id
      } else {
        if (existing && policy === 'overwrite') dropExisting(existing.id)
        const name =
          existing && policy === 'keep-both' ? uniqueName(index, parent, node.name) : node.name
        const created = vault.createFolder(parent, name)
        index.add(created)
        result.folders++
        targetId = created.id
      }
      for (const child of node.children ?? []) place(targetId, child)
      return
    }

    if ((node.size ?? 0) > MAX_IMPORT_BYTES) {
      result.failed.push({ path: node.path, reason: '文件超过 256MB，当前版本暂不支持' })
      return
    }

    let name = node.name
    if (existing) {
      if (policy === 'overwrite') dropExisting(existing.id)
      else name = uniqueName(index, parent, node.name)
    }

    const content = readFileSync(node.path)
    try {
      const created = vault.putFile(parent, name, content)
      index.add(created)
      result.imported++
    } finally {
      wipe(content)
    }
  }

  vault.runBatch(() => {
    for (const node of tree) {
      try {
        place(parentId, node)
      } catch (err) {
        // 单个条目失败不影响其余条目 —— 导入 100 个文件不该因为第 3 个坏了就全放弃
        result.failed.push({
          path: node.path,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })

  return result
}
