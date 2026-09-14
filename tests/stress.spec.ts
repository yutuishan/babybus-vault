import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { Vault } from '../src/main/vault/vault'
import { MAX_IMPORT_BYTES, executeImport, scanImport } from '../src/main/ipc/importPlan'
import { exportNodes } from '../src/main/ipc/exportPlan'

/**
 * 暴力测试：大量混杂文件 / 超大文件 的导入导出。
 *
 * 默认 **不跑** —— 它要写几百个文件、造一个几百 MB 的大文件，几十秒起步。
 * 用 `npm run test:stress` 显式触发（scripts/stress.mjs 会设 STRESS=1）。
 *
 * 断言都是硬编码的期望值或与磁盘上的真实字节比对，不从被测函数反推 ——
 * 否则加密写错、导出写错都能"通过"。
 */

const ENABLED = process.env.STRESS === '1'
const PASSWORD = 'Bb-2026-stress-pass'

let vaultDir: string
let workDir: string

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'babybus-stress-vault-'))
  workDir = mkdtempSync(join(tmpdir(), 'babybus-stress-work-'))
})

afterEach(() => {
  for (const d of [vaultDir, workDir]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Windows 上文件可能还被占用；清理失败不该让用例失败
    }
  }
})

/**
 * 确定性字节内容。
 *
 * 大文件用逐块 sha256 链会慢得离谱（200MB 要算 600 万次），
 * 所以先造一块 1MB 的种子块再平铺。
 */
function makeBytes(seed: string, size: number): Buffer {
  const BLOCK = 1024 * 1024
  const blockLen = Math.min(BLOCK, Math.max(size, 32))
  const block = Buffer.alloc(blockLen)
  let h = createHash('sha256').update(seed).digest()
  for (let off = 0; off < blockLen; ) {
    h = createHash('sha256').update(h).digest()
    const n = Math.min(h.length, blockLen - off)
    h.copy(block, off, 0, n)
    off += n
  }
  if (size <= block.length) return block.subarray(0, size)
  const out = Buffer.alloc(size)
  for (let off = 0; off < size; off += block.length) {
    block.copy(out, off, 0, Math.min(block.length, size - off))
  }
  return out
}

/** 流式算文件哈希，避免把大文件整份读进内存 */
function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** 递归列出目录下的所有文件，返回相对路径（统一用 / 分隔） */
function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(root, p).split(sep).join('/'))
    }
  }
  walk(root)
  return out.sort()
}

