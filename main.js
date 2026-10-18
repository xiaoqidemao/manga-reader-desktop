/* ============================================================
   main.js · Electron 主进程
   ------------------------------------------------------------
   职责：
     1. 创建窗口，加载本地 site/index.html（纯 file://，无任何网络）
     2. 扫描用户指定的漫画根目录，只读，不修改任何文件
     3. 通过 IPC 把书籍元数据和单页图片交给渲染进程
     4. 读写 progress.json（阅读进度与设置）

   安全设定：
     - contextIsolation: true，nodeIntegration: false
     - 仅暴露 preload 白名单接口
     - 阻断一切网络请求（只允许 file: / data: / blob:）
     - CSP 禁止内联脚本与外部资源
   ============================================================ */

const {
  app, BrowserWindow, ipcMain, dialog, shell, session, screen, nativeImage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const IS_DEV = process.argv.includes('--dev');

/* ------------------------------------------------------------
   数据目录
   ------------------------------------------------------------
   开发时用带 -dev 后缀的目录，避免和已安装版本抢同一份配置
   （两边同时打开会互相锁住缓存，表现为窗口起不来）。
   正式运行时统一用「漫画阅读器」这个目录，进度与设置都在里面。
   ------------------------------------------------------------ */
const userDataArg = process.argv.find((a) => a.startsWith('--mr-user-data='));

if (userDataArg) {
  app.setPath('userData', path.resolve(userDataArg.slice('--mr-user-data='.length)));
} else if (IS_DEV) {
  app.setPath('userData', path.join(app.getPath('appData'), '漫画阅读器-dev'));
}

/* ------------------------------------------------------------
   支持的文件类型
   ------------------------------------------------------------ */
const IMG_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp', '.avif']);
const ARCHIVE_EXT = new Set(['.zip', '.cbz']);
const PDF_EXT = new Set(['.pdf']);

/* ------------------------------------------------------------
   读图片头部拿尺寸，不解码整张图
   （长卷/条漫要先知道宽高才能排版）
   ------------------------------------------------------------ */
function imageSize(buf) {
  try {
    // PNG
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // WEBP
    if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') {
        return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      }
    }
    // JPEG：扫描 SOF 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf
          && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
      }
    }
  } catch (e) { /* 解析失败就当未知尺寸 */ }
  return { w: 0, h: 0 };
}

async function readHead(fp, n = 65536) {
  const fh = await fsp.open(fp, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/* ------------------------------------------------------------
   配置：progress.json
   ------------------------------------------------------------ */
function dataDir() {
  return app.getPath('userData');
}

function settingsPath() {
  return path.join(dataDir(), 'progress.json');
}

const DEFAULT_SETTINGS = {
  rootDir: '',
  sort: 'lastRead',
  theme: 'dark',
  wheelStep: 0.08,         // 长卷模式：滚轮一格 = 屏宽百分比
  thumbsEnabled: true,     // 缩略图带开关
  progress: {},            // id -> {mode,page,unit,scroll,lastReadAt}
  renamed: {},             // id -> 自定义书名
};

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

let saveTimer = null;
function writeSettings(obj) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = settingsPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, settingsPath());
    } catch (e) {
      console.error('[settings] 写入失败', e);
    }
  }, 400);
}

/* ------------------------------------------------------------
   目录扫描
   ------------------------------------------------------------
   规则（与用户确认过）：
     - 「只有图片、没有子文件夹」的目录 = 一本
     - 层级不限，一路往下钻
     - 有子目录的目录不单独成书
     - 分卷各算一本
     - 根目录下散落的 zip / cbz / pdf 也算一本
   书的 id = 完整绝对路径，保证同名作品不冲突
   ------------------------------------------------------------ */

const SKIP_DIR = new Set([
  '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git',
  '__MACOSX', 'Thumbs.db',
]);

/** 扫描时的目录并发数。太高会撑爆文件句柄，太低又慢。 */
const SCAN_CONCURRENCY = 24;

function naturalCompare(a, b) {
  return new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' }).compare(a, b);
}

