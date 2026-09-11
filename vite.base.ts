import { fileURLToPath } from 'node:url'

/** 三份构建共用的路径别名，避免各处重复写 */
export const aliases = {
  '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
  '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
  '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
}
