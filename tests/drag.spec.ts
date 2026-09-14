import { describe, expect, it } from 'vitest'
import { encodeDragIds, filterMovable, parseDragIds } from '../src/renderer/utils/drag'
import type { NodeView } from '../src/shared/types'

/**
 * 为什么单独盯拖拽载荷：
 *
 * 「多选拖拽只有 1 个会移动」这个 bug 的根因就是载荷里只写了被按住的那一个 id。
 * 而这段逻辑原先埋在 FileTree.vue 的 `<script setup>` 里 —— 组件没有 jsdom，
 * 单测碰不到，于是错了一年也没人发现。抽到 utils/drag.ts 就是为了能在这里钉死契约。
 *
 * 注意：这里覆盖的是**载荷编解码**和**合法性过滤**。
 * 「dragstart 时到底把哪一批 id 放进载荷」是组件的选择，单测覆盖不到 ——
 * 那部分靠 uiProbe 的端到端用例（真的派发 DragEvent）。
 */

/** 目录树夹具：
 *  A/            （文件夹）
 *   ├── B/       （文件夹）
 *   │    └── C/  （文件夹）
 *   │         └── d.txt
 *   └── e.txt
 *  f.txt         （根目录下的文件）
 */
const NODES: NodeView[] = [
  { id: 'A', parentId: null, type: 'folder', name: 'A', updatedAt: 0 },
  { id: 'B', parentId: 'A', type: 'folder', name: 'B', updatedAt: 0 },
  { id: 'C', parentId: 'B', type: 'folder', name: 'C', updatedAt: 0 },
  { id: 'd', parentId: 'C', type: 'file', name: 'd.txt', updatedAt: 0 },
  { id: 'e', parentId: 'A', type: 'file', name: 'e.txt', updatedAt: 0 },
  { id: 'f', parentId: null, type: 'file', name: 'f.txt', updatedAt: 0 },
]

describe('拖拽载荷 · 编解码', () => {
  it('多选 id 能原样往返（回归：曾经只带一个 id）', () => {
    const ids = ['a', 'b', 'c']
    expect(parseDragIds(encodeDragIds(ids))).toEqual(['a', 'b', 'c'])
  })

  it('单个 id 也能往返', () => {
    expect(parseDragIds(encodeDragIds(['only']))).toEqual(['only'])
  })

  it('空数组往返后仍是空数组', () => {
    expect(parseDragIds(encodeDragIds([]))).toEqual([])
  })

  it('兼容早期的「裸 id」载荷格式', () => {
    // 旧版本 setData 写的是单个 id 而不是 JSON 数组。
    // 若这里退化成空数组，表现就是「拖了完全没反应」——极难排查，所以必须留着这条分支。
    expect(parseDragIds('8f3a-1b')).toEqual(['8f3a-1b'])
  })

  it('null / undefined / 空串 一律得到空数组，不抛错', () => {
    expect(parseDragIds(null)).toEqual([])
    expect(parseDragIds(undefined)).toEqual([])
    expect(parseDragIds('')).toEqual([])
  })

  it('JSON 损坏时返回空数组而不是抛错', () => {
    // 以 [ 或 { 开头 → 本意就是 JSON，坏了就该返回空。
    // 不能退回成「裸 id」：那样一个被截断的数组会被当成节点 id 去查库，
    // 报一个莫名其妙的 NODE_NOT_FOUND，把真正的原因（载荷损坏）盖掉。
    expect(parseDragIds('[not json')).toEqual([])
    expect(parseDragIds('["a",')).toEqual([])
    expect(parseDragIds('{"id":')).toEqual([])
  })

  it('JSON 合法但不是数组时返回空数组', () => {
    expect(parseDragIds('{"id":"a"}')).toEqual([])
    expect(parseDragIds('123')).toEqual([])
    expect(parseDragIds('null')).toEqual([])
    expect(parseDragIds('true')).toEqual([])
    expect(parseDragIds('"just-a-string"')).toEqual([])
  })

  it('不以 [ 或 { 开头的普通字符串按旧格式的裸 id 处理', () => {
    // 这是兼容分支存在的意义：UUID 解析不了 JSON，但它是合法的旧载荷
    expect(parseDragIds('3f2a91b7-04c8-4d1e-9a2b-6c7d8e9f0a11')).toEqual([
      '3f2a91b7-04c8-4d1e-9a2b-6c7d8e9f0a11',
    ])
  })

  it('数组里混入非字符串元素时只保留字符串', () => {
    expect(parseDragIds('["a",1,null,"b",{"x":1}]')).toEqual(['a', 'b'])
  })
})

describe('拖拽目标过滤 · 防止目录树成环', () => {
  it('拖到根目录（destId 为 null）时一个都不拦', () => {
    expect(filterMovable(NODES, ['A', 'B', 'd'], null)).toEqual(['A', 'B', 'd'])
  })

  it('拖进自己 → 被拦下', () => {
    // 把 A 拖到 A 上
    expect(filterMovable(NODES, ['A'], 'A')).toEqual([])
  })

  it('拖进自己的子孙目录 → 被拦下（否则子树会从树上脱落）', () => {
    // A 是 C 的祖先：把 A 移进 C，A 就成了自己的后代
    expect(filterMovable(NODES, ['A'], 'C')).toEqual([])
    // B 也是 C 的祖先
    expect(filterMovable(NODES, ['B'], 'C')).toEqual([])
  })

  it('拖进自己的直接子目录 → 被拦下', () => {
    expect(filterMovable(NODES, ['A'], 'B')).toEqual([])
  })

  it('平级/跨分支移动 → 放行', () => {
    // C 移到根目录
    expect(filterMovable(NODES, ['C'], null)).toEqual(['C'])
    // 文件 f 移进 A
    expect(filterMovable(NODES, ['f'], 'A')).toEqual(['f'])
    // C 上移到 A（A 不在 C 的子树里）
    expect(filterMovable(NODES, ['C'], 'A')).toEqual(['C'])
  })

  it('多选里混了非法项时，只剔除非法的那些 —— 不能让整批失败', () => {
    // 选中 A（文件夹）、e、f，拖到 A 上：
    // A 不能移进自己，但 e/f 应该照常移动
    expect(filterMovable(NODES, ['A', 'e', 'f'], 'A')).toEqual(['e', 'f'])
  })

  it('多选里包含目标目录本身时，目标被剔除、其余放行', () => {
    // 选中 B、C、f，拖到 C 上：B 是 C 的祖先要剔除，C 是目标本身要剔除，f 放行
    expect(filterMovable(NODES, ['B', 'C', 'f'], 'C')).toEqual(['f'])
  })

  it('空输入得到空输出', () => {
    expect(filterMovable(NODES, [], 'A')).toEqual([])
  })

  it('未知 id 不被拦（组件拿不到的信息，交给主进程报错）', () => {
    expect(filterMovable(NODES, ['ghost'], 'A')).toEqual(['ghost'])
  })

  it('保持原有顺序，不重排', () => {
    expect(filterMovable(NODES, ['f', 'e', 'd'], 'A')).toEqual(['f', 'e', 'd'])
  })
})
