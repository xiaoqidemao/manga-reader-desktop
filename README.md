# 漫画阅读器 · Windows 桌面版

一个只在本地运行的漫画阅读器。**不联网、不登录、不上传任何东西。**

最初来自一个网页版阅读器（`https://manga-reader-38605.app.workbuddy.host/`），
改造成桌面程序后有两个根本变化：

1. **不复制漫画**：直接读取你指定的漫画文件夹，只读不写。
   网页版是把漫画复制进浏览器数据库，桌面版不再需要那个「柜子」。
2. **新增「长卷」阅读模式**：所有页水平排成一条带子，零间隙，
   第一张在最左，滚轮控制左右移动，点画面中间浮现缩略图带。

---

## 快速开始

```bash
npm install          # 安装依赖
npm start            # 正式模式运行
npm run dev          # 开发模式（数据目录带 -dev 后缀）
```

打包（不需要联网，用本地 Electron 运行时手工组装）：

```bash
node tools/build-portable.js    # 生成 dist/win-unpacked/
node tools/make-zip.js          # 压成便携版 zip
```

> 注意：`electron-builder` 需要从 GitHub 下载 winCodeSign / nsis，
> 网络不通时会超时。所以打包改成了手工组装。

---

## 项目结构

```
main.js              主进程：窗口、文件夹扫描、IPC、请求拦截、CSP
preload.js           渲染进程白名单桥（contextBridge）
site/                前端页面（原网页改造而来）
  index.html
  css/style.css
  js/app.js          入口：读设置 → 扫描 → 渲染书架
  js/db.js           数据层：用 IPC 读磁盘（替换原 IndexedDB）
  js/library.js      书架页：扫描结果、封面懒加载、排序
  js/reader.js       阅读器核心：单页/跨页/条漫/长卷
  js/ui.js           toast / 抽屉 / 对话框
  js/theme-boot.js   首屏主题（从内联脚本抽出以配合 CSP）
  js/zip.js          ZIP/CBZ 解包（零依赖）
  js/pdf.js          PDF → 逐页图片
  vendor/            pdf.js 引擎
build/icon.ico       打包用图标（由 tools/make-icon.js 生成）
installer/           安装脚本与使用说明（会复制进打包产物）
tools/               构建与验证脚本
```

---

## 核心设计

### 书的识别规则

一个「只有图片、没有子文件夹」的目录 = 一本。

- 层级不限，一路往下钻到图片目录为止
- 有子目录的目录不单独成书
- 分卷各算一本（「作品/卷一」「作品/卷二」= 两本）
- 根目录下散落的 `.zip` / `.cbz` / `.pdf` 也算书
- 书的 `id` 是**完整绝对路径**，所以同名作品不会串

### 性能取舍

| 环节 | 做法 | 原因 |
|---|---|---|
| 扫描 | 只读目录结构，**不 stat 每张图**；子目录并行（并发 24） | 24 万张图逐个 stat 要 20+ 秒 |
| 封面 | 滚动到才加载；主进程缩到 360px，渲染进程再用 canvas 缩到 200px | 原图常有 1~2MB，几千本会爆内存 |
| 长卷 | 全部插占位格子（用图片头尺寸算宽度），图片按需加载；超 400 页分批插入 | 3841 页的书也能 3 秒建好 |
| 读页 | LRU 缓存 24 页 + 并发去重 | 来回滚动不重复读盘 |
| 超大图 | 超 4MB 降到 1600px 宽再显示 | 压缩包里常有几十 MB 的无压缩 PNG |

### 长卷模式的排版

两处 `gap: 0` 是命门：flex 容器不能有 gap，每个格子也不能有 padding/border。
图片统一按舞台高度等比缩放（`object-fit: contain`），保证上下齐平成一条带子。

### 离线保证（三道）

1. **静态**：`site/` 下所有源码零外部链接（`tools/verify-offline.js` 可扫描）
2. **主进程**：`webRequest.onBeforeRequest` 只放行 `file:` / `data:` / `blob:`
3. **CSP**：`script-src 'self' file:`，禁止一切内联脚本与外链资源

---

## 数据存放

| 内容 | 位置 |
|---|---|
| 阅读进度与设置 | `%APPDATA%\漫画阅读器\progress.json` |
| 开发模式的数据 | `%APPDATA%\漫画阅读器-dev\`（避免与正式版抢锁） |
| 漫画本身 | 你自己指定的文件夹，**不会被改动** |

`progress.json` 是普通文本，可拷走备份。卸载程序不会删它。

### 多实例冲突

开发版与正式版若共用同一个 `userData` 目录，会互相锁住缓存，
表现为「窗口起不来 / 缓存无法创建」。所以开发模式（`--dev`）
默认使用带 `-dev` 后缀的独立目录。

---

## 验证脚本

```bash
node tools/cdp.js js "表达式"      # 在运行中的程序里执行 JS
node tools/cdp.js shot 路径.png    # 截图
node tools/verify-offline.js       # 离线能力验证
```

程序需要带调试端口启动：

```bat
漫画阅读器.exe --remote-debugging-port=9222
```

---

## 已知问题

- **安装包不是标准 NSIS**：网络不通导致 electron-builder 无法下载组件，
  改用 `installer/安装.ps1`（PowerShell）完成复制、建快捷方式、登记卸载项。
  功能等价，但不是向导式安装程序。
- **PDF / 压缩包首次打开较慢**：要先把整本书解析进内存，之后有缓存。
  扫描阶段只能显示「待统计」，打开后才知道页数。
- **PDF 的页面尺寸拿不到**：pdf.js 渲染前不知道原始宽高，
  长卷模式里 PDF 页会按默认比例占位，加载完自动修正。
- **封面偶有留白**：某本书的第一张图读不出来时显示灰色书本图标。

---

## 后续可做

- 长卷滚轮速度做成可调设置（目前按屏宽 8%）
- 书架按目录分组显示
- 手机版（Capacitor 打包，需先配好 Java + Android SDK）
