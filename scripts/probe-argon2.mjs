/**
 * 能力探测脚本（M0 第一项）
 *
 * 目的：在真实 Node 运行时上验证 crypto.argon2Sync 的可用性，回答四个问题：
 *   1. API 是否存在（Node >= 24.7）
 *   2. 真实签名与参数字段名
 *   3. 是否需要 --experimental-argon2 启动标志
 *   4. 64MB / 3 passes 在本机的实际耗时（目标 100~500ms）
 *
 * 用法：
 *   node scripts/probe-argon2.mjs
 *
 * 结论（探测后填写）：
 *   签名：crypto.argon2Sync(algorithm, parameters)
 *   algorithm: 'argon2id' | 'argon2i' | 'argon2d'
 *   parameters: { password, salt, memory, iterations, parallelism, tagLength }
 */
import crypto from 'node:crypto'

const log = (...a) => console.log(...a)

log('=== 运行时 ===')
log('node version      :', process.version)
log('platform          :', process.platform, process.arch)
log('typeof argon2Sync :', typeof crypto.argon2Sync)
log('typeof argon2     :', typeof crypto.argon2)
log('typeof scryptSync :', typeof crypto.scryptSync)

const password = Buffer.from('probe-password')
const salt = crypto.randomBytes(16)

if (typeof crypto.argon2Sync !== 'function') {
  log('')
  log('!!! crypto.argon2Sync 不存在 -> 必须回退 scrypt。')
} else {
  log('')
  log('=== 参数字段名探测（签名：argon2Sync(algorithm, parameters)）===')
  const candidates = [
    ['memory/iterations/parallelism/tagLength', { password, salt, memory: 4096, iterations: 2, parallelism: 1, tagLength: 32 }],
    ['memoryCost/timeCost/parallelism/hashLength', { password, salt, memoryCost: 4096, timeCost: 2, parallelism: 1, hashLength: 32 }],
    ['memory/time/parallelism/tagLength', { password, salt, memory: 4096, time: 2, parallelism: 1, tagLength: 32 }],
    ['m/t/p/l', { password, salt, m: 4096, t: 2, p: 1, l: 32 }],
    ['N/r/p/tagLength', { password, salt, N: 4096, r: 2, p: 1, tagLength: 32 }],
  ]
  let working = null
  for (const [name, params] of candidates) {
    try {
      const out = crypto.argon2Sync('argon2id', params)
      log(`  [OK]   ${name} -> ${out.length} 字节  ${out.subarray(0, 8).toString('hex')}...`)
      if (!working) working = { name, params }
    } catch (e) {
      log(`  [FAIL] ${name} -> ${e.code || ''} ${String(e.message).split('\n')[0]}`)
    }
  }

  log('')
  log('=== 算法类型支持 ===')
  for (const alg of ['argon2id', 'argon2i', 'argon2d']) {
    try {
      const out = crypto.argon2Sync(alg, { password, salt, memory: 4096, iterations: 1, parallelism: 1, tagLength: 32 })
      log(`  [OK]   ${alg} -> ${out.length} 字节`)
    } catch (e) {
      log(`  [FAIL] ${alg} -> ${e.code || ''} ${String(e.message).split('\n')[0]}`)
    }
  }

  if (working) {
    log('')
    log('=== 生产参数耗时（OWASP: 64MB / p=1，测 1~3 passes）===')
    for (const passes of [1, 2, 3]) {
      const params = { password, salt, memory: 65536, iterations: passes, parallelism: 1, tagLength: 32 }
      try {
        const t0 = performance.now()
        crypto.argon2Sync('argon2id', params)
        const t1 = performance.now()
        log(`  memory=64MB passes=${passes} -> ${(t1 - t0).toFixed(0)} ms`)
      } catch (e) {
        log(`  memory=64MB passes=${passes} -> FAIL ${e.code || ''} ${String(e.message).split('\n')[0]}`)
      }
    }

    log('')
    log('=== 确定性验证（同参数两次结果必须一致）===')
    const p1 = { password, salt, memory: 4096, iterations: 2, parallelism: 1, tagLength: 32 }
    const a = crypto.argon2Sync('argon2id', p1)
    const b = crypto.argon2Sync('argon2id', p1)
    log('  两次结果一致 :', a.equals(b))
    const c = crypto.argon2Sync('argon2id', { ...p1, salt: crypto.randomBytes(16) })
    log('  换 salt 后不同 :', !a.equals(c))
  }
}

log('')
log('=== scrypt 兜底耗时 ===')
// 注意：N=2^15, r=8 需要 128*N*r = 32MiB，会超过 Node 默认 maxmem(32MB)，必须显式设置 maxmem
for (const [N, maxmem] of [[16384, 33554432], [32768, 67108864]]) {
  try {
    const t0 = performance.now()
    crypto.scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem })
    const t1 = performance.now()
    log(`  N=${N} maxmem=${maxmem} -> ${(t1 - t0).toFixed(0)} ms`)
  } catch (e) {
    log(`  N=${N} -> FAIL ${e.code || ''} ${String(e.message).split('\n')[0]}`)
  }
}
log('')
log('  对照：N=32768 不设 maxmem（预期失败，用于验证该坑真实存在）')
try {
  crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1 })
  log('  -> 居然成功了（说明本机默认 maxmem 更高）')
} catch (e) {
  log(`  -> 失败 ${e.code || ''}：${String(e.message).split('\n')[0]}`)
}
