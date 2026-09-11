import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  BLOB_VERSION,
  HEADER_SIZE,
  MAX_PLAIN_SIZE,
  bytesToUuid,
  decryptBlob,
  encryptBlob,
  newBlobId,
  parseHeader,
  readBlobHeader,
  rewrapBlob,
  serializeHeader,
  uuidToBytes,
} from '../src/main/crypto/blob'
import { NONCE_LENGTH, TAG_LENGTH, WRAPPED_DEK_SIZE } from '../src/main/crypto/envelope'
import { wipe } from '../src/main/crypto/secureBuffer'

const masterKey = () => randomBytes(32)

describe('blob 基本往返', () => {
  it('加密后能正确解出原文', () => {
    const mk = masterKey()
    const id = newBlobId()
    const plain = Buffer.from('这是一份机密合同的内容', 'utf8')

    const blob = encryptBlob(mk, id, plain)
    const out = decryptBlob(mk, blob, { expectBlobId: id })

    expect(out.equals(plain)).toBe(true)
    wipe(mk, out)
  })

  it('空文件与二进制内容都能正确处理', () => {
    const mk = masterKey()
    for (const plain of [Buffer.alloc(0), randomBytes(4096), Buffer.from([0, 1, 2, 255])]) {
      const id = newBlobId()
      const blob = encryptBlob(mk, id, plain)
      const out = decryptBlob(mk, blob, { expectBlobId: id })
      expect(out.equals(plain)).toBe(true)
      // 头部记录的明文长度必须准确
      expect(readBlobHeader(blob).plainSize).toBe(plain.length)
      wipe(out)
    }
    wipe(mk)
  })

  it('头部结构固定为 38 字节，字段可完整往返', () => {
    const header = {
      version: BLOB_VERSION,
      flags: 0,
      chunkSize: 0,
      chunkCount: 0,
      blobId: newBlobId(),
      plainSize: 123456,
    }
    const buf = serializeHeader(header)
    expect(buf).toHaveLength(HEADER_SIZE)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('ENC1')

    const parsed = parseHeader(buf)
    expect(parsed).toEqual(header)
  })

  it('UUID 与 16 字节互转可逆', () => {
    const id = newBlobId()
    expect(bytesToUuid(uuidToBytes(id))).toBe(id)
  })
})

describe('nonce 与 DEK 绝不复用', () => {
  it('同一明文加密两次，密文必须完全不同', () => {
    const mk = masterKey()
    const plain = Buffer.from('same content', 'utf8')

    const a = encryptBlob(mk, newBlobId(), plain)
    const b = encryptBlob(mk, newBlobId(), plain)

    // blobId 不同会导致 header 不同，为了单独验证 nonce/DEK 的随机性，用同一个 blobId 再比一次
    const sameId = newBlobId()
    const c = encryptBlob(mk, sameId, plain)
    const d = encryptBlob(mk, sameId, plain)

    const contentA = c.subarray(HEADER_SIZE + WRAPPED_DEK_SIZE)
    const contentB = d.subarray(HEADER_SIZE + WRAPPED_DEK_SIZE)
    expect(contentA.equals(contentB)).toBe(false) // 同 blobId 同明文，密文仍必须不同

    const nonceA = c.subarray(HEADER_SIZE, HEADER_SIZE + NONCE_LENGTH)
    const nonceB = d.subarray(HEADER_SIZE, HEADER_SIZE + NONCE_LENGTH)
    expect(nonceA.equals(nonceB)).toBe(false)

    expect(a.equals(b)).toBe(false)
    wipe(mk)
  })

  it('同 blobId 同明文加密 50 次，nonce 不得重复（统计验证）', () => {
    const mk = masterKey()
    const id = newBlobId()
    const plain = Buffer.from('repeat test', 'utf8')
    const nonces = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const blob = encryptBlob(mk, id, plain)
      nonces.add(blob.subarray(HEADER_SIZE, HEADER_SIZE + NONCE_LENGTH).toString('hex'))
    }
    expect(nonces.size).toBe(50)
    wipe(mk)
  })
})

describe('篡改必须被检测到', () => {
  const setup = () => {
    const mk = masterKey()
    const id = newBlobId()
    const plain = Buffer.from('原始内容 original content 1234567890', 'utf8')
    const blob = encryptBlob(mk, id, plain)
    return { mk, id, plain, blob }
  }

  it('改动 content 密文任意一个字节 → 认证失败', () => {
    const { mk, id, blob } = setup()
    const tampered = Buffer.from(blob)
    const last = tampered.length - 1
    tampered[last] = (tampered[last]! ^ 0xff) & 0xff

    expect(() => decryptBlob(mk, tampered, { expectBlobId: id })).toThrow()
    wipe(mk)
  })

  it('改动认证标签 → 认证失败', () => {
    const { mk, id, blob } = setup()
    const tampered = Buffer.from(blob)
    const tagPos = HEADER_SIZE + WRAPPED_DEK_SIZE + NONCE_LENGTH
    tampered[tagPos] = (tampered[tagPos]! ^ 0x01) & 0xff

    expect(() => decryptBlob(mk, tampered, { expectBlobId: id })).toThrow()
    wipe(mk)
  })

  it('改动 header 中的 plainSize → 认证失败（AAD 生效）', () => {
    const { mk, id, blob } = setup()
    const tampered = Buffer.from(blob)
    tampered.writeBigUInt64BE(BigInt(999999), 30)

    expect(() => decryptBlob(mk, tampered, { expectBlobId: id })).toThrow()
    wipe(mk)
  })

  it('改动 header 中的 blobId → 认证失败（AAD 绑定生效）', () => {
    const { mk, id, blob } = setup()
    const tampered = Buffer.from(blob)
    uuidToBytes(newBlobId()).copy(tampered, 14)

    expect(() => decryptBlob(mk, tampered, { expectBlobId: id })).toThrow()
    wipe(mk)
  })

  it('截断密文 → 失败', () => {
    const { mk, id, blob } = setup()
    const truncated = blob.subarray(0, blob.length - 10)
    expect(() => decryptBlob(mk, truncated, { expectBlobId: id })).toThrow()
    wipe(mk)
  })

  it('使用错误的主密钥 → 失败', () => {
    const { id, blob } = setup()
    const wrongKey = masterKey()
    expect(() => decryptBlob(wrongKey, blob, { expectBlobId: id })).toThrow()
    wipe(wrongKey)
  })
})

