/**
 * 工作表 → HTML 的回归测试。
 *
 * 用户报的原始现象是「xls 表格文件 解析失败：Cannot read properties of undefined
 * (reading 'indexOf')」。追下去发现跟 .xls 格式、编码、数字格式统统无关，
 * 真正的原因是 **空工作表**：SheetJS 的 sheet_to_html 第一行就是
 * decode_range(ws['!ref'])，而 decode_range 内部直接对参数调 .indexOf(':')。
 * 工作表里一个单元格都没有时不会有 !ref，参数就是 undefined，于是抛出上面那句话。
 *
 * 这里既做纯函数单测，也直接用真实的 SheetJS 复现一次原始报错 —— 后者是关键的
 * 那一条：一旦将来有人把 !ref 判断删掉，它会立刻红。
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { sheetToTable } from '../src/renderer/utils/sheet'

/** 原样透传，不做消毒 —— 单测里不需要真实 DOM */
const identity = (html: string) => html
/** 真实的转换函数 */
const realToHtml = (ws: XLSX.WorkSheet) => XLSX.utils.sheet_to_html(ws)

describe('sheetToTable · 空工作表', () => {
  it('复现原始报错：空表直接调 sheet_to_html 会抛 indexOf', () => {
    // 完全空的工作表对象：有这张表，但没有任何单元格，所以没有 !ref
    const empty = {} as XLSX.WorkSheet
    expect(() => realToHtml(empty)).toThrow(/indexOf/)
  })

  it('空表经 sheetToTable 后不再抛错，标记为 empty', () => {
    const empty = {} as XLSX.WorkSheet
    const r = sheetToTable(empty, identity, realToHtml)
    expect(r.empty).toBe(true)
    expect(r.html).toBe('')
    expect(r.error).toBeUndefined()
  })

  it('worksheet 为 undefined 也按空表处理', () => {
    const r = sheetToTable(undefined, identity, realToHtml)
    expect(r).toEqual({ html: '', empty: true })
  })

  it('有 !ref 但没有任何单元格：不崩，且识别为空表', () => {
    // 用户把内容删光、只留格式时，SheetJS 会给出 !ref 但没有任何单元格。
    // 这种表 sheet_to_html 不会崩，但会渲染一片空白网格 —— 不如直接说是空的。
    const ws = { '!ref': 'A1' } as XLSX.WorkSheet
    const r = sheetToTable(ws, identity, realToHtml)
    expect(r.error).toBeUndefined()
    expect(r.empty).toBe(true)
    expect(r.html).toBe('')
  })

  it('只有格式元数据（!cols / !merges）没有单元格，也算空表', () => {
    const ws = {
      '!ref': 'A1:C3',
      '!cols': [{ wch: 12 }],
      '!merges': [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }],
    } as XLSX.WorkSheet
    expect(sheetToTable(ws, identity, realToHtml).empty).toBe(true)
  })

  it('aoa_to_sheet([[]]) 产出的是没有 !ref 的 {}，按空表处理', () => {
    // 这条是实测结果：SheetJS 对空区间不写 !ref
    const ws = XLSX.utils.aoa_to_sheet([[]])
    expect(ws['!ref']).toBeUndefined()
    expect(sheetToTable(ws, identity, realToHtml).empty).toBe(true)
  })
})

describe('sheetToTable · 正常表', () => {
  it('普通数据表能渲染出表格 HTML 并被消毒函数处理', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['姓名', '分数'],
      ['张三', 90],
    ])
    const r = sheetToTable(ws, identity, realToHtml)
    expect(r.empty).toBe(false)
    expect(r.error).toBeUndefined()
    expect(r.html).toContain('<table')
    expect(r.html).toContain('张三')
    expect(r.html).toContain('90')
  })

  it('消毒函数确实被调用（返回被替换的内容）', () => {
    const ws = XLSX.utils.aoa_to_sheet([['x']])
    const r = sheetToTable(ws, () => 'SANITIZED', realToHtml)
    expect(r.html).toBe('SANITIZED')
  })

  it('中文内容不会出问题（曾经怀疑是编码表，实际不是）', () => {
    const ws = XLSX.utils.aoa_to_sheet([['金额', '¥1,234.56'], ['备注', '含税价']])
    const r = sheetToTable(ws, identity, realToHtml)
    expect(r.html).toContain('金额')
    expect(r.html).toContain('含税价')
  })
})

describe('sheetToTable · 单表出错不拖垮工作簿', () => {
  it('单表抛错时只记录 error，不向外抛', () => {
    const ws = XLSX.utils.aoa_to_sheet([['x']])
    const boom = () => {
      throw new Error('坏掉的表')
    }
    const r = sheetToTable(ws, identity, boom)
    expect(r.error).toBe('坏掉的表')
    expect(r.html).toBe('')
    expect(r.empty).toBe(false)
  })

  it('非 Error 抛出物也能转成字符串', () => {
    const ws = XLSX.utils.aoa_to_sheet([['x']])
    const boom = () => {
      throw 'plain string'
    }
    expect(sheetToTable(ws, identity, boom).error).toBe('plain string')
  })
})

describe('sheetToTable · 真实工作簿端到端', () => {
  it('含空表的多表工作簿：每张表都能出结果，没有异常逃逸', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), '数据')
    XLSX.utils.book_append_sheet(wb, {} as XLSX.WorkSheet, '空表')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['仅一行']]), '备注')

    const results = wb.SheetNames.map((n) =>
      sheetToTable(wb.Sheets[n], identity, realToHtml),
    )

    expect(results[0]!.html).toContain('<table')
    expect(results[1]!.empty).toBe(true)
    expect(results[2]!.html).toContain('仅一行')
    expect(results.every((r) => r.error === undefined)).toBe(true)
  })

  it('从 BIFF8（.xls）字节流读出来的空表同样不崩', () => {
    // 造一个真 .xls：一个数据表 + 一个空表
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['标题'], ['值']]), 'Sheet1')
    XLSX.utils.book_append_sheet(wb, {} as XLSX.WorkSheet, 'Empty')
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'biff8' }) as ArrayBuffer

    const back = XLSX.read(bytes, { type: 'array' })
    const results = back.SheetNames.map((n) =>
      sheetToTable(back.Sheets[n], identity, realToHtml),
    )
    // 读回来的工作簿里空表可能被 SheetJS 丢掉，也可能保留；两种都必须是「不报错」
    expect(results.every((r) => r.error === undefined)).toBe(true)
    expect(results.some((r) => r.html.includes('<table'))).toBe(true)
  })
})
