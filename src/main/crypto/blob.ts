/**
 * blob：加密的文件内容容器（ENC1 / version 2）
 *
 * 二进制布局：
 * ┌─ Header（明文，38 字节）─────────────────────────────┐
 * │ magic         4B    "ENC1"                          │
 * │ version       1B    2                               │
 * │ flags         1B    bit0: 1=分块模式 / 0=整文件模式   │
 * │ chunkSize     4B    分块大小（BE），整文件模式填 0     │
 * │ chunkCount    4B    块数量（BE），整文件模式填 0       │
 * │ blobId        16B   UUIDv4 原始字节                  │
 * │ plainSize     8B    明文字节数（BE）                  │
 * ├─ wrappedDEK 段（60 字节）────────────────────────────┤
 * │ wrappedDEKNonce       12B                           │
 * │ wrappedDEKTag         16B                           │
 * │ wrappedDEKCiphertext  32B                           │
 * ├─ content 段 ────────────────────────────────────────┤
 * │ contentNonce          12B                           │
 * │ contentTag            16B                           │
 * │ contentCiphertext     变长                           │
 * └─────────────────────────────────────────────────────┘
 *
 * AAD 绑定（防跨文件搬运，必须有）：
 *   AAD(wrappedDEK) = header 全部 38 字节
 *   AAD(content)    = header 全部 38 字节
 *
 * 并且 blobId 必须等于 manifest 中该节点的 id，否则 decryptBlob 直接拒绝。
 *
 * ⚠️ 关于 AAD(content) 为什么"只"绑 header，而不像基线 §4.3 那样再并上 wrappedDEK 段：
 *    基线 §4.3 写 AAD(content) = header || wrappedDEK 三段，但 §5.3 又承诺
 *    "改主密码时只需重新包装 DEK，不需要重新加密文件内容" —— 这两条互斥：
 *    重包装 DEK 会改变 wrappedDEK 的字节，content 的 AAD 随之失效，必须重加密全部内容。
 *
 *    而并上 wrappedDEK 段带来的额外保护其实为零：跨文件搬运已经被 header 里的 blobId
 *    阻断（A 的 content 搬到 B，解密时用的是 B 的 DEK 与 B 的 header，认证必然失败）。
 *    "替换同一 blob 内的 wrappedDEK 段"这一攻击要想成立，攻击者必须能用 masterKey
 *    包装一个他自己知道的 DEK —— 那说明 masterKey 已经泄露，防护早已失去意义。
 *
 *    因此这里选择"绑 header"，保住改密码 O(1) 的性能承诺；
 *    跨文件替换的二次校验由 manifest 中记录的 contentTag（整个 blob 的 SHA-256）承担。
 */
import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { randomBytes, wipe } from './secureBuffer'
import {
  NONCE_LENGTH,
  TAG_LENGTH,
  WRAPPED_DEK_SIZE,
  generateDek,
  parseWrappedDek,
  serializeWrappedDek,
  unwrapDek,
  wrapDek,
  type WrappedDek,
} from './envelope'

export const BLOB_MAGIC = 'ENC1'
export const BLOB_VERSION = 2
export const HEADER_SIZE = 38

/** flags bit0：分块模式（当前版本未启用，为将来 v3 预留） */
export const FLAG_CHUNKED = 0x01

/** 整文件模式下单个 blob 的明文上限：512 MiB。超过必须改用分块流式 */
export const MAX_PLAIN_SIZE = 512 * 1024 * 1024

export interface BlobHeader {
  version: number
  flags: number
  chunkSize: number
  chunkCount: number
  blobId: string
  plainSize: number
}

// ---------------------------------------------------------------- UUID 工具

export function newBlobId(): string {
  // randomUUID 在 Node 中生成的是 v4（随机），不含 MAC 地址与时间戳
  return randomUUID()
}

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`非法 UUID：${uuid}`)
  return Buffer.from(hex, 'hex')
}

