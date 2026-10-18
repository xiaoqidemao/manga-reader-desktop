/* ============================================================
   db.js · 桌面版数据层（替换原 IndexedDB）
   ------------------------------------------------------------
   原版把漫画复制进浏览器 IndexedDB。
   桌面版改成：直接读用户指定的漫画文件夹，只读不写。

   对外接口保持与书库/阅读器一致的形状：
     open()                → 读设置
     scan()                → 扫根目录，返回书籍列表
     getAllBooks()         → 返回缓存的书列表
     updateBook()          → 只更新进度/显示名（写 progress.json）
     getPageRecord()       → 返回该页 Blob 与尺寸
     getPageDataUrl()      → 返回 dataURL（长卷用）
     getArchivePageCount() → PDF/zip 的页数（首次会解析）
   ============================================================ */

const host = window.mangaHost;

/* ---------------- 状态 ---------------- */

let settings = null;
let books = [];
let pageCache = new Map();    // bookId -> {kind, paths, file}
let lastScan = { ms: 0, total: 0, error: null };

/* ------------------------------------------------------------
   单页读图缓存（LRU）
   ------------------------------------------------------------
   长卷滚动时会反复进出同一批页，磁盘读 + base64 编码很贵。
   缓存最近 PAGE_CACHE_MAX 页，来回滚动就不用重复读盘。
   ------------------------------------------------------------ */
const PAGE_CACHE_MAX = 24;
const pageDataCache = new Map();   // path -> {ok,dataUrl,w,h,bytes}
const pageInflight = new Map();    // path -> Promise（并发去重）

function touchCache(key, val) {
  pageDataCache.delete(key);
  pageDataCache.set(key, val);
  while (pageDataCache.size > PAGE_CACHE_MAX) {
    pageDataCache.delete(pageDataCache.keys().next().value);
  }
}

function readPageCached(filePath) {
  const hit = pageDataCache.get(filePath);
  if (hit) {
    touchCache(filePath, hit);
    return Promise.resolve(hit);
  }

  const flying = pageInflight.get(filePath);
  if (flying) return flying;

  const p = host.readPage(filePath).then((r) => {
    pageInflight.delete(filePath);
    if (r && r.ok) touchCache(filePath, r);
    return r;
  }).catch((err) => {
    pageInflight.delete(filePath);
    throw err;
  });

  pageInflight.set(filePath, p);
  return p;
}

function clearPageDataCache() {
  pageDataCache.clear();
  pageInflight.clear();
}

/* ------------------------------------------------------------
   超大图降采样
   ------------------------------------------------------------
   压缩包里常混着几十 MB 的原始 PNG，转 base64 后还会再涨 1/3。
   长卷一屏要看几张，直接塞进 DOM 会立刻吃满内存。
   ------------------------------------------------------------ */
const BIG_IMAGE_BYTES = 4 * 1024 * 1024;   // 4MB 以上才处理
const DISPLAY_MAX_W = 1600;                // 显示用的最大宽度