/** 文件库里每个文件节点 → 相对路径（用名字拼出来） */
function vaultFilePaths(vault: Vault): Map<string, string> {
  const nodes = vault.list()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, string>()
  for (const n of nodes) {
    if (n.type !== 'file') continue
    const parts: string[] = []
    let cur: (typeof nodes)[number] | undefined = n
    while (cur) {
      parts.unshift(cur.name)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    out.set(n.id, parts.join('/'))
  }
  return out
}

const EXT_POOL: { ext: string; count: number; dir: string; size: [number, number] }[] = [
  { ext: 'docx', count: 120, dir: '文档/合同', size: [2048, 8192] },
  { ext: 'xlsx', count: 120, dir: '文档/报表', size: [1024, 4096] },
  { ext: 'md', count: 120, dir: '文档/草稿', size: [256, 2048] },
  { ext: 'mp3', count: 60, dir: '媒体/音频', size: [4096, 16384] },
  { ext: 'mp4', count: 40, dir: '媒体/视频', size: [8192, 32768] },
  { ext: 'png', count: 80, dir: '媒体/图片', size: [1024, 6144] },
  { ext: 'csv', count: 60, dir: '数据/表格', size: [512, 4096] },
  { ext: 'json', count: 40, dir: '数据/接口', size: [128, 2048] },
  { ext: 'txt', count: 60, dir: '文本', size: [0, 1024] },
]

/**
 * 造一棵「多而杂」的目录树：中文名、深层嵌套、0 字节、超长名、
 * 无扩展名、名字里带空格/括号/井号/加号/emoji。
 */
function buildFixture(root: string): { files: number; folders: number; bytes: number } {
  let files = 0
  let bytes = 0
  const folders = new Set<string>()

  const put = (rel: string, size: number) => {
    const p = join(root, rel)
    const d = dirname(p)
    mkdirSync(d, { recursive: true })
    folders.add(relative(root, d))
    writeFileSync(p, makeBytes(rel, size))
    files++
    bytes += size
  }

  let n = 0
  for (const spec of EXT_POOL) {
    for (let i = 0; i < spec.count; i++) {
      const size = spec.size[0] + ((n * 977) % Math.max(1, spec.size[1] - spec.size[0] + 1))
      put(`${spec.dir}/第${i + 1}份 材料 (${spec.ext}) #${i + 1}.${spec.ext}`, size)
      n++
    }
  }

  // 深层嵌套：8 层
  put('深层/a/b/c/d/e/f/g/最深处的文件.txt', 512)
  // 0 字节
  put('边界/空文件.txt', 0)
  // 无扩展名
  put('边界/没有扩展名的文件', 300)
  // 点开头（不能把 .gitignore 这类名字拆成空主名）
  put('边界/.gitignore', 64)
  // 名字里带空格、括号、井号、加号、中括号
  put('边界/带 空格 (括号) #井号 +加号 [方括号].txt', 256)
  // emoji
  put('边界/报表📊汇总✅.txt', 256)
  // 超长文件名（200 字符主名，放在浅层避免超过 Windows MAX_PATH）
  put(`边界/${'很长的名字'.repeat(40)}.txt`, 256)
  // 一个中等体积的文件混在里面
  put('大文件/中等体积 30MB.bin', 30 * 1024 * 1024)

  return { files, folders: folders.size, bytes }
}

describe.skipIf(!ENABLED)('暴力测试 · 大量混杂文件', () => {
  it(
    '导入 ~700 个混杂文件：全部成功、内容逐字节一致',
    async () => {
      const src = join(workDir, 'fixture')
      mkdirSync(src, { recursive: true })
      const built = buildFixture(src)
      expect(built.files).toBeGreaterThanOrEqual(700)

      const vault = await Vault.create(vaultDir, PASSWORD)
      const before = process.memoryUsage()

      const t0 = Date.now()
      const res = executeImport(vault, null, [src], 'keep-both')
      const importMs = Date.now() - t0

      const after = process.memoryUsage()
      console.log(
        `\n[导入] 文件 ${built.files} 个 / ${(built.bytes / 1048576).toFixed(1)} MB → ` +
          `${importMs} ms；导入报告 imported=${res.imported} folders=${res.folders} failed=${res.failed.length}`,
      )
      console.log(
        `[内存] rss +${((after.rss - before.rss) / 1048576).toFixed(0)} MB，` +
          `heapUsed +${((after.heapUsed - before.heapUsed) / 1048576).toFixed(0)} MB`,
      )

      // 一个都不许失败
      expect(res.failed).toEqual([])
      expect(res.imported).toBe(built.files)

      // 逐字节核对：从库里读回来，和磁盘上的源文件比 sha256
      const srcFiles = listFiles(src)
      expect(srcFiles.length).toBe(built.files)

      // 导入会把源根目录本身也建出来（有意的行为），所以库内路径 = "fixture/" + 源相对路径
      const pathToId = new Map([...vaultFilePaths(vault)].map(([id, p]) => [p, id]))
      expect(pathToId.size).toBe(built.files)

      let mismatched = 0
      let missing = 0
      for (const rel of srcFiles) {
        const id = pathToId.get(`fixture/${rel}`)
        if (!id) {
          missing++
          continue
        }
        const fromVault = createHash('sha256').update(vault.readFile(id)).digest('hex')
        if (fromVault !== (await hashFile(join(src, rel)))) mismatched++
      }
      expect({ missing, mismatched }).toEqual({ missing: 0, mismatched: 0 })

      vault.lock()
    },
    300_000,
  )

  it(
    '把导入的内容整棵导出：目录结构与每个文件都逐字节一致',
    async () => {
      const src = join(workDir, 'fixture')
      mkdirSync(src, { recursive: true })
      const built = buildFixture(src)

      const vault = await Vault.create(vaultDir, PASSWORD)
      executeImport(vault, null, [src], 'keep-both')

      const dest = join(workDir, 'exported')
      mkdirSync(dest, { recursive: true })

      const roots = vault.list().filter((n) => n.parentId === null)
      const t0 = Date.now()
      const written = exportNodes(
        vault,
        roots.map((r) => r.id),
        dest,
      )
      console.log(
        `\n[导出] 写出 ${written} 个文件，用时 ${Date.now() - t0} ms（源共 ${built.files} 个）`,
      )

      expect(written).toBe(built.files)

      // 库内多了一层 "fixture"（导入时把源根目录本身也建出来了），
      // 所以要比的是 dest/fixture 这棵子树，而不是 dest 本身
      const inner = join(dest, 'fixture')

      // 目录结构与文件名必须原样保留
      const srcList = listFiles(src)
      expect(listFiles(inner)).toEqual(srcList)

      // 内容逐字节一致
      let mismatched = 0
      for (const rel of srcList) {
        const a = await hashFile(join(src, rel))
        const b = await hashFile(join(inner, rel))
        if (a !== b) mismatched++
      }
      expect(mismatched).toBe(0)

      vault.lock()
    },
    300_000,
  )
})

describe.skipIf(!ENABLED)('暴力测试 · 超大文件', () => {
  it(
    '200MB 单文件：导入 → 读回 → 导出，sha256 全链路一致',
    async () => {
      const SIZE = 200 * 1024 * 1024
      const srcDir = join(workDir, 'huge')
      mkdirSync(srcDir, { recursive: true })
      const srcFile = join(srcDir, '超大文件.bin')
      writeFileSync(srcFile, makeBytes('huge-file', SIZE))
      const srcHash = await hashFile(srcFile)
      console.log(`\n[超大文件] 源 ${(SIZE / 1048576).toFixed(0)} MB，sha256 ${srcHash.slice(0, 16)}…`)

      const vault = await Vault.create(vaultDir, PASSWORD)

      const t0 = Date.now()
      const res = executeImport(vault, null, [srcDir], 'keep-both')
      const importMs = Date.now() - t0
      console.log(`[超大文件] 导入 ${importMs} ms（约 ${(SIZE / 1048576 / (importMs / 1000)).toFixed(1)} MB/s）`)
      expect(res.failed).toEqual([])
      expect(res.imported).toBe(1)

      const node = vault.list().find((n) => n.type === 'file')
      expect(node?.size).toBe(SIZE)

      const t1 = Date.now()
      const back = vault.readFile(node!.id)
      console.log(`[超大文件] 解密读回 ${Date.now() - t1} ms`)
      expect(createHash('sha256').update(back).digest('hex')).toBe(srcHash)

      const dest = join(workDir, 'huge-out')
      mkdirSync(dest, { recursive: true })
      const t2 = Date.now()
      const written = exportNodes(vault, vault.list().filter((n) => n.parentId === null).map((n) => n.id), dest)
      console.log(`[超大文件] 导出 ${Date.now() - t2} ms`)
      expect(written).toBe(1)

      expect(await hashFile(join(dest, 'huge', '超大文件.bin'))).toBe(srcHash)

      vault.lock()
    },
    600_000,
  )

  it(
    `超过上限（${(MAX_IMPORT_BYTES / 1048576).toFixed(0)}MB）的文件必须被拒绝，且不影响同批其他文件`,
    async () => {
      const srcDir = join(workDir, 'oversize')
      mkdirSync(srcDir, { recursive: true })

      // 稀疏文件：瞬间造出 257MB 的"大文件"，不实际写 257MB 磁盘
      const big = join(srcDir, '超过上限.bin')
      writeFileSync(big, '')
      truncateSync(big, MAX_IMPORT_BYTES + 1024 * 1024)
      expect(statSync(big).size).toBe(MAX_IMPORT_BYTES + 1024 * 1024)

      // 同批里放一个正常文件，验证不会因为一个超大文件就整批失败
      const ok = join(srcDir, '正常文件.txt')
      writeFileSync(ok, makeBytes('ok', 128))

      const vault = await Vault.create(vaultDir, PASSWORD)

      // 预扫描要能提前告知
      const scan = scanImport(vault, null, [srcDir])
      expect(scan.oversized).toBe(1)

      const res = executeImport(vault, null, [srcDir], 'keep-both')
      console.log(`\n[超限] failed=${JSON.stringify(res.failed)} imported=${res.imported}`)
      expect(res.failed).toHaveLength(1)
      expect(res.failed[0]?.reason).toMatch(/256MB/)
      expect(res.imported).toBe(1)

      vault.lock()
    },
    120_000,
  )
})