export function bytesToUuid(buf: Buffer): string {
  if (buf.length !== 16) throw new Error('UUID 必须是 16 字节')
  const h = buf.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ---------------------------------------------------------------- Header 读写

export function serializeHeader(header: BlobHeader): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE)
  buf.write(BLOB_MAGIC, 0, 'ascii')
  buf.writeUInt8(header.version, 4)
  buf.writeUInt8(header.flags, 5)
  buf.writeUInt32BE(header.chunkSize, 6)
  buf.writeUInt32BE(header.chunkCount, 10)
  uuidToBytes(header.blobId).copy(buf, 14)
  buf.writeBigUInt64BE(BigInt(header.plainSize), 30)
  return buf
}

export function parseHeader(buf: Buffer): BlobHeader {
  if (buf.length < HEADER_SIZE) {
    throw new Error(`blob 过短：${buf.length} 字节`)
  }
  const magic = buf.subarray(0, 4).toString('ascii')
  if (magic !== BLOB_MAGIC) {
    throw new Error(`不是有效的 blob 文件（magic=${magic}）`)
  }
  const version = buf.readUInt8(4)
  if (version !== BLOB_VERSION) {
    throw new Error(`不支持的 blob 版本：${version}（当前实现仅支持 ${BLOB_VERSION}）`)
  }
  return {
    version,
    flags: buf.readUInt8(5),
    chunkSize: buf.readUInt32BE(6),
    chunkCount: buf.readUInt32BE(10),
    blobId: bytesToUuid(buf.subarray(14, 30)),
    plainSize: Number(buf.readBigUInt64BE(30)),
  }
}

// ---------------------------------------------------------------- 加解密

export interface EncryptBlobOptions {
  /** 分块模式预留字段，当前必须为 0 */
  chunkSize?: number
  chunkCount?: number
}

/**
 * 加密一段明文为 blob 二进制。
 *
 * 每次调用都会生成全新的 DEK 与全新的 nonce —— 绝不复用。
 * GCM 在同一密钥下复用 nonce 会让攻击者恢复认证子密钥，等于整层加密失效。
 */
