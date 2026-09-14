# 宝宝巴士 · 本地离线加密文档保险箱

一个**纯本地、离线、无服务端**的加密文件库桌面应用。把文件放进保险箱后，磁盘上只有密文；
所有解密都在内存里完成，明文不落盘。适合存放证件、合同、财务资料这类敏感文档。

技术栈：Electron + Vue 3 + TypeScript + Vite，不依赖任何云端服务，运行时也不联网。

---

## 功能

**加密存储**
- AES-256-GCM 信封加密，**每个文件一份独立的 DEK**，单个文件泄露不牵连其他文件
- 主密钥由 Argon2id 从主密码派生（OWASP 推荐参数：64 MiB / 3 轮 / 并行度 1），并提供 scrypt 回退
- 主密钥经 HKDF-SHA256 派生用途独立的子密钥，**绝不直接用于加密数据**
- 目录树（manifest）整体加密落盘，原子写入（临时文件 + fsync + `.bak` + rename）
- 每个 blob 记录内容摘要，读取时二次校验，防止密文被整体替换

**预览**（全部在内存中解密，渲染完即弃）
- PDF：pdf.js，连续滚动、页码跟随、缩放/旋转/适应宽度与高度
- Word（docx）：mammoth 转 HTML；旧版 doc 由主进程提取纯文本
- Excel（xlsx / xls）：SheetJS 解析，多工作表切换
- PPT（pptx）：本地渲染
- 文本 / Markdown（渲染前经 DOMPurify 消毒）、图片
- **音频 / 视频：走自定义 `vault://` 协议按 Range 分片解密**，边解密边播放，可拖动进度条，
  内存占用与文件大小无关（1GB 视频也不会 OOM）

**文件管理**
- 目录树、多选、右键菜单、全部展开 / 折叠
- 导入文件与文件夹（**保留原目录层级**），工具栏导入默认落根目录
- 重名冲突先预扫描再让用户决定：覆盖 / 改名共存（默认不丢数据）
- 批量导出、拖拽导入
- 按文件名检索 + 全文检索（文本类文件）
- 主密码提示语（**明文保存**，用于锁屏时显示，界面上有明确说明）

**安全与体验**
- 自动上锁：空闲、系统休眠、系统锁屏触发；**没有「从不」档**，三层保证（UI / 配置归一化 / 上锁逻辑）
- 修改主密码会重新包裹所有 DEK，不重写文件密文
- 亮色 / 暗色主题、界面字号缩放、新手图文引导
- 渲染进程 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 双份 CSP（HTML `<meta>` + 主进程响应头），由测试逐条比对防止漂移

---

## 加密设计

磁盘上的文件库长这样：

```
我的文件库/
├── vault.meta          # 明文 JSON：KDF 名称与参数、salt、校验块、密码提示语
├── manifest.enc        # 加密的目录树（AES-256-GCM，AAD = "manifest-v2"）
├── manifest.enc.bak    # 上一版备份
└── blobs/
    ├── 3f2a…c8.enc     # 每个文件一份密文
    └── 91b7…04.enc
```

单个 blob 的布局（密文从偏移 **126** 开始）：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 38 | 明文头：`ENC1` 魔数 / 版本 / flags / chunkSize / chunkCount / blobId / plainSize |
| 38 | 60 | 被包裹的 DEK（12 字节 nonce + 16 字节 tag + 32 字节密钥） |
| 98 | 12 | 内容 nonce |
| 110 | 16 | 内容 tag |
| 126 | — | 密文本体（GCM 是流模式，密文长度 == 明文长度） |

被包裹的 DEK 与内容密文的 **AAD 都是那 38 字节明文头**，因此头部被篡改会直接导致解密失败。

**关于「加密方式不保密」**：算法、参数、文件格式全部可读，这是有意的 ——
安全性建立在密钥保密上（Kerckhoffs 原则），而不是算法保密。
真正拦住攻击者的是 Argon2id 的计算成本 + 主密码的熵。
详细的攻击面分析见 [`docs/encryption-assessment.md`](docs/encryption-assessment.md)。

> ⚠️ **主密码一旦忘记，数据无法恢复。** 没有后门、没有恢复码、没有云端备份。

### 为什么音视频不走 IPC

早期实现是把整个文件解密后通过 IPC 传给渲染进程。1GB 的视频会直接让主进程 OOM，
而且 Blob URL 无法拖动进度条。现在音视频走自定义协议 `vault://media/<节点id>`，
`<video>` / `<audio>` 直接把它当 `src`，Chromium 按需发 Range 请求，主进程只解密被请求的那一段。

这里有个关键约束：**GCM 计数器无法跳到任意偏移**，所以取中间一段也必须从 0 开始顺序解密，
把 `start` 之前的部分解出来再丢掉。内存占用只与 256 KB 的分块有关，与文件大小无关。