describe('跨 blob 搬运必须失败（P0-3）', () => {
  it('把 A 的 content 段接到 B 的头部之后，解密必须失败', () => {
    const mk = masterKey()
    const idA = newBlobId()
    const idB = newBlobId()
    const blobA = encryptBlob(mk, idA, Buffer.from('A 的内容', 'utf8'))
    const blobB = encryptBlob(mk, idB, Buffer.from('B 的内容', 'utf8'))

    // 拼接：B 的 header + B 的 wrappedDEK + A 的 content 段
    const spliced = Buffer.concat([
      blobB.subarray(0, HEADER_SIZE + WRAPPED_DEK_SIZE),
      blobA.subarray(HEADER_SIZE + WRAPPED_DEK_SIZE),
    ])

    expect(() => decryptBlob(mk, spliced, { expectBlobId: idB })).toThrow()
    wipe(mk)
  })

  it('blobId 与 manifest 节点 id 不一致时直接拒绝', () => {
    const mk = masterKey()
    const realId = newBlobId()
    const blob = encryptBlob(mk, realId, Buffer.from('内容', 'utf8'))

    expect(() => decryptBlob(mk, blob, { expectBlobId: newBlobId() })).toThrow(/blobId 不匹配/)
    wipe(mk)
  })

  it('明文长度与记录不符时拒绝', () => {
    const mk = masterKey()
    const id = newBlobId()
    const blob = encryptBlob(mk, id, Buffer.from('内容', 'utf8'))
    expect(() => decryptBlob(mk, blob, { expectBlobId: id, expectPlainSize: 999 })).toThrow(
      /明文长度不匹配/,
    )
    wipe(mk)
  })

  /**
   * 诚实地记录一个边界：如果调用方不传 expectBlobId，A 的 blob 本身依然能被解开
   * （因为它自洽）。所以"文件被搬运到别处"这件事，最终靠 manifest 记录的
   * contentTag 兜底 —— 这也是 manifest 里必须记 contentTag 的原因。
   */
  it('不传 expectBlobId 时 blob 自洽可解，因此必须依赖 manifest 的 contentTag 兜底', () => {
    const mk = masterKey()
    const idA = newBlobId()
    const blobA = encryptBlob(mk, idA, Buffer.from('A 的内容', 'utf8'))
    expect(() => decryptBlob(mk, blobA)).not.toThrow()
    wipe(mk)
  })
})

describe('改主密码：只重包装 DEK，不重加密内容', () => {
  it('重包装后新密钥可解出原文，且 content 段字节完全不变', () => {
    const oldKey = masterKey()
    const newKey = masterKey()
    const id = newBlobId()
    const plain = randomBytes(8192)

    const blob = encryptBlob(oldKey, id, plain)
    const contentBefore = Buffer.from(blob.subarray(HEADER_SIZE + WRAPPED_DEK_SIZE))

    const rewrapped = rewrapBlob(oldKey, newKey, blob)
    const contentAfter = rewrapped.subarray(HEADER_SIZE + WRAPPED_DEK_SIZE)

    // content 段一个字节都不变 —— 这正是信封加密的价值
    expect(contentAfter.equals(contentBefore)).toBe(true)

    const out = decryptBlob(newKey, rewrapped, { expectBlobId: id })
    expect(out.equals(plain)).toBe(true)

    // 旧密钥不应再能解开
    expect(() => decryptBlob(oldKey, rewrapped, { expectBlobId: id })).toThrow()

    wipe(oldKey, newKey, out, plain)
  })

  it('头部在重包装后保持不变（blobId 与 plainSize 不受影响）', () => {
    const oldKey = masterKey()
    const newKey = masterKey()
    const id = newBlobId()
    const blob = encryptBlob(oldKey, id, Buffer.from('abc', 'utf8'))
    const rewrapped = rewrapBlob(oldKey, newKey, blob)

    expect(rewrapped.subarray(0, HEADER_SIZE).equals(blob.subarray(0, HEADER_SIZE))).toBe(true)
    wipe(oldKey, newKey)
  })
})

describe('边界与拒绝', () => {
  it('超过整文件模式上限的明文直接拒绝', () => {
    const mk = masterKey()
    expect(() => encryptBlob(mk, newBlobId(), Buffer.alloc(MAX_PLAIN_SIZE + 1))).toThrow(/过大/)
    wipe(mk)
  })

  it('非法 magic 直接拒绝', () => {
    const bad = Buffer.alloc(HEADER_SIZE + 100)
    bad.write('XXXX', 0, 'ascii')
    expect(() => parseHeader(bad)).toThrow(/不是有效的 blob/)
  })
})
