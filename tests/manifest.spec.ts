import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Manifest } from '../src/shared/types'
import {
  MANIFEST_BAK_FILENAME,
  MANIFEST_FILENAME,
  MANIFEST_TMP_FILENAME,
  encryptManifest,
  decryptManifest,
  readManifest,
  writeManifest,
  cleanupTempFiles,
} from '../src/main/crypto/manifest'
import { wipe } from '../src/main/crypto/secureBuffer'

let dir: string
let key: Buffer

const sample = (): Manifest => ({
  version: 2,
  nodes: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      parentId: null,
      type: 'folder',
      name: '项目资料',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      parentId: '11111111-1111-4111-8111-111111111111',
      type: 'file',
      name: '合同.docx',
      ext: 'docx',
      size: 123456,
      blob: 'blobs/22222222-2222-4222-8222-222222222222.enc',
      blobId: '22222222-2222-4222-8222-222222222222',
      createdAt: 2,
      updatedAt: 2,
    },
  ],
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'babybus-manifest-'))
  key = randomBytes(32)
})

afterEach(() => {
  wipe(key)
  rmSync(dir, { recursive: true, force: true })
})

describe('manifest 加解密', () => {
  it('往返后节点与文件名完全一致', () => {
    const m = sample()
    const payload = encryptManifest(key, m)
    const out = decryptManifest(key, payload)

    expect(out.nodes).toHaveLength(2)
    expect(out.nodes[0]!.name).toBe('项目资料')
    expect(out.nodes[1]!.name).toBe('合同.docx')
    expect(out.nodes[1]!.blobId).toBe(m.nodes[1]!.id)
  })

  it('中文文件名与深层结构不丢失', () => {
    const m: Manifest = {
      version: 2,
      nodes: [
        { id: 'a', parentId: null, type: 'folder', name: '财务/报表 2026', createdAt: 1, updatedAt: 1 },
        { id: 'b', parentId: 'a', type: 'file', name: '预算表.xlsx', ext: 'xlsx', size: 10, createdAt: 1, updatedAt: 1 },
      ],
    }
    const out = decryptManifest(key, encryptManifest(key, m))
    expect(out.nodes[0]!.name).toBe('财务/报表 2026')
    expect(out.nodes[1]!.name).toBe('预算表.xlsx')
  })

  it('用错误的密钥解密必须失败', () => {
    const payload = encryptManifest(key, sample())
    const wrong = randomBytes(32)
    expect(() => decryptManifest(wrong, payload)).toThrow()
    wipe(wrong)
  })

  it('篡改密文必须失败', () => {
    const payload = encryptManifest(key, sample())
    const tampered = Buffer.from(payload)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff
    expect(() => decryptManifest(key, tampered)).toThrow()
  })
})

describe('manifest 原子写入与崩溃恢复', () => {
  it('写入后可以读出同样内容，且生成备份', () => {
    writeManifest(dir, key, sample())
    const first = readManifest(dir, key)
    expect(first.recoveredFromBackup).toBe(false)
    expect(first.manifest.nodes).toHaveLength(2)

    // 第二次写入后应产生 .bak
    const updated = sample()
    updated.nodes.push({
      id: '33333333-3333-4333-8333-333333333333',
      parentId: null,
      type: 'file',
      name: '新增.txt',
      ext: 'txt',
      size: 5,
      createdAt: 3,
      updatedAt: 3,
    })
    writeManifest(dir, key, updated)

    expect(existsSync(join(dir, MANIFEST_BAK_FILENAME))).toBe(true)
    expect(readManifest(dir, key).manifest.nodes).toHaveLength(3)
  })

  it('主文件损坏时自动回退到备份，并如实标记 recovered', () => {
    writeManifest(dir, key, sample())

    const updated = sample()
    updated.nodes[0]!.name = '改过的名字'
    writeManifest(dir, key, updated)

    // 模拟写入过程中断电 / 内容损坏
    writeFileSync(join(dir, MANIFEST_FILENAME), randomBytes(200))

    const result = readManifest(dir, key)
    expect(result.recoveredFromBackup).toBe(true)
    // 回退到的是上一版，所以名字应是最初的
    expect(result.manifest.nodes[0]!.name).toBe('项目资料')
  })

  it('主文件与备份都损坏时必须明确报错，而不是静默返回空目录树', () => {
    writeManifest(dir, key, sample())
    writeFileSync(join(dir, MANIFEST_FILENAME), randomBytes(200))
    writeFileSync(join(dir, MANIFEST_BAK_FILENAME), randomBytes(200))

    // 关键：错误信息必须是人能看懂的中文说明，而不是 GCM 底层的
    // "Unsupported state or unable to authenticate data"
    expect(() => readManifest(dir, key)).toThrow(/均无法解密/)
  })

  it('写入过程中残留的 .tmp 文件可以被清理', () => {
    writeManifest(dir, key, sample())
    writeFileSync(join(dir, MANIFEST_TMP_FILENAME), 'garbage')
    cleanupTempFiles(dir)
    expect(existsSync(join(dir, MANIFEST_TMP_FILENAME))).toBe(false)
  })

  it('连续写入 20 次不会损坏，且每次都能读出最新内容', () => {
    for (let i = 0; i < 20; i++) {
      const m = sample()
      m.nodes[0]!.name = `版本-${i}`
      writeManifest(dir, key, m)
      expect(readManifest(dir, key).manifest.nodes[0]!.name).toBe(`版本-${i}`)
    }
  })

  it('文件夹中不存在 manifest 时给出清晰错误', () => {
    expect(() => readManifest(dir, key)).toThrow(/不存在/)
  })

  it('磁盘上的 manifest.enc 必须是密文，不能出现明文文件名', () => {
    writeManifest(dir, key, sample())
    const raw = readFileSync(join(dir, MANIFEST_FILENAME))
    const text = raw.toString('utf8')
    expect(text).not.toContain('项目资料')
    expect(text).not.toContain('合同.docx')
  })
})
