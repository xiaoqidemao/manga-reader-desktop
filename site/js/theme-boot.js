/* ============================================================
   theme-boot.js · 首屏主题
   ------------------------------------------------------------
   必须在 CSS 之前同步执行，否则浅色用户会先闪一下深色。
   桌面版把这段从 index.html 内联抽了出来，配合 CSP：
   不允许内联脚本，只能外链。
   ============================================================ */

(function () {
  try {
    var t = localStorage.getItem('mr.theme') === 'light' ? 'light' : 'dark';
    var el = document.documentElement;
    el.dataset.theme = t;
    var isLight = t === 'light';

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLight ? '#f4f4f6' : '#0b0b0d');

    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', isLight ? 'light dark' : 'dark light');
  } catch (e) {
    /* localStorage 不可用时保持默认深色 */
  }
})();
