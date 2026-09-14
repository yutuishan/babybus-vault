import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, VaultError } from '../src/main/vault/vault'
import { isVaultDir, peekHint } from '../src/main/vault/vaultMeta'
import { wipe } from '../src/main/crypto/secureBuffer'

let dir: string
const PASSWORD = 'Bb-2026-strong-pass'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'babybus-vault-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('新建与打开文件库', () => {
  it('新建后应生成 vault.meta / manifest.enc / blobs 目录', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    expect(existsSync(join(dir, 'vault.meta'))).toBe(true)
    expect(existsSync(join(dir, 'manifest.enc'))).toBe(true)
    expect(existsSync(join(dir, 'blobs'))).toBe(true)
    expect(vault.list()).toHaveLength(0)
    vault.lock()
  })

  it('密码正确可以打开，密码错误必须失败', async () => {
    ;(await Vault.create(dir, PASSWORD)).lock()
    expect(isVaultDir(dir)).toBe(true)

    const ok = await Vault.open(dir, PASSWORD)
    expect(ok).toBeInstanceOf(Vault)
    ok.lock()

    await expect(Vault.open(dir, 'wrong-password')).rejects.toThrow(VaultError)
    await expect(Vault.open(dir, 'wrong-password')).rejects.toMatchObject({ code: 'BAD_PASSWORD' })
  })

  it('在已有文件库上新建必须被拒绝（否则会覆盖导致数据永久丢失）', async () => {
    ;(await Vault.create(dir, PASSWORD)).lock()
    await expect(Vault.create(dir, PASSWORD)).rejects.toThrow(/已经是加密文件库/)
  })

  it('打开一个普通目录必须报 NOT_A_VAULT，而不是静默新建', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'babybus-empty-'))
    try {
      await expect(Vault.open(empty, PASSWORD)).rejects.toThrow(/不是有效的加密文件库/)
      // 关键：打开失败后不能留下任何新建的痕迹
      expect(existsSync(join(empty, 'vault.meta'))).toBe(false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('密码提示', () => {
  it('提示语存在明文的 vault.meta 里，锁定状态下也读得到', async () => {
    const HINT = '常用那串加生日'
    const vault = await Vault.create(dir, PASSWORD, HINT)
    expect(vault.getHint()).toBe(HINT)
    vault.lock()

    // 这是刻意的设计取舍：提示语必须能在锁屏上显示，那就只能是不加密的。
    // 代价是任何拿到这个文件夹的人都能直接读出它 —— 界面上必须写清楚这一点。
    expect(readFileSync(join(dir, 'vault.meta'), 'utf8')).toContain(HINT)
    // 提示语不能再进 manifest：两个存储位置同时存在迟早会不一致
    expect(readFileSync(join(dir, 'manifest.enc')).includes(Buffer.from(HINT, 'utf8'))).toBe(false)

    // 锁屏路径：不需要密码就能读
    expect(peekHint(dir)).toBe(HINT)

    const again = await Vault.open(dir, PASSWORD)
    expect(again.getHint()).toBe(HINT)
    again.lock()
  })

  it('peekHint 读不到时返回空串而不是抛错', () => {
    // 锁屏界面不该因为读个提示语失败就报错
    expect(peekHint(join(dir, '不存在的目录'))).toBe('')
    expect(peekHint('')).toBe('')
  })

  it('新建时不传提示语，getHint 返回空串而不是 undefined', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    expect(vault.getHint()).toBe('')
    vault.lock()
  })

  it('未解锁时读提示语必须被拒绝', async () => {
    const vault = await Vault.create(dir, PASSWORD, 'x')
    vault.lock()
    expect(() => vault.getHint()).toThrow(VaultError)
    expect(() => vault.setHint('y')).toThrow(VaultError)
  })

  it('改提示语会落盘；传空串等于删除', async () => {
    const vault = await Vault.create(dir, PASSWORD, 'old')
    vault.setHint('new-hint')
    expect(vault.getHint()).toBe('new-hint')
    vault.setHint('   ')
    expect(vault.getHint()).toBe('')
    vault.lock()

    const again = await Vault.open(dir, PASSWORD)
    expect(again.getHint()).toBe('')
    again.lock()
  })

  it('修改主密码后提示语必须保留', async () => {
    const vault = await Vault.create(dir, PASSWORD, 'keep-me')
    await vault.changePassword('Bb-2026-another-pass')
    expect(vault.getHint()).toBe('keep-me')
    vault.lock()

    const again = await Vault.open(dir, 'Bb-2026-another-pass')
    expect(again.getHint()).toBe('keep-me')
    again.lock()
  })
})

describe('文件的写入与读取', () => {  it('写入后能原样读回（含中文与二进制）', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const content = Buffer.from('机密：2026 年度并购方案\r\n附件二进制：\x00\x01\x02\xff', 'latin1')

    const node = vault.putFile(null, '并购方案.txt', content)
    const out = vault.readFile(node.id)

    expect(out.equals(content)).toBe(true)
    expect(node.size).toBe(content.length)
    wipe(out)
    vault.lock()
  })

  it('文件夹层级与重命名正常工作', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const folder = vault.createFolder(null, '项目资料')
    const file = vault.putFile(folder.id, '合同.docx', Buffer.from('docx 内容'))

    expect(vault.list()).toHaveLength(2)

    vault.renameNode(file.id, '合同-已签署.docx')
    const renamed = vault.list().find((n) => n.id === file.id)
    expect(renamed!.name).toBe('合同-已签署.docx')
    vault.lock()
  })

  it('移动节点时不能把文件夹移进自己的子树', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const root = vault.createFolder(null, '根目录')
    const sub = vault.createFolder(root.id, '子目录')

    vault.moveNode(sub.id, null)
    expect(vault.list().find((n) => n.id === sub.id)!.parentId).toBeNull()

    // 移回 root 之下，此时 sub 又是 root 的子节点
    vault.moveNode(sub.id, root.id)
    expect(vault.list().find((n) => n.id === sub.id)!.parentId).toBe(root.id)

    // 再把 root 移进它自己的子目录 sub，会让整棵子树从目录树消失，必须拒绝
    expect(() => vault.moveNode(root.id, sub.id)).toThrow(/自己的子目录|自己下面/)
    expect(() => vault.moveNode(root.id, root.id)).toThrow(/自己下面/)
    vault.lock()
  })

  it('批量移动多个节点（多选拖拽）一次调用即可全部就位', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const dest = vault.createFolder(null, '目标')
    const f1 = vault.putFile(null, 'a.txt', Buffer.from('a'))
    const f2 = vault.putFile(null, 'b.txt', Buffer.from('b'))
    const folder = vault.createFolder(null, '素材')

    // 对应 handlers 里 vaultMove 的批量分支：文件与文件夹混着移
    vault.runBatch(() => {
      for (const id of [f1.id, f2.id, folder.id]) vault.moveNode(id, dest.id)
    })

    const byId = new Map(vault.list().map((n) => [n.id, n]))
    expect(byId.get(f1.id)!.parentId).toBe(dest.id)
    expect(byId.get(f2.id)!.parentId).toBe(dest.id)
    expect(byId.get(folder.id)!.parentId).toBe(dest.id)
    vault.lock()
  })

  it('批量移动中途遇到非法项时，已应用的改动仍然落盘（不能留下内存与磁盘不一致）', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const target = vault.createFolder(null, '目标')
    const a = vault.putFile(null, 'a.txt', Buffer.from('a'))
    const inner = vault.createFolder(target.id, '内层')

    // 顺序：先移 a（合法），再把 target 移进它自己的子目录 inner（非法 → 抛错）
    expect(() =>
      vault.runBatch(() => {
        vault.moveNode(a.id, target.id)
        vault.moveNode(target.id, inner.id)
      }),
    ).toThrow(/自己的子目录|自己下面/)

    // a 的移动在抛错前已生效。runBatch 的契约是「无论 fn 是否抛错都落盘一次」——
    // 渲染进程那边「移动失败也要 refresh」正是依赖这条契约：否则界面会与磁盘对不上。
    vault.lock()

    const reopened = await Vault.open(dir, PASSWORD)
    const byId = new Map(reopened.list().map((n) => [n.id, n]))
    expect(byId.get(a.id)!.parentId).toBe(target.id)
    expect(byId.get(target.id)!.parentId).toBeNull()
    reopened.lock()
  })

  it('删除文件夹会递归删除其下所有文件', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const root = vault.createFolder(null, '根目录')
    const sub = vault.createFolder(root.id, '子目录')
    vault.putFile(sub.id, 'a.txt', Buffer.from('a'))
    vault.putFile(sub.id, 'b.txt', Buffer.from('b'))
    vault.putFile(null, 'c.txt', Buffer.from('c'))

    // 共 5 个节点：root、sub、a.txt、b.txt，以及根目录外的 c.txt
    expect(vault.list()).toHaveLength(5)
    // 删除 root 会带走 root + sub + a.txt + b.txt 共 4 个节点，只留下 c.txt
    const deleted = vault.deleteNode(root.id)
    expect(deleted).toBe(4)
    expect(vault.list()).toHaveLength(1)
    expect(vault.list()[0]!.name).toBe('c.txt')
    vault.lock()
  })

  it('文件被整体替换后，contentTag 校验必须拒绝读取', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const node = vault.putFile(null, 'a.txt', Buffer.from('原始内容'))
    const another = vault.putFile(null, 'b.txt', Buffer.from('另一份内容'))

    // 把 b 的密文整体覆盖到 a 的路径上，模拟文件被替换
    const bBlob = readFileSync(join(dir, `blobs/${another.id}.enc`))
    vault.lock()
    writeFileSync(join(dir, `blobs/${node.id}.enc`), bBlob)

    const reopened = await Vault.open(dir, PASSWORD)
    expect(() => reopened.readFile(node.id)).toThrow(/不一致|不匹配/)
    reopened.lock()
  })
})

