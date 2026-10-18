/* ============================================================
   reader.js · 阅读器核心
   单页翻页 / 跨页（双页并排） / 条漫连续滚动
   —— 翻页与跨页共用一套「单元(unit)」模型：
      单页 = 每个单元 1 页，跨页 = 每个单元 1~2 页
      翻页、手势、缩放、进度逻辑因此完全复用
   ============================================================ */

import { DB } from './db.js';
import { sheet, toast, promptInput } from './ui.js';

const THEME_KEY = 'mr.theme';

const S = {
  book: null,
  mode: 'paged',        // 'paged' | 'spread' | 'webtoon' | 'strip'
  direction: 'ltr',
  page: 0,              // 翻页模式下的「单元」索引（不是页号）
  units: [],            // 翻页模式：units[单元] = [页索引, ...]
  coverAlone: false,    // 跨页时首页单独显示（日漫惯例）
  scale: 1,
  tx: 0,
  ty: 0,
  isOpen: false,
  wtRatio: 0,
  stripRatio: 0,        // 长卷：0 = 最左（第 1 页），1 = 最右
  stripPage: 0,         // 长卷：当前居中的页索引
};

let E = {};
let cache = new Map();       // 页索引 -> {url, w, h}
let slides = new Map();      // 单元索引 -> el
let wtNodes = [];            // webtoon: {el, idx, loaded}
let wtOffsets = [];

/* 长卷状态 */
let stripCells = [];         // {el, idx, loaded}
let stripOffsets = [];       // 每页左边缘的 x 坐标
let stripObserver = null;
let stripDims = [];          // 每页 {w,h}
let stripPruneTimer = null;

/* 缩略图带 */
let thumbNodes = [];         // {el, idx, loaded}
let thumbsVisible = false;
let thumbIO = null;
let wtObserver = null;
let uiTimer = null;
let saveTimer = null;
let floatTimer = null;
let pruneTimer = null;
let tapTimer = null;
let spreadHintShown = false;   // 跨页横屏提示每次打开应用只弹一次
let lastTouchAt = 0;           // 用来忽略触摸后浏览器补发的合成 click
let ctrlSolo = false;          // 左 Ctrl 是否被「单独」按下（没搭配其他键）
let ctrlAt = 0;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isFlip = () => S.mode === 'paged' || S.mode === 'spread';
const isStrip = () => S.mode === 'strip';
const unitCount = () => S.units.length;

/* ============================================================
   单元模型
   ============================================================ */

/** 根据当前模式重建单元表 */
function buildUnits() {
  const total = S.book ? S.book.pageCount : 0;
  const units = [];

  if (S.mode !== 'spread') {
    for (let i = 0; i < total; i++) units.push([i]);
    return units;
  }

  let i = 0;
  if (S.coverAlone && total > 0) {
    units.push([0]);
    i = 1;
  }
  for (; i < total; i += 2) {
    units.push(i + 1 < total ? [i, i + 1] : [i]);
  }
  return units;
}

/** 某页落在哪个单元里 */
function unitIndexForPage(page) {
  if (!S.units.length) return 0;
  for (let i = 0; i < S.units.length; i++) {
    if (S.units[i].indexOf(page) >= 0) return i;
  }
  return page >= (S.book ? S.book.pageCount : 0) ? S.units.length - 1 : 0;
}

/** 当前读到哪一页（跨页取单元首页） */
function currentStartPage() {
  if (!S.book) return 0;
  if (S.mode === 'webtoon') {
    const max = E.webtoon.scrollHeight - E.webtoon.clientHeight;
    const r = max > 0 ? E.webtoon.scrollTop / max : 0;
    return Math.round(r * Math.max(0, S.book.pageCount - 1));
  }
  if (S.mode === 'strip') {
    return S.stripPage;
  }
  const u = S.units[S.page];
  return u ? u[0] : 0;
}

/** 进度条文字，跨页显示成 "3-4 / 20" */
function unitLabel(i) {
  const u = S.units[i];
  if (!u || !S.book) return '';
  const total = S.book.pageCount;
  if (u.length === 1) return `${u[0] + 1} / ${total}`;
  return `${u[0] + 1}-${u[u.length - 1] + 1} / ${total}`;
}

/* ============================================================
   初始化
   ============================================================ */

export function initReader(opts = {}) {
  E = {
    view: $('view-reader'),
    stage: $('rd-stage'),
    paged: $('stage-paged'),
    webtoon: $('stage-webtoon'),
    wtInner: $('webtoon-inner'),
    ui: $('reader-ui'),
    title: $('rd-title'),
    scrub: $('rd-scrub'),
    scrubFill: $('rd-scrub-fill'),
    scrubKnob: $('rd-scrub-knob'),
    scrubLabel: $('rd-scrub-label'),
    modeSeg: $('rd-mode'),
    float: $('rd-float'),
    strip: $('stage-strip'),
    stripInner: $('strip-inner'),
    thumbsPanel: $('thumbs-panel'),
    thumbsScroll: $('thumbs-scroll'),
  };
  E.onClose = opts.onClose || null;

  $('rd-back').onclick = () => closeBook();
  $('rd-more').onclick = openMoreMenu;
  $('rd-theme').onclick = toggleTheme;
  $('rd-dir').onclick = toggleDirection;
  $('rd-fullscreen').onclick = toggleFullscreen;

  E.modeSeg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  bindScrub();
  bindGestures();
  bindStripScroll();
  bindThumbs();

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 260));

  window.addEventListener('popstate', () => {
    if (S.isOpen) closeBook(true);
  });

  // 切到后台时立刻落盘进度，避免被系统杀进程丢数据
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.isOpen) saveProgress();
  });
  window.addEventListener('pagehide', () => { if (S.isOpen) saveProgress(); });

  return E;
}

/* ============================================================
   打开 / 关闭
   ============================================================ */

/** 读取「默认阅读方式 / 默认方向」设置 */
function getDefaults() {
  const s = (DB.getSettings && DB.getSettings()) || {};
  const m = s.defaultMode;
  const mode = (m === 'webtoon' || m === 'spread' || m === 'strip') ? m : 'paged';
  const direction = s.defaultDirection === 'rtl' ? 'rtl' : 'ltr';
  return { mode, direction };
}

