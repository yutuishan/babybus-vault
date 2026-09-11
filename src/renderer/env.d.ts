/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/** mammoth 浏览器构建没带类型声明，这里只声明用到的最小面 */
declare module 'mammoth/mammoth.browser' {
  export interface MammothResult {
    value: string
    messages: { type: string; message: string }[]
  }
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: Record<string, unknown>,
  ): Promise<MammothResult>
  const mammoth: { convertToHtml: typeof convertToHtml }
  export default mammoth
}
