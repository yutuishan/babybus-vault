/**
 * 流式解密与刷新文件库的回归测试。
 *
 * 流式解密是「支持流媒体文件（视频和音频）」的底座：<video> 会按 Range 请求分片，
 * 主进程必须能只解出那一段，而不是把整份明文拼出来。
 * 这里不测播放器，只测"给一段区间，还回来的字节是否逐字节正确"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, VaultError } from '../src/main/vault/vault'
import { parseRange } from '../src/main/vault/mediaProtocol'

const PASSWORD = 'Test-2026-pass'

let dir: string
let vault: Vault

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bb-stream-'))
  vault = await Vault.create(dir, PASSWORD)
})

afterEach(() => {
  try {
    vault.lock()
  } catch {
    /* 已经锁了 */
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发 EPERM */
  }
})

async function readRange(id: string, start: number, end: number): Promise<Buffer> {
  const reader = vault.createPlainStream(id, start, end).getReader()
  const chunks: Buffer[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** 造一段可识别的明文：每个字节的值等于下标模 251（质数，避免和块边界对齐） */
function pattern(size: number): Buffer {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}

describe('parseRange', () => {
  it('bytes=a-b 取闭区间', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
  })

  it('bytes=a- 取到末尾', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('bytes=-n 取最后 n 个字节', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
    // n 比文件还大时夹到 0
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('末尾越界会被夹到 size-1', () => {
    expect(parseRange('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('没有 Range 或语法不认时返回 null（按整份返回）', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('', 1000)).toBeNull()
    expect(parseRange('items=0-9', 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
    // 多段 Range 不实现，退回整份
    expect(parseRange('bytes=0-99,200-299', 1000)).toBeNull()
  })

  it('起点越界返回 null', () => {
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
    expect(parseRange('bytes=2000-3000', 1000)).toBeNull()
  })

  it('空文件（size=0）一律返回 null', () => {
    expect(parseRange('bytes=0-99', 0)).toBeNull()
  })
})

describe('createPlainStream · 区间正确性', () => {
  it('取中间一段，字节与原文逐字节相同', async () => {
    const content = pattern(1000)
    const node = vault.putFile(null, 'a.bin', content)

    const got = await readRange(node.id, 10, 19)
    expect(got.length).toBe(10)
    expect(got.equals(content.subarray(10, 20))).toBe(true)
  })

  it('取整份', async () => {
    const content = pattern(1000)
    const node = vault.putFile(null, 'b.bin', content)

    const got = await readRange(node.id, 0, 999)
    expect(got.length).toBe(1000)
    expect(got.equals(content)).toBe(true)
  })

  it('跨越内部 256KB 分块边界时依然连续正确', async () => {
    // 600KB 会走 3 个内部块，专门用来抓"块与块之间丢字节/错位"这类错误
    const content = pattern(600 * 1024)
    const node = vault.putFile(null, 'big.bin', content)

    // 从第一块中间跨到第二块中间
    const start = 256 * 1024 - 500
    const end = 256 * 1024 + 500
    const got = await readRange(node.id, start, end)
    expect(got.length).toBe(end - start + 1)
    expect(got.equals(content.subarray(start, end + 1))).toBe(true)
  })

  it('只取最后一个字节', async () => {
    const content = pattern(4096)
    const node = vault.putFile(null, 'c.bin', content)

    const got = await readRange(node.id, 4095, 4095)
    expect(got.length).toBe(1)
    expect(got[0]).toBe(content[4095])
  })

  it('末尾越界会被夹住，不会多吐字节', async () => {
    const content = pattern(100)
    const node = vault.putFile(null, 'd.bin', content)

    const got = await readRange(node.id, 90, 99999)
    expect(got.length).toBe(10)
    expect(got.equals(content.subarray(90))).toBe(true)
  })

  it('负数起点按 0 处理', async () => {
    const content = pattern(100)
    const node = vault.putFile(null, 'e.bin', content)

    const got = await readRange(node.id, -50, 9)
    expect(got.length).toBe(10)
    expect(got.equals(content.subarray(0, 10))).toBe(true)
  })

  it('中文与二进制混排也不会错位', async () => {
    const content = Buffer.concat([Buffer.from('中文内容'), pattern(300), Buffer.from('结尾')])
    const node = vault.putFile(null, 'f.bin', content)

    const got = await readRange(node.id, 4, content.length - 1)
    expect(got.equals(content.subarray(4))).toBe(true)
  })

  it('空文件返回空流', async () => {
    const node = vault.putFile(null, 'empty.bin', Buffer.alloc(0))
    const got = await readRange(node.id, 0, 0)
    expect(got.length).toBe(0)
  })
})

/**
 * 回归：起点 ≥ 一个内部分块（256KB）时，读取曾经**永久挂死**。
 *
 * 根因不在解密，而在 ReadableStream 的 pull 契约：GCM 计数器不能跳转，取中后段
 * 必须从 0 顺序推进、把 from 之前的明文全部丢掉，于是前若干次 pull 一个字节都
 * enqueue 不出去；而 pull 空手而归时流**不会再调它**，reader.read() 就永不 resolve。
 *
 * 为什么原来没被发现：老用例里最"深"的一条是 start = 256KB - 500 —— 恰好卡在阈值
 * 下方 500 字节，第一次 pull 就有产出；其余用例的文件都小于 256KB。
 * 也就是说整套用例系统性地避开了 from >= 256KB 这个条件。
 *
 * 这些用例故意不设内部超时：万一回归，让 vitest 的 testTimeout 把它判成超时失败，
 * 而不是把 CI 永久挂住。
 */
describe('createPlainStream · 起点超过一个分块（回归：曾经永久挂死）', () => {
  const CHUNK = 256 * 1024

  it('起点正好等于一个分块', async () => {
    const content = pattern(3 * CHUNK)
    const node = vault.putFile(null, 'at-chunk.bin', content)
    const got = await readRange(node.id, CHUNK, CHUNK + 99)
    expect(got.length).toBe(100)
    expect(got.equals(content.subarray(CHUNK, CHUNK + 100))).toBe(true)
  })

  it('起点远超过一个分块（模拟拖进度条到中后段）', async () => {
    const content = pattern(5 * CHUNK)
    const node = vault.putFile(null, 'far.bin', content)
    const start = 4 * CHUNK + 12345
    const got = await readRange(node.id, start, start + 999)
    expect(got.length).toBe(1000)
    expect(got.equals(content.subarray(start, start + 1000))).toBe(true)
  })

  it('读大文件末尾的若干字节（模拟 MP4 取尾部 moov）', async () => {
    const content = pattern(4 * CHUNK)
    const node = vault.putFile(null, 'tail.bin', content)
    const start = content.length - 64
    const got = await readRange(node.id, start, content.length - 1)
    expect(got.length).toBe(64)
    expect(got.equals(content.subarray(start))).toBe(true)
  })

  it('从一个分块之后一直读到末尾（open-ended Range）', async () => {
    const content = pattern(2 * CHUNK + 777)
    const node = vault.putFile(null, 'open.bin', content)
    const start = CHUNK + 1000
    const got = await readRange(node.id, start, content.length - 1)
    expect(got.length).toBe(content.length - start)
    expect(got.equals(content.subarray(start))).toBe(true)
  })

  it('起点超过分块且只取一个字节', async () => {
    const content = pattern(2 * CHUNK)
    const node = vault.putFile(null, 'one.bin', content)
    const start = CHUNK + 5
    const got = await readRange(node.id, start, start)
    expect(got.length).toBe(1)
    expect(got[0]).toBe(content[start])
  })
})

describe('createPlainStream · 安全边界', () => {
  it('锁定后拒绝流式读取', () => {
    const node = vault.putFile(null, 'x.bin', pattern(100))
    vault.lock()
    expect(() => vault.createPlainStream(node.id, 0, 10)).toThrow(VaultError)
  })

  it('不存在的节点被拒绝', () => {
    expect(() => vault.createPlainStream('不存在的-id', 0, 10)).toThrow(VaultError)
  })

  it('文件夹节点不能当文件读', () => {
    const folder = vault.createFolder(null, '目录')
    expect(() => vault.createPlainStream(folder.id, 0, 10)).toThrow(VaultError)
  })
})

describe('Vault.reload · 刷新文件库', () => {
  it('另一个实例写入的改动，reload 之后能看到', async () => {
    const first = await Vault.open(dir, PASSWORD)
    expect(first.list().length).toBe(0)

    // 模拟"外部程序改了文件库"：另开一个实例写进去
    const second = await Vault.open(dir, PASSWORD)
    second.putFile(null, '外部加进来的.txt', Buffer.from('hello'))
    second.lock()

    // 刷新前：内存里还是旧的空树
    expect(first.list().length).toBe(0)
    first.reload()
    expect(first.list().map((n) => n.name)).toEqual(['外部加进来的.txt'])
    first.lock()
  })

  it('reload 之后文件内容也能读到', async () => {
    const first = await Vault.open(dir, PASSWORD)
    const second = await Vault.open(dir, PASSWORD)
    const node = second.putFile(null, 'a.txt', Buffer.from('内容'))
    second.lock()

    first.reload()
    expect(first.readFile(node.id).toString()).toBe('内容')
    first.lock()
  })

  it('锁定状态下 reload 会被拒绝', () => {
    vault.lock()
    expect(() => vault.reload()).toThrow(VaultError)
  })
})
