/**
 * KDF 能力探测（在真实的 Electron 主进程里跑）
 *
 * 为什么必须实跑：Electron 内置的是 BoringSSL，很多 OpenSSL 算法在 Electron 里
 * `typeof fn === 'function'` 成立，但一调用就抛 ERR_CRYPTO_*_NOT_SUPPORTED。
 * 只判断 API 存在性会漏掉这种情况，导致解锁时直接崩溃。
 */
import { argon2Sync, scryptSync, pbkdf2Sync } from 'node:crypto'
import { argon2id as wasmArgon2id } from 'hash-wasm'

export interface KdfProbe {
  nodeArgon2: { available: boolean; ms?: number; error?: string }
  scrypt: { available: boolean; ms?: number; error?: string }
  pbkdf2: { available: boolean; ms?: number; error?: string }
  wasmArgon2: { available: boolean; ms?: number; error?: string }
  /** 最终推荐使用的 KDF */
  recommended: 'argon2id-node' | 'argon2id-wasm' | 'scrypt' | 'none'
}

const PASSWORD = 'probe-password-2026'
const SALT = Buffer.alloc(16, 0x5a)

function timed(fn: () => unknown): { ms: number } {
  const t0 = Date.now()
  fn()
  return { ms: Date.now() - t0 }
}

export async function probeKdf(): Promise<KdfProbe> {
  const result: KdfProbe = {
    nodeArgon2: { available: false },
    scrypt: { available: false },
    pbkdf2: { available: false },
    wasmArgon2: { available: false },
    recommended: 'none',
  }

  // 1. Node 内置 Argon2id（生产参数）
  try {
    const { ms } = timed(() =>
      argon2Sync('argon2id', {
        message: Buffer.from(PASSWORD),
        nonce: SALT,
        memory: 65536,
        passes: 3,
        parallelism: 1,
        tagLength: 32,
      }),
    )
    result.nodeArgon2 = { available: true, ms }
  } catch (err) {
    result.nodeArgon2 = { available: false, error: (err as Error).message }
  }

  // 2. scrypt 兜底（必须显式给 maxmem，否则 2^15/r=8 会顶穿默认的 32MB）
  try {
    const { ms } = timed(() =>
      scryptSync(PASSWORD, SALT, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }),
    )
    result.scrypt = { available: true, ms }
  } catch (err) {
    result.scrypt = { available: false, error: (err as Error).message }
  }

  // 3. PBKDF2 —— 最后一道兜底，抗 GPU 能力弱但永远可用
  try {
    const { ms } = timed(() => pbkdf2Sync(PASSWORD, SALT, 600_000, 32, 'sha512'))
    result.pbkdf2 = { available: true, ms }
  } catch (err) {
    result.pbkdf2 = { available: false, error: (err as Error).message }
  }

  // 4. WASM 版 Argon2id（hash-wasm，绿色版友好，无原生编译）
  try {
    const t0 = Date.now()
    await wasmArgon2id({
      password: PASSWORD,
      salt: SALT,
      memorySize: 65536,
      iterations: 3,
      parallelism: 1,
      hashLength: 32,
      outputType: 'binary',
    })
    result.wasmArgon2 = { available: true, ms: Date.now() - t0 }
  } catch (err) {
    result.wasmArgon2 = { available: false, error: (err as Error).message }
  }

  if (result.nodeArgon2.available) result.recommended = 'argon2id-node'
  else if (result.wasmArgon2.available) result.recommended = 'argon2id-wasm'
  else if (result.scrypt.available) result.recommended = 'scrypt'
  else result.recommended = 'none'

  return result
}
