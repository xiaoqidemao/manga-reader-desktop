/* ============================================================
   ui.js · 通用交互层（toast / 抽屉 / 对话框 / 进度浮层）
   ============================================================ */

const ICONS = {
  back: '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4h8v2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  archive: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>',
  sort: '<path d="M3 6h18M6 12h12M10 18h4"/>',
  theme: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H20z"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  storage: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};

export function icon(name, cls = '') {
  const d = ICONS[name] || '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" `
    + `stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''}>${d}</svg>`;
}

/* ---------------- toast ---------------- */

let toastWrap = null;

export function toast(msg, ms = 2000) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastWrap.appendChild(el);

  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 240);
  }, ms);

  return el;
}

/* ---------------- 底部抽屉 ---------------- */

let maskEl = null;
let sheetEl = null;
let sheetResolve = null;

function ensureLayers() {
  if (maskEl) return;
  maskEl = document.createElement('div');
  maskEl.className = 'sheet-mask';
  maskEl.addEventListener('click', () => {
    if (sheetResolve) closeSheet(null);
    else if (dialogResolve) closeDialog(null);
  });
  document.body.appendChild(maskEl);
}

function closeSheet(v) {
  if (!sheetEl) return;
  sheetEl.classList.remove('is-show');
  maskEl.classList.remove('is-show');
  const el = sheetEl;
  const res = sheetResolve;
  sheetEl = null;
  sheetResolve = null;
  setTimeout(() => el.remove(), 320);
  if (res) res(v);
}

/**
 * @param {{title?:string, items:Array<{label:string,sub?:string,value:any,icon?:string,danger?:boolean}>}} o
 * @returns {Promise<any|null>}
 */
export function sheet(o) {
  ensureLayers();
  if (sheetEl) closeSheet(null);

  sheetEl = document.createElement('div');
  sheetEl.className = 'sheet';

  let html = '<div class="sheet-grip"></div>';
  if (o.title) html += `<div class="sheet-title">${o.title}</div>`;

  (o.items || []).forEach((it, i) => {
    html += `<button class="sheet-item${it.danger ? ' danger' : ''}" data-i="${i}">`
      + (it.icon ? icon(it.icon) : '')
      + `<span>${it.label}${it.sub ? `<span class="sub">${it.sub}</span>` : ''}</span>`
      + '</button>';
  });

  sheetEl.innerHTML = html;
  document.body.appendChild(sheetEl);

  sheetEl.querySelectorAll('.sheet-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const it = o.items[Number(btn.dataset.i)];
      closeSheet(it.value);
    });
  });

  requestAnimationFrame(() => {
    maskEl.classList.add('is-show');
    sheetEl.classList.add('is-show');
  });

  return new Promise((r) => { sheetResolve = r; });
}

/* ---------------- 对话框 ---------------- */

let dialogEl = null;
let dialogResolve = null;

function closeDialog(v) {
  if (!dialogEl) return;
  dialogEl.classList.remove('is-show');
  maskEl.classList.remove('is-show');
  const el = dialogEl;
  const res = dialogResolve;
  dialogEl = null;
  dialogResolve = null;
  setTimeout(() => el.remove(), 220);
  if (res) res(v);
}

function openDialog(html, onMount) {
  ensureLayers();
  if (sheetEl) closeSheet(null);
  if (dialogEl) closeDialog(null);

  dialogEl = document.createElement('div');
  dialogEl.className = 'dialog';
  dialogEl.innerHTML = html;
  document.body.appendChild(dialogEl);

  onMount && onMount(dialogEl);

  requestAnimationFrame(() => {
    maskEl.classList.add('is-show');
    dialogEl.classList.add('is-show');
  });

  return new Promise((r) => { dialogResolve = r; });
}

export function confirm(o = {}) {
  const { title = '确认', desc = '', okText = '确定', cancelText = '取消', danger = false } = o;
  return openDialog(
    `<h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}`
    + `<div class="acts">`
    + `<button data-act="cancel">${cancelText}</button>`
    + `<button data-act="ok" class="${danger ? 'danger' : 'primary'}">${okText}</button>`
    + '</div>',
    (el) => {
      el.querySelector('[data-act="cancel"]').onclick = () => closeDialog(false);
      el.querySelector('[data-act="ok"]').onclick = () => closeDialog(true);
    }
  );
}

export function promptInput(o = {}) {
  const { title = '重命名', value = '', placeholder = '', okText = '保存' } = o;
  return openDialog(
    `<h3>${title}</h3>`
    + `<input class="text-input" type="text" value="${String(value).replace(/"/g, '&quot;')}" placeholder="${placeholder}">`
    + `<div class="acts">`
    + '<button data-act="cancel">取消</button>'
    + `<button data-act="ok" class="primary">${okText}</button>`
    + '</div>',
    (el) => {
      const input = el.querySelector('.text-input');
      const done = () => closeDialog((input.value || '').trim() || null);
      el.querySelector('[data-act="cancel"]').onclick = () => closeDialog(null);
      el.querySelector('[data-act="ok"]').onclick = done;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
      setTimeout(() => { input.focus(); input.select(); }, 60);
    }
  );
}

/* ---------------- 导入进度浮层 ---------------- */

let busyEl = null;

export const busy = {
  show(title = '正在导入', file = '') {
    if (!busyEl) {
      busyEl = document.createElement('div');
      busyEl.className = 'importing';
      busyEl.innerHTML = '<h3></h3><div class="file"></div>'
        + '<div class="bar-track"><div class="bar-fill"></div></div>'
        + '<div class="pct"></div>';
      document.body.appendChild(busyEl);
    }
    busyEl.querySelector('h3').textContent = title;
    busyEl.querySelector('.file').textContent = file;
    busyEl.querySelector('.bar-fill').style.width = '0%';
    busyEl.querySelector('.pct').textContent = '';
    requestAnimationFrame(() => busyEl.classList.add('is-show'));
  },

  update(done, total, note) {
    if (!busyEl) return;
    const pct = total ? Math.round((done / total) * 100) : 0;
    busyEl.querySelector('.bar-fill').style.width = pct + '%';
    busyEl.querySelector('.pct').textContent = note || `${done} / ${total} 页 · ${pct}%`;
  },

  stage(text) {
    if (!busyEl) return;
    busyEl.querySelector('.file').textContent = text;
  },

  hide() {
    if (!busyEl) return;
    busyEl.classList.remove('is-show');
    const el = busyEl;
    busyEl = null;
    setTimeout(() => el.remove(), 240);
  },
};

/* ---------------- 工具 ---------------- */

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (x) => String(x).padStart(2, '0');
  if (sameDay) return `今天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

export function haptic(ms = 8) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* noop */ } }
}