async function scanRoot(root) {
  const books = [];

  async function walk(dir, depth) {
    if (depth > 24) return;                    // 防病态深目录

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;                                   // 无权限的目录安静跳过
    }

    const subdirs = [];
    const images = [];
    const files = [];

    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.')) continue;
      if (SKIP_DIR.has(name)) continue;

      const full = path.join(dir, name);

      let isDir = ent.isDirectory();
      let isFile = ent.isFile();

      // 处理符号链接/快捷方式：只认目录软链，避免环路
      if (ent.isSymbolicLink()) {
        try {
          const st = await fsp.stat(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch (e) { continue; }
      }

      if (isDir) { subdirs.push({ name, full }); continue; }
      if (!isFile) continue;

      const ext = path.extname(name).toLowerCase();
      if (IMG_EXT.has(ext)) images.push({ name, full, ext });
      else if (ARCHIVE_EXT.has(ext) || PDF_EXT.has(ext)) files.push({ name, full, ext });
    }

    // 本目录只有图片、没有子目录 → 成书
    if (subdirs.length === 0 && images.length > 0) {
      images.sort((a, b) => naturalCompare(a.name, b.name));
      books.push(await makeFolderBook(dir, images));
    }

    // 散落的压缩包 / PDF → 各自成书
    for (const f of files) {
      let st;
      try { st = await fsp.stat(f.full); } catch (e) { continue; }
      books.push({
        id: f.full,
        title: path.basename(f.name, f.ext),
        dir: f.full,
        kind: PDF_EXT.has(f.ext) ? 'pdf' : 'archive',
        name: f.name,
        pageCount: 0,                // 惰性：打开时才解析
        bytes: st.size,
        cover: null,
        mtime: st.mtimeMs,
      });
    }

    // 继续下钻：并行处理子目录。
    // 串行 await 2928 个目录会累积成 10 秒，并行后约 4 秒。
    await runPool(subdirs, SCAN_CONCURRENCY, (d) => walk(d.full, depth + 1));
  }

  await walk(root, 0);
  books.sort((a, b) => naturalCompare(a.id, b.id));
  return books;
}

/** 带并发上限的并行执行器（不用 Promise.all 直接铺开，避免句柄耗尽） */
async function runPool(items, limit, fn) {
  if (!items.length) return;
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        await fn(items[cur]);
      } catch (e) {
        // 单个目录出错不影响整体扫描
      }
    }
  }

  const n = Math.min(limit, items.length);
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
}

/**
 * 给一本书取显示名。
 * 「卷一」「卷二」「Vol.1」这类重名太多，补上上级作品名。
 */
const VOLUME_LIKE = /^(卷\s*[0-9一二三四五六七八九十]+|vol\.?\s*\d+|ch(apter)?\s*\d+|[0-9]+)$/i;

function titleFor(dirPath) {
  const base = path.basename(dirPath) || dirPath;
  const parent = path.basename(path.dirname(dirPath)) || '';

  let name = base;

  if (VOLUME_LIKE.test(base.trim()) && parent && parent !== base) {
    name = `${parent} · ${base}`;
  } else if (/^(第?\s*[0-9一二三四五六七八九十百]+\s*[卷章话回集部册])$/i.test(base)) {
    name = parent && parent !== base ? `${parent} · ${base}` : base;
  }

  return name;
}

/**
 * 建一本「文件夹书」。
 *
 * 故意不 stat 每一张图：24 万张图逐个 stat 要 20 多秒，
 * 而文件大小对阅读毫无用处。书架首屏永远秒开。
 */
async function makeFolderBook(dir, images) {
  let mtime = 0;
  try {
    const st = await fsp.stat(dir);
    mtime = st.mtimeMs;
  } catch (e) { /* 忽略 */ }

  return {
    id: dir,
    title: titleFor(dir),
    dir,
    kind: 'folder',
    name: path.basename(dir),
    pageCount: images.length,
    bytes: 0,                 // 惰性：真正需要时再算
    cover: images[0] ? images[0].full : null,
    mtime,
  };
}

/* ------------------------------------------------------------
   IPC
   ------------------------------------------------------------ */

let win = null;

