/* ============================================================
   library.js · 书库页（桌面版）
   ------------------------------------------------------------
   与网页版的区别：
     - 不再「导入」，改成「选一个漫画文件夹」后直接读磁盘
     - 封面来自磁盘真实文件，滚动到才加载
     - 删除 = 只删进度，不碰磁盘
     - 增加「刷新」，重新扫描并更新缓存

   v1.1 改动：分层浏览
     - 书架不再一次性铺开全部书，而是「一层一层进」
     - 根目录显示子文件夹；双击进入后显示下一层
     - 目录本身就是一本（只有图片）时，也会作为书出现
     - 顶部面包屑可点回任意层级，Alt+← / Backspace 回上级
   ============================================================ */

import { DB } from './db.js';
import { sheet, promptInput, icon, formatBytes, toast } from './ui.js';

let onOpenBook = null;
let allBooks = [];
let io = null;

/* ---------------- 分层浏览状态 ---------------- */

const BROWSE = {
  rootDir: '',        // 漫画根目录（来自设置）
  path: '',           // 当前所在目录（绝对路径）
  dirs: [],           // 当前层的子文件夹
  books: [],          // 当前层的书
  trail: [],          // 面包屑：[{name, path}, ...]，trail[0] 恒为根
  loading: false,
};

/** 下一次渲染是否要把滚动条拉回顶部（换目录时为 true） */
let scrollResetPending = false;

/** 每个目录记住自己的滚动位置，进出不同层时各回各的 */
const scrollMemo = new Map();   // dirPath -> scrollTop

/** 渲染期间的静默标记：此时滚动事件不写入记忆，避免把 0 覆盖掉真实位置 */
let scrollSilent = false;

/** 当前层滚动位置变化时，随手记下来 */
function rememberScroll() {
  if (scrollSilent) return;
  const stage = els().stage;
  if (!stage || !BROWSE.path) return;
  scrollMemo.set(BROWSE.path, stage.scrollTop);
}

/** 渲染后恢复该层上次的滚动位置 */
function restoreScroll(dirPath) {
  const stage = els().stage;
  if (!stage) return;
  const y = scrollMemo.get(dirPath) || 0;
  if (y <= 0) return;

  // 恢复期间禁掉写入，等布局稳定后连续几帧对齐，
  // 因为封面是异步加载的，页面高度会变。
  scrollSilent = true;
  let tries = 0;
  const tick = () => {
    stage.scrollTop = y;
    tries++;
    if (tries < 12 && Math.abs(stage.scrollTop - y) > 2) {
      requestAnimationFrame(tick);
    } else {
      scrollSilent = false;
    }
  };
  requestAnimationFrame(tick);
}

/** 当前是否在根目录 */
function atRoot() {
  return !BROWSE.path || BROWSE.path === BROWSE.rootDir;
}

