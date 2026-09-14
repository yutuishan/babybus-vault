/**
 * word-extractor 未自带 TypeScript 类型，按 lib/document.js 的实际 API 手写 shim。
 * 仅声明本项目用到的部分。
 */
declare module 'word-extractor' {
  export interface ExtractedDocument {
    getBody(options?: unknown): string
    getFootnotes(options?: unknown): string
    getEndnotes(options?: unknown): string
    getHeaders(options?: unknown): string
    getFooters(options?: unknown): string
    getAnnotations(options?: unknown): string
    getTextboxes(options?: unknown): string
  }

  export default class WordExtractor {
    /** source 为文件路径或文件内容 Buffer（本项目只用 Buffer，明文不落盘） */
    extract(source: string | Buffer): Promise<ExtractedDocument>
  }
}
