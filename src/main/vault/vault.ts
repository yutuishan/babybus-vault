/**
 * 文件库（vault）的高层封装
 *
 * 硬约束（来自基线 §4）：
 *   - 文件库根目录 = 用户显式选择的文件夹，程序不设默认路径、不自动建库
 *   - 新建前必须确认目标目录不是已有文件库，否则覆盖 vault.meta 会让原数据永久解不开
 *   - 路径失效时只提示，绝不静默新建
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createDecipheriv, randomUUID } from 'node:crypto'
import type { Manifest, ManifestNode, NodeView } from '@shared/types'
import {
  createVaultMeta,
  isVaultDir,
  normalizeHint,
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
import {
  decryptBlob,
  digestContentTag,
  encryptBlob,
  parseHeader,
  rewrapBlob,
  FLAG_CHUNKED,
  HEADER_SIZE,
} from '../crypto/blob'
import {
  NONCE_LENGTH,
  TAG_LENGTH,
  WRAPPED_DEK_SIZE,
  parseWrappedDek,
  unwrapDek,
} from '../crypto/envelope'
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
  /** runBatch 期间为 true：写操作只标脏，不立刻落盘 */
  private deferPersist = false
  private pendingPersist = false

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

  /**
   * 新建文件库。目标目录若已是文件库则直接报错 —— 覆盖等于销毁原数据
   * @param hint 可选的密码提示语，以明文写进 vault.meta（锁屏界面要显示它）
   */
  static async create(vaultDir: string, password: string, hint = ''): Promise<Vault> {
    if (isVaultDir(vaultDir)) {
      throw new VaultError(
        '该目录已经是加密文件库。请改用「打开文件库」，不要在此新建 —— 新建会覆盖原有数据且无法恢复。',
        'ALREADY_VAULT',
      )
    }
    mkdirSync(vaultDir, { recursive: true })
    initVaultDir(vaultDir)

    const { meta, masterKey } = await createVaultMeta(password, hint)
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

    // 旧库迁移：提示语原本存在加密的 manifest 里，锁屏看不到。
    // 这里把它搬到明文的 vault.meta，之后 manifest 里不再写这个字段。
    const legacyHint = normalizeHint(read.manifest.hint)
    if (legacyHint && !meta.hint) {
      meta.hint = legacyHint
      try {
        writeVaultMeta(vaultDir, meta)
      } catch {
        // 只读介质上写不进去也不该让开库失败，提示语退回"仅解锁后可见"
      }
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
    // 批量导入期间抑制落盘：一次导入 500 个文件不该写 500 遍 manifest
    if (this.deferPersist) {
      this.pendingPersist = true
      return
    }
    this.withManifestKey((key) => writeManifest(this.vaultDir, key, this.manifestData))
  }

  /**
   * 把一批写操作合并成一次落盘。
   *
   * 导入目录时每个文件都要写一次 manifest，而 manifest 是整棵树的 JSON ——
   * 500 个文件就是 500 次全量序列化 + 原子写，慢得没必要。
   * 这里只推迟落盘，不改任何语义。
   *
   * 无论 fn 是否抛错，最后都会落盘一次：期间创建的 blob 已经写到磁盘上了，
   * manifest 必须与之保持一致，否则会留下永远读不到的孤儿密文。
   */
  runBatch<T>(fn: () => T): T {
    this.assertUnlocked()
    const outer = this.deferPersist
    this.deferPersist = true
    try {
      return fn()
    } finally {
      this.deferPersist = outer
      if (!outer && this.pendingPersist) {
        this.pendingPersist = false
        this.persist()
      }
    }
  }

  // ------------------------------------------------------------ 密码提示

  /**
   * 读取主密码提示语。
   *
   * 提示语存在 vault.meta 里（明文），所以严格来说这里不必要求解锁 ——
   * 但 Vault 实例的其它方法都在锁定时拒绝服务，保持一致性更不容易误用。
   * 锁屏界面需要的那次读取走 vaultMeta.peekHint(dir)，不经过实例。
   */
  getHint(): string {
    this.assertUnlocked()
    return normalizeHint(this.meta.hint)
  }

  /** 设置/清除主密码提示语。空字符串表示清除 */
  setHint(hint: string): void {
    this.assertUnlocked()
    const trimmed = normalizeHint(hint)
    if (trimmed) this.meta.hint = trimmed
    else delete this.meta.hint
    // 提示语在 vault.meta 里，写的是 meta 而不是 manifest
    writeVaultMeta(this.vaultDir, this.meta)
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

  /**
   * 重新从磁盘读一遍 manifest —— 「刷新文件库」按钮的实际动作。
   *
   * 为什么需要它：界面上的目录树来自内存里的 manifestData，只在启动时读过一次。
   * 文件库目录是普通文件夹，同步盘回写、手动替换文件、杀软隔离文件都会让磁盘
   * 与内存不一致，不重读就永远看不到这些变化。
   *
   * 失败时**保持原有内存状态不变**并抛错。这一点很重要：绝不能因为一次读取失败
   * （比如 manifest 正被同步盘写坏）就把用户眼前的目录清空 —— 那看起来就像数据丢了。
   */
  reload(): void {
    this.assertUnlocked()
    const key = deriveSubkey(this.masterKey, this.salt, INFO_MANIFEST)
    try {
      const read = readManifest(this.vaultDir, key)
      this.manifestData = read.manifest
    } finally {
      wipe(key)
    }
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

  /**
   * 流式读取文件明文的一个字节区间 —— 音视频预览专用。
   *
   * 为什么不能复用 readFile：
   *   1. 内存。readFile 会把整个密文读进来、再把整个明文拼出来，峰值内存约 2×文件大小。
   *      一个 1.5GB 的视频足以把主进程直接 OOM 掉，而视频恰恰是最需要预览的大文件。
   *   2. 拖动进度条。<video> 需要能按 Range 随机访问，整包读完再交给 Blob URL 的话，
   *      浏览器必须等整个文件下载完才能播，进度条基本不可用。
   *
   * 实现要点（GCM 是 CTR 流模式，密文长度 == 明文长度）：
   *   - 只需读前 126 字节（header 38 + wrappedDEK 60 + nonce 12 + tag 16）就能解出 DEK；
   *   - 密文从偏移 126 开始，与明文一一对应，所以明文偏移 X 就是密文偏移 126+X；
   *   - GCM 的计数器必须从块 0 开始推进，**无法跳到任意偏移**，因此哪怕只取中间一段，
   *     也要把 [0, end] 的密文顺序喂给 decipher，只是把 start 之前解出来的明文丢掉。
   *     这是 GCM 的固有代价，换来的是内存占用与文件大小无关（只与分块大小有关）。
   *
   * ⚠️ 有意省略的一步：不调用 decipher.final()，因此**不校验 GCM 认证标签**。
   *    要校验就必须读完整个密文，那就回到"必须整份解密"的老路上，流式就失去意义了。
   *    代价可接受，因为其余防线仍在：
   *      - AAD 绑定 header（含 blobId），跨文件搬运依然会被 header 里的 blobId 与节点 id 比对拦下；
   *      - header.plainSize 与 manifest 记录比对，截断/替换长度会被发现；
   *      - 真正的完整性校验（contentTag，整个 blob 的 SHA-256）在导出、搜索等
   *        会完整读一遍的路径上照常执行。
   *    换言之：这条路径牺牲的是"流式播放期间检测到密文被篡改"，而不是"防止读错文件"。
   *
   * @param start 起始明文偏移（含），负数按 0 处理
   * @param end   结束明文偏移（含），超过文件长度会被夹到末尾
   * @returns 明文分片流。调用方取消或读取完毕时 fd 与 DEK 都会被释放
   */
  createPlainStream(id: string, start: number, end: number): ReadableStream<Uint8Array> {
    this.assertUnlocked()
    const node = this.findNode(id)
    if (!node || node.type !== 'file' || !node.blob) {
      throw new VaultError('文件不存在', 'NODE_NOT_FOUND')
    }

    const PREFIX_SIZE = HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH + TAG_LENGTH
    const fd = openSync(join(this.vaultDir, node.blob), 'r')
    let dek: Buffer | null = null

    const release = () => {
      if (dek) {
        wipe(dek)
        dek = null
      }
      try {
        closeSync(fd)
      } catch {
        /* 已经关掉了 */
      }
    }

    try {
      const prefix = Buffer.alloc(PREFIX_SIZE)
      const got = readSync(fd, prefix, 0, PREFIX_SIZE, 0)
      if (got < PREFIX_SIZE) throw new VaultError('密文文件不完整', 'BLOB_TRUNCATED')

      const headerBuf = prefix.subarray(0, HEADER_SIZE)
      const wrappedBytes = prefix.subarray(HEADER_SIZE, HEADER_SIZE + WRAPPED_DEK_SIZE)
      const contentNonce = prefix.subarray(
        HEADER_SIZE + WRAPPED_DEK_SIZE,
        HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH,
      )
      const contentTag = prefix.subarray(PREFIX_SIZE - TAG_LENGTH, PREFIX_SIZE)

      const header = parseHeader(headerBuf)
      if (header.blobId !== node.id) {
        throw new VaultError('密文与目录记录不一致，已拒绝读取（文件可能被替换）', 'TAG_MISMATCH')
      }
      // 长度比对是这条路径上唯一还能做的完整性校验（见方法注释里关于认证标签的说明），
      // 同时也保证调用方给出的 Content-Length 与实际发出的字节数严格一致 ——
      // 播放器对这一点很敏感，长度对不上会直接报错而不是播到一半结束。
      if (node.size !== undefined && header.plainSize !== node.size) {
        throw new VaultError('密文长度与目录记录不一致，已拒绝读取（文件可能被替换）', 'TAG_MISMATCH')
      }
      if (header.flags & FLAG_CHUNKED) {
        throw new VaultError('分块模式的密文暂不支持流式读取', 'UNSUPPORTED_BLOB')
      }

      const plainSize = header.plainSize
      if (plainSize <= 0) {
        release()
        return new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        })
      }

      const from = Math.max(0, Math.min(Math.floor(start) || 0, plainSize - 1))
      const to = Math.min(Math.max(Math.floor(end) || 0, from), plainSize - 1)

      dek = unwrapDek(this.masterKey, parseWrappedDek(wrappedBytes), headerBuf)
      const decipher = createDecipheriv('aes-256-gcm', dek, contentNonce)
      decipher.setAAD(headerBuf)
      decipher.setAuthTag(contentTag)

      /** 已喂入 decipher 的密文字节数，等于已解出的明文字节数 */
      let fed = 0
      let done = false
      const CHUNK = 256 * 1024

      /**
       * ⚠️ pull 有一条**必须遵守的契约**：每次被调用时，要么 enqueue，要么 close/error，
       * **绝不能什么都没做就返回**。
       *
       * 实测（Node 22 的 ReadableStream）：pull 返回后若没有 enqueue 任何东西，
       * 流**不会再调用 pull**，reader.read() 就永久挂住 —— 不是变慢，是彻底死等。
       * 而"取中后段"的请求恰恰会命中：GCM 计数器无法跳转，必须从 0 顺序推进，
       * 所以在追上 from 之前的每一块都是"解出来再丢掉"，一个字节都 enqueue 不出去。
       * 结果是**任何 start >= CHUNK(256KB) 的区间请求永久挂死**：
       *   - <audio> 拖动进度条后卡住、不再出声；
       *   - <video> 需要读 moov（常在文件尾部）时干脆放不了。
       * 这正是"mp3 拖进度条不能继续播放、mp4 无法播放"的根因。
       *
       * 所以下面写成"在单次 pull 内循环推进"：只有真正产出（或结束）才 return。
       * 每 8 块让出一次事件循环 —— 拖到接近末尾时要顺序解掉前面整份，
       * 全程不让出会把主进程卡死（IPC 与窗口都会无响应）。
       */
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            let spins = 0
            while (!done) {
              const want = Math.min(CHUNK, to - fed + 1)
              const buf = Buffer.alloc(want)
              const n = readSync(fd, buf, 0, want, PREFIX_SIZE + fed)
              if (n <= 0) {
                done = true
                release()
                controller.close()
                return
              }
              const plainStart = fed
              fed += n
              const plain = decipher.update(n === want ? buf : buf.subarray(0, n))
              const finished = fed > to

              // 丢掉 start 之前解出来的部分 —— 它们只是为了推进 GCM 计数器
              const skip = Math.max(0, from - plainStart)
              if (skip < plain.length) {
                controller.enqueue(new Uint8Array(plain.subarray(skip)))
                if (finished) {
                  done = true
                  release()
                  controller.close()
                }
                return
              }

              if (finished) {
                done = true
                release()
                controller.close()
                return
              }

              // 整块都落在 from 之前，本次还没产出：必须继续推进，不能就此 return
              if (++spins % 8 === 0) await new Promise<void>((r) => setImmediate(r))
            }
          } catch (err) {
            done = true
            release()
            controller.error(err)
          }
        },
        cancel() {
          done = true
          release()
        },
      })
    } catch (err) {
      release()
      throw err
    }
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
    // 提示语必须带上：它是 vault.meta 的字段，不传就等于改密码时把提示语抹掉
    const created = await createVaultMeta(newPassword, this.meta.hint ?? '')
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
