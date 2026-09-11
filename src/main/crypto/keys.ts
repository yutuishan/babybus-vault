/**
 * 子密钥派生（HKDF）
 *
 * 规则：masterKey 绝不直接用于加密任何数据，一律经 HKDF 派生用途独立的子密钥。
 * 这样即使某个子密钥的密文暴露，也不会牵连到主密钥或其它用途的密文。
 */
import { hkdfSync } from 'node:crypto'
import { wipe } from './secureBuffer'

export const SUBKEY_LENGTH = 32

/** manifest.enc 的加密密钥 */
export const INFO_MANIFEST = 'vault-manifest-v1'
/** vault.meta 中密码校验值的密钥 */
export const INFO_VERIFY = 'vault-verify-v1'

/**
 * HKDF-SHA256 派生子密钥
 * @param masterKey 主密钥（调用方负责生命周期）
 * @param salt      盐（vault 的 salt，保证不同库即使同密码也得到不同子密钥）
 * @param info      用途标识，不同用途必须不同
 */
export function deriveSubkey(
  masterKey: Buffer,
  salt: Buffer,
  info: string,
  length: number = SUBKEY_LENGTH,
): Buffer {
  const out = hkdfSync('sha256', masterKey, salt, Buffer.from(info, 'utf8'), length)
  return Buffer.from(out)
}

/**
 * 生成一个用完即弃的临时子密钥，并在回调结束后自动清零。
 * 推荐用法：withSubkey(masterKey, salt, INFO_MANIFEST, k => { ... })
 */
export function withSubkey<T>(
  masterKey: Buffer,
  salt: Buffer,
  info: string,
  fn: (subkey: Buffer) => T,
  length: number = SUBKEY_LENGTH,
): T {
  const key = deriveSubkey(masterKey, salt, info, length)
  try {
    return fn(key)
  } finally {
    wipe(key)
  }
}
