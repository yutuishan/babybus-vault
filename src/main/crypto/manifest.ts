/**
 * manifest：加密的目录树，以及它的原子写入
 *
 * manifest 保存了所有文件名和目录结构 —— 它一旦损坏，即使 blobs 里的密文全都还在，
 * 用户也已经不知道哪个密文是哪个文件了。这是本项目的头号数据事故风险。
 *
 * 因此写入必须原子化：
 *   1. 序列化 + 加密到内存
 *   2. 写 manifest.enc.tmp 并 fsync
 *   3. 把当前 manifest.enc 另存为 manifest.enc.bak（必须在 rename 之前！）
 *   4. rename(tmp → manifest.enc)，操作系统保证原子
 *   5. fsync 所在目录（尽力而为，Windows 上不支持）
 *
 * ⚠️ 基线文档里把"备份 .bak"写在了 rename 之后，那是不可能的 —— rename 之后旧文件已经不存在了。
 *    此处按正确顺序实现：先备份，再 rename。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv } from 'node:crypto'
import { randomBytes, wipe } from './secureBuffer'
import { NONCE_LENGTH, TAG_LENGTH } from './envelope'
import type { Manifest } from '@shared/types'

export const MANIFEST_VERSION = 2
export const MANIFEST_FILENAME = 'manifest.enc'
export const MANIFEST_BAK_FILENAME = 'manifest.enc.bak'
export const MANIFEST_TMP_FILENAME = 'manifest.enc.tmp'

// ---------------------------------------------------------------- 序列化

export function serializeManifest(manifest: Manifest): Buffer {
  // hint 一并序列化 —— 它跟文件名、目录结构享有同等级别的保护
  const body: Record<string, unknown> = {
    version: MANIFEST_VERSION,
    nodes: manifest.nodes,
  }
  if (manifest.hint) body.hint = manifest.hint
  return Buffer.from(JSON.stringify(body), 'utf8')
}

export function deserializeManifest(buf: Buffer): Manifest {
  const parsed = JSON.parse(buf.toString('utf8')) as Manifest
  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new Error('manifest 格式损坏：缺少 nodes 数组')
  }
  return {
    version: parsed.version ?? MANIFEST_VERSION,
    nodes: parsed.nodes,
    hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
  }
}

// ---------------------------------------------------------------- 加解密

/** 加密为 nonce(12) || tag(16) || ciphertext */
export function encryptManifest(
  manifestKey: Buffer,
  manifest: Manifest,
): Buffer {
  const plain = serializeManifest(manifest)
  const nonce = randomBytes(NONCE_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', manifestKey, nonce)
  // AAD 绑定版本号，防止把旧版 manifest 的密文搬来冒充新版
  cipher.setAAD(Buffer.from(`manifest-v${MANIFEST_VERSION}`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  try {
    return Buffer.concat([nonce, tag, ciphertext])
  } finally {
    wipe(plain)
  }
}

export function decryptManifest(
  manifestKey: Buffer,
  payload: Buffer,
): Manifest {
  if (payload.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error('manifest.enc 长度不足')
  }
  const nonce = payload.subarray(0, NONCE_LENGTH)
  const tag = payload.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH)
  const ciphertext = payload.subarray(NONCE_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv('aes-256-gcm', manifestKey, nonce)
  decipher.setAAD(Buffer.from(`manifest-v${MANIFEST_VERSION}`, 'utf8'))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  try {
    return deserializeManifest(plain)
  } finally {
    wipe(plain)
  }
}

// ---------------------------------------------------------------- 原子写

/** 尽力而为地 fsync 目录。Windows 上打开目录会失败，忽略即可 */
function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Windows / 部分文件系统不支持 fsync 目录，忽略
  }
}

/** 同步写入文件并 fsync，保证数据真正落到磁盘 */
function writeFileFsync(path: string, data: Buffer): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 原子化写入 manifest。
 * 任何一步失败都不会破坏已有的 manifest.enc。
 */
export function writeManifest(
  vaultDir: string,
  manifestKey: Buffer,
  manifest: Manifest,
): void {
  const mainPath = join(vaultDir, MANIFEST_FILENAME)
  const tmpPath = join(vaultDir, MANIFEST_TMP_FILENAME)
  const bakPath = join(vaultDir, MANIFEST_BAK_FILENAME)

  const payload = encryptManifest(manifestKey, manifest)

  // 1) 写临时文件并落盘
  writeFileFsync(tmpPath, payload)

  // 2) 先备份当前版本（顺序关键：必须在 rename 之前）
  if (existsSync(mainPath)) {
    copyFileSync(mainPath, bakPath)
  }

  // 3) 原子替换
  renameSync(tmpPath, mainPath)

  // 4) fsync 目录，让 rename 本身持久化
  fsyncDirBestEffort(dirname(mainPath))
}

export interface ReadManifestResult {
  manifest: Manifest
  /** true 表示主文件损坏，已从 .bak 恢复 */
  recoveredFromBackup: boolean
}

/**
 * 读取 manifest。主文件校验失败时自动回退到 .bak。
 * 两者都失败才抛错。
 */
export function readManifest(
  vaultDir: string,
  manifestKey: Buffer,
): ReadManifestResult {
  const mainPath = join(vaultDir, MANIFEST_FILENAME)
  const bakPath = join(vaultDir, MANIFEST_BAK_FILENAME)

  const hint = '可能原因：主密码错误、文件被篡改，或写入过程中断电/崩溃。'

  if (existsSync(mainPath)) {
    try {
      const payload = readFileSync(mainPath)
      return { manifest: decryptManifest(manifestKey, payload), recoveredFromBackup: false }
    } catch (err) {
      // 主文件损坏，落到备份
      if (!existsSync(bakPath)) {
        throw new Error(
          `manifest.enc 解密失败且无备份可用：${(err as Error).message}。${hint}`,
        )
      }
      try {
        const payload = readFileSync(bakPath)
        return { manifest: decryptManifest(manifestKey, payload), recoveredFromBackup: true }
      } catch (bakErr) {
        // 主文件与备份都坏：必须给出人能看懂的提示，而不是抛出 GCM 底层错误
        throw new Error(
          `manifest.enc 与其备份均无法解密：${(err as Error).message}；` +
            `备份：${(bakErr as Error).message}。${hint}`,
        )
      }
    }
  }

  if (existsSync(bakPath)) {
    try {
      const payload = readFileSync(bakPath)
      return { manifest: decryptManifest(manifestKey, payload), recoveredFromBackup: true }
    } catch (err) {
      throw new Error(`仅存的 manifest.enc.bak 也无法解密：${(err as Error).message}。${hint}`)
    }
  }

  throw new Error('文件库中不存在 manifest.enc')
}

/** 初始化一个空的文件库目录结构 */
export function initVaultDir(vaultDir: string): void {
  mkdirSync(join(vaultDir, 'blobs'), { recursive: true })
}

/** 清理临时文件（启动自检时调用） */
export function cleanupTempFiles(vaultDir: string): void {
  const tmpPath = join(vaultDir, MANIFEST_TMP_FILENAME)
  if (existsSync(tmpPath)) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 忽略清理失败
    }
  }
}