---

## 支持的格式

| 类型 | 格式 | 说明 |
| --- | --- | --- |
| 文档 | `pdf` | pdf.js 渲染 |
| | `docx` | 转 HTML 预览 |
| | `doc` | 旧版二进制格式，仅提取文字（无排版与图片） |
| 表格 | `xlsx` `xls` | 多工作表 |
| 演示 | `pptx` | 本地渲染 |
| 文本 | `txt` `md` `json` `xml` `yml` `log` `csv` … | Markdown 渲染前消毒 |
| 图片 | `png` `jpg` `gif` `webp` `svg` `bmp` … | |
| 音频 | `mp3` `wav` `flac` `aac` `ogg` `m4a` … | `vault://` 流式播放 |
| 视频 | `mp4` `webm` `mov` `mkv` `avi` … | `vault://` 流式播放 |

未支持预览：`ppt` `odt` `ods` `odp`。扩展名判断不了编码（比如 mkv 里装 H.265），
这类文件会由播放器的 `error` 事件兜底提示「导出后用本地播放器打开」。

---

## 开发

**环境要求**：Node.js >= 24.7.0

```bash
npm install

npm run dev          # 开发模式（会先准备 pdf.js 资源）
npm run build        # 构建到 dist/
npm start            # 用已构建的 dist/ 启动
npm test             # 单元测试
npm run typecheck    # 类型检查
```

### 打包

```bash
npm run package:win  # Windows 绿色版（解压即用）
npm run package:mac  # macOS .app.zip，arm64 + x64
npm run icon         # 重新生成 build/icon.ico 与 build/icon.icns
npm run verify:mac   # 校验 macOS 产物（符号链接、Mach-O 架构、Info.plist、asar 树）
npm run smoke:win    # Windows 产物冒烟测试
```

产物输出到 `release/`。**macOS 产物未签名**，首次打开需「右键 → 打开」，
或执行 `xattr -dr com.apple.quarantine <App路径>`。

> 打包是手写脚本，没有使用 electron-builder 的打包流程 —— 详见
> [`docs/开发文档.md`](docs/开发文档.md) 中关于跨平台符号链接与权限位处理的部分。

### 维护脚本

```bash
npm run prune:dist        # 预演：列出 dist/ 里的陈旧产物（不动文件）
npm run prune:dist:apply  # 实际清理
```

`vite.renderer.config.ts` 设了 `emptyOutDir: false`，所以 `dist/renderer/assets`
会不断累积历史产物。清理脚本用**不动点扫描**（传递闭包）判断哪些资源仍被引用，
能正确保住 `pdf.worker.min-<hash>.mjs`、`pptx-preview.es-<hash>.js` 这类
**只在 bundle 内部按裸文件名引用、不出现在 index.html 里**的资源。

### 端到端探针

```bash
npm run probe:media   # 无头启动 Electron，验证 vault:// 分片解密与播放器 seek
npm run probe:ui      # 无头驱动界面，验证渲染与交互
```

---

## 目录结构

```
src/
├── main/                     # 主进程
│   ├── crypto/               # KDF、密钥派生、信封加密、blob、manifest、密码策略
│   ├── vault/                # 文件库、会话、vault.meta、vault:// 流式协议
│   ├── ipc/                  # IPC 处理器、导入计划（与 IPC 解耦，可单测）
│   ├── autoLock.ts           # 自动上锁
│   ├── config.ts             # 应用配置与归一化
│   └── *Probe.ts             # 端到端探针（媒体 / 界面 / KDF）
├── preload/                  # contextBridge 桥接层
├── renderer/                 # 渲染进程（Vue 3）
│   ├── components/           # 界面组件与各类预览器
│   ├── composables/          # 状态与提示
│   └── utils/                # 格式判定、图标、目录树、表格
└── shared/                   # 主/渲染共用：IPC 契约、媒体格式表、序列化工具

tests/                        # vitest（12 个文件 / 161 项）
docs/                         # 开发文档、加密强度评估、评审意见
scripts/                      # 构建、打包、校验、探针脚本
```

---

## 测试

```bash
npm test
```

覆盖加密核心（KDF、blob、manifest、vault）、IPC 边界序列化、CSP 双份一致性、
媒体格式判定与分片流、导入计划、工作表解析、图标与格式归一化。

其中 `tests/csp-sync.spec.ts` 会逐条比对 HTML `<meta>` 与主进程响应头两份 CSP ——
**改动任意一份而忘了另一份，这个测试会红**。两份 CSP 浏览器都会执行，任一份不通过就拒绝加载。

---

## 许可证

当前为 `UNLICENSED`（保留所有权利），尚未选定开源许可证。
如需在他人项目中使用，请先联系作者。
