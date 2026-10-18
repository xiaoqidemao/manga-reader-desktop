/* ============================================================
   library.js · 书库页（桌面版）
   ------------------------------------------------------------
   与网页版的区别：
     - 不再「导入」，改成「选一个漫画文件夹」后自动扫描
     - 封面来自磁盘真实文件，滚动到才加载
     - 删除 = 只删进度，不碰磁盘
     - 增加「刷新」，扫描完成后重新读目录
   ============================================================ */

import { DB } from './db.js';
import { sheet, promptInput, icon, formatBytes, toast } from './ui.js';

let onOpenBook = null;
let allBooks = [];
let io = null;

function els() {
  return {
    grid: document.getElementById('lib-grid'),
    empty: document.getElementById('lib-empty'),
    count: document.getElementById('lib-count'),
    stage: document.getElementById('lib-stage'),
  };
}

/* ---------------- 封面缓存 ---------------- */

/**
 * 封面直接用 dataURL 缓存。
 *
 * 原网页用的是 blob URL + 手工 revoke，但那套在桌面版会踩坑：
 * 每次 renderLibrary 都会重建 DOM，若在重建后回收了某个仍被新 DOM
 * 引用的 URL，就变成死链（封面留白）。dataURL 没有生命周期问题。
 */
const coverCache = new Map();   // id -> dataURL
let coverLoading = new Set();

function pruneCovers(list) {
  const alive = new Set(list.map((b) => b.id));
  for (const id of Array.from(coverCache.keys())) {
    if (!alive.has(id)) coverCache.delete(id);
  }
  // 控制内存：超出就丢最旧的（Map 保持插入顺序）
  while (coverCache.size > 800) {
    coverCache.delete(coverCache.keys().next().value);
  }
}

/**
 * 把封面图缩到书架需要的大小。
 * 原图常有 1~2MB，2496 本全塞进 DOM 会直接爆内存，
 * 所以读进来后立刻过一遍 canvas，缩成约 200px 宽的小图。
 */
function makeThumb(dataUrl, targetW = 200) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || targetW;
        const h = img.naturalHeight || targetW;
        const scale = Math.min(1, targetW / w);
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));

        const cv = document.createElement('canvas');
        cv.width = cw;
        cv.height = ch;
        const ctx = cv.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(cv.toDataURL('image/jpeg', 0.78));
      } catch (e) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

async function loadCover(coverEl, id) {
  if (!coverEl || !id) return;

  const cached = coverCache.get(id);
  if (cached) { paintCover(coverEl, cached); return; }

  if (coverLoading.has(id)) return;
  coverLoading.add(id);

  try {
    const raw = await DB.getCover(id);
    if (!raw) return;

    // IPC 拿回的是原图（可能 1~2MB），这里缩成缩略图再缓存
    const small = await makeThumb(raw, 200);
    if (!small) return;

    coverCache.set(id, small);
    paintCover(coverEl, small);
  } catch (e) {
    /* 静默 */
  } finally {
    coverLoading.delete(id);
  }
}

function paintCover(coverEl, url) {
  if (!coverEl || !coverEl.isConnected) return;
  if (coverEl.querySelector('img')) return;   // 已经画过了

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => {
    img.classList.add('is-loaded');
    coverEl.classList.add('is-ready');
    const fb = coverEl.querySelector('.cover-fallback');
    if (fb) fb.remove();
  };
  img.onerror = () => { img.remove(); };
  img.src = url;
  coverEl.insertBefore(img, coverEl.firstChild);
}

/* ---------------- 排序 ---------------- */

function getSort() {
  const s = DB.getSettings();
  return (s && s.sort) || 'lastRead';
}

function setSort(v) {
  DB.setSettings({ sort: v });
}

function sortBooks(list, mode) {
  const arr = list.slice();
  const collator = new Intl.Collator('zh-Hans', { numeric: true });
  if (mode === 'title') {
    arr.sort((a, b) => collator.compare(a.title, b.title));
  } else if (mode === 'added') {
    arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } else {
    arr.sort((a, b) => {
      const ta = a.lastReadAt || 0;
      const tb = b.lastReadAt || 0;
      if (ta !== tb) return tb - ta;
      return collator.compare(a.title, b.title);
    });
  }
  return arr;
}

/* ---------------- 进度 ---------------- */