export async function openBook(book) {
  S.book = book;

  /* 阅读方式与方向：
     有历史进度 → 接着上次的方式读（不打断）
     没有历史进度（第一次打开这本）→ 用设置里的「默认阅读方式」 */
  const hasProgress = !!book.progress;
  const pref = getDefaults();

  if (hasProgress) {
    S.mode = (book.mode === 'webtoon' || book.mode === 'spread' || book.mode === 'strip')
      ? book.mode : 'paged';
    S.direction = book.direction === 'rtl' ? 'rtl' : 'ltr';
  } else {
    S.mode = pref.mode;
    S.direction = pref.direction;
  }

  S.coverAlone = !!book.coverAlone;
  S.page = 0;
  S.wtRatio = 0;
  S.stripRatio = 0;
  S.stripPage = 0;
  S.units = buildUnits();
  resetZoom();

  E.title.textContent = book.title;
  E.view.classList.add('is-active');
  S.isOpen = true;

  // 任务栏/窗口标题跟着当前书走
  try { window.mangaHost?.setWindowTitle?.(book.title + ' — 漫画阅读器'); } catch (e) { /* noop */ }

  try { history.pushState({ reader: true }, ''); } catch (e) { /* noop */ }

  setModeUI();
  updateDirBtn();

  // PDF / 压缩包在扫描阶段拿不到页数，这里补解析一次
  if (!book.pageCount) {
    try {
      toast('正在解析…', 8000);
      const n = await DB.getArchivePageCount(book.id);
      if (n > 0) book.pageCount = n;
    } catch (err) {
      console.error('[openBook] 解析失败', err);
      toast('这本书解析失败：' + (err.message || err), 4000);
    }
    S.units = buildUnits();
  }

  if (!book.pageCount) {
    toast('这本书没有可显示的页面', 3200);
    S.isOpen = false;
    E.view.classList.remove('is-active');
    try { if (history.state && history.state.reader) history.back(); } catch (e) { /* noop */ }
    try { window.mangaHost?.setWindowTitle?.('漫画阅读器'); } catch (e) { /* noop */ }
    if (E.onClose) E.onClose(book);
    return;
  }

  if (S.mode === 'webtoon') {
    showStage('webtoon');
    await buildWebtoon();
  } else if (S.mode === 'strip') {
    showStage('strip');
    await buildStrip();
  } else {
    showStage('paged');
    S.page = clamp(unitIndexForPage(progressPageOf(book.progress)), 0, Math.max(0, unitCount() - 1));
    await buildFlip();
  }

  syncProgressUI();
  showUI(true);
}

/** 切换显示哪个舞台 */
function showStage(name) {
  const map = { paged: E.paged, webtoon: E.webtoon, strip: E.strip };
  for (const [k, el] of Object.entries(map)) {
    if (!el) continue;
    el.classList.toggle('is-show', k === name);
  }
}

/** 把任意形态的进度记录换算成「页号」 */
function progressPageOf(p) {
  if (!p || !S.book) return 0;
  if (p.mode === 'webtoon') {
    return Math.round((p.scroll || 0) * Math.max(0, S.book.pageCount - 1));
  }
  if (p.mode === 'strip') {
    return clamp(Number(p.page || 0), 0, Math.max(0, S.book.pageCount - 1));
  }
  if (p.mode === 'spread') {
    const u = S.units[p.unit || 0];
    return u ? u[0] : 0;
  }
  return p.page || 0;
}

export async function closeBook(skipHistory) {
  if (!S.isOpen) return;
  await saveProgress();

  S.isOpen = false;
  clearPaged();
  clearWebtoon();
  clearStrip();
  hideThumbs();
  resetZoom();
  hideUI();
  E.view.classList.remove('is-active');

  const book = S.book;
  S.book = null;
  S.units = [];

  try { window.mangaHost?.setWindowTitle?.('漫画阅读器'); } catch (e) { /* noop */ }

  if (!skipHistory) {
    try { if (history.state && history.state.reader) history.back(); } catch (e) { /* noop */ }
  }

  if (E.onClose) E.onClose(book);
}

/* ============================================================
   进度
   ============================================================ */

function currentRatio() {
  if (!S.book || S.book.pageCount <= 1) return 0;
  if (S.mode === 'webtoon') return S.wtRatio;
  if (S.mode === 'strip') return S.stripRatio;
  const n = unitCount();
  return n <= 1 ? 0 : S.page / (n - 1);
}

function syncProgressUI() {
  if (!S.book) return;
  setScrubUI(currentRatio());

  if (S.mode === 'webtoon') {
    E.scrubLabel.textContent = `${pageAtScroll(E.webtoon.scrollTop) + 1} / ${S.book.pageCount}`;
  } else if (S.mode === 'strip') {
    E.scrubLabel.textContent = `${S.stripPage + 1} / ${S.book.pageCount}`;
  } else {
    E.scrubLabel.textContent = unitLabel(S.page);
  }
}

function setScrubUI(r) {
  r = clamp(r, 0, 1);
  E.scrubFill.style.width = (r * 100) + '%';
  E.scrubKnob.style.left = (r * 100) + '%';
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveProgress(); }, 700);
}

async function saveProgress() {
  const book = S.book;
  if (!book) return;

  let progress;
  if (S.mode === 'webtoon') {
    const max = E.webtoon.scrollHeight - E.webtoon.clientHeight;
    const ratio = max > 0 ? E.webtoon.scrollTop / max : 0;
    progress = { mode: 'webtoon', scroll: clamp(ratio, 0, 1) };
  } else if (S.mode === 'strip') {
    progress = { mode: 'strip', page: S.stripPage, scroll: S.stripRatio };
  } else if (S.mode === 'spread') {
    progress = { mode: 'spread', unit: S.page, coverAlone: S.coverAlone };
  } else {
    progress = { mode: 'paged', page: S.page };
  }

  const lastReadAt = Date.now();
  book.progress = progress;
  book.lastReadAt = lastReadAt;
  book.mode = S.mode;
  book.direction = S.direction;
  book.coverAlone = S.coverAlone;

  try {
    await DB.updateBook(book.id, {
      progress, lastReadAt, mode: S.mode, direction: S.direction, coverAlone: S.coverAlone,
    });
  } catch (e) { /* 无痕模式等场景忽略 */ }
}

/* ============================================================
   翻页模式（单页 / 跨页共用）
   ============================================================ */

const stageW = () => E.paged.clientWidth || window.innerWidth || 360;
const stageH = () => E.paged.clientHeight || window.innerHeight || 640;

async function getPage(idx) {
  if (cache.has(idx)) return cache.get(idx);
  const rec = await DB.getPageRecord(S.book.id, idx);
  if (!rec) return null;
  const item = { url: URL.createObjectURL(rec.blob), w: rec.w || 0, h: rec.h || 0 };
  cache.set(idx, item);
  return item;
}

function ensureSlide(idx) {
  if (!S.book) return null;
  if (idx < 0 || idx >= unitCount()) return null;
  if (slides.has(idx)) return slides.get(idx);

  const unit = S.units[idx];

  const el = document.createElement('div');
  el.className = 'slide';
  el.dataset.idx = String(idx);
  el.dataset.pages = unit.join(',');

  const rtl = S.direction === 'rtl' ? ' is-rtl' : '';
  el.innerHTML = `<div class="slide-inner${rtl}">`
    + unit.map((p) => `<div class="pg" data-p="${p}">`
      + '<div class="page-loading"><div class="spinner"></div></div></div>').join('')
    + '</div>';

  E.paged.appendChild(el);
  slides.set(idx, el);
  placeSlide(idx, el);     // 立刻定位到正确位置，否则新建的页会从屏幕中央滑入
  unit.forEach((p) => loadPageInto(el, p));
  return el;
}

async function loadPageInto(el, pageIdx) {
  let item = null;
  try { item = await getPage(pageIdx); } catch (e) { item = null; }
  if (!el.isConnected) return;

  const holder = el.querySelector(`.pg[data-p="${pageIdx}"]`);
  if (!holder) return;

  const clearLoading = () => {
    const ld = holder.querySelector('.page-loading');
    if (ld) ld.remove();
  };

  if (!item) {
    clearLoading();
    holder.insertAdjacentHTML('beforeend', `<div class="page-error">第 ${pageIdx + 1} 页读取失败</div>`);
    return;
  }

  const img = document.createElement('img');
  img.decoding = 'async';
  img.draggable = false;
  img.onload = clearLoading;
  img.onerror = () => {
    clearLoading();
    holder.insertAdjacentHTML('beforeend', `<div class="page-error">第 ${pageIdx + 1} 页解码失败</div>`);
  };
  img.src = item.url;
  holder.appendChild(img);
}

