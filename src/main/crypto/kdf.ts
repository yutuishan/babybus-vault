/**
 * 密钥派生（KDF）
 *
 * 选型优先级：Node 内置 Argon2id → hash-wasm Argon2id → scrypt。
 *
 * ⚠️ 实测结论（2026-09-11，Electron 43.7.0 / Node 24.21.0 win-x64）：
 *
 *   1. Electron 用的是 **BoringSSL**，不是 OpenSSL。因此 `crypto.argon2Sync` 虽然存在
 *      （typeof 是 function），但一调用就抛 ERR_CRYPTO_ARGON2_NOT_SUPPORTED。
 *      **只判断 API 存在性会漏判**，能力探测必须实跑一次。
 *   2. hash-wasm 的 WASM 版 Argon2id 在 Electron 里正常工作（64MB/3passes ≈ 430ms）。
 *   3. 三者耗时：node 内置 236ms < scrypt 327ms < wasm 430ms < pbkdf2 594ms。
 *   4. **hash-wasm 与 node 内置在相同参数下输出逐字节一致**（已验证），
 *      所以 vault.meta 只需记录 kdf='argon2id' 与参数，不必绑定具体实现。
 *      换机器、换实现都能打开同一个库。
 *
 * Node 内置签名（字段名与直觉不同，全部必填无默认值）：
 *
 *   crypto.argon2Sync('argon2id', {
 *     message,      // 密码，不叫 password
 *     nonce,        // 盐，不叫 salt
 *     memory,       // KiB，不叫 memoryCost
 *     passes,       // 迭代，不叫 timeCost / iterations
 *     parallelism,
 *     tagLength,    // 输出字节数，不叫 hashLength
 *   })
 */
import * as crypto from 'node:crypto'
import { argon2id as wasmArgon2id } from 'hash-wasm'
import { randomBytes, wipe } from './secureBuffer'

export type KdfId = 'argon2id' | 'scrypt'
export type KdfImpl = 'node-crypto' | 'hash-wasm' | 'scrypt'

export interface Argon2Params {
  /** 内存开销，单位 KiB。65536 = 64 MiB */
  memory: number
  /** 迭代次数（Argon2 的 time cost） */
  passes: number
  /** 并行度 */
  parallelism: number
  /** 输出字节数 */
  tagLength: number
}

export interface ScryptParams {
  /** CPU/内存开销，必须是 2 的幂 */
  N: number
  r: number
  p: number
  /**
   * 内存上限（字节）。Node 默认仅 32 MiB，N=32768,r=8 需要 128*N*r = 32 MiB，
   * 加上算法开销会超过默认值而直接抛 ERR_CRYPTO_INVALID_SCRYPT_PARAMS，必须显式放大。
   */
  maxmem: number
}

/** OWASP 推荐：64 MiB / 3 passes / 并行度 1 */
export const ARGON2_PARAMS: Argon2Params = {
  memory: 65536,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
}

export const SCRYPT_PARAMS: ScryptParams = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 128 * 32768 * 8 * 2,
}

export const KEY_LENGTH = 32

interface Argon2Parameters {
  message: crypto.BinaryLike
  nonce: crypto.BinaryLike
  memory: number
  passes: number
  parallelism: number
  tagLength: number
}
type Argon2SyncFn = (algorithm: string, parameters: Argon2Parameters) => Buffer

function getArgon2Sync(): Argon2SyncFn | null {
  const fn = (crypto as unknown as { argon2Sync?: unknown }).argon2Sync
  return typeof fn === 'function' ? (fn.bind(crypto) as Argon2SyncFn) : null
}

export interface Argon2Support {
  node: boolean
  wasm: boolean
  nodeMs?: number
  wasmMs?: number
  nodeError?: string
  wasmError?: string
}

let cachedSupport: Argon2Support | null = null

/**
 * 实跑探测两种 Argon2id 实现。
 * 用小参数（8 MiB / 1 pass）快速判断可用性，避免每次启动都付 400ms 代价。
 */
export async function probeArgon2(force = false): Promise<Argon2Support> {
  if (cachedSupport && !force) return cachedSupport

  const support: Argon2Support = { node: false, wasm: false }
  const probe: Argon2Params = { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 }
  const pw = Buffer.from('babybus-probe')
  const nonce = randomBytes(16)

  const fn = getArgon2Sync()
  if (fn) {
    try {
      const t0 = performance.now()
      const out = fn('argon2id', {
        message: pw,
        nonce,
        memory: probe.memory,
        passes: probe.passes,
        parallelism: probe.parallelism,
        tagLength: probe.tagLength,
      })
      support.node = !!out && out.length === KEY_LENGTH
      support.nodeMs = Math.round(performance.now() - t0)
    } catch (err) {
      support.nodeError = (err as Error).message
    }
  } else {
    support.nodeError = 'crypto.argon2Sync 不存在（需要 Node >= 24.7）'
  }

  try {
    const t0 = performance.now()
    const out = await wasmArgon2id({
      password: pw,
      salt: nonce,
      memorySize: probe.memory,
      iterations: probe.passes,
      parallelism: probe.parallelism,
      hashLength: probe.tagLength,
      outputType: 'binary',
    })
    support.wasm = !!out && out.length === KEY_LENGTH
    support.wasmMs = Math.round(performance.now() - t0)
  } catch (err) {
    support.wasmError = (err as Error).message
  }

  wipe(nonce)
  cachedSupport = support
  return support
}