export function progressOf(book) {
  const p = book.progress;
  if (!p || !book.pageCount) return 0;

  if (p.mode === 'webtoon' || p.mode === 'strip') return clamp01(p.scroll || 0);

  if (p.mode === 'spread') {
    const total = book.pageCount;
    const unitCount = p.coverAlone ? 1 + Math.ceil((total - 1) / 2) : Math.ceil(total / 2);
    return clamp01(Number(p.unit || 0) / Math.max(1, unitCount - 1));
  }

  return clamp01(Number(p.page || 0) / Math.max(1, book.pageCount - 1));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function progressLabel(book) {
  const p = progressOf(book);
  const pages = book.pageCount ? `${book.pageCount} 页` : '待统计';
  if (!book.lastReadAt || p <= 0.001) return pages;
  if (p >= 0.995) return `${pages} · 已读完`;
  return `${pages} · ${Math.round(p * 100)}%`;
}

/* ---------------- 渲染 ---------------- */

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function escapeAttr(s) {
  return escapeHTML(s);
}

/** 相对根目录的路径，给悬停提示用（同名作品多，需要区分） */
function relPath(full) {
  const s = DB.getSettings() || {};
  const root = s.rootDir || '';
  if (!root || !full) return full || '';
  const norm = (x) => String(x).replace(/[\\/]+/g, '/');
  const r = norm(root).replace(/\/+$/, '');
  const f = norm(full);
  if (f.toLowerCase().startsWith(r.toLowerCase())) {
    const sub = f.slice(r.length).replace(/^\/+/, '');
    return sub || '.';
  }
  return f;
}

function cardHTML(b) {
  const p = progressOf(b);
  const done = p >= 0.995;
  const rel = relPath(b.path);

  return `<div class="card" data-id="${escapeAttr(b.id)}" title="${escapeAttr(b.title)}\n${escapeAttr(rel)}">
    <div class="card-cover">
      <div class="cover-fallback">${icon('book')}</div>
      ${done ? '<div class="badge-done">已读完</div>' : ''}
      <div class="card-progress"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
    </div>
    <div class="card-title">${escapeHTML(b.title)}</div>
    <div class="card-meta">${progressLabel(b)}</div>
  </div>`;
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

/** 懒加载封面：滚动到附近才去读磁盘 */
function observeCovers() {
  if (io) io.disconnect();
  if (!('IntersectionObserver' in window)) return;

  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const cover = en.target;
      const id = cover.dataset.coverId;
      io.unobserve(cover);
      loadCover(cover, id);
    }
  }, { root: els().stage, rootMargin: '600px 0px' });
}

export function renderLibrary(books) {
  const { grid, empty, count } = els();
  hideScanning();
  allBooks = sortBooks(books, getSort());

  pruneCovers(allBooks);

  if (!allBooks.length) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty.classList.add('is-show');
    if (count) count.textContent = '';
    renderEmptyState();
    return;
  }

  grid.classList.remove('hidden');
  empty.classList.remove('is-show');
  if (count) count.textContent = `${allBooks.length} 本`;

  grid.innerHTML = allBooks.map(cardHTML).join('');

  grid.querySelectorAll('.card').forEach((el) => {
    const book = allBooks.find((b) => b.id === el.dataset.id);
    if (book) bindCard(el, book);
  });

  allBooks.forEach((b) => {
    const el = grid.querySelector(`.card[data-id="${cssEscape(b.id)}"] .card-cover`);
    if (el) el.dataset.coverId = b.id;
  });

  observeCovers();
  grid.querySelectorAll('.card-cover').forEach((c) => io && io.observe(c));
}

/** 空书架时，按当前状态显示不同引导 */
function renderEmptyState() {
  const empty = document.getElementById('lib-empty');
  if (!empty) return;

  const s = DB.getSettings() || {};
  const hasRoot = !!s.rootDir;
  const title = empty.querySelector('h2');
  const desc = empty.querySelector('p');
  const cta = document.getElementById('btn-import-empty');
  const hint = empty.querySelector('.hint');

  if (!hasRoot) {
    if (title) title.textContent = '还没有选择漫画文件夹';
    if (desc) desc.textContent = '选一个放着漫画的文件夹，软件会直接读取里面的图片。不复制、不上传、不联网。';
    if (cta) cta.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>选择漫画文件夹</span>';
    if (hint) hint.textContent = '每个「只有图片」的子文件夹算作一本';
  } else {
    if (title) title.textContent = '这个文件夹里没找到漫画';
    if (desc) {
      desc.textContent = `当前：${s.rootDir}\n规则：只有图片、没有子文件夹的目录算一本。`;
      desc.style.whiteSpace = 'pre-line';
    }
    if (cta) cta.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>换个文件夹</span>';
    if (hint) hint.textContent = '也可以点右上角「刷新」重新扫描';
  }
}

/** 扫描中的占位状态，避免首屏空书架误导用户 */
export function showScanning(rootDir) {
  const { grid, empty, count, stage } = els();
  if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
  if (empty) empty.classList.remove('is-show');
  if (count) count.textContent = '';
  if (!stage) return;

  let el = document.getElementById('lib-scanning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lib-scanning';
    el.className = 'empty';
    el.innerHTML = `
      <div class="glyph">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        </svg>
      </div>
      <h2>正在扫描漫画文件夹</h2>
      <p id="lib-scanning-path"></p>
      <div class="hint">首次扫描要遍历所有子目录，稍等一下</div>`;
    stage.appendChild(el);
  }
  el.classList.add('is-show');
  const p = document.getElementById('lib-scanning-path');
  if (p) p.textContent = rootDir || '';
}

function hideScanning() {
  const el = document.getElementById('lib-scanning');
  if (el) el.classList.remove('is-show');
}

async function reload() {
  const books = await DB.getAllBooks();
  renderLibrary(books);
  return books;
}

