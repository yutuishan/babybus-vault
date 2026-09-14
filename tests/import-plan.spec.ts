/**
 * 目录导入的回归测试。
 *
 * 用户提的两条需求都在这里被钉住：
 *   - 「支持导入文件夹，并不破坏内部结构」—— 以前是递归展开成文件列表后全塞进同一个目录，
 *     层级被拍平了；现在必须原样保留。
 *   - 「导入相同文件和文件夹，支持覆盖和同时存在并区分」—— 两种策略各自的语义。
 *
 * 注意一个容易搞混的点：导入一个目录时，**目录本身也会在文件库里被建出来**。
 * 所以想让某个文件落在根目录，就得直接导入那个文件；导入它所在的文件夹会多一层。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Vault } from '../src/main/vault/vault'
import { executeImport, scanImport } from '../src/main/ipc/importPlan'

const PASSWORD = 'Test-2026-pass'

let vaultDir: string
let vault: Vault
const tempDirs: string[] = []

/**
 * 造一个"待导入的目录"，名字可控 —— 名字很重要：导入后文件库里那个文件夹就叫这个名字，
 * 同名冲突测试全靠它。
 */
function makeSourceDir(name = '源目录'): string {
  const parent = mkdtempSync(join(tmpdir(), 'bb-src-'))
  tempDirs.push(parent)
  const leaf = join(parent, name)
  mkdirSync(leaf, { recursive: true })
  return leaf
}

/** 造一个"待导入的文件"，直接导入它就能落在目标目录的根上 */
function makeSourceFile(name: string, content: string): string {
  const parent = mkdtempSync(join(tmpdir(), 'bb-src-'))
  tempDirs.push(parent)
  const file = join(parent, name)
  writeFileSync(file, content)
  return file
}

beforeEach(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'bb-vault-'))
  tempDirs.push(vaultDir)
  vault = await Vault.create(vaultDir, PASSWORD)
})

afterEach(() => {
  try {
    vault.lock()
  } catch {
    /* 已经锁了 */
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发 EPERM，不影响断言 */
    }
  }
})

/** 按名字 + 父目录取节点，找不到就抛（省掉一堆 ?.） */
function pick(name: string, parentId: string | null) {
  const node = vault.list().find((n) => n.name === name && n.parentId === parentId)
  if (!node) throw new Error(`没找到节点 ${name}（parent=${parentId}）`)
  return node
}

/** 某个目录下的直接子项名字，排好序便于整体断言 */
function names(parentId: string | null): string[] {
  return vault
    .list()
    .filter((n) => n.parentId === parentId)
    .map((n) => n.name)
    .sort()
}

describe('导入文件夹 · 保留内部结构', () => {
  it('多级目录原样重建，文件落在各自该在的层级', () => {
    const src = makeSourceDir('资料')
    mkdirSync(join(src, '照片', '2024'), { recursive: true })
    writeFileSync(join(src, '照片', '封面.jpg'), 'cover')
    writeFileSync(join(src, '照片', '2024', '合影.jpg'), 'group')
    writeFileSync(join(src, '说明.txt'), 'readme')

    const res = executeImport(vault, null, [src], 'keep-both')
    expect(res.imported).toBe(3)
    expect(res.folders).toBe(3) // 资料 + 照片 + 2024
    expect(res.failed).toEqual([])

    const root = pick('资料', null)
    const photos = pick('照片', root.id)
    const year = pick('2024', photos.id)

    expect(root.type).toBe('folder')
    expect(photos.type).toBe('folder')
    expect(year.type).toBe('folder')

    expect(names(root.id)).toEqual(['照片', '说明.txt'])
    expect(names(photos.id)).toEqual(['2024', '封面.jpg'])
    expect(names(year.id)).toEqual(['合影.jpg'])
  })

  it('文件内容在导入后能原样读回', () => {
    const src = makeSourceDir('资料')
    mkdirSync(join(src, '子目录'), { recursive: true })
    writeFileSync(join(src, '子目录', 'a.txt'), '中文内容-abc', 'utf8')

    executeImport(vault, null, [src], 'keep-both')
    const root = pick(basename(src), null)
    const sub = pick('子目录', root.id)
    const file = pick('a.txt', sub.id)

    expect(vault.readFile(file.id).toString('utf8')).toBe('中文内容-abc')
  })

  it('导入单个文件时只建文件，不建多余的目录', () => {
    const file = makeSourceFile('single.txt', 'x')

    const res = executeImport(vault, null, [file], 'keep-both')
    expect(res.imported).toBe(1)
    expect(res.folders).toBe(0)
    expect(names(null)).toEqual(['single.txt'])
  })

  it('把文件库目录自己拖进来不会被导入（否则库会无限膨胀）', () => {
    vault.putFile(null, 'x.txt', Buffer.from('hello'))

    const res = executeImport(vault, null, [vaultDir], 'keep-both')
    expect(res.imported).toBe(0)
    expect(res.folders).toBe(0)
    // 原本那个文件还在，没有被清掉或复制
    expect(vault.list().length).toBe(1)
  })

  it('源目录里的 vault.meta / manifest.enc 会被跳过', () => {
    const src = makeSourceDir('资料')
    writeFileSync(join(src, 'vault.meta'), '{}')
    writeFileSync(join(src, 'manifest.enc'), 'xxx')
    writeFileSync(join(src, '正常.txt'), 'ok')

    const res = executeImport(vault, null, [src], 'keep-both')
    expect(res.imported).toBe(1)
    const root = pick('资料', null)
    expect(names(root.id)).toEqual(['正常.txt'])
  })

  it('空目录也能导入（只是建一个空文件夹）', () => {
    const src = makeSourceDir('资料')
    mkdirSync(join(src, '空的'), { recursive: true })

    const res = executeImport(vault, null, [src], 'keep-both')
    expect(res.imported).toBe(0)
    expect(res.folders).toBe(2) // 资料 + 空的
    const root = pick('资料', null)
    expect(names(root.id)).toEqual(['空的'])
  })
})

