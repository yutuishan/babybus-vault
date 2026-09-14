/**
 * 目录树拖拽的载荷编解码与合法性过滤。
 *
 * 抽成独立模块的理由和 sheet.ts / importPlan.ts 一样：逻辑埋在组件的
 * `<script setup>` 里就没法单测。而「多选拖拽只有 1 个会移动」这个 bug 正是栽在这里 ——
 * 逻辑本身很简单，但没人测得到它。
 */
import type { NodeView } from '@shared/types'
import { ancestorsOf } from './tree'

/** 拖拽载荷的 MIME。载荷是 id 的 JSON 数组，见 encodeDragIds */
export const DRAG_MIME = 'application/x-vault-node'

/** 把要移动的节点编码成拖拽载荷 */
export function encodeDragIds(ids: string[]): string {
  return JSON.stringify(ids)
}

/**
 * 解析拖拽载荷。
 *
 * 当前格式是 JSON 数组；早期版本写的是单个裸 id，这里保留兼容分支。
 * 判定顺序很关键 —— 先试 JSON.parse，再退回裸 id：
 *
 *   '["a","b"]'   → ['a','b']      当前格式
 *   '8f3a-1b'     → ['8f3a-1b']    旧格式（UUID 解析不了 JSON，落到兼容分支）
 *   '{"id":"a"}'  → []             合法 JSON 但不是数组：不是我们的格式，拒绝
 *   '123'         → []             同上（数字）
 *   '[not json'   → []             以 [ 开头说明本意是 JSON，只是损坏了
 *
 * 为什么要区分「损坏的 JSON」和「裸 id」：如果一律退回裸 id，
 * 一个被截断的数组会被当成某个节点 id 拿去查库，报一个莫名其妙的 NODE_NOT_FOUND，
 * 而真正的原因（载荷损坏）被完全掩盖。
 */
export function parseDragIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string')
    }
    // 合法 JSON，但不是数组 —— 不是本模块写出去的格式
    return []
  } catch {
    // 解析不了。以 [ 或 { 开头 = 本意是 JSON（只是坏了）→ 返回空；
    // 否则按旧格式的单个裸 id 处理。
    return raw.startsWith('[') || raw.startsWith('{') ? [] : [raw]
  }
}

/**
 * 剔除不能移动的节点。
 *
 * 把一个节点拖进它自己、或者拖进它自己的子孙目录，都会让目录树成环 ——
 * 子树从树上脱落，那些节点就再也点不到了。主进程 moveNode 有兜底校验，
 * 但这里先挡掉：一次拖 10 个时，不能因为其中 1 个非法就让整批失败。
 *
 * 判定基准是**目标目录**（`destId`）：拖到文件上时落点是该文件所在的目录，
 * 不是文件本身，所以调用方要传 parentId 而不是被拖到的节点 id。
 */
export function filterMovable(
  nodes: NodeView[],
  ids: string[],
  destId: string | null,
): string[] {
  if (!destId) return ids
  const blocked = new Set<string>(ancestorsOf(nodes, destId))
  blocked.add(destId)
  return ids.filter((id) => !blocked.has(id))
}
