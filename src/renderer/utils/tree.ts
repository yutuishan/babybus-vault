import type { NodeView } from '@shared/types'

export interface TreeNode extends NodeView {
  children: TreeNode[]
}

/** 扁平节点列表 → 树。孤儿节点（父节点已不存在）挂到根下，避免节点凭空消失 */
export function buildTree(nodes: NodeView[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  for (const n of nodes) map.set(n.id, { ...n, children: [] })

  const roots: TreeNode[] = []
  for (const node of map.values()) {
    const parent = node.parentId ? map.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sort = (list: TreeNode[]) => {
    // 文件夹在前，其余按名称排序
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    for (const n of list) sort(n.children)
  }
  sort(roots)
  return roots
}

/** 展开某个节点的全部祖先，用于导入/搜索后定位 */
export function ancestorsOf(nodes: NodeView[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const result: string[] = []
  let current = byId.get(id)
  while (current?.parentId) {
    result.push(current.parentId)
    current = byId.get(current.parentId)
  }
  return result
}

/** 从根到该节点的完整路径文本，用于预览区面包屑 */
export function pathOf(nodes: NodeView[], id: string): NodeView[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const chain: NodeView[] = []
  let current = byId.get(id)
  while (current) {
    chain.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return chain
}