function setupIPC() {
  /* --- 设置 --- */
  ipcMain.handle('settings:get', () => readSettings());

  ipcMain.handle('settings:set', (e, patch) => {
    const cur = readSettings();
    const next = Object.assign({}, cur, patch);
    writeSettings(next);
    return next;
  });

  /* --- 选择漫画根目录 --- */
  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择漫画文件夹',
      properties: ['openDirectory'],
      buttonLabel: '就用这个文件夹',
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  /* --- 扫描 --- */
  ipcMain.handle('library:scan', async (e, root) => {
    if (!root || !fs.existsSync(root)) {
      return { ok: false, error: '文件夹不存在或无法访问', books: [] };
    }
    const t0 = Date.now();
    try {
      const books = await scanRoot(root);
      const settings = readSettings();

      const out = books.map((b) => ({
        id: b.id,
        title: settings.renamed[b.id] || b.title,
        kind: b.kind,
        pageCount: b.pageCount,
        bytes: b.bytes,
        hasCover: !!b.cover,
        path: b.dir,
        mtime: b.mtime,
        progress: settings.progress[b.id] || null,
        lastReadAt: (settings.progress[b.id] && settings.progress[b.id].lastReadAt) || 0,
      }));

      return { ok: true, books: out, ms: Date.now() - t0, total: out.length };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), books: [] };
    }
  });

  /* --- 取一本书的完整页列表 --- */
  ipcMain.handle('book:pages', async (e, id) => {
    try {
      if (!id) return { ok: false, error: '缺少书籍 id' };

      const st = await fsp.stat(id).catch(() => null);
      if (!st) return { ok: false, error: '文件或目录不存在' };

      if (st.isDirectory()) {
        const entries = await fsp.readdir(id, { withFileTypes: true });
        const imgs = entries
          .filter((en) => en.isFile() && IMG_EXT.has(path.extname(en.name).toLowerCase()))
          .map((en) => en.name)
          .sort(naturalCompare);
        const paths = imgs.map((n) => path.join(id, n));
        return { ok: true, kind: 'folder', paths, pageCount: paths.length };
      }

      // 单个压缩包 / PDF：交给渲染进程解析（zip.js / pdf.js）
      return {
        ok: true,
        kind: path.extname(id).toLowerCase() === '.pdf' ? 'pdf' : 'archive',
        file: id,
        paths: [],
        pageCount: 0,
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  /* --- 读单页图片，返回 dataURL（file:// 下 <img> 不能直接读任意本地路径） --- */
  ipcMain.handle('page:read', async (e, filePath) => {
    try {
      const buf = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ({
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
        '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
        '.bmp': 'image/bmp', '.avif': 'image/avif',
      })[ext] || 'application/octet-stream';

      const { w, h } = imageSize(buf);
      return {
        ok: true,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        w, h,
        bytes: buf.length,
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  /* --- 读原始字节（给 PDF / ZIP 解析用） --- */
  ipcMain.handle('file:readBytes', async (e, filePath) => {
    try {
      const buf = await fsp.readFile(filePath);
      // Uint8Array 可直接结构化克隆，比 base64 省 1/3 开销
      return { ok: true, data: new Uint8Array(buf) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  /* --- 只读文件头，取尺寸（给长卷/条漫占位用） --- */
  ipcMain.handle('page:dims', async (e, filePath) => {
    try {
      const head = await readHead(filePath);
      return imageSize(head);
    } catch (err) {
      return { w: 0, h: 0 };
    }
  });

  /* --- 封面：缩成小图再传，避免把 1MB+ 的原图塞进渲染进程 --- */
  ipcMain.handle('cover:get', async (e, id) => {
    try {
      if (!id) return null;

      let coverPath = null;
      const st = await fsp.stat(id).catch(() => null);
      if (!st) return null;

      if (st.isDirectory()) {
        const entries = await fsp.readdir(id, { withFileTypes: true });
        const imgs = entries
          .filter((en) => en.isFile() && IMG_EXT.has(path.extname(en.name).toLowerCase()))
          .map((en) => en.name)
          .sort(naturalCompare);
        if (!imgs.length) return null;
        coverPath = path.join(id, imgs[0]);
      } else {
        // 压缩包/PDF 暂不在此生成封面
        return null;
      }

      // nativeImage 做第一道缩小；渲染进程还会用 canvas 再缩一次。
      // 两道都留着是因为 Windows 上 toDataURL 的 quality 参数
      // 在部分图片格式下会被忽略，单靠一道不可靠。
      const img = nativeImage.createFromPath(coverPath);
      if (img.isEmpty()) return null;

      const size = img.getSize();
      const targetW = 360;
      const scale = size.width > 0 ? Math.min(1, targetW / size.width) : 1;
      const thumb = scale < 1
        ? img.resize({ width: Math.round(size.width * scale), quality: 'good' })
        : img;

      return thumb.toDataURL({ quality: 80 });
    } catch (err) {
      return null;
    }
  });

  /* --- 进度 --- */
  ipcMain.handle('progress:set', (e, id, progress) => {
    const s = readSettings();
    if (!s.progress) s.progress = {};
    s.progress[id] = Object.assign({}, progress, { lastReadAt: Date.now() });
    writeSettings(s);
    return true;
  });

  ipcMain.handle('progress:clear', (e, id) => {
    const s = readSettings();
    if (s.progress) delete s.progress[id];
    writeSettings(s);
    return true;
  });

  /* --- 重命名（只改显示名，不动磁盘文件） --- */
  ipcMain.handle('book:rename', (e, id, name) => {
    const s = readSettings();
    if (!s.renamed) s.renamed = {};
    s.renamed[id] = name;
    writeSettings(s);
    return true;
  });

  /* --- 窗口标题：读书时显示书名 --- */
  ipcMain.handle('window:title', (e, t) => {
    if (win && typeof t === 'string') win.setTitle(t || '漫画阅读器');
    return true;
  });

  /* --- 打开文件所在位置 --- */
  ipcMain.handle('shell:reveal', (e, p) => {
    try { shell.showItemInFolder(p); return true; } catch (err) { return false; }
  });

  /* --- 数据目录（给用户看、备份用） --- */
  ipcMain.handle('app:dataDir', () => dataDir());

  ipcMain.handle('shell:openDataDir', () => {
    try { shell.openPath(dataDir()); return true; } catch (err) { return false; }
  });
}

/* ------------------------------------------------------------
   窗口
   ------------------------------------------------------------ */

function createWindow() {
  // 按屏幕实际大小决定初始窗口，避免小屏/高缩放下窗口超出屏幕
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1280, Math.round(work.width * 0.88));
  const height = Math.min(820, Math.round(work.height * 0.88));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: '#0b0b0d',
    title: '漫画阅读器',
    show: false,
    autoHideMenuBar: true,
    center: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 一切外部导航都拦掉（本地应用，不需要跳出去）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith('file://')) ev.preventDefault();
  });

  // 禁用 F5 / Ctrl+R 刷新，避免阅读中误触；F11 切全屏
  win.webContents.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown') return;
    const k = (input.key || '').toLowerCase();

    if (k === 'f5' || (input.control && k === 'r')) {
      ev.preventDefault();
      return;
    }
    if (k === 'f11') {
      ev.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  win.loadFile(path.join(__dirname, 'site', 'index.html'));
}

/* ------------------------------------------------------------
   CSP：只允许本地文件与本应用自身，禁掉一切远程加载
   ------------------------------------------------------------ */

function installCSP() {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [
          "default-src 'self' file:; "
          + "img-src 'self' file: data: blob:; "
          + "style-src 'self' 'unsafe-inline'; "
          // 不允许任何内联脚本；首屏主题脚本已抽成 js/theme-boot.js
          + "script-src 'self' file:; "
          + "media-src 'self' file: data: blob:; "
          + "font-src 'self' file: data:; "
          + "connect-src 'self' file: data: blob:; "
          + "object-src 'none'; "
          + "base-uri 'none'; "
          + "form-action 'none'",
        ],
      }),
    });
  });
}

/* ------------------------------------------------------------
   启动
   ------------------------------------------------------------ */

app.whenReady().then(() => {
  // 兜底：拒绝一切非本地协议请求（双保险）
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    if (u.startsWith('file://') || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('devtools:')) {
      cb({ cancel: false });
    } else {
      cb({ cancel: true });
    }
  });

  setupIPC();
  installCSP();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// 单实例：避免重复开
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('[main] 未捕获异常', err);
});