async function shrinkIfHuge(source, bytesHint) {
  if (!(bytesHint && bytesHint > BIG_IMAGE_BYTES)) return null;

  let url = null;
  try {
    url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });

    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (!w || !h) return null;

    const scale = Math.min(1, DISPLAY_MAX_W / w);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);

    return { dataUrl: cv.toDataURL('image/jpeg', 0.85), w: cw, h: ch };
  } catch (e) {
    return null;
  } finally {
    if (url && typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------
   PDF / 压缩包解析器（惰性加载）
   ------------------------------------------------------------
   只有真的点开这类书才去解析。同时只保留最近几本，
   防止大文件吃爆内存。
   ------------------------------------------------------------ */
const ARCHIVE_CACHE_MAX = 3;
const archiveCache = new Map();   // bookId -> {kind, pages, dispose}
const archiveLoading = new Map(); // bookId -> Promise

function touchArchive(key, val) {
  archiveCache.delete(key);
  archiveCache.set(key, val);
  while (archiveCache.size > ARCHIVE_CACHE_MAX) {
    const [oldestKey, oldestVal] = archiveCache.entries().next().value;
    try { if (oldestVal.dispose) oldestVal.dispose(); } catch (e) { /* noop */ }
    archiveCache.delete(oldestKey);
  }
}

/** 把磁盘文件读成 File 对象，给 zip.js / pdf.js 用 */
async function fileOfPath(filePath) {
  const r = await host.readBytes(filePath);
  if (!r || !r.ok) throw new Error((r && r.error) || '文件读取失败');
  const name = filePath.split(/[\\/]/).pop() || 'book';
  return new File([r.data], name);
}

async function getArchiveSource(bookId) {
  const hit = archiveCache.get(bookId);
  if (hit) { touchArchive(bookId, hit); return hit; }

  const flying = archiveLoading.get(bookId);
  if (flying) return flying;

  const p = (async () => {
    try {
      const info = await DB.getPages(bookId);
      if (!info.file) return null;

      const file = await fileOfPath(info.file);

      if (info.kind === 'pdf') {
        const mod = await import('./pdf.js');
        const parsed = await mod.listPdfPages(file);
        const src = { kind: 'pdf', pages: parsed.pages, dispose: parsed.dispose };
        touchArchive(bookId, src);
        return src;
      }

      if (info.kind === 'archive') {
        const mod = await import('./zip.js');
        // 注意：listZipImages 直接返回数组，不像 listPdfPages 返回 {pages, dispose}
        const pages = await mod.listZipImages(file);
        const src = { kind: 'archive', pages, dispose: () => {} };
        touchArchive(bookId, src);
        return src;
      }

      return null;
    } finally {
      archiveLoading.delete(bookId);
    }
  })();

  archiveLoading.set(bookId, p);
  return p;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('转码失败'));
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const i = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, i);
  const b64 = dataUrl.slice(i + 1);
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let k = 0; k < len; k++) arr[k] = bin.charCodeAt(k);
  return new Blob([arr], { type: mime });
}

function ensureHost() {
  if (!host) throw new Error('桌面接口未就绪（请通过桌面版启动）');
  return host;
}

/* ============================================================
   对外
   ============================================================ */

