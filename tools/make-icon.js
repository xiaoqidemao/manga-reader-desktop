/* ============================================================
   用 Electron 的 nativeImage 把 SVG 图标转成多尺寸 ICO / PNG
   运行方式（注意要清掉 ELECTRON_RUN_AS_NODE）：
     electron tools/make-icon.js
   ============================================================ */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const svgPath = path.join(root, 'site', 'icons', 'icon.svg');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

  // 用离屏窗口把 SVG 渲染成位图
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    webPreferences: { offscreen: true },
  });

  await win.loadURL('data:text/html,' + encodeURIComponent(`
    <html><body style="margin:0;background:transparent">
    <img id="i" width="512" height="512" src="${dataUrl}">
    </body></html>
  `));

  await new Promise((r) => setTimeout(r, 600));

  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  win.destroy();

  const outDir = path.join(root, 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  const buffers = [];
  for (const s of sizes) {
    const resized = img.resize({ width: s, height: s, quality: 'best' });
    buffers.push({ size: s, png: resized.toPNG() });
  }

  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildICO(buffers));
  fs.writeFileSync(path.join(outDir, 'icon.png'), buffers[buffers.length - 1].png);

  console.log('icon.ico:', fs.statSync(path.join(outDir, 'icon.ico')).size, 'bytes');
  console.log('icon.png:', fs.statSync(path.join(outDir, 'icon.png')).size, 'bytes');
  app.quit();
});

/** ICO 格式：ICONDIR(6) + ICONDIRENTRY[count](16 each) + PNG 数据 */
function buildICO(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;

  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}
