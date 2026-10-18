/* ============================================================
   pdf.js · PDF → 逐页图片
   pdfjs-dist 走动态 import，只有真正导入 PDF 时才下载，
   不影响首屏；下载后由 Service Worker 缓存，离线也能用。
   ============================================================ */

const TARGET_W = 1600;   // 渲染目标宽度：够手机看清，又不至于把体积做爆
const MAX_H = 4000;      // 单页最大高度，防超长页撑爆 canvas
const QUALITY = 0.88;

let libPromise = null;

function loadLib() {
  if (libPromise) return libPromise;

  libPromise = import('../vendor/pdf.min.mjs')
    .then((mod) => {
      const lib = (mod && mod.getDocument) ? mod : mod.default;
      if (!lib || !lib.getDocument) throw new Error('模块结构不符合预期');
      const workerUrl = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      lib.GlobalWorkerOptions.workerSrc = workerUrl;
      return lib;
    })
    .catch((err) => {
      libPromise = null;   // 失败不缓存，允许重试
      throw new Error('PDF 引擎加载失败：' + ((err && err.message) || err));
    });

  return libPromise;
}

/** 按魔数 / 扩展名判断是不是 PDF */
async function looksLikePdf(file) {
  if (/\.pdf$/i.test(file.name || '')) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF-
  } catch (e) {
    return false;
  }
}

/** 渲染单页为 JPEG Blob */
async function renderPage(doc, pageNo) {
  const page = await doc.getPage(pageNo);

  try {
    const base = page.getViewport({ scale: 1 });
    let scale = base.width > 0 ? TARGET_W / base.width : 1;
    if (base.height * scale > MAX_H) scale = MAX_H / base.height;
    scale = Math.max(scale, 0.1);

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', QUALITY));
    if (!blob) throw new Error(`第 ${pageNo} 页渲染结果为空`);
    return blob;
  } finally {
    try { page.cleanup(); } catch (e) { /* noop */ }
  }
}

/**
 * 把 PDF 拆成「逐页可读」的列表，结构与 zip.js 的 listZipImages 一致
 * @returns {Promise<{pages:Array, dispose:()=>void, pageCount:number}>}
 */
async function listPdfPages(file, opts = {}) {
  const lib = await loadLib();
  if (opts.onStage) opts.onStage('正在把 PDF 转成图片（较慢，请勿离开）…');

  let source;
  try {
    source = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    throw new Error('PDF 读取失败，文件可能过大或已损坏');
  }

  if (source.length < 5) throw new Error('文件内容为空，不是有效的 PDF');

  let doc;
  try {
    doc = await lib.getDocument({
      data: source,
      isEvalSupported: false,   // 漫画 PDF 用不到，关掉更安全
      disableAutoFetch: true,
      disableStream: true,
    }).promise;
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/password/i.test(msg)) {
      throw new Error('这个 PDF 有密码保护，请先解密后再导入');
    }
    if (/Invalid PDF|not a PDF|structure/i.test(msg)) {
      throw new Error('PDF 文件损坏或格式不合法');
    }
    throw new Error('PDF 解析失败：' + msg);
  }

  const total = doc.numPages || 0;
  if (!total) {
    try { doc.destroy(); } catch (e) { /* noop */ }
    throw new Error('这个 PDF 里没有任何页面');
  }

  if (opts.onScan) opts.onScan(total);

  const pages = [];
  for (let i = 1; i <= total; i++) {
    pages.push({
      name: `${String(i).padStart(4, '0')}.jpg`,
      size: 0,
      read: () => renderPage(doc, i),
    });
  }

  return {
    pages,
    pageCount: total,
    dispose: () => { try { doc.destroy(); } catch (e) { /* noop */ } },
  };
}

export { looksLikePdf, listPdfPages };