describe('修改主密码', () => {
  it('改密后旧密码失效、新密码可用，且文件内容不变', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const content = Buffer.from('改密码前的机密内容')
    const node = vault.putFile(null, 'secret.txt', content)

    await vault.changePassword('New-Pass-2026!')

    // 仍在内存中的实例可以继续用
    expect(vault.readFile(node.id).equals(content)).toBe(true)
    vault.lock()

    // 旧密码失效
    await expect(Vault.open(dir, PASSWORD)).rejects.toThrow(/主密码错误/)
    // 新密码可用，内容一致
    const reopened = await Vault.open(dir, 'New-Pass-2026!')
    const out = reopened.readFile(node.id)
    expect(out.equals(content)).toBe(true)
    wipe(out)
    reopened.lock()
  })

  it('改密码不会重新加密文件内容（content 段字节保持不变）', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const node = vault.putFile(null, 'big.bin', Buffer.alloc(64 * 1024, 7))
    const blobPath = join(dir, `blobs/${node.id}.enc`)

    const before = readFileSync(blobPath)
    const HEADER = 38
    const WRAPPED = 60
    const contentBefore = Buffer.from(before.subarray(HEADER + WRAPPED))

    await vault.changePassword('Another-Pass-1')
    const after = readFileSync(blobPath)
    const contentAfter = after.subarray(HEADER + WRAPPED)

    expect(contentAfter.equals(contentBefore)).toBe(true)
    expect(after.subarray(0, HEADER).equals(before.subarray(0, HEADER))).toBe(true)
    vault.lock()
  })
})