export { reload as reloadLibrary };

/** 全量重新扫描（用户点刷新 / 改目录后） */
export async function rescan() {
  const s = DB.getSettings() || {};
  if (!s.rootDir) {
    toast('还没有选择漫画文件夹', 2600);
    return [];
  }

  showScanning(s.rootDir);
  try {
    const r = await DB.scan();
    const books = r.ok ? r.books : [];
    renderLibrary(books);

    if (r.ok) {
      toast(`扫描完成 · ${books.length} 本 · 用时 ${(r.ms / 1000).toFixed(1)} 秒`, 2600);
    } else {
      toast('扫描失败：' + r.reason, 3400);
    }
    return books;
  } catch (err) {
    renderLibrary([]);
    toast('扫描失败：' + (err.message || err), 3400);
    return [];
  }
}

/* ---------------- 卡片交互 ---------------- */

function bindCard(el, book) {
  el.addEventListener('click', () => {
    if (onOpenBook) onOpenBook(book);
  });

  // 右键菜单：重命名 / 打开所在文件夹 / 重置进度 / 标记已读
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showBookMenu(book);
  });
}

async function showBookMenu(book) {
  const items = [
    { label: '重命名（只改显示名）', value: 'rename', icon: 'edit' },
    { label: '打开所在文件夹', value: 'reveal', icon: 'folder' },
  ];
  if (book.lastReadAt) {
    items.push({ label: '重置阅读进度', value: 'restart', icon: 'reset' });
  }
  items.push({ label: '标记为已读完', value: 'done', icon: 'check' });

  const v = await sheet({ title: book.title, items });

  if (v === 'rename') {
    const name = await promptInput({ title: '重命名（只改显示名，不动磁盘）', value: book.title });
    if (name && name !== book.title) {
      await DB.updateBook(book.id, { title: name });
      await reload();
      toast('已重命名');
    }
  } else if (v === 'reveal') {
    await window.mangaHost.reveal(book.path);
  } else if (v === 'restart') {
    await window.mangaHost.clearProgress(book.id);
    book.progress = null;
    book.lastReadAt = 0;
    await DB.scan();
    await reload();
    toast('阅读进度已重置');
  } else if (v === 'done') {
    await DB.updateBook(book.id, {
      progress: { mode: 'paged', page: Math.max(0, book.pageCount - 1) },
      lastReadAt: Date.now(),
    });
    await reload();
    toast('已标记为读完');
  }
}

/* ---------------- 排序菜单 ---------------- */

async function showSortMenu() {
  const cur = getSort();
  const opts = [
    { key: 'lastRead', label: '最近阅读' },
    { key: 'added', label: '修改时间' },
    { key: 'title', label: '书名' },
  ];
  const v = await sheet({
    title: '排序方式',
    items: opts.map((o) => ({
      label: o.label,
      value: o.key,
      icon: o.key === cur ? 'check' : undefined,
    })),
  });
  if (v) {
    setSort(v);
    renderLibrary(allBooks);
  }
}

/* ---------------- 统计 / 存储 ---------------- */

export async function showStorageInfo() {
  const s = DB.getSettings() || {};
  const books = allBooks.length ? allBooks : await DB.getAllBooks();
  const pages = books.reduce((sum, b) => sum + (b.pageCount || 0), 0);
  const bytes = books.reduce((sum, b) => sum + (b.bytes || 0), 0);
  const scan = DB.getScanInfo();

  const items = [
    { label: '漫画文件夹', sub: s.rootDir || '尚未选择', icon: 'folder' },
    { label: '书架内容', sub: `${books.length} 本 · ${pages} 页 · ${formatBytes(bytes)}`, icon: 'storage' },
    { label: '数据位置', sub: '阅读进度与设置（可直接备份这个文件）', icon: 'info' },
  ];

  if (scan && scan.ms) {
    items.push({ label: '上次扫描', sub: `${(scan.ms / 1000).toFixed(2)} 秒`, icon: 'info' });
  }

  await sheet({ title: '存储', items });
}

/* ---------------- 选择文件夹 ---------------- */

export async function chooseFolder() {
  const dir = await window.mangaHost.pickFolder();
  if (!dir) return null;

  await DB.setSettings({ rootDir: dir });
  const books = await rescan();
  toast(`已选择：${dir}`, 3000);
  return books;
}

/* ---------------- 初始化 ---------------- */

export function initLibrary(opts = {}) {
  onOpenBook = opts.onOpen;

  document.getElementById('btn-sort').onclick = showSortMenu;
  document.getElementById('btn-data-dir').onclick = () => window.mangaHost.openDataDir();
  document.getElementById('btn-refresh').onclick = () => rescan();
  document.getElementById('btn-open-folder').onclick = () => chooseFolder();

  const emptyCta = document.getElementById('btn-import-empty');
  if (emptyCta) emptyCta.onclick = () => chooseFolder();

  const fab = document.getElementById('fab-import');
  if (fab) {
    fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>换文件夹</span>';
    fab.onclick = () => chooseFolder();
  }

  return true;
}

export function getBooks() {
  return allBooks;
}
