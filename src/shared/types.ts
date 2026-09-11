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
}

/** vault.meta 中的密码校验值（GCM 必须要 nonce/ciphertext/tag 三元组） */
export interface VerifyPayload {
  nonce: string
  ciphertext: string
  tag: string
}

/** vault.meta：非敏感，可随库迁移，不含任何文件名与目录结构 */
export interface VaultMeta {
  version: number
  kdf: 'argon2id' | 'scrypt'
  /** 实现来源：node-crypto / scrypt / hash-wasm */
  kdfImpl: string
  kdfParams: Record<string, number>
  /** base64 编码的盐（16 字节） */
  salt: string
  verify: VerifyPayload
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