function els() {
  return {
    grid: document.getElementById('lib-grid'),
    empty: document.getElementById('lib-empty'),
    count: document.getElementById('lib-count'),
    stage: document.getElementById('lib-stage'),
    crumbs: document.getElementById('lib-crumbs'),
    back: document.getElementById('lib-back'),
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

/* ---------------- 文件夹卡片 ---------------- */

/**
 * 文件夹层不读任何图片，只显示：纯色块 + 文件夹图标 + 名称。
 * 这样即使目录里有几百个子文件夹，也不需要打开任何文件。
 */
function dirCardHTML(d) {
  const meta = d.entryCount > 0
    ? `${d.entryCount} 项${d.isBook ? ' · 可直接阅读' : ''}`
    : (d.entryCount === 0 ? '空文件夹' : '无法读取');

  return `<div class="card card-dir" data-dir="${escapeAttr(d.path)}" title="${escapeAttr(d.path)}">
    <div class="card-cover dir-cover">
      <div class="dir-glyph">${icon('folder')}</div>
    </div>
    <div class="card-title">${escapeHTML(d.name)}</div>
    <div class="card-meta">${escapeHTML(meta)}</div>
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

  // 兼容旧调用：只给书、不给文件夹时，文件夹层为空
  BROWSE.books = allBooks;
  if (!BROWSE.dirs) BROWSE.dirs = [];

  renderCurrentView();
}

/**
 * 按当前浏览状态渲染：先文件夹，后书。
 * 文件夹层不需要读任何图片，所以即使有几百个目录也是瞬间完成。
 */
function renderCurrentView() {
  const { grid, empty, count } = els();
  const dirs = BROWSE.dirs || [];
  const books = BROWSE.books || [];

  renderCrumbs();

  const total = dirs.length + books.length;
  if (!total) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty.classList.add('is-show');
    if (count) count.textContent = '';
    renderEmptyState();
    return;
  }

  grid.classList.remove('hidden');
  empty.classList.remove('is-show');

  // 数量提示：文件夹和书分开说清楚
  if (count) {
    const parts = [];
    if (books.length) parts.push(`${books.length} 本`);
    if (dirs.length) parts.push(`${dirs.length} 个文件夹`);
    count.textContent = parts.join(' · ');
  }

  // 折叠后的混排：书在前、文件夹在后，符合「主要目的是看书」的直觉
  const dirHTML = dirs.map(dirCardHTML).join('');
  const bookHTML = books.map(cardHTML).join('');
  grid.innerHTML = bookHTML + dirHTML;

  // 文件夹卡片：双击进入；本身就是书时，单击直接阅读
  grid.querySelectorAll('.card-dir').forEach((el) => {
    const d = dirs.find((x) => x.path === el.dataset.dir);
    if (!d) return;
    bindDirCard(el, d);
  });

  // 书卡片：单击打开
  grid.querySelectorAll('.card:not(.card-dir)').forEach((el) => {
    const book = books.find((b) => b.id === el.dataset.id);
    if (book) bindCard(el, book);
  });

  books.forEach((b) => {
    const el = grid.querySelector(`.card[data-id="${cssEscape(b.id)}"] .card-cover`);
    if (el) el.dataset.coverId = b.id;
  });

  // 只给书挂封面观察器；文件夹不需要读图
  observeCovers();
  grid.querySelectorAll('.card:not(.card-dir) .card-cover').forEach((c) => io && io.observe(c));

  /* 滚动位置：
     换目录时才回到顶部；同一层重新渲染（比如从阅读器返回、
     排序、刷新）要保留原来的位置，否则读到一半退出会跳回开头。 */
  const stage = els().stage;
  if (stage && scrollResetPending) {
    scrollSilent = true;          // 归零的动作不写入记忆
    stage.scrollTop = 0;
    scrollResetPending = false;
    requestAnimationFrame(() => { scrollSilent = false; });
  }
}

/* ---------------- 面包屑 ---------------- */

function renderCrumbs() {
  const { crumbs, back } = els();
  if (!crumbs) return;

  const parts = ['<h1 class="crumb-root" data-crumb-root="1">书架</h1>'];

  // trail[0] 是根目录，从它开始逐级展开
  BROWSE.trail.forEach((node, i) => {
    const isLast = i === BROWSE.trail.length - 1;
    parts.push('<span class="crumb-sep">›</span>');
    if (isLast) {
      parts.push(`<span class="crumb-cur" title="${escapeAttr(node.path)}">${escapeHTML(node.name)}</span>`);
    } else {
      parts.push(`<button class="crumb" data-crumb-i="${i}" title="${escapeAttr(node.path)}">${escapeHTML(node.name)}</button>`);
    }
  });

  crumbs.innerHTML = parts.join('');

  // 点面包屑跳回任意层级
  crumbs.querySelectorAll('.crumb').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.crumbI);
      const node = BROWSE.trail[i];
      if (node) navigateTo(node.path);
    };
  });

  const rootBtn = crumbs.querySelector('.crumb-root');
  if (rootBtn) {
    rootBtn.onclick = () => {
      if (BROWSE.trail.length) navigateTo(BROWSE.trail[0].path);
    };
  }

  // 不在根目录时显示返回键
  if (back) back.hidden = BROWSE.trail.length <= 1;
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

/** 在标题后面显示「列表来自上次扫描」的时间，让你知道数据新鲜度 */
export function showCacheNotice(scannedAt) {
  const el = document.getElementById('lib-cache-note');
  if (!el) return;
  if (!scannedAt) { el.textContent = ''; return; }

  const d = new Date(scannedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  el.textContent = `· 上次扫描 ${time}`;
  el.title = `书架列表来自上次扫描（${d.toLocaleString('zh-CN')}）。\n磁盘上有新增或删除的漫画时，点右上角「刷新」重新扫描。`;
}

/** 扫描中的占位状态，避免首屏空书架误导用户 */
export function showScanning(rootDir) {  const { grid, empty, count, stage } = els();
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

/**
 * 从阅读器返回书架时调用。
 * 分层浏览下不能再用 getAllBooks()（那会触发全量扫描），
 * 而是重新读当前所在层，保留位置。
 */
async function reload() {
  if (BROWSE.path) {
    await navigateTo(BROWSE.path);
  } else {
    renderCurrentView();
  }
  return BROWSE.books;
}

export { reload as reloadLibrary };

/** 全量重新扫描（用户点刷新 / 改目录后）
    刷新只更新「全书缓存」与统计，界面仍停留在当前目录，
    不会把你踢回根目录。 */
export async function rescan() {
  const s = DB.getSettings() || {};
  if (!s.rootDir) {
    toast('还没有选择漫画文件夹', 2600);
    return [];
  }

  showScanning(s.rootDir);
  try {
    const r = await DB.scan();
    if (r.ok) showCacheNotice(Date.now());

    if (r.ok) {
      // 扫完回到当前所在层重新读一次，保持位置不变
      const target = BROWSE.path || s.rootDir;
      await navigateTo(target);
      toast(`扫描完成 · 全书架 ${r.total} 本 · 用时 ${(r.ms / 1000).toFixed(1)} 秒`, 2800);
    } else {
      hideScanning();
      renderCurrentView();
      toast('扫描失败：' + r.reason, 3400);
    }
    return r.ok ? r.books : [];
  } catch (err) {
    hideScanning();
    renderCurrentView();
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
    { label: '设置封面…', value: 'setCover', icon: 'book' },
    { label: '打开所在文件夹', value: 'reveal', icon: 'folder' },
  ];

  // 已经有自定义封面时，给一个恢复入口
  if (DB.hasCustomCover(book.id)) {
    items.splice(2, 0, { label: '恢复默认封面', value: 'resetCover', icon: 'reset' });
  }

  if (book.lastReadAt) {
    items.push({ label: '重置阅读进度', value: 'restart', icon: 'reset' });
  }
  items.push({ label: '标记为已读完', value: 'done', icon: 'check' });

  const v = await sheet({ title: book.title, items });

  if (v === 'setCover') {
    await setCustomCover(book);
    return;
  }

  if (v === 'resetCover') {
    await DB.resetCover(book.id);
    coverCache.delete(book.id);          // 清掉内存里的旧封面
    await reload();
    toast('已恢复默认封面');
    return;
  }

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
    // 只是清了进度，书籍列表本身没变，不用重新扫描整个目录
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

/* ---------------- 自定义封面 ---------------- */

/**
 * 选一张图片作为这本书的封面。
 * 只记录图片路径，不复制、不移动、不改动你的任何文件。
 */
async function setCustomCover(book) {
  const r = await DB.pickCover(book.id);
  if (!r || !r.ok) {
    if (r && r.canceled) return;      // 用户取消了，什么也不说
    toast('设置封面失败：' + ((r && r.error) || '未知错误'), 3200);
    return;
  }

  // 清掉这一本的封面缓存，让书架重新拉一次
  coverCache.delete(book.id);
  await reload();
  toast('封面已更新', 2000);
}

/* ---------------- 全书搜索 ---------------- */

const SEARCH = {
  active: false,
  keyword: '',
  timer: null,
};

function searchEls() {
  return {
    box: document.getElementById('lib-search'),
    input: document.getElementById('lib-search-input'),
    clear: document.getElementById('lib-search-clear'),
    note: document.getElementById('lib-search-note'),
    kw: document.getElementById('lib-search-kw'),
    total: document.getElementById('lib-search-total'),
    exit: document.getElementById('lib-search-exit'),
    grid: document.getElementById('lib-grid'),
    empty: document.getElementById('lib-empty'),
    count: document.getElementById('lib-count'),
  };
}

/** 展开搜索框并聚焦 */
function openSearch() {
  const { box, input } = searchEls();
  if (!box || !input) return;
  box.classList.add('is-open');
  setTimeout(() => input.focus(), 120);
}

/** 收起搜索框（不退出搜索状态） */
function closeSearchBox() {
  const { box } = searchEls();
  if (box) box.classList.remove('is-open');
}

/** 退出搜索，回到正常浏览 */
function exitSearch() {
  const e = searchEls();
  SEARCH.active = false;
  SEARCH.keyword = '';
  if (e.input) e.input.value = '';
  if (e.clear) e.clear.hidden = true;
  if (e.note) e.note.classList.remove('is-show');
  closeSearchBox();
  // 回到当前目录的正常视图
  if (BROWSE.path) {
    navigateTo(BROWSE.path);
  } else {
    renderCurrentView();
  }
}

/** 执行搜索（带 250ms 防抖） */
function scheduleSearch(kw) {
  if (SEARCH.timer) clearTimeout(SEARCH.timer);
  SEARCH.timer = setTimeout(() => runSearch(kw), 250);
}

async function runSearch(kw) {
  const e = searchEls();
  const keyword = String(kw || '').trim();

  if (e.clear) e.clear.hidden = !keyword;

  if (!keyword) {
    // 清空输入 → 退出搜索
    if (SEARCH.active) exitSearch();
    return;
  }

  SEARCH.active = true;
  SEARCH.keyword = keyword;

  const r = await DB.search(keyword);

  if (!r.ok) {
    if (r.reason === 'no-cache') {
      toast('还没有书架缓存，请先点右上角「刷新」扫描一次', 3600);
      if (e.note) e.note.classList.remove('is-show');
    }
    return;
  }

  // 渲染结果
  const dirs = r.dirs || [];
  const books = r.books || [];

  BROWSE.dirs = dirs;
  BROWSE.books = sortBooks(books, getSort());
  allBooks = BROWSE.books;

  if (e.kw) e.kw.textContent = keyword;
  if (e.total) e.total.textContent = String(r.total || books.length);
  if (e.note) e.note.classList.add('is-show');

  // 搜索时数量提示换成「N 个文件夹 · M 本」
  if (e.count) {
    const parts = [];
    if (books.length) parts.push(`${books.length} 本`);
    if (dirs.length) parts.push(`${dirs.length} 个文件夹`);
    e.count.textContent = parts.join(' · ');
  }

  renderSearchResults(dirs, books);

  // 搜索结果不需要恢复滚动位置，回到顶部
  const stage = els().stage;
  if (stage) stage.scrollTop = 0;
}

/** 渲染搜索结果（文件夹在前，书在后） */
function renderSearchResults(dirs, books) {
  const { grid, empty } = searchEls();

  if (!dirs.length && !books.length) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty.classList.remove('is-show');   // 不显示「没选择文件夹」那个空状态
    grid.classList.remove('hidden');
    grid.innerHTML = '<div class="search-empty">没有找到匹配的内容</div>';
    return;
  }

  grid.classList.remove('hidden');
  empty.classList.remove('is-show');

  const dirHTML = dirs.map(dirCardHTML).join('');
  const bookHTML = books.map(cardHTML).join('');
  grid.innerHTML = dirHTML + bookHTML;

  // 文件夹：双击进入（会清掉搜索状态）
  grid.querySelectorAll('.card-dir').forEach((el) => {
    const d = dirs.find((x) => x.path === el.dataset.dir);
    if (!d) return;
    el.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      SEARCH.active = false;
      SEARCH.keyword = '';
      const se = searchEls();
      if (se.input) se.input.value = '';
      if (se.note) se.note.classList.remove('is-show');
      closeSearchBox();
      navigateTo(d.path);
    });
  });

  // 书：单击打开
  grid.querySelectorAll('.card:not(.card-dir)').forEach((el) => {
    const book = books.find((b) => b.id === el.dataset.id);
    if (book) bindCard(el, book);
  });

  books.forEach((b) => {
    const el = grid.querySelector(`.card[data-id="${cssEscape(b.id)}"] .card-cover`);
    if (el) el.dataset.coverId = b.id;
  });

  observeCovers();
  grid.querySelectorAll('.card:not(.card-dir) .card-cover').forEach((c) => io && io.observe(c));
}

/** 绑定搜索框相关事件 */
function bindSearch() {
  const e = searchEls();
  if (!e.input) return;

  e.input.addEventListener('input', () => {
    scheduleSearch(e.input.value);
  });

  // 回车立即搜索
  e.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      if (SEARCH.timer) clearTimeout(SEARCH.timer);
      runSearch(e.input.value);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      if (e.input.value) {
        // 有内容：先清空
        e.input.value = '';
        exitSearch();
      } else {
        closeSearchBox();
      }
    }
  });

  if (e.clear) {
    e.clear.onclick = () => {
      e.input.value = '';
      exitSearch();
      openSearch();
    };
  }

  if (e.exit) {
    e.exit.onclick = () => exitSearch();
  }
}

/* ---------------- 默认阅读方式 / 方向 ---------------- */

/**
 * 书架右上角「默认阅读方式」按钮。
 * 这里设定的是「新书第一次打开时用哪种方式」；
 * 已经有进度的书仍按它自己的进度读，不会被覆盖。
 */
async function showDefaultModeMenu() {
  const s = DB.getSettings() || {};
  const curMode = s.defaultMode || 'paged';
  const curDir = s.defaultDirection === 'rtl' ? 'rtl' : 'ltr';

  const modeLabel = {
    paged: '单页', spread: '跨页', webtoon: '条漫', strip: '长卷',
  };

  const v = await sheet({
    title: '默认阅读方式',
    items: [
      { label: '单页', value: 'mode:paged', icon: curMode === 'paged' ? 'check' : undefined },
      { label: '跨页（双页并排）', value: 'mode:spread', icon: curMode === 'spread' ? 'check' : undefined },
      { label: '条漫（竖排连续）', value: 'mode:webtoon', icon: curMode === 'webtoon' ? 'check' : undefined },
      { label: '长卷（横排无间隙）', value: 'mode:strip', icon: curMode === 'strip' ? 'check' : undefined },
      { label: '阅读方向：' + (curDir === 'rtl' ? '从右往左（日漫）' : '从左往右'), value: 'toggleDir', icon: 'reset' },
    ],
  });

  if (!v) return;

  if (v === 'toggleDir') {
    const next = curDir === 'rtl' ? 'ltr' : 'rtl';
    await DB.setSettings({ defaultDirection: next });
    toast(`默认方向：${next === 'rtl' ? '从右往左' : '从左往右'}`, 1800);
    return;
  }

  if (v.startsWith('mode:')) {
    const mode = v.slice(5);
    await DB.setSettings({ defaultMode: mode });
    toast(`默认阅读方式：${modeLabel[mode] || mode}`, 1800);
  }
}

/* ---------------- 分层导航 ---------------- */

/**
 * 进入某个目录（只读这一层）。
 * 面包屑 trail 同步维护：从根到当前路径。
 */
export async function navigateTo(dirPath) {
  if (!dirPath || BROWSE.loading) return;

  const root = BROWSE.rootDir;
  if (!root) return;

  // 不允许跑到根目录外面去
  const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const nRoot = norm(root);
  const nDir = norm(dirPath);
  if (nDir !== nRoot && !nDir.toLowerCase().startsWith(nRoot.toLowerCase() + '/')) {
    toast('不能浏览漫画根目录之外的位置', 2600);
    return;
  }

  BROWSE.loading = true;
  showBrowsing(dirPath);

  const prevPath = BROWSE.path;   // 记下当前层，用于判断是不是「同一层重渲染」

  // 离开当前层之前，先把它的滚动位置存下来
  if (prevPath) rememberScroll();

  try {
    const r = await DB.browse(dirPath);
    if (!r.ok) {
      toast('打开文件夹失败：' + (r.reason || '未知错误'), 3400);
      renderCurrentView();
      return;
    }

    BROWSE.path = dirPath;
    BROWSE.dirs = r.dirs || [];
    BROWSE.books = sortBooks(r.books || [], getSort());
    allBooks = BROWSE.books;

    // 重建面包屑：根目录名 + 相对路径的每一段
    BROWSE.trail = buildTrail(root, dirPath);

    hideScanning();

    /* 滚动位置：
       · 首次进入某个目录 → 从顶部开始
       · 回到访问过的目录、或同层重新渲染（从阅读器返回、排序、刷新）
         → 用记忆值恢复。记忆值在用户滚动时实时更新，所以不会弹回旧位置。 */
    const hasMemory = scrollMemo.has(dirPath);
    scrollResetPending = !hasMemory;

    renderCurrentView();
    if (hasMemory) restoreScroll(dirPath);

    updateWindowTitle();

  } finally {
    BROWSE.loading = false;
    hideBrowsing();
  }
}

/** 根据根目录和目标目录，算出面包屑的每一级 */
function buildTrail(root, dirPath) {
  const trail = [];
  const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const nRoot = norm(root);
  const nDir = norm(dirPath);

  const rootName = nRoot.split('/').pop() || nRoot;
  trail.push({ name: rootName, path: root });
  if (nDir === nRoot) return trail;

  const rest = nDir.slice(nRoot.length).replace(/^\/+/, '');
  if (!rest) return trail;

  const segs = rest.split('/');
  let acc = root;
  for (const seg of segs) {
    acc = acc.replace(/[\\/]+$/, '') + '\\' + seg;
    trail.push({ name: seg, path: acc });
  }
  return trail;
}

/** 返回上一级 */
export async function goUp() {
  if (BROWSE.trail.length <= 1) return;
  const parent = BROWSE.trail[BROWSE.trail.length - 2];
  if (parent) await navigateTo(parent.path);
}

/** 双击文件夹卡片进入；本身就是书时，单击直接打开 */
function bindDirCard(el, d) {
  let clickTimer = null;

  el.addEventListener('click', (e) => {
    // 本身就含图片的目录：单击 = 直接读书，双击 = 进去看文件
    if (d.isBook) {
      if (clickTimer) return;             // 双击的第二次点击不再处理
      clickTimer = setTimeout(async () => {
        clickTimer = null;
        await openAsBook(d.path);
      }, 240);
      return;
    }

    // 普通文件夹：单击选中样式（视觉反馈），双击进入
    el.classList.add('is-picked');
    setTimeout(() => el.classList.remove('is-picked'), 180);
  });

  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    navigateTo(d.path);
  });
}

/** 把一个「目录」当书打开（用于既有图片又有子目录的混合目录） */
async function openAsBook(dirPath) {
  // 从全量缓存里找这本书；找不到就现场组一个
  let book = null;
  try {
    const all = await DB.getAllBooks();
    book = all.find((b) => b.id === dirPath) || null;
  } catch (e) { /* 忽略 */ }

  if (!book) {
    // 缓存里没有（比如混合目录不算书），手工构造
    book = {
      id: dirPath,
      title: dirPath.split(/[\\/]/).pop() || dirPath,
      kind: 'folder',
      pageCount: 0,
      path: dirPath,
      progress: null,
      lastReadAt: 0,
    };
  }
  if (onOpenBook) onOpenBook(book);
}

/** 浏览器式窗口标题：显示当前目录 */
function updateWindowTitle() {
  try {
    if (atRoot()) {
      window.mangaHost?.setWindowTitle?.('漫画阅读器');
    } else {
      const cur = BROWSE.trail[BROWSE.trail.length - 1];
      window.mangaHost?.setWindowTitle?.(`${BROWSE.trail[0].name} / ${cur.name} — 漫画阅读器`);
    }
  } catch (e) { /* noop */ }
}

/** 浏览中的轻提示（只读一层很快，通常一闪而过） */
function showBrowsing(dirPath) {
  const stage = els().stage;
  if (!stage) return;
  let el = document.getElementById('lib-browsing');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lib-browsing';
    el.className = 'browsing-tip';
    stage.appendChild(el);
  }
  el.textContent = '正在读取…';
  el.classList.add('is-show');
}

function hideBrowsing() {
  const el = document.getElementById('lib-browsing');
  if (el) el.classList.remove('is-show');
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
    BROWSE.books = sortBooks(BROWSE.books || [], v);
    renderCurrentView();
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
  BROWSE.rootDir = dir;
  BROWSE.path = '';
  BROWSE.trail = [];

  // 换目录后回到根，重新读这一层
  await navigateTo(dir);
  toast(`已选择：${dir}`, 3000);
  return BROWSE.books;
}

/* ---------------- 初始化 ---------------- */

export function initLibrary(opts = {}) {
  onOpenBook = opts.onOpen;

  document.getElementById('btn-sort').onclick = showSortMenu;
  document.getElementById('btn-default-mode').onclick = showDefaultModeMenu;

  // 搜索
  const btnSearch = document.getElementById('btn-search');
  if (btnSearch) btnSearch.onclick = () => openSearch();
  bindSearch();
  document.getElementById('btn-data-dir').onclick = () => window.mangaHost.openDataDir();
  document.getElementById('btn-refresh').onclick = () => rescan();
  document.getElementById('btn-open-folder').onclick = () => chooseFolder();

  // 返回上一级
  const back = document.getElementById('lib-back');
  if (back) back.onclick = () => goUp();

  // 滚动时记下当前层的位置，供「退出阅读器返回」时恢复
  const stageEl = document.getElementById('lib-stage');
  if (stageEl) {
    stageEl.addEventListener('scroll', () => {
      rememberScroll();
    }, { passive: true });
  }

  const emptyCta = document.getElementById('btn-import-empty');
  if (emptyCta) emptyCta.onclick = () => chooseFolder();

  // 换文件夹的入口：顶栏「文件夹」按钮 与 Ctrl+O（右下角悬浮按钮已按需求移除）

  // Alt+← / Backspace：返回上一层（阅读器打开时不抢键）
  window.addEventListener('keydown', (e) => {
    const inReader = document.getElementById('view-reader')?.classList.contains('is-active');
    if (inReader) return;

    const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

    // Ctrl+F：聚焦搜索框
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openSearch();
      return;
    }

    if (inField) return;

    if ((e.altKey && e.key === 'ArrowLeft') || e.key === 'Backspace') {
      if (BROWSE.trail.length > 1) {
        e.preventDefault();
        goUp();
      }
    }
  });

  return true;
}

/**
 * 直接把一本书交给阅读器（不经过书架卡片）。
 * 给「混合目录直接阅读」和自动化验收脚本用。
 */
export async function openBookDirect(book) {
  if (!book) return false;
  if (onOpenBook) { onOpenBook(book); return true; }
  return false;
}

/** 进入根目录（启动时调用） */
export async function enterRoot(rootDir) {
  BROWSE.rootDir = rootDir || '';
  BROWSE.path = '';
  BROWSE.dirs = [];
  BROWSE.books = [];
  BROWSE.trail = [];
  if (!BROWSE.rootDir) return;
  await navigateTo(BROWSE.rootDir);
}

export function getBooks() {
  return allBooks;
}

export function getTrail() {
  return BROWSE.trail.slice();
}

export function isAtRoot() {
  return atRoot();
}
