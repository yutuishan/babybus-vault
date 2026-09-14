/**
 * 导出：把文件库里的节点递归写回普通目录，保持原有目录结构。
 *
 * 从 handlers.ts 抽出来（与 importPlan.ts 对称），有两个理由：
 *   1. 能单测 —— 埋在 IPC 处理器里的递归函数，测试碰不到；
 *   2. 顺手修掉原来的 O(n²)：旧实现每层递归都 `vault.list()` 一次，
 *      而 list() 返回的是整棵目录树。导出 600 个文件就会把整棵树取 600 遍。
 *      现在只取一次，再按 parentId 建索引。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { NodeView } from '@shared/types'
import type { Vault } from '../vault/vault'
import { wipe } from '../crypto/secureBuffer'

/** 导出单个节点（文件夹则连子节点一起），返回实际写出的文件数 */
export function exportNodeRecursive(vault: Vault, id: string, destDir: string): number {
  return exportNodes(vault, [id], destDir)
}

/** 批量导出多个节点到同一个目标目录，返回实际写出的文件数 */
export function exportNodes(vault: Vault, ids: string[], destDir: string): number {
  const nodes = vault.list()
  const byId = new Map<string, NodeView>()
  const childrenOf = new Map<string | null, NodeView[]>()
  for (const n of nodes) {
    byId.set(n.id, n)
    const bucket = childrenOf.get(n.parentId)
    if (bucket) bucket.push(n)
    else childrenOf.set(n.parentId, [n])
  }

  let written = 0

  const walk = (node: NodeView, dir: string): void => {
    const target = join(dir, node.name)
    if (node.type === 'folder') {
      mkdirSync(target, { recursive: true })
      for (const child of childrenOf.get(node.id) ?? []) walk(child, target)
      return
    }
    // 明文只在内存里过一手，写完立刻擦掉 —— 与预览路径同一套约定
    const content = vault.readFile(node.id)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      written++
    } finally {
      wipe(content)
    }
  }

  for (const id of ids) {
    const node = byId.get(id)
    if (node) walk(node, destDir)
  }
  return written
}