/** 跨页时两张图左右顺序随阅读方向翻转 */
function applySpreadDir() {
  const rtl = S.direction === 'rtl';
  for (const el of slides.values()) {
    const inner = el.querySelector('.slide-inner');
    if (inner) inner.classList.toggle('is-rtl', rtl);
  }
}

/** 按当前单元算出某单元应处的位置 */
function placeSlide(idx, el) {
  const dir = S.direction === 'rtl' ? -1 : 1;
  const off = dir * stageW();
  const d = idx - S.page;

  let x;
  if (d === 0) x = 0;
  else if (d === 1) x = off;
  else if (d === -1) x = -off;
  else x = d > 0 ? off : -off;

  el.style.transform = `translate3d(${x}px,0,0)`;
  el.style.visibility = Math.abs(d) <= 1 ? 'visible' : 'hidden';
}

async function buildFlip() {
  clearPaged();
  ensureSlide(S.page);
  ensureSlide(S.page + 1);
  ensureSlide(S.page - 1);
  layoutPaged(false);
}

function layoutPaged(animate) {
  for (const el of slides.values()) {
    if (animate) el.classList.add('is-anim');
    else el.classList.remove('is-anim');
  }
  if (animate) void E.paged.offsetWidth;   // 强制 reflow，让 transition 生效
  for (const [idx, el] of slides) placeSlide(idx, el);
}

function dragPaged(dx) {
  const dir = S.direction === 'rtl' ? -1 : 1;
  const off = dir * stageW();

  for (const el of slides.values()) el.classList.remove('is-anim');

  const cur = slides.get(S.page);
  if (cur) cur.style.transform = `translate3d(${dx}px,0,0)`;
  const nx = slides.get(S.page + 1);
  if (nx) nx.style.transform = `translate3d(${dx + off}px,0,0)`;
  const pv = slides.get(S.page - 1);
  if (pv) pv.style.transform = `translate3d(${dx - off}px,0,0)`;
}

function releasePaged(dx, speed) {
  const dir = S.direction === 'rtl' ? -1 : 1;
  const W = stageW();
  const thresh = Math.min(W * 0.2, 76);
  const proj = dx * dir;

  let action = 0;
  if (proj < -thresh || (speed * dir < -0.45 && proj < -10)) action = 1;
  else if (proj > thresh || (speed * dir > 0.45 && proj > 10)) action = -1;

  if (action !== 0) {
    const target = S.page + action;
    if (target < 0 || target >= unitCount()) action = 0;
    else ensureSlide(target);
  }

  if (action === 0) { layoutPaged(true); return; }

  S.page += action;
  resetZoom();
  layoutPaged(true);
  afterPageChange();
}

function jump(n) {
  if (!S.book) return;
  n = clamp(n, 0, Math.max(0, unitCount() - 1));
  if (n === S.page) return;
  ensureSlide(n);
  S.page = n;
  resetZoom();
  layoutPaged(true);
  afterPageChange();
}

function afterPageChange() {
  if (S.page + 1 < unitCount()) ensureSlide(S.page + 1);
  syncProgressUI();
  scheduleSave();
  if (pruneTimer) clearTimeout(pruneTimer);
  pruneTimer = setTimeout(prunePaged, 420);
}

function prunePaged() {
  for (const [idx, el] of Array.from(slides)) {
    if (Math.abs(idx - S.page) > 2) {
      const inner = el.querySelector('.slide-inner');
      if (inner) inner.innerHTML = '';
      el.remove();
      slides.delete(idx);
    }
  }

  // 页缓存按「当前单元覆盖到的页」附近保留
  const keep = new Set();
  for (let d = -4; d <= 4; d++) {
    const u = S.units[S.page + d];
    if (u) u.forEach((p) => keep.add(p));
  }
  for (const [idx, item] of Array.from(cache)) {
    if (!keep.has(idx)) {
      URL.revokeObjectURL(item.url);
      cache.delete(idx);
    }
  }
}

function clearPaged() {
  for (const el of slides.values()) el.remove();
  slides.clear();
  if (E.paged) E.paged.innerHTML = '';
  for (const item of cache.values()) URL.revokeObjectURL(item.url);
  cache.clear();
}

/* ============================================================
   条漫模式
   ============================================================ */

function dimOf(book, i) {
  const d = book.dims;
  if (d && d.length >= (i + 1) * 2) {
    const w = d[i * 2], h = d[i * 2 + 1];
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: 0, h: 0 };
}

async function buildWebtoon() {
  clearWebtoon();
  const book = S.book;
  const total = book.pageCount;
  const W = E.webtoon.clientWidth || window.innerWidth || 360;

  const frag = document.createDocumentFragment();
  wtOffsets = new Array(total);
  let y = 0;

  for (let i = 0; i < total; i++) {
    const d = dimOf(book, i);
    const ratio = (d.w && d.h) ? d.h / d.w : 1.5;

    const ph = document.createElement('div');
    ph.className = 'webtoon-ph';
    ph.dataset.idx = String(i);
    ph.style.aspectRatio = `${d.w && d.h ? d.w : 2} / ${d.w && d.h ? d.h : 3}`;

    wtOffsets[i] = y;
    y += W * ratio;

    frag.appendChild(ph);
    wtNodes.push({ el: ph, idx: i, loaded: false });
  }

  E.wtInner.appendChild(frag);

  wtObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const n = wtNodes[Number(en.target.dataset.idx)];
      if (n) loadWtPage(n);
    }
  }, { root: E.webtoon, rootMargin: '1600px 0px 1600px 0px' });

  for (const n of wtNodes) wtObserver.observe(n.el);

  // 恢复进度：优先用自身滚动比例，其次由页号换算
  const p = book.progress;
  let target;
  if (p && p.mode === 'webtoon') target = clamp(p.scroll || 0, 0, 1);
  else target = (progressPageOf(p) || 0) / Math.max(1, total - 1);

  restoreWebtoonScroll(target);
}

async function loadWtPage(node) {
  if (!node || node.loaded) return;
  node.loaded = true;

  let item = null;
  try { item = await getPage(node.idx); } catch (e) { item = null; }
  if (!node.el.isConnected) return;

  if (!item) {
    node.el.classList.add('page-error');
    node.el.textContent = `第 ${node.idx + 1} 页读取失败`;
    return;
  }

  const img = document.createElement('img');
  img.decoding = 'async';
  img.loading = 'lazy';
  img.draggable = false;
  img.onload = () => { node.el.style.aspectRatio = 'auto'; };
  img.src = item.url;
  node.el.appendChild(img);
}

function restoreWebtoonScroll(ratio) {
  if (!E.webtoon) return;
  const apply = () => {
    const max = E.webtoon.scrollHeight - E.webtoon.clientHeight;
    if (max > 0) {
      E.webtoon.scrollTop = ratio * max;
      S.wtRatio = ratio;
      return true;
    }
    return false;
  };
  apply();
  requestAnimationFrame(() => {
    if (!apply()) {
      setTimeout(apply, 80);
      setTimeout(apply, 260);
    }
  });
}

