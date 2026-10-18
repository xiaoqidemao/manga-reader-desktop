/* ============================================================
   app.js · 入口（桌面版）
   ------------------------------------------------------------
   与网页版的区别：
     - 去掉了「导入文件」的整套流程（不再复制进数据库）
     - 启动时读设置 → 有根目录就自动扫描
     - 没有 Service Worker（桌面版不需要）
   ============================================================ */

import { DB } from './db.js';
import { initLibrary, reloadLibrary, chooseFolder, rescan, renderLibrary, showScanning } from './library.js';
import { initReader, openBook, applyTheme, attachScroll } from './reader.js';
import { toast } from './ui.js';

/* ---------------- 启动 ---------------- */

async function main() {
  if (!window.mangaHost) {
    toast('请通过桌面版程序启动（当前缺少本地接口）', 6000);
    return;
  }

  /* --- 读取设置并应用主题 --- */
  let settings = null;
  try {
    settings = await DB.open();
  } catch (err) {
    toast('读取设置失败：' + (err.message || err), 5000);
    console.error(err);
    return;
  }

  applyTheme(settings.theme || 'dark');

  /* --- 阅读器 --- */
  initReader({
    onClose: () => {
      reloadLibrary();
    },
  });
  attachScroll();

  /* --- 绑定书库交互（但不触发扫描） --- */
  await initLibrary({ onOpen: (book) => openBook(book) });

  /* --- 首次使用：引导选文件夹 --- */
  if (!settings.rootDir) {
    setTimeout(() => { chooseFolder(); }, 400);
    return;
  }

  /* --- 已有根目录：先显示「扫描中」，扫完再渲染 --- */
  showScanning(settings.rootDir);

  const result = await DB.scan();
  if (result.ok) {
    renderLibrary(result.books);
    if (result.total === 0) {
      toast('这个文件夹里没找到漫画', 3200);
    }
  } else {
    renderLibrary([]);
    toast('扫描失败：' + (result.reason || '未知错误'), 4200);
  }

  /* --- 快捷键：Ctrl+O 换文件夹，Ctrl+R 重新扫描 --- */
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    const k = (e.key || '').toLowerCase();
    const inReader = document.getElementById('view-reader').classList.contains('is-active');
    if (k === 'o') { e.preventDefault(); chooseFolder(); }
    else if (k === 'r' && !inReader) { e.preventDefault(); rescan(); }
  });

  /* --- 防止双击放大等浏览器默认行为 --- */
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
