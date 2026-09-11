/**
 * vault.meta 的创建、读取与密码校验
 *
 * vault.meta 是非敏感的：只含 KDF 参数、盐与一个密码校验值。
 * 不含任何文件名或目录结构，因此可以被安全地随库迁移。
 *
 * 校验值必须"再派生一次独立密钥"后生成（verifyKey = HKDF(masterKey, "vault-verify-v1")），
 * 不能用 masterKey 直接加密一个已知明文 —— 那样等于把 masterKey 的一个已知明文/密文对
 * 拱手送人，虽然 AES-GCM 目前仍能抗住，但属于毫无必要的暴露。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import {
  deriveMasterKey,
  deriveMasterKeyWithParams,
  generateSalt,
  type Argon2Params,
  type ScryptParams,
} from '../crypto/kdf'
import { deriveSubkey, INFO_VERIFY } from '../crypto/keys'
import { randomBytes, wipe } from '../crypto/secureBuffer'
import { NONCE_LENGTH, TAG_LENGTH } from '../crypto/envelope'
import type { VaultMeta } from '@shared/types'

export const VAULT_META_VERSION = 3
export const VAULT_META_FILENAME = 'vault.meta'
const VERIFY_PLAINTEXT = Buffer.from('unlock-check', 'utf8')

export interface CreateMetaResult {
  meta: VaultMeta
  masterKey: Buffer
  elapsedMs: number
}

/** 创建新的 vault.meta 并返回派生出的主密钥（KDF 是异步的，因此这里也是异步） */
export async function createVaultMeta(password: string): Promise<CreateMetaResult> {
  const salt = generateSalt()
  const { key, kdf, kdfImpl, params, elapsedMs } = await deriveMasterKey(password, salt)

  const verifyKey = deriveSubkey(key, salt, INFO_VERIFY)
  let verify
  try {
    const nonce = randomBytes(NONCE_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', verifyKey, nonce)
    const ciphertext = Buffer.concat([cipher.update(VERIFY_PLAINTEXT), cipher.final()])
    const tag = cipher.getAuthTag()
    verify = {
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    }
  } finally {
    wipe(verifyKey)
  }

  return {
    meta: {
      version: VAULT_META_VERSION,
      kdf,
      kdfImpl,
      kdfParams: { ...params } as unknown as Record<string, number>,
      salt: salt.toString('base64'),
      verify,
    },
    masterKey: key,
    elapsedMs,
  }
}

export interface VerifyResult {
  ok: boolean
  masterKey?: Buffer
  elapsedMs: number
}

/** 校验密码。失败时不抛异常，返回 ok=false */
export async function verifyPassword(meta: VaultMeta, password: string): Promise<VerifyResult> {
  const salt = Buffer.from(meta.salt, 'base64')
  const t0 = performance.now()
  const key = await deriveMasterKeyWithParams(
    password,
    salt,
    meta.kdf,
    meta.kdfParams as unknown as Argon2Params | ScryptParams,
  )
  const elapsedMs = performance.now() - t0

  const verifyKey = deriveSubkey(key, salt, INFO_VERIFY)
  try {
    const nonce = Buffer.from(meta.verify.nonce, 'base64')
    const ciphertext = Buffer.from(meta.verify.ciphertext, 'base64')
    const tag = Buffer.from(meta.verify.tag, 'base64')

    const decipher = createDecipheriv('aes-256-gcm', verifyKey, nonce)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    if (plain.length !== VERIFY_PLAINTEXT.length) {
      wipe(key)
      return { ok: false, elapsedMs }
    }
    // 恒定时间比较，避免通过耗时差异泄露信息
    let diff = 0
    for (let i = 0; i < plain.length; i++) diff |= plain[i]! ^ VERIFY_PLAINTEXT[i]!
    wipe(plain)
    if (diff !== 0) {
      wipe(key)
      return { ok: false, elapsedMs }
    }
    return { ok: true, masterKey: key, elapsedMs }
  } catch {
    wipe(key)
    return { ok: false, elapsedMs }
  } finally {
    wipe(verifyKey)
  }
}

export function vaultMetaPath(vaultDir: string): string {
  return join(vaultDir, VAULT_META_FILENAME)
}

/** 目标目录是否已经是文件库（用于防止"新建"覆盖已有库 —— 那会导致数据永久丢失） */
export function isVaultDir(vaultDir: string): boolean {
  return existsSync(vaultMetaPath(vaultDir))
}

export function readVaultMeta(vaultDir: string): VaultMeta {
  const raw = readFileSync(vaultMetaPath(vaultDir), 'utf8')
  const meta = JSON.parse(raw) as VaultMeta
  if (meta.version !== VAULT_META_VERSION) {
    throw new Error(
      `不支持的文件库版本：${meta.version}（当前程序支持 ${VAULT_META_VERSION}）。请升级软件，本程序不会改写原文件。`,
    )
  }
  return meta
}

/** 原子化写入 vault.meta（先写 tmp 再 rename） */
export function writeVaultMeta(vaultDir: string, meta: VaultMeta): void {
  const target = vaultMetaPath(vaultDir)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
  renameSync(tmp, target)
}
