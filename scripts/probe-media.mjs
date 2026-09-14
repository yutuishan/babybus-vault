/**
 * `vault://` 流式协议的端到端探针 launcher。
 *
 * 所有坑都写在 `probe-runner.mjs` 里，这里只声明开关和输出文件。
 * 跑法：`npm run probe:media`（会把构建串进来）。
 *
 * 如果沙箱拦 Electron，改成：
 *   HOME=/c/tmp/probehome USERPROFILE='C:\tmp\probehome' \
 *   APPDATA='C:\tmp\probehome\AppData\Roaming' LOCALAPPDATA='C:\tmp\probehome\AppData\Local' \
 *   node scripts/probe-media.mjs
 */
import { runProbe } from './probe-runner.mjs'

runProbe({ flag: '--probe-media', outFile: 'probe-media-out.json' })