describe('导入重名 · 保留两者', () => {
  it('同名文件自动改名为「名字 (2).ext」，两份都在', () => {
    vault.putFile(null, '报告.txt', Buffer.from('旧'))
    const file = makeSourceFile('报告.txt', '新')

    executeImport(vault, null, [file], 'keep-both')

    // 空格 (0x20) 排在点 (0x2E) 前面，所以 (2) 那份在前
    expect(names(null)).toEqual(['报告 (2).txt', '报告.txt'])
    const original = pick('报告.txt', null)
    const renamed = pick('报告 (2).txt', null)
    expect(vault.readFile(original.id).toString()).toBe('旧')
    expect(vault.readFile(renamed.id).toString()).toBe('新')
  })

  it('连续导入三次会依次得到 (2) (3)', () => {
    const file = makeSourceFile('a.txt', 'x')

    executeImport(vault, null, [file], 'keep-both')
    executeImport(vault, null, [file], 'keep-both')
    executeImport(vault, null, [file], 'keep-both')

    expect(names(null)).toEqual(['a (2).txt', 'a (3).txt', 'a.txt'])
  })

  it('同名文件夹改名为「名字 (2)」，里面的内容不会混在一起', () => {
    const existing = vault.createFolder(null, '项目')
    vault.putFile(existing.id, 'old.txt', Buffer.from('old'))

    const src = makeSourceDir('项目')
    writeFileSync(join(src, 'new.txt'), 'new')

    executeImport(vault, null, [src], 'keep-both')

    const copy = pick('项目 (2)', null)
    expect(names(copy.id)).toEqual(['new.txt'])
    // 原有那份没有被污染
    expect(names(existing.id)).toEqual(['old.txt'])
  })

  it('隐藏文件的改名不会把前导点当成扩展名', () => {
    vault.putFile(null, '.gitignore', Buffer.from('a'))
    const file = makeSourceFile('.gitignore', 'b')

    executeImport(vault, null, [file], 'keep-both')
    expect(names(null)).toEqual(['.gitignore', '.gitignore (2)'])
  })

  it('没有扩展名的文件改名后仍然没有多余的点', () => {
    vault.putFile(null, 'LICENSE', Buffer.from('a'))
    const file = makeSourceFile('LICENSE', 'b')

    executeImport(vault, null, [file], 'keep-both')
    expect(names(null)).toEqual(['LICENSE', 'LICENSE (2)'])
  })
})

