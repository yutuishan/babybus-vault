/**
 * IPC 边界回归测试。
 *
 * 背景：渲染进程里凡是 Vue 的 reactive / ref 值都是 Proxy，直接丢给
 * ipcRenderer.invoke 会抛 "An object could not be cloned."，而这个异常发生在
 * 桥接层、UI 上只表现为"点了按钮没反应"（删除功能就是这么失效的）。
 *
 * ⚠️ 本文件**必须 import 真正的 toPlain**，不要自己再抄一份实现。
 * 这里以前就是抄的：抄件和真货各改各的，preload 里的真实现被改坏了，
 * 这个测试照样是绿的 —— 等于没测。为此实现被挪到了 `src/shared/plain.ts`
 * （刻意保持零依赖，单测能直接加载）。
 */
import { describe, expect, it } from 'vitest'
import { toPlain } from '../src/shared/plain'

/** 用 Proxy 模拟 Vue 的响应式数组：读任意属性都走 get 陷阱 */
function reactiveArray<T>(items: T[]): T[] {
  return new Proxy(items, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** 模拟 Vue 的 reactive(普通对象) —— 注意它的原型仍是 Object.prototype */
function reactiveObject<T extends object>(obj: T): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

/** 结构化克隆的等价校验：Proxy 不是可克隆类型，普通值才是 */
function isStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value)
    return true
  } catch {
    return false
  }
}

describe('IPC 边界 · 结构化克隆', () => {
  it('Proxy 数组不可直接结构化克隆（这正是 bug 的成因）', () => {
    const proxied = reactiveArray(['a', 'b'])
    expect(isStructuredCloneable(proxied)).toBe(false)
  })

  it('toPlain 之后可以安全过桥', () => {
    const proxied = reactiveArray(['a', 'b'])
    expect(isStructuredCloneable(toPlain(proxied))).toBe(true)
  })

  it('Set 会被转成数组（删除/导出都传的是 Set 来源的 id 集合）', () => {
    const ids = new Set(['id-1', 'id-2'])
    const plain = toPlain(ids)
    expect(Array.isArray(plain)).toBe(true)
    expect(plain).toEqual(['id-1', 'id-2'])
  })

  it('嵌套的 Proxy 对象也会被逐层还原', () => {
    const patch = reactiveArray([
      { id: 'n1', meta: reactiveArray([{ k: 'v' }]) },
    ] as never)
    const plain = toPlain(patch)
    expect(isStructuredCloneable(plain)).toBe(true)
    expect(JSON.parse(JSON.stringify(plain))).toEqual([{ id: 'n1', meta: [{ k: 'v' }] }])
  })

  it('reactive 的普通对象仍会被深拷贝（不能因为它是 Proxy 就当成"非普通对象"跳过）', () => {
    const o = reactiveObject({ a: 1, nested: { b: 2 } })
    const plain = toPlain(o)
    expect(plain).toEqual({ a: 1, nested: { b: 2 } })
    // 必须是拷贝，不是原对象 —— 否则 Proxy 会原样过桥，照样抛克隆异常
    expect(plain).not.toBe(o)
    expect(isStructuredCloneable(plain)).toBe(true)
  })

  it('Uint8Array 与 ArrayBuffer 原样透传，不做逐元素拷贝', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const buf = bytes.buffer
    expect(toPlain(bytes)).toBe(bytes)
    expect(toPlain(buf)).toBe(buf)
  })

  it('空数组与基本类型不受影响', () => {
    expect(toPlain([])).toEqual([])
    expect(toPlain('x')).toBe('x')
    expect(toPlain(0)).toBe(0)
    expect(toPlain(null)).toBe(null)
  })
})

/**
 * 这一组盯的是"实例被拍扁成 {}"这个静默数据丢失。
 * 根因：File / Date / Map / Blob 的**自有可枚举属性是空的**，
 * 一旦走 Object.entries 就会得到 `{}` —— 不报错，但数据没了。
 * 拖拽导入（resolveDropPaths 的 File）就是靠这条性质才不能过 toPlain。
 */
describe('IPC 边界 · 实例不能被拍扁成 {}', () => {
  it.runIf(typeof File !== 'undefined')('File 的自有可枚举属性确实是空的 —— 这就是根因', () => {
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' })
    expect(Object.keys(file)).toEqual([])
  })

  it.runIf(typeof File !== 'undefined')('File 原样透传（拖拽路径依赖它保住身份）', () => {
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' })
    expect(toPlain(file)).toBe(file)
    expect(toPlain([file])[0]).toBe(file)
  })

  it('Date 原样透传，时间信息不丢', () => {
    const d = new Date(0)
    expect(toPlain(d)).toBe(d)
    expect(toPlain(d).getTime()).toBe(0)
  })

  it('Map 原样透传，键值不丢', () => {
    const m = new Map([['a', 1]])
    expect(toPlain(m)).toBe(m)
    expect(toPlain(m).get('a')).toBe(1)
  })

  it.runIf(typeof Blob !== 'undefined')('Blob 原样透传，字节数不丢', () => {
    const b = new Blob(['abcd'])
    expect(toPlain(b)).toBe(b)
    expect(toPlain(b).size).toBe(4)
  })

  it('普通对象仍然照常深拷贝（别为了透传实例把普通对象也放过去了）', () => {
    const src = { a: 1, b: { c: 2 } }
    const out = toPlain(src)
    expect(out).toEqual(src)
    expect(out).not.toBe(src)
    expect(out.b).not.toBe(src.b)
  })
})