describe('锁定与明文残留', () => {
  it('锁定后任何操作都必须失败', async () => {
    const vault = await Vault.create(dir, PASSWORD)
    const node = vault.putFile(null, 'a.txt', Buffer.from('x'))
    vault.lock()

    expect(vault.isLocked).toBe(true)
    expect(() => vault.list()).toThrow(/已锁定/)
    expect(() => vault.readFile(node.id)).toThrow(/已锁定/)
    expect(() => vault.putFile(null, 'b.txt', Buffer.from('y'))).toThrow(/已锁定/)
  })

  it('磁盘上不应出现任何明文：文件名与内容都必须不可见', async () => {
    const secretName = '绝密-员工薪资表.xlsx'
    const secretBody = 'UNIQUE-MARKER-SALARY-2026'
    const vault = await Vault.create(dir, PASSWORD)
    vault.putFile(null, secretName, Buffer.from(secretBody))
    vault.lock()

    const scan = (d: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name)
        if (entry.isDirectory()) out.push(...scan(p))
        else out.push(p)
      }
      return out
    }

    for (const file of scan(dir)) {
      const raw = readFileSync(file)
      expect(raw.toString('utf8')).not.toContain(secretBody)
      expect(raw.toString('utf8')).not.toContain(secretName)
      // base64 也扫一遍，防止明文被编码后残留
      expect(raw.toString('base64')).not.toContain(
        Buffer.from(secretBody, 'utf8').toString('base64'),
      )
    }
  })
})
