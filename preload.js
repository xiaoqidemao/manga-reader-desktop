/* ============================================================
   preload.js · 渲染进程与主进程之间的白名单桥
   ------------------------------------------------------------
   只暴露这里列出的方法，渲染进程拿不到任何 Node API。
   ============================================================ */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mangaHost', {
  /* 设置 */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /* 目录 */
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  scan: (root) => ipcRenderer.invoke('library:scan', root),
  cached: (root) => ipcRenderer.invoke('library:cached', root),
  browse: (dir) => ipcRenderer.invoke('library:browse', dir),
  search: (kw) => ipcRenderer.invoke('library:search', kw),

  /* 书与页 */
  getPages: (id) => ipcRenderer.invoke('book:pages', id),
  readPage: (filePath) => ipcRenderer.invoke('page:read', filePath),
  readBytes: (filePath) => ipcRenderer.invoke('file:readBytes', filePath),
  getDims: (filePath) => ipcRenderer.invoke('page:dims', filePath),
  getCover: (id) => ipcRenderer.invoke('cover:get', id),
  pickCover: (id) => ipcRenderer.invoke('cover:pick', id),
  resetCover: (id) => ipcRenderer.invoke('cover:reset', id),

  /* 进度 */
  saveProgress: (id, progress) => ipcRenderer.invoke('progress:set', id, progress),
  clearProgress: (id) => ipcRenderer.invoke('progress:clear', id),
  renameBook: (id, name) => ipcRenderer.invoke('book:rename', id, name),

  /* 系统 */
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  dataDir: () => ipcRenderer.invoke('app:dataDir'),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  setWindowTitle: (t) => ipcRenderer.invoke('window:title', t),

  /* 环境标记 */
  isDesktop: true,
  platform: process.platform,
});