function pageAtScroll(top) {
  if (!wtOffsets.length) return 0;
  const c = top + (E.webtoon.clientHeight || 0) / 2;
  let lo = 0, hi = wtOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (wtOffsets[mid] <= c) lo = mid; else hi = mid - 1;
  }
  return clamp(lo, 0, wtOffsets.length - 1);
}

function onWebtoonScroll() {
  if (S.mode !== 'webtoon' || !S.book) return;

  const max = E.webtoon.scrollHeight - E.webtoon.clientHeight;
  S.wtRatio = max > 0 ? clamp(E.webtoon.scrollTop / max, 0, 1) : 0;

  const idx = pageAtScroll(E.webtoon.scrollTop);
  E.float.textContent = `${idx + 1} / ${S.book.pageCount}`;
  E.float.classList.add('is-show');
  if (floatTimer) clearTimeout(floatTimer);
  floatTimer = setTimeout(() => E.float.classList.remove('is-show'), 1300);

  setScrubUI(S.wtRatio);
  E.scrubLabel.textContent = `${idx + 1} / ${S.book.pageCount}`;

  scheduleSave();

  if (pruneTimer) clearTimeout(pruneTimer);
  pruneTimer = setTimeout(pruneWebtoon, 500);
}

function pruneWebtoon() {
  const st = E.webtoon.scrollTop;
  const ch = E.webtoon.clientHeight || 600;
  const lo = st - ch * 6;
  const hi = st + ch * 7;

  for (const n of wtNodes) {
    if (!n.loaded) continue;
    const top = wtOffsets[n.idx] || 0;
    const h = n.el.offsetHeight || 1;
    if (top + h < lo || top > hi) {
      const img = n.el.querySelector('img');
      if (img) img.remove();
      n.el.style.aspectRatio = (() => {
        const d = dimOf(S.book, n.idx);
        return (d.w && d.h) ? `${d.w} / ${d.h}` : '2 / 3';
      })();
      n.loaded = false;
    }
  }
}

function clearWebtoon() {
  if (wtObserver) { wtObserver.disconnect(); wtObserver = null; }
  if (E.wtInner) E.wtInner.innerHTML = '';
  wtNodes = [];
  wtOffsets = [];
}

/* ============================================================
   长卷模式（横排 · 零间隙）
   ------------------------------------------------------------
   第 1 页在最左，往后依次往右铺开。
   滚轮向下 = 画面往左 = 往后读。
   点画面中心 → 浮出缩略图带。
   ============================================================ */

const MIN_GUESS_RATIO = 0.68;  // 拿不到尺寸时的推测宽高比
const STRIP_CHUNK = 400;       // 超长书分批插格子，每批之间让出主线程

/** 舞台可用高度（图片等高缩放的目标） */
function stripH() {
  return (E.strip && E.strip.clientHeight) || window.innerHeight || 800;
}

/**
 * 建长卷：先只插占位格子（用图片头尺寸算好宽度），再让浏览器按需加载图。
 * 这样 200+ 页的长卷也能瞬间出现，不会卡。
 * 3841 页的书一次性插几千个 DOM 会很卡，所以分批插入。
 */
async function buildStrip() {
  clearStrip();
  const book = S.book;
  if (!book) return;

  const total = book.pageCount;
  const H = stripH();
  const inner = E.stripInner;
  inner.innerHTML = '';

  stripCells = [];
  stripOffsets = new Array(total);
  stripDims = new Array(total);

  let x = 0;
  let batch = document.createDocumentFragment();
  let batchCount = 0;

  for (let i = 0; i < total; i++) {
    const cell = document.createElement('div');
    cell.className = 'strip-cell is-unknown';
    cell.dataset.idx = String(i);
    cell.style.height = H + 'px';
    cell.style.width = (H * MIN_GUESS_RATIO) + 'px';

    stripOffsets[i] = x;
    x += H * MIN_GUESS_RATIO;

    batch.appendChild(cell);
    stripCells.push({ el: cell, idx: i, loaded: false });
    batchCount++;

    if (batchCount >= STRIP_CHUNK) {
      inner.appendChild(batch);
      batch = document.createDocumentFragment();
      batchCount = 0;
      await new Promise((r) => setTimeout(r, 0));
      if (!S.book || S.book.id !== book.id || S.mode !== 'strip') return;
    }
  }

  if (batchCount) inner.appendChild(batch);

  // 异步补真实尺寸（只读文件头，很快）
  refitStrip(book);

  // 懒加载：滚到附近才真正读图
  stripObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const n = stripCells[Number(en.target.dataset.idx)];
      if (n) loadStripPage(n);
    }
  }, { root: E.strip, rootMargin: '0px 3000px 0px 3000px' });

  for (const c of stripCells) stripObserver.observe(c.el);

  // 恢复进度：跳到上次读到的页
  const target = progressPageOf(book.progress);
  requestAnimationFrame(() => scrollToStripPage(target, false));
}

/** 读图片头做精准排版 */
async function refitStrip(book) {
  const total = book.pageCount;
  const H = stripH();
  let dirty = 0;

  for (let i = 0; i < total; i++) {
    if (!S.book || S.book.id !== book.id) return;   // 书已经换了
    if (S.mode !== 'strip') return;

    let d = { w: 0, h: 0 };
    try {
      d = await DB.getDims(book.id, i);
    } catch (e) { d = { w: 0, h: 0 }; }

    stripDims[i] = d;

    const cell = stripCells[i] && stripCells[i].el;
    if (!cell) continue;

    const isUnknown = !(d && d.w && d.h);
    const ratio = isUnknown ? MIN_GUESS_RATIO : (d.w / d.h);
    cell.classList.toggle('is-unknown', isUnknown);
    cell.style.width = Math.max(1, Math.round(H * ratio)) + 'px';
    dirty++;

    // 每 40 页让出一次主线程，避免长书卡死界面
    if (dirty >= 40) {
      dirty = 0;
      recalcStripOffsets();
      await new Promise((r) => setTimeout(r, 0));
      if (!S.book || S.book.id !== book.id || S.mode !== 'strip') return;
    }
  }

  recalcStripOffsets();
  requestAnimationFrame(() => scrollToStripPage(S.stripPage, false));
}

function recalcStripOffsets() {
  let x = 0;
  for (let i = 0; i < stripCells.length; i++) {
    stripOffsets[i] = x;
    x += stripCells[i].el.offsetWidth || 0;
  }
}

/** 加载某一页的图片 */
async function loadStripPage(node) {
  if (!node || node.loaded || !S.book) return;
  node.loaded = true;

  let r = null;
  try { r = await DB.getPageDataUrl(S.book.id, node.idx); } catch (e) { r = null; }

  if (!node.el.isConnected) return;

  if (!r) {
    node.el.classList.add('is-error');
    node.el.textContent = `第 ${node.idx + 1} 页读取失败`;
    return;
  }

  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.onload = () => {
    // 真实尺寸未知时，用解码后的实际宽高修正格子
    if (node.el.classList.contains('is-unknown') && img.naturalWidth && img.naturalHeight) {
      const H = stripH();
      node.el.classList.remove('is-unknown');
      node.el.style.width = Math.round(H * (img.naturalWidth / img.naturalHeight)) + 'px';
      recalcStripOffsets();
    }
  };
  img.onerror = () => {
    node.el.classList.add('is-error');
    node.el.textContent = `第 ${node.idx + 1} 页解码失败`;
  };
  img.src = r.dataUrl;
  node.el.appendChild(img);
}