export function encryptBlob(
  masterKey: Buffer,
  blobId: string,
  plain: Buffer,
  options: EncryptBlobOptions = {},
): Buffer {
  if (plain.length > MAX_PLAIN_SIZE) {
    throw new Error(`明文过大（${plain.length} 字节），超出整文件模式上限 ${MAX_PLAIN_SIZE}`)
  }

  const header = serializeHeader({
    version: BLOB_VERSION,
    flags: 0, // 整文件模式
    chunkSize: options.chunkSize ?? 0,
    chunkCount: options.chunkCount ?? 0,
    blobId,
    plainSize: plain.length,
  })

  const dek = generateDek()
  try {
    const wrapped = wrapDek(masterKey, dek, header)
    const wrappedBytes = serializeWrappedDek(wrapped)

    // content 段的 AAD 绑定文件头（含 blobId 与 plainSize）
    const contentAad = header

    const contentNonce = randomBytes(NONCE_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', dek, contentNonce)
    cipher.setAAD(contentAad)
    const contentCiphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    const contentTag = cipher.getAuthTag()

    return Buffer.concat([header, wrappedBytes, contentNonce, contentTag, contentCiphertext])
  } finally {
    wipe(dek)
  }
}

export interface DecryptBlobOptions {
  /** 期望的 blobId（来自 manifest 节点 id）。不一致直接拒绝，防搬运 */
  expectBlobId?: string
  /** 期望的明文长度，来自 manifest。不一致说明被替换或截断 */
  expectPlainSize?: number
}

/**
 * 解密 blob。
 *
 * 任何篡改、搬运、截断都会导致 GCM 认证失败并抛异常 —— 这是设计目标，不是 bug。
 */
export function decryptBlob(
  masterKey: Buffer,
  blob: Buffer,
  options: DecryptBlobOptions = {},
): Buffer {
  const header = parseHeader(blob)

  if (options.expectBlobId && header.blobId !== options.expectBlobId) {
    throw new Error(
      `blobId 不匹配：blob=${header.blobId}，期望=${options.expectBlobId}（疑似密文被搬运）`,
    )
  }
  if (options.expectPlainSize !== undefined && header.plainSize !== options.expectPlainSize) {
    throw new Error(`明文长度不匹配：blob 记录 ${header.plainSize}，期望 ${options.expectPlainSize}`)
  }
  if (header.flags & FLAG_CHUNKED) {
    throw new Error('分块模式 blob 当前版本不支持（需升级到 v3 解码器）')
  }

  const headerBuf = blob.subarray(0, HEADER_SIZE)
  const wrappedBytes = blob.subarray(HEADER_SIZE, HEADER_SIZE + WRAPPED_DEK_SIZE)
  if (wrappedBytes.length !== WRAPPED_DEK_SIZE) {
    throw new Error('blob 的 wrappedDEK 段长度不足')
  }
  const contentAad = headerBuf

  const wrapped: WrappedDek = parseWrappedDek(wrappedBytes)
  const dek = unwrapDek(masterKey, wrapped, headerBuf)
  try {
    const contentNonce = blob.subarray(
      HEADER_SIZE + WRAPPED_DEK_SIZE,
      HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH,
    )
    const contentTag = blob.subarray(
      HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH,
      HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH + TAG_LENGTH,
    )
    const contentCiphertext = blob.subarray(
      HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH + TAG_LENGTH,
    )

    const decipher = createDecipheriv('aes-256-gcm', dek, contentNonce)
    decipher.setAAD(contentAad)
    decipher.setAuthTag(contentTag)
    const plain = Buffer.concat([decipher.update(contentCiphertext), decipher.final()])

    if (plain.length !== header.plainSize) {
      throw new Error(`解密长度与头部记录不一致：${plain.length} vs ${header.plainSize}`)
    }
    return plain
  } finally {
    wipe(dek)
  }
}

/** 只读头部信息（不解密，用于校验与展示） */
export function readBlobHeader(blob: Buffer): BlobHeader {
  return parseHeader(blob)
}

/**
 * 用新主密钥重新包装 DEK（改主密码时调用）。
 *
 * 只重写 wrappedDEK 段，content 段一个字节都不动 —— 这正是信封加密的价值：
 * 改密码是 O(文件数) 而不是 O(数据总量)。
 */
export function rewrapBlob(oldMasterKey: Buffer, newMasterKey: Buffer, blob: Buffer): Buffer {
  parseHeader(blob) // 先校验 magic / version
  const headerBuf = Buffer.from(blob.subarray(0, HEADER_SIZE))
  const wrappedBytes = blob.subarray(HEADER_SIZE, HEADER_SIZE + WRAPPED_DEK_SIZE)
  if (wrappedBytes.length !== WRAPPED_DEK_SIZE) {
    throw new Error('blob 的 wrappedDEK 段长度不足')
  }

  const wrapped = parseWrappedDek(wrappedBytes)
  const dek = unwrapDek(oldMasterKey, wrapped, headerBuf)
  try {
    const newWrappedBytes = serializeWrappedDek(wrapDek(newMasterKey, dek, headerBuf))
    return Buffer.concat([
      headerBuf,
      newWrappedBytes,
      blob.subarray(HEADER_SIZE + WRAPPED_DEK_SIZE),
    ])
  } finally {
    wipe(dek)
  }
}

/**
 * 计算整个 blob 的摘要，写入 manifest 作为第二重校验。
 * 说明：基线文档写的是 BLAKE3-256，但 Node 内置 crypto 没有 BLAKE3，
 * 因此使用 SHA-256 —— 用途是"检测文件被整体替换"，SHA-256 足够，
 * 且避免为摘要再引入一个第三方依赖。
 */
export function digestContentTag(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('hex')
}
