/**
 * 自检模式：`electron . --selftest`
 *
 * 存在的理由：M0 的能力探测是在独立下载的 Node 24.21 上做的，
 * 而真正运行时用的是 Electron 内置的 Node。两者必须一致，否则整个 KDF 选型就错了。
 *
 * 这个脚本跑的是端到端链路：真实目录 → 建库 → 写文件 → 读回 → 改密码 → 重开 → 锁库，
 * 顺便确认磁盘上没有明文残留。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Vault } from './vault/vault'
import { probeKdf } from './kdfProbe'
import type { BrowserWindow } from 'electron'

function assert(cond: unknown, message: string): void {
  if (!cond) throw new Error(`断言失败：${message}`)
}

export async function runSelfTest(): Promise<void> {
  const lines: string[] = []
  const log = (s: string) => {
    lines.push(s)
    console.log(s)
  }

  log(`[env] Electron ${process.versions.electron} / Node ${process.versions.node} / Chromium ${process.versions.chrome}`)

  // 1. KDF 能力矩阵：只判断 typeof 会被 BoringSSL 坑，必须实跑
  const probe = await probeKdf()
  log(`[kdf] node argon2id   : ${probe.nodeArgon2.available ? `${probe.nodeArgon2.ms}ms` : `不可用（${probe.nodeArgon2.error}）`}`)
  log(`[kdf] wasm argon2id   : ${probe.wasmArgon2.available ? `${probe.wasmArgon2.ms}ms` : `不可用（${probe.wasmArgon2.error}）`}`)
  log(`[kdf] scrypt          : ${probe.scrypt.available ? `${probe.scrypt.ms}ms` : `不可用（${probe.scrypt.error}）`}`)
  log(`[kdf] pbkdf2-sha512   : ${probe.pbkdf2.available ? `${probe.pbkdf2.ms}ms` : `不可用（${probe.pbkdf2.error}）`}`)
  log(`[kdf] 最终选用        : ${probe.recommended}`)
  assert(probe.recommended !== 'none', '所有 KDF 都不可用，无法继续')

  // 2. 端到端文件库读写
  const dir = mkdtempSync(join(tmpdir(), 'babybus-selftest-'))
  const PASSWORD = 'SelfTest-2026'
  const SECRET = '这是一段绝不能出现在磁盘上的明文内容 —— 合同金额 ¥1,280,000'
  const FILENAME = '机密合同.txt'

  try {
    const vault = await Vault.create(dir, PASSWORD)
    log(`[vault] 已创建：${dir}`)
    log(`[vault] KDF = ${vault.kdfInfo.kdf} (${vault.kdfInfo.kdfImpl})`)

    const folder = vault.createFolder(null, '项目资料')
    const node = vault.putFile(folder.id, FILENAME, Buffer.from(SECRET, 'utf8'))
    assert(node.blobId === node.id, 'blobId 必须等于节点 id')

    const back = vault.readFile(node.id).toString('utf8')
    assert(back === SECRET, '读回的明文与写入的不一致')

    // 3. 磁盘上不能有明文
    const offenders: string[] = []
    const scan = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name)
        if (entry.isDirectory()) {
          scan(p)
        } else {
          const raw = readFileSync(p)
          if (raw.includes(Buffer.from(SECRET, 'utf8'))) offenders.push(`${p}（含明文内容）`)
          if (raw.includes(Buffer.from(FILENAME, 'utf8'))) offenders.push(`${p}（含明文文件名）`)
        }
      }
    }
    scan(dir)
    assert(offenders.length === 0, `磁盘上发现明文残留：${offenders.join('；')}`)
    log('[vault] 磁盘明文扫描：未发现明文文件名或内容')

    // 4. 改密码后内容仍可读，且 content 段字节不变
    const before = readFileSync(join(dir, node.blob!))
    await vault.changePassword('Another-Pass-2026')
    const after = readFileSync(join(dir, node.blob!))
    assert(before.length === after.length, '改密码后 blob 长度不应变化')
    const contentUnchanged = before.subarray(98).equals(after.subarray(98))
    log(`[vault] 改密码：内容段 ${contentUnchanged ? '未重新加密' : '已重新加密'}（预期为未重新加密）`)

    const reopened = await Vault.open(dir, 'Another-Pass-2026')
    assert(reopened.readFile(node.id).toString('utf8') === SECRET, '改密码后无法用新密码读取')
    reopened.lock()

    // 5. 错误密码必须失败
    let rejected = false
    try {
      await Vault.open(dir, 'wrong-password')
    } catch {
      rejected = true
    }
    assert(rejected, '错误密码竟然打开了文件库')
    log('[vault] 错误密码已被拒绝')

    assert(existsSync(join(dir, 'vault.meta')), 'vault.meta 不存在')
    log('[vault] 全部检查通过')
    log('SELFTEST OK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 界面自检：`electron . --uitest`
 *
 * 验证 preload 桥是否真的挂上、Vue 应用是否渲染成功。
 * 只在渲染进程里读 DOM，不触碰任何密钥。
 */
export async function runUiTest(win: BrowserWindow): Promise<void> {
  // 等 Vue 挂载完成
  await new Promise((r) => setTimeout(r, 1500))

  const probe = await win.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelector(s)
    const qa = (s) => Array.from(document.querySelectorAll(s))
    return {
      hasApi: typeof window.api === 'object' && typeof window.api.create === 'function',
      apiMethods: window.api ? Object.keys(window.api).length : 0,
      brand: q('.brand h1') ? q('.brand h1').textContent.trim() : null,
      cards: qa('.card').length,
      cardTitles: qa('.card .title').map((e) => e.textContent.trim()),
      windowButtons: qa('.wbtn').length,
      foot: q('.foot') ? q('.foot').innerText.replace(/\\s+/g, ' ').trim() : null,
      appHtmlLength: q('#app') ? q('#app').innerHTML.length : 0,
    }
  })()`)

  console.log('\n[ui] ---- 渲染进程探测 ----')
  console.log('[ui] window.api 就绪   :', probe.hasApi ? `是（${probe.apiMethods} 个方法）` : '否 ✗')
  console.log('[ui] 品牌标题          :', probe.brand)
  console.log('[ui] 入口卡片          :', probe.cards, probe.cardTitles.join(' / '))
  console.log('[ui] 窗口控制按钮      :', probe.windowButtons)
  console.log('[ui] 底部说明          :', probe.foot)
  console.log('[ui] #app DOM 字节数   :', probe.appHtmlLength)

  assert(probe.hasApi, 'preload 未成功暴露 window.api')
  assert(probe.brand === '宝宝巴士', `品牌标题异常：${probe.brand}`)
  assert(probe.cards === 2, `入口卡片数量异常：${probe.cards}`)
  assert(probe.windowButtons === 3, `窗口按钮数量异常：${probe.windowButtons}`)
  assert(probe.appHtmlLength > 500, '页面 DOM 过少，Vue 可能未挂载')

  console.log('[ui] 界面自检通过')
  console.log('UITEST OK')
}