/** 把某页滚到视野中央 */
function scrollToStripPage(idx, smooth) {
  if (!E.strip || !stripCells.length) return;
  idx = clamp(idx, 0, stripCells.length - 1);

  const cell = stripCells[idx] && stripCells[idx].el;
  if (!cell) return;

  const w = cell.offsetWidth || 1;
  const left = cell.offsetLeft;
  const target = Math.max(0, left - (E.strip.clientWidth - w) / 2);

  if (smooth) E.strip.scrollTo({ left: target, behavior: 'smooth' });
  else E.strip.scrollLeft = target;

  S.stripPage = idx;
  updateStripRatio();
}

/** 滚动时算「当前页」和「整体进度」 */
function updateStripRatio() {
  if (!E.strip || !stripCells.length) return;

  const max = E.strip.scrollWidth - E.strip.clientWidth;
  S.stripRatio = max > 0 ? clamp(E.strip.scrollLeft / max, 0, 1) : 0;

  // 找当前居中的那一页
  const center = E.strip.scrollLeft + E.strip.clientWidth / 2;
  let lo = 0, hi = stripOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stripOffsets[mid] <= center) lo = mid; else hi = mid - 1;
  }
  S.stripPage = clamp(lo, 0, stripCells.length - 1);
}

function onStripScroll() {
  if (S.mode !== 'strip' || !S.book) return;

  updateStripRatio();

  const idx = S.stripPage;
  E.float.textContent = `${idx + 1} / ${S.book.pageCount}`;
  E.float.classList.add('is-show');
  if (floatTimer) clearTimeout(floatTimer);
  floatTimer = setTimeout(() => E.float.classList.remove('is-show'), 1100);

  setScrubUI(S.stripRatio);
  E.scrubLabel.textContent = `${idx + 1} / ${S.book.pageCount}`;

  if (thumbsVisible) markCurrentThumb(idx);

  scheduleSave();
  scheduleStripPrune();
}

function scheduleStripPrune() {
  if (stripPruneTimer) clearTimeout(stripPruneTimer);
  stripPruneTimer = setTimeout(pruneStrip, 700);
}

/** 把远离视野的图片卸掉，防内存爆 */
function pruneStrip() {
  if (!E.strip) return;
  const sl = E.strip.scrollLeft;
  const vw = E.strip.clientWidth || 1000;
  const lo = sl - vw * 3;
  const hi = sl + vw * 4;

  for (const c of stripCells) {
    if (!c.loaded) continue;
    const left = stripOffsets[c.idx] || 0;
    const w = c.el.offsetWidth || 1;
    if (left + w < lo || left > hi) {
      const img = c.el.querySelector('img');
      if (img) img.remove();
      c.loaded = false;
    }
  }
}

function clearStrip() {
  if (stripObserver) { stripObserver.disconnect(); stripObserver = null; }
  if (stripPruneTimer) { clearTimeout(stripPruneTimer); stripPruneTimer = null; }
  if (E.stripInner) E.stripInner.innerHTML = '';
  stripCells = [];
  stripOffsets = [];
  stripDims = [];
}

/** 长卷：滚轮横向移动 */
function bindStripScroll() {
  if (!E.strip) return;
  E.strip.addEventListener('scroll', onStripScroll, { passive: true });

  // 竖向滚轮 → 横向移动（向下 = 往左 = 往后读）
  E.strip.addEventListener('wheel', (e) => {
    if (!S.book || !isStrip()) return;

    let delta = 0;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      delta = e.deltaX;                      // 触控板横向手势
    } else {
      const step = (DB.getSettings() || {}).wheelStep || 0.08;
      delta = e.deltaY * (E.strip.clientWidth * step) / 100 * 1.6;
    }

    if (!delta) return;
    e.preventDefault();
    E.strip.scrollLeft += delta;
  }, { passive: false });
}

/* ============================================================
   缩略图带
   ============================================================ */

function thumbsEnabled() {
  const s = DB.getSettings() || {};
  return s.thumbsEnabled !== false;
}

/**
 * 只生成当前页附近 ±30 页的缩略图，避免一次建 200+ 张图卡死。
 * 滚到新位置时按需补远处。
 */
async function buildThumbs(current) {
  if (!E.thumbsScroll || !S.book) return;
  if (!thumbsEnabled()) { E.thumbsScroll.innerHTML = ''; return; }

  const total = S.book.pageCount;
  const from = Math.max(0, current - 30);
  const to = Math.min(total - 1, current + 30);

  // 已经是这个区间了就不重建
  if (thumbNodes.length) {
    const have = thumbNodes.map((n) => n.idx);
    const min = Math.min.apply(null, have);
    const max = Math.max.apply(null, have);
    if (from >= min && to <= max) {
      markCurrentThumb(current);
      return;
    }
  }

  thumbNodes = [];
  E.thumbsScroll.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (let i = from; i <= to; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.idx = String(i);
    item.innerHTML = `<div class="thumb-box"></div><span class="thumb-num">${i + 1}</span>`;
    item.onclick = () => scrollToStripPage(i, true);
    frag.appendChild(item);
    thumbNodes.push({ el: item, idx: i, loaded: false });
  }
  E.thumbsScroll.appendChild(frag);

  // 可见的才加载缩略图
  if (thumbIO) thumbIO.disconnect();
  thumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const n = thumbNodes.find((t) => t.el === en.target);
      if (n) loadThumb(n);
    }
  }, { root: E.thumbsScroll, rootMargin: '200px 0px' });

  for (const n of thumbNodes) thumbIO.observe(n.el);

  markCurrentThumb(current);
}

async function loadThumb(node) {
  if (!node || node.loaded || !S.book) return;
  node.loaded = true;

  let r = null;
  try { r = await DB.getPageDataUrl(S.book.id, node.idx); } catch (e) { r = null; }
  if (!r || !node.el.isConnected) return;

  const box = node.el.querySelector('.thumb-box');
  if (!box) return;

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = r.dataUrl;
  box.appendChild(img);
}

function markCurrentThumb(idx) {
  for (const n of thumbNodes) {
    n.el.classList.toggle('is-current', n.idx === idx);
  }
  const cur = thumbNodes.find((n) => n.idx === idx);
  if (cur && E.thumbsScroll) {
    const left = cur.el.offsetLeft;
    const w = cur.el.offsetWidth;
    const vw = E.thumbsScroll.clientWidth;
    const sl = E.thumbsScroll.scrollLeft;
    if (left < sl + 20 || left + w > sl + vw - 20) {
      E.thumbsScroll.scrollTo({ left: left - vw / 2 + w / 2, behavior: 'smooth' });
    }
  }
}

/* ------------------------------------------------------------
   缩略图带
   ------------------------------------------------------------
   v1.1 之后它嵌在底部工具栏里（进度条上方），跟着工具栏一起升降。
   所以这里不再单独控制「浮层」，而是统一由 showUI / toggleUI 驱动：
     · 点画面中部 → 工具栏和缩略图带一起出现
     · 再点一次   → 一起隐藏
   缩略图带自身的 is-show 只用来展开/收起它那一行的高度。
   ------------------------------------------------------------ */

function toggleThumbs() {
  if (!S.book || !isStrip()) { toggleUI(); return; }
  // 跟工具栏保持同一节奏：工具栏现在显示，就把缩略图带也打开
  if (thumbsVisible) {
    hideThumbs();
    showUI();          // 工具栏留着（隐藏缩略图带后仍可操作进度条）
  } else {
    showThumbs();
  }
}

