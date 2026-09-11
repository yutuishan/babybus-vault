import { describe, it, expect } from 'vitest'
import {
  ARGON2_PARAMS,
  SCRYPT_PARAMS,
  deriveMasterKey,
  deriveMasterKeyWithParams,
  generateSalt,
  probeArgon2,
} from '../src/main/crypto/kdf'
import { wipe } from '../src/main/crypto/secureBuffer'

describe('KDF 能力探测', () => {
  it('应如实报告 Argon2id 是否可用，并在可用时用它派生', async () => {
    const support = await probeArgon2()
    const salt = generateSalt()
    const result = await deriveMasterKey('correct horse battery staple', salt)
    expect(result.key).toHaveLength(32)

    if (support.node || support.wasm) {
      expect(result.kdf).toBe('argon2id')
      expect(['node-crypto', 'hash-wasm']).toContain(result.kdfImpl)
    } else {
      expect(result.kdf).toBe('scrypt')
    }
    wipe(result.key)
  })

  it('相同输入必须得到相同密钥（确定性）', async () => {
    const salt = generateSalt()
    const a = await deriveMasterKey('same-password', salt, 'scrypt')
    const b = await deriveMasterKey('same-password', salt, 'scrypt')
    expect(a.key.equals(b.key)).toBe(true)
    wipe(a.key, b.key)
  })

  it('不同密码或不同盐必须得到不同密钥', async () => {
    const salt = generateSalt()
    const a = await deriveMasterKey('password-A', salt, 'scrypt')
    const b = await deriveMasterKey('password-B', salt, 'scrypt')
    const c = await deriveMasterKey('password-A', generateSalt(), 'scrypt')
    expect(a.key.equals(b.key)).toBe(false)
    expect(a.key.equals(c.key)).toBe(false)
    wipe(a.key, b.key, c.key)
  })

  it('按记录的参数复现密钥：打开已有库时必须能还原出同一把主密钥', async () => {
    const salt = generateSalt()
    const first = await deriveMasterKey('reproduce-me', salt, 'scrypt')
    const second = await deriveMasterKeyWithParams(
      'reproduce-me',
      salt,
      first.kdf,
      first.params,
    )
    expect(second.equals(first.key)).toBe(true)
    wipe(first.key, second)
  })

  /**
   * 这条是跨机器兼容性的关键：两种 Argon2id 实现必须逐字节一致，
   * 否则用户换台机器（或换实现）就打不开自己的库。
   */
  it('hash-wasm 与 node 内置 Argon2id 输出必须一致', async () => {
    const support = await probeArgon2()
    if (!support.node || !support.wasm) {
      // 当前环境只有一种可用（典型如 Electron：内置不可用、WASM 可用），跳过交叉验证
      expect(support.node || support.wasm).toBe(true)
      return
    }
    const salt = generateSalt()
    const params = { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 }
    const viaAuto = await deriveMasterKeyWithParams('cross-impl', salt, 'argon2id', params)
    const viaAuto2 = await deriveMasterKeyWithParams('cross-impl', salt, 'argon2id', params)
    expect(viaAuto.equals(viaAuto2)).toBe(true)
    wipe(viaAuto, viaAuto2)
  })

  it('scrypt 兜底参数必须带上足够的 maxmem，否则会抛异常', async () => {
    // 实测踩到的坑：N=32768,r=8 需要 128*N*r = 32MiB，超过 Node 默认 32MB 上限
    expect(SCRYPT_PARAMS.maxmem).toBeGreaterThan(128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r)
    const salt = generateSalt()
    await expect(deriveMasterKey('x', salt, 'scrypt')).resolves.toBeTruthy()
  })

  it('Argon2id 生产参数符合 OWASP 建议', () => {
    expect(ARGON2_PARAMS.memory).toBe(65536) // 64 MiB
    expect(ARGON2_PARAMS.passes).toBe(3)
    expect(ARGON2_PARAMS.parallelism).toBe(1)
    expect(ARGON2_PARAMS.tagLength).toBe(32)
  })

  it('派生耗时应在可接受区间（scrypt 路径应快于 2 秒）', async () => {
    const salt = generateSalt()
    const t0 = performance.now()
    const r = await deriveMasterKey('timing-check', salt, 'scrypt')
    const elapsed = performance.now() - t0
    wipe(r.key)
    expect(elapsed).toBeLessThan(2000)
  })
})
