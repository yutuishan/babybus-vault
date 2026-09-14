/** 前后端共享的数据结构定义 */

export type NodeType = 'folder' | 'file'

export interface ManifestNode {
  /** 节点 id。对于文件节点，必须等于对应 blob 的 blobId（AAD 绑定的关键） */
  id: string
  parentId: string | null
  type: NodeType
  /** 明文文件名（仅存在于加密后的 manifest 内部） */
  name: string
  /** 文件扩展名，小写无点，如 "docx" */
  ext?: string
  /** 明文大小（字节） */
  size?: number
  /** blob 相对路径，如 "blobs/uuid.enc" */
  blob?: string
  /** blobId，必须等于 id。解密时用于校验 blob 未被跨文件搬运 */
  blobId?: string
  /** 整个 blob 文件的 SHA-256，第二重校验 */
  contentTag?: string
  createdAt: number
  updatedAt: number
}

export interface Manifest {
  version: number
  nodes: ManifestNode[]
  /**
   * 主密码提示语 —— **历史字段，仅用于迁移读取**。
   *
   * 早期版本把提示语放在加密的 manifest 里，代价是锁屏时看不到（密钥已清空，
   * 主进程自己都读不出来）。后来按需求改成锁屏也要能看见，提示语就搬到了
   * vault.meta 的 `hint` 字段（明文）。这里保留字段定义只为兼容旧库：
   * Vault.open 时如果发现 manifest 里有提示语而 meta 里没有，会自动迁移过去。
   *
   * 新代码不要再写这个字段。
   */
  hint?: string
}

/** vault.meta 中的密码校验值（GCM 必须要 nonce/ciphertext/tag 三元组） */
export interface VerifyPayload {
  nonce: string
  ciphertext: string
  tag: string
}

/** vault.meta：不含任何文件名与目录结构，可随库迁移 */
export interface VaultMeta {
  version: number
  kdf: 'argon2id' | 'scrypt'
  /** 实现来源：node-crypto / scrypt / hash-wasm */
  kdfImpl: string
  kdfParams: Record<string, number>
  /** base64 编码的盐（16 字节） */
  salt: string
  verify: VerifyPayload
  /**
   * 主密码提示语（可选）。
   *
   * ⚠️ 这个字段是**明文**的，任何拿到这个文件夹的人都能直接读出来 ——
   * 这是为了满足「锁屏界面也要显示提示」而付出的明确代价：
   * 密钥在锁定时已被清空，要在不输入密码的前提下显示提示，它就只能是不加密的。
   *
   * 因此界面上必须写清楚「提示语以明文保存，不要直接写出密码本身」。
   * 反过来说，如果哪天又要求"提示语必须保密"，那这个字段就得删掉，
   * 提示语会退回成"只有解锁后才可见"。
   */
  hint?: string
}

/** 传给渲染进程的节点视图（不含 blob 路径等内部信息） */
export interface NodeView {
  id: string
  parentId: string | null
  type: NodeType
  name: string
  ext?: string
  size?: number
  updatedAt: number
}