async function showThumbs() {
  if (!S.book || !E.thumbsPanel) return;
  if (!thumbsEnabled()) return;

  // 先置位再 showUI：showUI 看到 thumbsVisible 就不会启动自动隐藏
  thumbsVisible = true;
  E.thumbsPanel.classList.add('is-show');
  showUI(false);
  await buildThumbs(S.stripPage);
}

function hideThumbs() {
  thumbsVisible = false;
  if (E.thumbsPanel) E.thumbsPanel.classList.remove('is-show');
}

function bindThumbs() {
  if (!E.thumbsPanel) return;
  E.thumbsPanel.addEventListener('click', (e) => {
    if (e.target === E.thumbsPanel) return;
  });
}

/* ============================================================
   缩放
   ============================================================ */

function applyZoom() {
  const el = slides.get(S.page);
  const inner = el && el.querySelector('.slide-inner');
  if (inner) inner.style.transform = `translate3d(${S.tx}px,${S.ty}px,0) scale(${S.scale})`;
}

function clampPan() {
  if (S.scale <= 1.01) { S.tx = 0; S.ty = 0; return; }
  const mx = (stageW() * (S.scale - 1)) / 2;
  const my = (stageH() * (S.scale - 1)) / 2;
  S.tx = clamp(S.tx, -mx, mx);
  S.ty = clamp(S.ty, -my, my);
}

function resetZoom() {
  S.scale = 1;
  S.tx = 0;
  S.ty = 0;
  // 清掉所有页残留的缩放，避免切页回来还停在上次的放大状态
  for (const el of slides.values()) {
    const inner = el.querySelector('.slide-inner');
    if (inner) inner.style.transform = '';
  }
}

function toggleZoom() {
  if (S.scale > 1.01) resetZoom();
  else { S.scale = 2.4; S.tx = 0; S.ty = 0; clampPan(); applyZoom(); }
}

/* ============================================================
   手势
   ============================================================ */

function dist(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function bindGestures() {
  const el = E.stage;
  let g = null;

  el.addEventListener('touchstart', (e) => {
    if (!S.book) return;

    if (e.touches.length === 2) {
      g = {
        type: 'zoom',
        d0: dist(e.touches[0], e.touches[1]) || 1,
        s0: S.scale,
      };
      return;
    }

    const t = e.touches[0];
    if (!t) return;

    g = {
      type: S.scale > 1.01 ? 'pan' : 'swipe',
      x0: t.clientX,
      y0: t.clientY,
      t0: Date.now(),
      dx: 0,
      dy: 0,
      axis: null,
      moved: false,
      tx0: S.tx,
      ty0: S.ty,
    };
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!g || !S.book) return;

    if (g.type === 'zoom' && e.touches.length === 2) {
      if (!isFlip()) return;
      const d = dist(e.touches[0], e.touches[1]);
      S.scale = clamp(g.s0 * (d / g.d0), 1, 6);
      clampPan();
      applyZoom();
      if (e.cancelable) e.preventDefault();
      return;
    }

    const t = e.touches[0];
    if (!t) return;

    g.dx = t.clientX - g.x0;
    g.dy = t.clientY - g.y0;

    if (g.type === 'pan') {
      if (!isFlip()) return;
      S.tx = g.tx0 + g.dx;
      S.ty = g.ty0 + g.dy;
      clampPan();
      applyZoom();
      if (e.cancelable) e.preventDefault();
      return;
    }

    if (!isFlip()) return;

    if (!g.axis) {
      if (Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy)) g.axis = 'x';
      else if (Math.abs(g.dy) > 12) g.axis = 'y';
      else return;
    }

    if (g.axis !== 'x') return;

    if (e.cancelable) e.preventDefault();
    g.moved = true;
    dragPaged(g.dx);
  }, { passive: false });

  el.addEventListener('touchend', (e) => {
    lastTouchAt = Date.now();
    if (!g || !S.book) { g = null; return; }

    if (g.type === 'zoom') {
      if (e.touches && e.touches.length >= 2) return;
      g = null;
      if (S.scale < 1.1) resetZoom();
      else { clampPan(); applyZoom(); }
      return;
    }

    if (g.type === 'pan') { g = null; return; }

    const gg = g;
    g = null;
    const dt = Math.max(1, Date.now() - gg.t0);

    if (!gg.moved && Math.abs(gg.dx) < 10 && Math.abs(gg.dy) < 10 && dt < 320) {
      handleTap(gg.x0, gg.y0);
      return;
    }

    if (gg.axis === 'x') releasePaged(gg.dx, gg.dx / dt);
  }, { passive: true });

  el.addEventListener('touchcancel', () => { g = null; });

  /* ---------------- 桌面端：鼠标 ---------------- */

  // 鼠标点击。触摸会产生一次合成 click，靠 lastTouchAt 排掉，否则一次触摸触发两遍。
  el.addEventListener('click', (e) => {
    if (!S.book) return;
    if (Date.now() - lastTouchAt < 600) return;
    ctrlSolo = false;                      // Ctrl+点击 不算「单独按 Ctrl」
    singleTap(e.clientX, e.clientY);
  });

  // 滚轮翻页
  el.addEventListener('wheel', (e) => {
    if (ctrlSolo) ctrlSolo = false;        // Ctrl+滚轮（缩放）不算
    if (!S.book || !isFlip()) return;
    if (Math.abs(e.deltaY) < 12) return;
    if (e.deltaY > 0) jump(S.page + 1); else jump(S.page - 1);
  }, { passive: true });

  /* ---------------- 键盘 ---------------- */

  window.addEventListener('keydown', (e) => {
    if (!S.isOpen) return;

    // 左 Ctrl 单独短按 = 切换 单页/跨页。
    // 只在「按下期间没碰别的键、鼠标也没动」时才算，避免抢走 Ctrl+C 之类的组合键。
    if (e.code === 'ControlLeft') {
      ctrlSolo = true;
      ctrlAt = Date.now();
      return;
    }
    if (ctrlSolo) ctrlSolo = false;

    // 空格 = 显示 / 隐藏工具栏
    if (e.code === 'Space') {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;   // 输入框里照常打空格
      e.preventDefault();
      toggleUI();
      return;
    }

    if (e.key === 'ArrowLeft') {
      if (isFlip()) { if (S.direction === 'rtl') jump(S.page + 1); else jump(S.page - 1); }
      else if (isStrip()) jumpStripPage(S.stripPage - 1, true);
    } else if (e.key === 'ArrowRight') {
      if (isFlip()) { if (S.direction === 'rtl') jump(S.page - 1); else jump(S.page + 1); }
      else if (isStrip()) jumpStripPage(S.stripPage + 1, true);
    } else if (e.key === 'Escape') {
      if (thumbsVisible) { hideThumbs(); return; }
      closeBook();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'ControlLeft') return;
    const dur = Date.now() - ctrlAt;
    const solo = ctrlSolo;
    ctrlSolo = false;
    if (!solo || !S.isOpen || dur > 500) return;
    toggleSpread();
  });
}

/** 左 Ctrl 快捷键：在单页与跨页之间来回切 */
async function toggleSpread() {
  if (!S.book || S.mode === 'webtoon' || S.mode === 'strip') return;
  const next = S.mode === 'spread' ? 'paged' : 'spread';
  await setMode(next);
  toast(next === 'spread' ? '跨页模式' : '单页模式', 900);
}