export interface DeriveResult {
  key: Buffer
  kdf: KdfId
  kdfImpl: KdfImpl
  params: Argon2Params | ScryptParams
  elapsedMs: number
}

/**
 * 用 Argon2id 派生。返回 null 表示两种实现都不可用，调用方应回退 scrypt。
 * 优先 node 内置（快一倍），Electron 下自动走 hash-wasm。
 */
async function deriveArgon2id(
  pw: Buffer,
  salt: Buffer,
  params: Argon2Params,
): Promise<{ key: Buffer; impl: 'node-crypto' | 'hash-wasm'; ms: number } | null> {
  const support = await probeArgon2()

  if (support.node) {
    const fn = getArgon2Sync()!
    try {
      const t0 = performance.now()
      const key = fn('argon2id', {
        message: pw,
        nonce: salt,
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: params.tagLength,
      })
      return { key, impl: 'node-crypto', ms: performance.now() - t0 }
    } catch {
      // 探测通过但生产参数失败（内存不足等）时落下去试 WASM
      cachedSupport = { ...support, node: false, nodeError: '生产参数下失败' }
    }
  }

  if (support.wasm) {
    try {
      const t0 = performance.now()
      const out = await wasmArgon2id({
        password: pw,
        salt,
        memorySize: params.memory,
        iterations: params.passes,
        parallelism: params.parallelism,
        hashLength: params.tagLength,
        outputType: 'binary',
      })
      return {
        key: Buffer.from(out),
        impl: 'hash-wasm',
        ms: performance.now() - t0,
      }
    } catch (err) {
      cachedSupport = { ...support, wasm: false, wasmError: (err as Error).message }
    }
  }

  return null
}

/** 从主密码派生主密钥（异步：WASM 实现返回 Promise） */
export async function deriveMasterKey(
  password: string | Buffer,
  salt: Buffer,
  prefer: 'auto' | KdfId = 'auto',
): Promise<DeriveResult> {
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : password

  if (prefer !== 'scrypt') {
    const argon = await deriveArgon2id(pw, salt, ARGON2_PARAMS)
    if (argon) {
      if (pw !== password) wipe(pw)
      return {
        key: argon.key,
        kdf: 'argon2id',
        kdfImpl: argon.impl,
        params: { ...ARGON2_PARAMS },
        elapsedMs: argon.ms,
      }
    }
    if (prefer === 'argon2id') {
      throw new Error('Argon2id 在当前运行环境下不可用（Node 内置与 WASM 实现均失败）')
    }
  }

  const t0 = performance.now()
  const key = crypto.scryptSync(pw, salt, KEY_LENGTH, SCRYPT_PARAMS)
  const elapsedMs = performance.now() - t0
  if (pw !== password) wipe(pw)
  return { key, kdf: 'scrypt', kdfImpl: 'scrypt', params: { ...SCRYPT_PARAMS }, elapsedMs }
}

/**
 * 按 vault.meta 记录的算法与参数重新派生。
 * 打开已有库时必须复现原参数 —— 参数变了就等于密码错了。
 */
export async function deriveMasterKeyWithParams(
  password: string | Buffer,
  salt: Buffer,
  kdf: KdfId,
  params: Argon2Params | ScryptParams,
): Promise<Buffer> {
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : password

  if (kdf === 'argon2id') {
    const argon = await deriveArgon2id(pw, salt, params as Argon2Params)
    if (!argon) {
      throw new Error(
        '该库使用 Argon2id 创建，但当前环境不支持 Argon2id（Electron 使用 BoringSSL，由 hash-wasm 提供实现）。请升级到最新版本。',
      )
    }
    if (pw !== password) wipe(pw)
    return argon.key
  }

  const p = params as ScryptParams
  const key = crypto.scryptSync(pw, salt, KEY_LENGTH, {
    N: p.N,
    r: p.r,
    p: p.p,
    maxmem: p.maxmem ?? SCRYPT_PARAMS.maxmem,
  })
  if (pw !== password) wipe(pw)
  return key
}

/** 生成新的随机盐（16 字节） */
export function generateSalt(): Buffer {
  return randomBytes(16)
}
