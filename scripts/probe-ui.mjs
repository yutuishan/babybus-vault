/**
 * 主界面 UI 探针 launcher（文件树图标、按钮文案、重命名聚焦、展开/折叠）。
 *
 * 所有坑都写在 `probe-runner.mjs` 里，这里只声明开关和输出文件。
 * 跑法：`npm run probe:ui`（会把构建串进来）。
 *
 * 如果沙箱拦 Electron，改成：
 *   HOME=/c/tmp/probehome USERPROFILE='C:\tmp\probehome' \
 *   APPDATA='C:\tmp\probehome\AppData\Roaming' LOCALAPPDATA='C:\tmp\probehome\AppData\Local' \
 *   node scripts/probe-ui.mjs
 */
import { runProbe } from './probe-runner.mjs'

runProbe({ flag: '--probe-ui', outFile: 'probe-ui-out.json' })
