/**
 * 文件库（vault）的高层封装
 *
 * 硬约束（来自基线 §4）：
 *   - 文件库根目录 = 用户显式选择的文件夹，程序不设默认路径、不自动建库
 *   - 新建前必须确认目标目录不是已有文件库，否则覆盖 vault.meta 会让原数据永久解不开
 *   - 路径失效时只提示，绝不静默新建
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Manifest, ManifestNode, NodeView } from '@shared/types'
import {
  createVaultMeta,
  isVaultDir,
  readVaultMeta,
  verifyPassword,
  writeVaultMeta,
  type CreateMetaResult,
} from './vaultMeta'
import {
  cleanupTempFiles,
  initVaultDir,
  readManifest,
  writeManifest,
} from '../crypto/manifest'
import { decryptBlob, digestContentTag, encryptBlob, rewrapBlob } from '../crypto/blob'
import { deriveSubkey, INFO_MANIFEST } from '../crypto/keys'
import { wipe } from '../crypto/secureBuffer'
import { createHash } from 'node:crypto'

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}

export class Vault {
  private manifestData: Manifest
  private locked = false

  private constructor(
    readonly vaultDir: string,
    private masterKey: Buffer,
    private salt: Buffer,
    private meta: NonNullable<CreateMetaResult['meta']>,
    manifest: Manifest,
    readonly recoveredFromBackup = false,
  ) {
    this.manifestData = manifest
  }

  // ------------------------------------------------------------ 生命周期

  /** 新建文件库。目标目录若已是文件库则直接报错 —— 覆盖等于销毁原数据 */
  static async create(vaultDir: string, password: string): Promise<Vault> {
    if (isVaultDir(vaultDir)) {
      throw new VaultError(
        '该目录已经是加密文件库。请改用「打开文件库」，不要在此新建 —— 新建会覆盖原有数据且无法恢复。',
        'ALREADY_VAULT',
      )
    }
    mkdirSync(vaultDir, { recursive: true })
    initVaultDir(vaultDir)

    const { meta, masterKey } = await createVaultMeta(password)
    writeVaultMeta(vaultDir, meta)

    const empty: Manifest = { version: 2, nodes: [] }
    const salt = Buffer.from(meta.salt, 'base64')
    const manifestKey = deriveSubkey(masterKey, salt, INFO_MANIFEST)
    try {
      writeManifest(vaultDir, manifestKey, empty)
    } finally {
      wipe(manifestKey)
    }

    return new Vault(vaultDir, masterKey, salt, meta, empty)
  }

  /** 打开文件库。密码错误或格式不兼容都会抛 VaultError */
  static async open(vaultDir: string, password: string): Promise<Vault> {
    if (!isVaultDir(vaultDir)) {
      throw new VaultError('该目录不是有效的加密文件库（未找到 vault.meta）', 'NOT_A_VAULT')
    }
    const meta = readVaultMeta(vaultDir)
    const result = await verifyPassword(meta, password)
    if (!result.ok || !result.masterKey) {
      throw new VaultError('主密码错误', 'BAD_PASSWORD')
    }

    const salt = Buffer.from(meta.salt, 'base64')
    const manifestKey = deriveSubkey(result.masterKey, salt, INFO_MANIFEST)
    let read
    try {
      read = readManifest(vaultDir, manifestKey)
    } finally {
      wipe(manifestKey)
    }

    cleanupTempFiles(vaultDir)
    return new Vault(
      vaultDir,
      result.masterKey,
      salt,
      meta,
      read.manifest,
      read.recoveredFromBackup,
    )
  }

  /** 锁定时清空内存中的主密钥与目录树明文 */
  lock(): void {
    if (this.locked) return
    wipe(this.masterKey)
    this.manifestData = { version: 2, nodes: [] }
    this.locked = true
  }

  get isLocked(): boolean {
    return this.locked
  }

  private assertUnlocked(): void {
    if (this.locked) throw new VaultError('文件库已锁定', 'LOCKED')
  }

  /** 每次持久化都用临时子密钥，用完即弃 */
  private withManifestKey<T>(fn: (key: Buffer) => T): T {
    const key = deriveSubkey(this.masterKey, this.salt, INFO_MANIFEST)
    try {
      return fn(key)
    } finally {
      wipe(key)
    }
  }

  private persist(): void {
    this.withManifestKey((key) => writeManifest(this.vaultDir, key, this.manifestData))
  }

  // ------------------------------------------------------------ 目录树操作

  /** 返回给渲染进程用的节点视图 */
  list(): NodeView[] {
    this.assertUnlocked()
    return this.manifestData.nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      type: n.type,
      name: n.name,
      ext: n.ext,
      size: n.size,
      updatedAt: n.updatedAt,
    }))
  }

  private findNode(id: string): ManifestNode | undefined {
    return this.manifestData.nodes.find((n) => n.id === id)
  }

  createFolder(parentId: string | null, name: string): ManifestNode {
    this.assertUnlocked()
    if (parentId && !this.findNode(parentId)) {
      throw new VaultError('父目录不存在', 'PARENT_NOT_FOUND')
    }
    const now = Date.now()
    const node: ManifestNode = {
      id: randomUUID(),
      parentId,
      type: 'folder',
      name,
      createdAt: now,
      updatedAt: now,
    }
    this.manifestData.nodes.push(node)
    this.persist()
    return node
  }

  /**
   * 移动节点到新父目录。
   * 拒绝把节点移进自己的子树 —— 那样会让整棵子树从目录树里消失。
   */
  moveNode(id: string, parentId: string | null): void {
    this.assertUnlocked()
    const node = this.findNode(id)
    if (!node) throw new VaultError('节点不存在', 'NODE_NOT_FOUND')
    if (parentId === id) throw new VaultError('不能把文件夹移动到它自己下面', 'INVALID_MOVE')
    if (parentId) {
      const target = this.findNode(parentId)
      if (!target) throw new VaultError('目标目录不存在', 'PARENT_NOT_FOUND')
      if (target.type !== 'folder') throw new VaultError('只能移动到文件夹', 'NOT_FOLDER')
      if (this.collectSubtree(id).some((n) => n.id === parentId)) {
        throw new VaultError('不能把文件夹移动到它自己的子目录里', 'INVALID_MOVE')
      }
    }
    node.parentId = parentId
    node.updatedAt = Date.now()
    this.persist()
  }

  renameNode(id: string, name: string): void {
    this.assertUnlocked()
    const node = this.findNode(id)
    if (!node) throw new VaultError('节点不存在', 'NODE_NOT_FOUND')
    node.name = name
    node.updatedAt = Date.now()
    this.persist()
  }

  /**
   * 写入一个文件。
   * 每次调用都生成全新的 node id（= blobId）与全新 DEK/nonce。
   */
  putFile(parentId: string | null, name: string, content: Buffer): ManifestNode {
    this.assertUnlocked()
    if (parentId && !this.findNode(parentId)) {
      throw new VaultError('父目录不存在', 'PARENT_NOT_FOUND')
    }
    const id = randomUUID()
    const blob = encryptBlob(this.masterKey, id, content)
    const relPath = `blobs/${id}.enc`
    writeFileSync(join(this.vaultDir, relPath), blob)

    const now = Date.now()
    const node: ManifestNode = {
      id,
      parentId,
      type: 'file',
      name,
      ext: name.includes('.') ? name.split('.').pop()!.toLowerCase() : undefined,
      size: content.length,
      blob: relPath,
      blobId: id,
      contentTag: digestContentTag(blob),
      createdAt: now,
      updatedAt: now,
    }
    this.manifestData.nodes.push(node)
    this.persist()
    return node
  }

  /** 读取文件明文。调用方负责在用完后 wipe */
  readFile(id: string): Buffer {
    this.assertUnlocked()
    const node = this.findNode(id)
    if (!node || node.type !== 'file' || !node.blob) {
      throw new VaultError('文件不存在', 'NODE_NOT_FOUND')
    }
    const blob = readFileSync(join(this.vaultDir, node.blob))

    // 二次校验：整个 blob 的摘要必须与 manifest 记录一致，防止文件被整体替换
    if (node.contentTag && digestContentTag(blob) !== node.contentTag) {
      throw new VaultError('文件内容与目录记录不一致，已拒绝读取（文件可能被替换）', 'TAG_MISMATCH')
    }

    return decryptBlob(this.masterKey, blob, {
      expectBlobId: node.id,
      expectPlainSize: node.size,
    })
  }

  /** 递归收集子树的所有节点 id */
  private collectSubtree(id: string): ManifestNode[] {
    const result: ManifestNode[] = []
    const queue = [id]
    while (queue.length) {
      const current = queue.pop()!
      const node = this.findNode(current)
      if (!node) continue
      result.push(node)
      for (const child of this.manifestData.nodes) {
        if (child.parentId === current) queue.push(child.id)
      }
    }
    return result
  }

  /**
   * 删除节点（含子树）。
   * 密文 blob 直接 unlink，不进回收站 —— 进回收站等于把密文长期留在磁盘上。
   */
  deleteNode(id: string): number {
    this.assertUnlocked()
    const subtree = this.collectSubtree(id)
    if (subtree.length === 0) throw new VaultError('节点不存在', 'NODE_NOT_FOUND')

    for (const node of subtree) {
      if (node.type === 'file' && node.blob) {
        const path = join(this.vaultDir, node.blob)
        if (existsSync(path)) unlinkSync(path)
      }
    }
    const ids = new Set(subtree.map((n) => n.id))
    this.manifestData.nodes = this.manifestData.nodes.filter((n) => !ids.has(n.id))
    this.persist()
    return ids.size
  }

  // ------------------------------------------------------------ 改主密码

  /**
   * 修改主密码。
   *
   * 关键是顺序：先把所有 blob 重新包装到 .tmp，全部成功后再统一 rename，
   * 最后才更新 vault.meta 与 manifest。这样中途崩溃时，旧密码仍然能打开整个库
   * （最坏情况是留下一批 .tmp 垃圾文件）。
   *
   * 由于 content 段的 AAD 只绑定 header，重包装 DEK 不需要重新加密文件内容 ——
   * 所以改密码的代价是 O(文件数)，而不是 O(数据总量)。
   */
  async changePassword(newPassword: string): Promise<void> {
    this.assertUnlocked()
    const fileNodes = this.manifestData.nodes.filter((n) => n.type === 'file' && n.blob)
    const tmpPaths: { tmp: string; target: string }[] = []

    // 换密码同时换盐：旧盐即使已泄露也不影响新密码派生的密钥
    const created = await createVaultMeta(newPassword)
    const newMasterKey = created.masterKey
    const newSalt = Buffer.from(created.meta.salt, 'base64')

    try {
      // 阶段一：全部重包装到临时文件（此时磁盘上的正式文件仍是旧密钥，旧密码仍可开库）
      for (const node of fileNodes) {
        const target = join(this.vaultDir, node.blob!)
        if (!existsSync(target)) continue
        const blob = readFileSync(target)
        const rewrapped = rewrapBlob(this.masterKey, newMasterKey, blob)
        const tmp = `${target}.tmp`
        writeFileSync(tmp, rewrapped)
        tmpPaths.push({ tmp, target })
      }

      // 阶段二：统一替换（rename 是原子的）
      for (const { tmp, target } of tmpPaths) {
        renameSync(tmp, target)
      }

      // 阶段三：更新 vault.meta
      writeVaultMeta(this.vaultDir, created.meta)

      // 阶段四：用新 manifestKey 重写 manifest，并刷新 contentTag（blob 字节已变）
      const newManifestKey = deriveSubkey(newMasterKey, newSalt, INFO_MANIFEST)
      try {
        for (const node of fileNodes) {
          const path = join(this.vaultDir, node.blob!)
          if (existsSync(path)) node.contentTag = digestContentTag(readFileSync(path))
        }
        writeManifest(this.vaultDir, newManifestKey, this.manifestData)
      } finally {
        wipe(newManifestKey)
      }

      wipe(this.masterKey)
      this.masterKey = newMasterKey
      this.salt = newSalt
      this.meta = created.meta
    } catch (err) {
      // 回滚：清理所有临时文件，旧密码仍然可用
      for (const { tmp } of tmpPaths) {
        try {
          if (existsSync(tmp)) unlinkSync(tmp)
        } catch {
          /* 忽略清理失败 */
        }
      }
      wipe(newMasterKey)
      throw err
    }
  }

  /** 当前库使用的 KDF，用于界面展示 */
  get kdfInfo(): { kdf: string; kdfImpl: string } {
    return { kdf: this.meta.kdf, kdfImpl: this.meta.kdfImpl }
  }
}

/** 校验文件库目录是否可写（U 盘只读、权限不足时会失败） */
export function assertVaultWritable(vaultDir: string): void {
  const probe = join(vaultDir, '.write-probe')
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch {
    throw new VaultError('文件库目录不可写（可能是只读介质或权限不足）', 'NOT_WRITABLE')
  }
}

/** 计算文件的 SHA-256，用于导入导出时的完整性核对 */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
