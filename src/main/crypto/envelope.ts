/**
 * 信封加密：DEK（数据加密密钥）的生成、包装与解包
 *
 * 每个文件一个独立随机 DEK，DEK 用 masterKey 包装后随文件一起存储。
 * 好处：
 *   - 单文件 DEK 泄露不影响其它文件
 *   - 改主密码时只需重新包装每个 DEK（32 字节），无需重加密文件内容
 */
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { randomBytes, wipe } from './secureBuffer'

export const DEK_LENGTH = 32
export const NONCE_LENGTH = 12
export const TAG_LENGTH = 16
/** wrappedDEK 段的定长：nonce(12) + tag(16) + ciphertext(32) */
export const WRAPPED_DEK_SIZE = NONCE_LENGTH + TAG_LENGTH + DEK_LENGTH

export interface WrappedDek {
  nonce: Buffer
  ciphertext: Buffer
  tag: Buffer
}

/** 生成一个新的随机文件密钥 */
export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH)
}

/**
 * 用主密钥包装 DEK。
 * @param aad 附加认证数据，必须传入（绑定文件头），不允许留空
 */
export function wrapDek(masterKey: Buffer, dek: Buffer, aad: Buffer): WrappedDek {
  if (!aad || aad.length === 0) throw new Error('wrapDek: AAD 不允许为空')
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()])
  const tag = cipher.getAuthTag()
  return { nonce, ciphertext, tag }
}

/** 解包 DEK。认证失败会抛异常（密码错误或数据被篡改） */
export function unwrapDek(masterKey: Buffer, wrapped: WrappedDek, aad: Buffer): Buffer {
  if (!aad || aad.length === 0) throw new Error('unwrapDek: AAD 不允许为空')
  const decipher = createDecipheriv('aes-256-gcm', masterKey, wrapped.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(wrapped.tag)
  const dek = Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()])
  if (dek.length !== DEK_LENGTH) throw new Error('unwrapDek: DEK 长度异常')
  return dek
}

/** 序列化为 nonce || tag || ciphertext（与 blob 二进制布局一致） */
export function serializeWrappedDek(w: WrappedDek): Buffer {
  if (w.nonce.length !== NONCE_LENGTH || w.tag.length !== TAG_LENGTH) {
    throw new Error('serializeWrappedDek: 长度不符合约定')
  }
  return Buffer.concat([w.nonce, w.tag, w.ciphertext])
}

/** 从定长缓冲区解析 */
export function parseWrappedDek(buf: Buffer, offset = 0): WrappedDek {
  const nonce = buf.subarray(offset, offset + NONCE_LENGTH)
  const tag = buf.subarray(offset + NONCE_LENGTH, offset + NONCE_LENGTH + TAG_LENGTH)
  const ciphertext = buf.subarray(offset + NONCE_LENGTH + TAG_LENGTH, offset + WRAPPED_DEK_SIZE)
  return { nonce, tag, ciphertext }
}

/**
 * 重新包装：改主密码时使用。
 * 只做解包 + 重新包装，不触碰文件内容。
 */
export function rewrapDek(
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
  wrapped: WrappedDek,
  oldAad: Buffer,
  newAad: Buffer,
): WrappedDek {
  const dek = unwrapDek(oldMasterKey, wrapped, oldAad)
  try {
    return wrapDek(newMasterKey, dek, newAad)
  } finally {
    wipe(dek)
  }
}