function handleTap(x, y) {
  if (tapTimer) {
    clearTimeout(tapTimer);
    tapTimer = null;
    if (isFlip()) { toggleZoom(); return; }
    if (isStrip()) { jumpStripPage(S.stripPage + 1, true); return; }
    return;
  }
  tapTimer = setTimeout(() => {
    tapTimer = null;
    singleTap(x, y);
  }, 230);
}

/** 长卷：跳到指定页 */
function jumpStripPage(idx, smooth) {
  scrollToStripPage(idx, smooth !== false);
  syncProgressUI();
  scheduleSave();
}

function singleTap(x, y) {
  if (!S.book) return;

  if (S.mode === 'webtoon') { toggleUI(); return; }

  // 长卷：点画面中心 → 工具栏 + 缩略图带一起显隐；点左右 → 前后翻页
  if (isStrip()) {
    const cx = (window.innerWidth || 1) / 2;
    const cy = (window.innerHeight || 1) / 2;
    const nearCenter = Math.abs(x - cx) < (window.innerWidth * 0.28)
      && Math.abs(y - cy) < (window.innerHeight * 0.3);

    if (nearCenter) { toggleToolbarWithThumbs(); return; }

    if (x < cx) jumpStripPage(S.stripPage - 1, true);
    else jumpStripPage(S.stripPage + 1, true);
    return;
  }

  if (S.scale > 1.01) { toggleUI(); return; }

  const r = x / (window.innerWidth || 1);
  const dir = S.direction === 'rtl' ? -1 : 1;

  if (r < 0.34) { if (dir === 1) jump(S.page - 1); else jump(S.page + 1); }
  else if (r > 0.66) { if (dir === 1) jump(S.page + 1); else jump(S.page - 1); }
  else toggleUI();
}

/* ============================================================
   模式 / 方向 / 主题 / 全屏
   ============================================================ */

function setModeUI() {
  E.modeSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.mode === S.mode);
  });
}

function updateDirBtn() {
  const btn = $('rd-dir');
  btn.innerHTML = `<span style="font-size:11.5px;font-weight:700;letter-spacing:.5px">${S.direction === 'rtl' ? 'R→L' : 'L→R'}</span>`;
  btn.title = S.direction === 'rtl' ? '从右往左（日漫）' : '从左往右';
  btn.style.cssText = 'width:auto;min-width:44px;padding:0 8px';
}

async function setMode(mode) {
  if (!S.book || mode === S.mode) return;

  await saveProgress();
  const startPage = currentStartPage();

  S.mode = mode;
  S.units = buildUnits();
  setModeUI();

  if (mode === 'webtoon') {
    showStage('webtoon');
    clearPaged();
    clearStrip();
    hideThumbs();
    S.book.progress = { mode: 'webtoon', scroll: startPage / Math.max(1, S.book.pageCount - 1) };
    await buildWebtoon();
  } else if (mode === 'strip') {
    showStage('strip');
    clearPaged();
    clearWebtoon();
    S.book.progress = { mode: 'strip', page: startPage };
    S.stripPage = startPage;
    await buildStrip();
  } else {
    showStage('paged');
    clearWebtoon();
    clearStrip();
    hideThumbs();
    S.page = clamp(unitIndexForPage(startPage), 0, Math.max(0, unitCount() - 1));
    await buildFlip();

    if (mode === 'spread' && !spreadHintShown
      && window.innerWidth < 620 && window.innerHeight > window.innerWidth) {
      spreadHintShown = true;
      toast('跨页在竖屏下偏窄 · 横屏或双指放大更清楚', 2800);
    }
  }

  syncProgressUI();
  scheduleSave();
}

async function toggleCoverAlone() {
  if (!S.book) return;
  const startPage = currentStartPage();

  S.coverAlone = !S.coverAlone;
  S.book.coverAlone = S.coverAlone;

  if (S.mode === 'spread') {
    S.units = buildUnits();
    S.page = clamp(unitIndexForPage(startPage), 0, Math.max(0, unitCount() - 1));
    await buildFlip();
    syncProgressUI();
  }

  scheduleSave();
  toast(S.coverAlone ? '首页单独显示：开' : '首页单独显示：关', 1400);
}

function toggleDirection() {
  S.direction = S.direction === 'rtl' ? 'ltr' : 'rtl';
  updateDirBtn();
  if (isFlip()) {
    layoutPaged(false);
    applySpreadDir();   // 跨页时左右两页要跟着换位
  }
  scheduleSave();
  toast(S.direction === 'rtl' ? '翻页方向：从右往左（日漫）' : '翻页方向：从左往右', 1400);
}

export function applyTheme(theme) {
  const t = theme || (() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; } })();
  document.documentElement.dataset.theme = t;
  syncThemeColor(t);
  return t;
}

/**
 * 同步浏览器/系统栏配色。
 *
 * 分工（查证过）：
 * - theme-color       → 管 Android 地址栏/状态栏，可动态改
 * - color-scheme      → 告诉浏览器页面支持哪些配色，可动态改
 * - apple-mobile-web-app-status-bar-style → 只管 iOS PWA 状态栏，
 *   取值只有 default(白底黑字) / black(黑底白字) / black-translucent(半透黑底+白字)。
 *   ⚠️ iOS 只在「添加到主屏幕」时读一次，运行时改无效，所以这里不碰它，
 *   固定用 index.html 里静态的 default，避免浅色模式下出现黑框。
 */
const THEME_COLORS = { dark: '#0b0b0d', light: '#f4f4f6' };

function syncThemeColor(t) {
  const isLight = t === 'light';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', isLight ? THEME_COLORS.light : THEME_COLORS.dark);

  const scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', isLight ? 'light dark' : 'dark light');
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  syncThemeColor(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* noop */ }
  toast(next === 'light' ? '浅色模式' : '深色模式', 1200);
}

function toggleFullscreen() {
  const d = document;
  const isFs = d.fullscreenElement || d.webkitFullscreenElement;
  if (!isFs) {
    const el = d.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) fn.call(el).catch(() => toast('当前浏览器不支持全屏', 1500));
    else toast('iOS 上可将页面「添加到主屏幕」获得全屏体验', 2400);
  } else {
    const fn = d.exitFullscreen || d.webkitExitFullscreen;
    if (fn) fn.call(d);
  }
}

/* ============================================================
   UI 显隐
   ============================================================ */

function showUI(autoHide) {
  E.ui.classList.add('is-show');
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = null;

  /* 缩略图带展开时不自动收工具栏：
     用户正在挑图，4 秒后突然整条消失会很难用。
     等他挑完（点缩略图跳页 / 再点画面）才恢复自动隐藏。 */
  if (thumbsVisible) return;

  if (autoHide !== false) {
    // 进入阅读器时多停一会儿，让用户看清有哪些操作
    uiTimer = setTimeout(hideUI, 4200);
  }
}

function hideUI() {
  E.ui.classList.remove('is-show');
  if (uiTimer) { clearTimeout(uiTimer); uiTimer = null; }
  // 缩略图带是同一条工具栏的一部分，工具栏收了它也收
  if (thumbsVisible) hideThumbs();
}

function toggleUI() {
  if (E.ui.classList.contains('is-show')) hideUI();
  else showUI(true);
}

/** 工具栏是否可见 */
function uiVisible() {
  return !!(E.ui && E.ui.classList.contains('is-show'));
}

