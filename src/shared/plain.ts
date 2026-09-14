/**
 * 过 contextBridge 之前的参数净化。
 *
 * 为什么需要它：渲染进程里任何响应式值（Vue 的 reactive / ref）都是 Proxy，
 * 直接丢给 ipcRenderer.invoke 会抛 "An object could not be cloned."。
 * 这个异常发生在桥接层，UI 上只表现为"点了按钮没反应"，排查成本极高
 * （删除功能就是这么失效过一次）。
 *
 * 放在 shared 而不是 preload 里，是为了**让单测能直接 import 到真货**。
 * 以前 tests/ipc-boundary.spec.ts 里把这份实现**抄了一遍**再测 ——
 * 那种测试测的是抄件，真实现被改坏了它也照样绿。
 *
 * 本文件必须保持**零依赖**（不引 electron、不引 node 内建），否则单测加载不了。
 */

/** 只有"普通对象"才值得逐键深拷贝 —— 见 toPlain 里的说明 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 把参数还原成可结构化克隆的普通值。
 *
 * 规则：
 *   - Set        → 数组（删除/导出传的都是 id 集合）
 *   - 数组        → 逐元素递归
 *   - 二进制      → 原样透传，**不要**逐元素拷贝（大文件会炸内存）
 *   - 普通对象    → 逐键递归（Vue 的 reactive 普通对象也走这条）
 *   - 其它实例    → **原样透传**，绝不能走 Object.entries
 *
 * 最后一条是踩过的坑：`File` / `Date` / `Map` / `Blob` 这些实例的
 * **自有可枚举属性是空的**，`Object.entries()` 拿到 `[]`，
 * 于是会被静默拍扁成一个 `{}` —— 数据凭空消失，且不报错。
 * 实测：toPlain(new File([], 'a.txt')) === {}，连 instanceof 都没了。
 *
 * 特别地：拖拽进来的 `File` 对象**绝不能**过 toPlain。
 * 它要靠 webUtils.getPathForFile() 取真实路径，拍成 {} 之后拖拽导入直接失效。
 * 所以 preload 里的 resolveDropPaths 是刻意不调 toPlain 的，别去"统一"它。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Set) return Array.from(value, (v) => toPlain(v)) as unknown as T
  if (Array.isArray(value)) return value.map((v) => toPlain(v)) as unknown as T
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = toPlain(v)
  }
  return out as T
}