describe('导入重名 · 覆盖', () => {
  it('同名文件被替换，库里只剩一份', () => {
    const old = vault.putFile(null, '报告.txt', Buffer.from('旧'))
    const file = makeSourceFile('报告.txt', '新')

    executeImport(vault, null, [file], 'overwrite')

    expect(names(null)).toEqual(['报告.txt'])
    const now = pick('报告.txt', null)
    expect(vault.readFile(now.id).toString()).toBe('新')
    // 新的节点是新 id，旧的 blob 已经删掉了
    expect(now.id).not.toBe(old.id)
  })

  it('同名文件夹是合并，不是清空重建', () => {
    const existing = vault.createFolder(null, '项目')
    vault.putFile(existing.id, 'keep-me.txt', Buffer.from('重要'))

    const src = makeSourceDir('项目')
    writeFileSync(join(src, 'added.txt'), 'new')

    executeImport(vault, null, [src], 'overwrite')

    const merged = pick('项目', null)
    // 合并进同一个目录：id 不变，原有的和新的都在
    expect(merged.id).toBe(existing.id)
    expect(names(merged.id)).toEqual(['added.txt', 'keep-me.txt'])
  })

  it('嵌套层级里的重名也会被覆盖', () => {
    const existing = vault.createFolder(null, '外层')
    vault.putFile(existing.id, 'inner.txt', Buffer.from('旧'))

    const src = makeSourceDir('外层')
    writeFileSync(join(src, 'inner.txt'), '新')

    executeImport(vault, null, [src], 'overwrite')

    const outer = pick('外层', null)
    expect(outer.id).toBe(existing.id)
    const file = pick('inner.txt', outer.id)
    expect(vault.readFile(file.id).toString()).toBe('新')
    expect(names(outer.id)).toEqual(['inner.txt'])
  })

  it('类型不同也算重名：文件占了同名位置时会被替换成文件夹', () => {
    vault.putFile(null, '同名', Buffer.from('我是文件'))

    const src = makeSourceDir('同名')
    writeFileSync(join(src, 'a.txt'), 'x')

    executeImport(vault, null, [src], 'overwrite')

    const folder = pick('同名', null)
    expect(folder.type).toBe('folder')
    expect(names(folder.id)).toEqual(['a.txt'])
  })
})

describe('导入预扫描', () => {
  it('统计将要导入的文件数与文件夹数', () => {
    const src = makeSourceDir('资料')
    mkdirSync(join(src, '子'), { recursive: true })
    writeFileSync(join(src, '子', 'a.txt'), 'y')
    writeFileSync(join(src, '独有.txt'), 'z')

    const scan = scanImport(vault, null, [src])
    expect(scan.files).toBe(2)
    expect(scan.folders).toBe(2) // 资料 + 子
    expect(scan.conflicts).toEqual([])
  })

  it('同名文件夹下的嵌套重名也会被列出来', () => {
    const existing = vault.createFolder(null, '照片')
    vault.putFile(existing.id, '封面.jpg', Buffer.from('x'))

    const src = makeSourceDir('照片')
    writeFileSync(join(src, '封面.jpg'), 'y')

    const scan = scanImport(vault, null, [src])
    const listed = scan.conflicts.map((c) => c.name)
    // 外层同名文件夹 + 里面同名的文件
    expect(listed).toContain('照片')
    expect(listed).toContain('照片/封面.jpg')
  })

  it('同名文件夹会带上"库中已有的是文件夹"这个信息', () => {
    vault.createFolder(null, '照片')
    const src = makeSourceDir('照片')
    writeFileSync(join(src, 'a.jpg'), 'y')

    const scan = scanImport(vault, null, [src])
    expect(scan.conflicts[0]).toEqual({ name: '照片', kind: 'folder', existingType: 'folder' })
  })

  it('没有重名时 conflicts 为空，界面可以直接导入', () => {
    const file = makeSourceFile('全新的.txt', 'x')
    expect(scanImport(vault, null, [file]).conflicts).toEqual([])
  })

  it('源路径不存在时安静跳过，不抛错', () => {
    const scan = scanImport(vault, null, [join(tmpdir(), '绝对不存在的路径-xyz')])
    expect(scan.files).toBe(0)
    expect(scan.folders).toBe(0)
  })
})

describe('导入的批量落盘', () => {
  it('一次导入多个文件后，重新打开文件库仍然能看到全部内容', async () => {
    const src = makeSourceDir('资料')
    mkdirSync(join(src, 'a'), { recursive: true })
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(src, 'a', `f${i}.txt`), `内容-${i}`)
    }

    const res = executeImport(vault, null, [src], 'keep-both')
    expect(res.imported).toBe(20)

    // runBatch 把多次写合并成一次落盘；这里验证那一次确实写成功了
    vault.lock()
    const reopened = await Vault.open(vaultDir, PASSWORD)
    const root = reopened.list().find((n) => n.name === '资料')!
    const a = reopened.list().find((n) => n.name === 'a' && n.parentId === root.id)!
    const files = reopened.list().filter((n) => n.parentId === a.id)
    expect(files.length).toBe(20)

    const one = files.find((n) => n.name === 'f7.txt')!
    expect(reopened.readFile(one.id).toString()).toBe('内容-7')
    reopened.lock()
  })
})

describe('导入不会动到库中原有的东西', () => {
  it('保留两者时，库里原有的同名文件字节不变', () => {
    const file = makeSourceFile('same.txt', '原始内容')
    executeImport(vault, null, [file], 'keep-both')

    const before = pick('same.txt', null)
    const beforeBytes = vault.readFile(before.id)

    // 再导一次，这次会生成 same (2).txt
    executeImport(vault, null, [file], 'keep-both')

    const after = pick('same.txt', null)
    expect(after.id).toBe(before.id)
    expect(vault.readFile(after.id).equals(beforeBytes)).toBe(true)
  })
})