/* ------------------------------------------------------------
   长卷模式下的「点画面中部」
   ------------------------------------------------------------
   需求：点一下，工具栏和缩略图带一起出现；再点一下，一起隐藏。
   所以这里以「工具栏是否可见」作为唯一状态，两者同步。
   ------------------------------------------------------------ */
async function toggleToolbarWithThumbs() {
  if (!S.book || !isStrip()) { toggleUI(); return; }

  if (uiVisible()) {
    hideUI();                     // 会顺带 hideThumbs()
  } else {
    showUI();                     // 先让工具栏升起
    await showThumbs();           // 缩略图带在同一行里展开
  }
}

/* ============================================================
   进度条拖动
   ============================================================ */

function bindScrub() {
  let dragging = false;

  const clientXOf = (e) => (e.touches && e.touches[0] ? e.touches[0].clientX
    : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : e.clientX));

  const ratioOf = (e) => {
    const r = E.scrub.getBoundingClientRect();
    return clamp((clientXOf(e) - r.left) / (r.width || 1), 0, 1);
  };

  const preview = (r) => {
    setScrubUI(r);
    if (!S.book) return;
    if (S.mode === 'webtoon' || S.mode === 'strip') {
      const idx = clamp(Math.round(r * (S.book.pageCount - 1)), 0, S.book.pageCount - 1);
      E.scrubLabel.textContent = `${idx + 1} / ${S.book.pageCount}`;
    } else {
      const n = unitCount();
      E.scrubLabel.textContent = unitLabel(clamp(Math.round(r * Math.max(0, n - 1)), 0, Math.max(0, n - 1)));
    }
  };

  const start = (e) => {
    if (!S.book) return;
    dragging = true;
    E.scrub.classList.add('is-drag');
    showUI(false);
    preview(ratioOf(e));
    if (e.cancelable) e.preventDefault();
  };

  const move = (e) => {
    if (!dragging) return;
    preview(ratioOf(e));
    if (e.cancelable) e.preventDefault();
  };

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    E.scrub.classList.remove('is-drag');

    const r = ratioOf(e);
    if (!S.book) return;

    if (isFlip()) {
      const n = unitCount();
      jump(clamp(Math.round(r * Math.max(0, n - 1)), 0, Math.max(0, n - 1)));
    } else if (isStrip()) {
      const idx = clamp(Math.round(r * (S.book.pageCount - 1)), 0, S.book.pageCount - 1);
      jumpStripPage(idx, false);
    } else {
      const max = E.webtoon.scrollHeight - E.webtoon.clientHeight;
      E.webtoon.scrollTop = r * Math.max(0, max);
    }
    showUI(true);
  };

  E.scrub.addEventListener('touchstart', start, { passive: false });
  E.scrub.addEventListener('touchmove', move, { passive: false });
  E.scrub.addEventListener('touchend', end);
  E.scrub.addEventListener('touchcancel', () => { dragging = false; E.scrub.classList.remove('is-drag'); });

  E.scrub.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
}

/* ============================================================
   更多菜单
   ============================================================ */

async function openMoreMenu() {
  if (!S.book) return;
  showUI(false);

  const modeName = { paged: '单页', spread: '跨页', webtoon: '条漫', strip: '长卷' }[S.mode] || S.mode;

  const items = [
    { label: '跳转到页码', sub: `1 – ${S.book.pageCount}`, value: 'goto', icon: 'list' },
    { label: '翻页方向', sub: S.direction === 'rtl' ? '从右往左（日漫）' : '从左往右', value: 'dir', icon: 'sort' },
    {
      label: '缩略图带',
      sub: thumbsEnabled() ? '开 · 长卷模式下点画面中心浮现' : '关 · 只保留进度条',
      value: 'thumbs',
      icon: thumbsEnabled() ? 'check' : undefined,
    },
  ];

  if (S.mode === 'spread') {
    items.push({
      label: '首页单独显示',
      sub: S.coverAlone ? '开 · 封面不参与配对（日漫惯例）' : '关 · 从第 1 页起两两配对',
      value: 'coverAlone',
      icon: S.coverAlone ? 'check' : undefined,
    });
  }

  items.push({ label: '标记为已读完', value: 'done', icon: 'check' });

  const v = await sheet({ title: `${S.book.title} · ${modeName}`, items });

  if (v === 'goto') {
    const input = await promptInput({
      title: '跳转到页码',
      value: String(currentStartPage() + 1),
      placeholder: `1 - ${S.book.pageCount}`,
      okText: '跳转',
    });
    const n = parseInt(input, 10);
    if (!Number.isNaN(n)) {
      const page = clamp(n - 1, 0, S.book.pageCount - 1);
      if (isFlip()) jump(unitIndexForPage(page));
      else if (isStrip()) jumpStripPage(page, true);
      else {
        E.webtoon.scrollTop = (page / Math.max(1, S.book.pageCount - 1))
          * Math.max(0, E.webtoon.scrollHeight - E.webtoon.clientHeight);
      }
    }
    showUI(true);
  } else if (v === 'dir') {
    toggleDirection();
    showUI(true);
  } else if (v === 'thumbs') {
    const on = !thumbsEnabled();
    await DB.setSettings({ thumbsEnabled: on });
    if (!on) hideThumbs();
    toast(on ? '缩略图带：开' : '缩略图带：关（更省性能）', 1600);
    showUI(true);
  } else if (v === 'coverAlone') {
    await toggleCoverAlone();
    showUI(true);
  } else if (v === 'done') {
    if (S.mode === 'webtoon') {
      E.webtoon.scrollTop = E.webtoon.scrollHeight;
    } else if (isStrip()) {
      jumpStripPage(S.book.pageCount - 1, true);
    } else {
      jump(unitCount() - 1);
    }
    await saveProgress();
    toast('已标记为读完');
    showUI(true);
  } else {
    showUI(true);
  }
}

/* ============================================================
   尺寸变化
   ============================================================ */

function onResize() {
  if (!S.book) return;
  if (isFlip()) {
    layoutPaged(false);
    clampPan();
    applyZoom();
  } else if (isStrip()) {
    // 长卷按舞台高度等高排版，窗口变了要重排
    const H = stripH();
    for (let i = 0; i < stripCells.length; i++) {
      const cell = stripCells[i].el;
      const d = stripDims[i];
      const isUnknown = !(d && d.w && d.h);
      const ratio = isUnknown ? MIN_GUESS_RATIO : (d.w / d.h);
      cell.style.height = H + 'px';
      cell.style.width = Math.max(1, Math.round(H * ratio)) + 'px';
    }
    recalcStripOffsets();
    requestAnimationFrame(() => scrollToStripPage(S.stripPage, false));
  } else {
    // 重算偏移
    const book = S.book;
    const W = E.webtoon.clientWidth || window.innerWidth || 360;
    let y = 0;
    for (let i = 0; i < book.pageCount; i++) {
      const d = dimOf(book, i);
      const ratio = (d.w && d.h) ? d.h / d.w : 1.5;
      wtOffsets[i] = y;
      y += W * ratio;
    }
    restoreWebtoonScroll(S.wtRatio);
  }
}

/* ============================================================
   滚动监听
   ============================================================ */

export function attachScroll() {
  if (E.webtoon) E.webtoon.addEventListener('scroll', onWebtoonScroll, { passive: true });
}

export function getState() {
  return S;
}