const DB = {
  /* ---------------- 初始化 ---------------- */

  async open() {
    ensureHost();
    settings = await host.getSettings();
    return settings;
  },

  getSettings() {
    return settings;
  },

  async setSettings(patch) {
    ensureHost();
    settings = await host.setSettings(patch);
    return settings;
  },

  /* ---------------- 扫描根目录 ---------------- */

  async scan() {
    ensureHost();
    settings = await host.getSettings();

    if (!settings.rootDir) {
      books = [];
      return { ok: false, reason: 'no-root', books: [] };
    }

    const res = await host.scan(settings.rootDir);
    lastScan = { ms: res.ms || 0, total: res.total || 0, error: res.error || null };

    if (!res.ok) {
      books = [];
      return { ok: false, reason: res.error, books: [] };
    }

    books = res.books || [];
    return { ok: true, books, ms: res.ms, total: res.total };
  },

  getScanInfo() {
    return lastScan;
  },

  /* ---------------- 书籍 ---------------- */

  async getAllBooks() {
    if (!books || !books.length) await DB.scan();
    return books.slice();
  },

  /**
   * 只更新「软件自己产生的」字段：进度、显示名。
   * 绝不改动磁盘上的书。
   */
  async updateBook(id, patch) {
    ensureHost();
    if (!id) return null;

    const book = books.find((b) => b.id === id);

    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      await host.renameBook(id, patch.title);
      if (settings && settings.renamed) settings.renamed[id] = patch.title;
      if (book) book.title = patch.title;
    }

    const hasProgress = Object.prototype.hasOwnProperty.call(patch, 'progress')
      || Object.prototype.hasOwnProperty.call(patch, 'mode')
      || Object.prototype.hasOwnProperty.call(patch, 'direction')
      || Object.prototype.hasOwnProperty.call(patch, 'coverAlone')
      || Object.prototype.hasOwnProperty.call(patch, 'lastReadAt');

    if (hasProgress) {
      const p = Object.assign({}, patch.progress, {
        mode: patch.mode || (patch.progress && patch.progress.mode),
        direction: patch.direction,
        coverAlone: patch.coverAlone,
        lastReadAt: patch.lastReadAt || Date.now(),
      });

      await host.saveProgress(id, p);
      if (settings && settings.progress) settings.progress[id] = p;
      if (book) {
        book.progress = patch.progress;
        book.lastReadAt = p.lastReadAt;
      }
    }

    return book || null;
  },

  async deleteBook() {
    // 桌面版不允许删除磁盘上的书
    throw new Error('桌面版不删除磁盘文件，请使用「重置进度」');
  },

  /* ---------------- 页面 ---------------- */

  async getPages(id) {
    if (pageCache.has(id)) return pageCache.get(id);
    ensureHost();
    const res = await host.getPages(id);
    if (!res || !res.ok) throw new Error((res && res.error) || '读取失败');
    const info = { kind: res.kind, paths: res.paths || [], file: res.file || null };
    pageCache.set(id, info);
    return info;
  },

  /** 取单页内容。返回 { blob, w, h } */
  async getPageRecord(bookId, index) {
    ensureHost();
    const info = await DB.getPages(bookId);

    // 文件夹型：直接读磁盘上的图片
    if (info.kind === 'folder') {
      const p = info.paths[index];
      if (!p) return null;
      const r = await readPageCached(p);
      if (!r || !r.ok) return null;

      // 超大图先降采样
      if (r.bytes && r.bytes > BIG_IMAGE_BYTES) {
        const small = await shrinkIfHuge(r.dataUrl, r.bytes);
        if (small) {
          return { blob: dataUrlToBlob(small.dataUrl), w: small.w, h: small.h, index, path: p };
        }
      }

      return { blob: dataUrlToBlob(r.dataUrl), w: r.w || 0, h: r.h || 0, index, path: p };
    }

    // PDF / 压缩包
    const src = await getArchiveSource(bookId);
    if (!src || index < 0 || index >= src.pages.length) return null;

    const blob = await src.pages[index].read();
    if (!blob) return null;

    if (blob.size > BIG_IMAGE_BYTES) {
      const small = await shrinkIfHuge(blob, blob.size);
      if (small) {
        return { blob: dataUrlToBlob(small.dataUrl), w: small.w, h: small.h, index };
      }
    }

    return { blob, w: 0, h: 0, index };
  },

  /** 直接拿 dataURL（长卷模式用） */
  async getPageDataUrl(bookId, index) {
    ensureHost();
    const info = await DB.getPages(bookId);

    if (info.kind === 'folder') {
      const p = info.paths[index];
      if (!p) return null;
      const r = await readPageCached(p);
      if (!r || !r.ok) return null;

      if (r.bytes && r.bytes > BIG_IMAGE_BYTES) {
        const small = await shrinkIfHuge(r.dataUrl, r.bytes);
        if (small) return { ok: true, dataUrl: small.dataUrl, w: small.w, h: small.h };
      }
      return r;
    }

    const rec = await DB.getPageRecord(bookId, index);
    if (!rec || !rec.blob) return null;
    const dataUrl = await blobToDataUrl(rec.blob);
    return { ok: true, dataUrl, w: rec.w || 0, h: rec.h || 0 };
  },

  /** 只读图片头取尺寸（不传整张图） */
  async getDims(bookId, index) {
    ensureHost();
    const info = await DB.getPages(bookId);

    if (info.kind === 'folder') {
      const p = info.paths[index];
      if (!p) return { w: 0, h: 0 };
      return host.getDims(p);
    }

    // PDF 要渲染后才知道尺寸，返回 0 让前端按默认比例
    const src = await getArchiveSource(bookId);
    if (!src || !src.pages[index]) return { w: 0, h: 0 };
    const d = src.pages[index]._dims;
    return d || { w: 0, h: 0 };
  },

  /** 封面 */
  async getCover(id) {
    ensureHost();
    return host.getCover(id);
  },

  /** PDF/压缩包页数（会触发一次解析，结果留在缓存复用） */
  async getArchivePageCount(id) {
    ensureHost();
    const info = await DB.getPages(id);
    if (info.kind === 'folder') return info.paths.length;

    const src = await getArchiveSource(id);
    if (!src || !Array.isArray(src.pages)) return 0;
    return src.pages.length;
  },

  /* ---------------- 容量 ---------------- */

  async estimate() {
    const total = books.reduce((s, b) => s + (b.bytes || 0), 0);
    return { usage: total, quota: 0 };
  },

  async isPersisted() {
    return true;   // 桌面版数据就在磁盘上，不存在被浏览器清理的问题
  },

  async persist() {
    return true;
  },

  /* ---------------- 缓存维护 ---------------- */

  clearPageCache() {
    pageCache = new Map();
    clearPageDataCache();
  },

  forgetBook(id) {
    pageCache.delete(id);
    const src = archiveCache.get(id);
    if (src) {
      try { if (src.dispose) src.dispose(); } catch (e) { /* noop */ }
      archiveCache.delete(id);
    }
  },
};

export { DB };
