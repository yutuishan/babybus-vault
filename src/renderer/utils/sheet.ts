/**
 * 工作表 → HTML 表格的转换。
 *
 * 单独抽成纯函数是为了能写单测：SheetJS 的 sheet_to_html 有一个很容易踩的坑 ——
 * 它第一行就是 decode_range(ws['!ref'])，而 decode_range 内部直接对参数调
 * .indexOf(":")。**工作表没有 !ref（完全空表）时参数是 undefined**，于是抛出
 *   Cannot read properties of undefined (reading 'indexOf')
 * 这个报错完全看不出跟「空工作表」有关，用户只会看到一句莫名其妙的解析失败。
 *
 * 空表在真实文件里非常常见：很多人会在工作簿里留几个空 sheet，或者某个 sheet
 * 只有格式/图表、没有任何单元格。Excel 存的 .xls 尤其容易这样。
 *
 * 消毒函数由调用方注入，不在这里 import DOMPurify —— 这样本模块在 Node 里
 * 也能直接跑单测，不依赖真实 DOM。
 */
import type { WorkSheet } from 'xlsx'

export interface SheetTable {
  /** 已经过消毒的 HTML 片段；空表或出错时为空串 */
  html: string
  /** 是否是空工作表（有这张表，但一个单元格都没有） */
  empty: boolean
  /** 单表解析失败的原因；不影响同一工作簿里的其它表 */
  error?: string
}

/**
 * 工作表里有没有真正的单元格。
 *
 * SheetJS 把工作表的所有元数据（!ref / !cols / !merges / !protect …）都挂在
 * 「!」开头的键上，其余键才是 A1、B2 这样的单元格。所以只要找到一个不以
 * 「!」开头的键，就说明表里是有内容的。
 */
function hasAnyCell(ws: WorkSheet): boolean {
  for (const key in ws) {
    if (key.charCodeAt(0) !== 33 /* '!' */) return true
  }
  return false
}

/**
 * 把一个工作表转成 HTML 表格。
 *
 * @param ws SheetJS 的工作表对象
 * @param sanitize HTML 消毒函数（浏览器侧传 DOMPurify.sanitize）
 * @param toHtml 实际的转换函数，默认用 XLSX.utils.sheet_to_html；注入是为了单测
 */
export function sheetToTable(
  ws: WorkSheet | undefined,
  sanitize: (html: string) => string,
  toHtml: (ws: WorkSheet) => string,
): SheetTable {
  // 表不存在 —— 调用方给的 SheetNames 里有、Sheets 里没有，理论上不该发生，兜住
  if (!ws) return { html: '', empty: true }

  // 没有 !ref 就是完全空表，这一条是必须的：sheet_to_html 会崩在 decode_range 里
  if (!ws['!ref']) return { html: '', empty: true }

  // 有 !ref 但一个单元格都没有（用户把内容删光只留格式，或只设了列宽）。
  // 这种表不会崩，但会渲染出一片空白网格，不如直接说清楚它是空的。
  if (!hasAnyCell(ws)) return { html: '', empty: true }

  try {
    return { html: sanitize(toHtml(ws)), empty: false }
  } catch (err) {
    // 单张表坏掉不该让整个工作簿都看不了，记下原因继续
    return { html: '', empty: false, error: err instanceof Error ? err.message : String(err) }
  }
}
