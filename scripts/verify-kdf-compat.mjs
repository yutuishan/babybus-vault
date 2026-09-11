/**
 * KDF 兼容性验证（在支持内置 Argon2 的 Node 上运行，非 Electron）
 *
 * 要回答两个问题：
 *   1. hash-wasm 的 Argon2id 是否符合 RFC 9106 标准向量
 *   2. hash-wasm 与 Node 内置 argon2Sync 的输出是否逐字节一致
 *
 * 只有第 2 点成立，vault.meta 里才可以只记 "argon2id" 而不记具体实现 ——
 * 否则用户换一台机器就可能打不开自己的库。
 */
import { argon2Sync } from 'node:crypto'
import { argon2id as wasmArgon2id } from 'hash-wasm'

function hex(buf) {
  return Buffer.from(buf).toString('hex')
}

// RFC 9106 Section 4 官方测试向量
// 注意：该向量带 secret(8B) 与 associatedData(12B)，漏传任意一个结果都会不同
const RFC_PASSWORD = Buffer.alloc(32, 0x01)
const RFC_SALT = Buffer.alloc(16, 0x02)
const RFC_SECRET = Buffer.alloc(8, 0x03)
const RFC_AD = Buffer.alloc(12, 0x04)
const RFC_EXPECTED = '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659'

console.log('=== 1. RFC 9106 标准向量（hash-wasm）===')
const rfcWasm = await wasmArgon2id({
  password: RFC_PASSWORD,
  salt: RFC_SALT,
  secret: RFC_SECRET,
  associatedData: RFC_AD,
  memorySize: 32,
  iterations: 3,
  parallelism: 4,
  hashLength: 32,
  outputType: 'binary',
})
console.log('  期望 :', RFC_EXPECTED)
console.log('  实际 :', hex(rfcWasm))
console.log('  结论 :', hex(rfcWasm) === RFC_EXPECTED ? '一致 ✓' : '不一致 ✗')

console.log('\n=== 2. RFC 9106 标准向量（Node 内置）===')
for (const [sk, ak] of [
  ['secret', 'ad'],
  ['secret', 'associatedData'],
]) {
  try {
    const rfcNode = argon2Sync('argon2id', {
      message: RFC_PASSWORD,
      nonce: RFC_SALT,
      [sk]: RFC_SECRET,
      [ak]: RFC_AD,
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    })
    console.log(`  [${sk}/${ak}] :`, hex(rfcNode), hex(rfcNode) === RFC_EXPECTED ? '一致 ✓' : '✗')
  } catch (err) {
    console.log(`  [${sk}/${ak}] : 失败 -`, String(err.message).split('\n')[0].slice(0, 90))
  }
}

console.log('\n=== 3. hash-wasm vs Node 内置（生产参数 64MB/3/1）===')
const pw = 'Compat-Test-2026'
const salt = Buffer.alloc(16, 0x5a)
const t0 = Date.now()
const wasmOut = await wasmArgon2id({
  password: pw,
  salt,
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
  outputType: 'binary',
})
const wasmMs = Date.now() - t0

let nodeMs = null
let nodeOut = null
try {
  const t1 = Date.now()
  nodeOut = argon2Sync('argon2id', {
    message: Buffer.from(pw),
    nonce: salt,
    memory: 65536,
    passes: 3,
    parallelism: 1,
    tagLength: 32,
  })
  nodeMs = Date.now() - t1
} catch (err) {
  console.log('  Node 内置不可用:', err.message)
}

console.log('  wasm :', hex(wasmOut), `${wasmMs}ms`)
if (nodeOut) {
  console.log('  node :', hex(nodeOut), `${nodeMs}ms`)
  console.log('  结论 :', hex(wasmOut) === hex(nodeOut) ? '逐字节一致 ✓ 可互换' : '不一致 ✗ 必须记录实现')
} else {
  console.log('  结论 : 本环境无内置 Argon2，无法交叉验证')
}

console.log('\n=== 4. 参数映射确认 ===')
console.log('  Node: memory(KiB) / passes / parallelism / tagLength')
console.log('  wasm: memorySize(KiB) / iterations / parallelism / hashLength')
