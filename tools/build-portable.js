/* ============================================================
   手工打包脚本（绕过 electron-builder 的联网下载）
   ------------------------------------------------------------
   electron-builder 打包时会去 GitHub 拉 winCodeSign / nsis 等工具，
   网络不通会超时。改成手工组装：
     1. 复制本地 Electron 运行时
     2. 把应用代码打成 app.asar，放进 resources/
     3. 改名成「漫画阅读器.exe」
     4. 精简语言包
     5. 放入安装脚本与说明书
   产出即为可直接双击运行的便携版。
   ============================================================ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ELECTRON_DIR = path.join(ROOT, 'node_modules', 'electron', 'dist');
const STAGE = path.join(DIST, 'win-unpacked');
const ASAR_BIN = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const NODE_EXE = process.execPath;

const APP_NAME = '漫画阅读器';
const EXE_NAME = APP_NAME + '.exe';

/* 需要打进 app.asar 的文件 */
const INCLUDE = ['main.js', 'preload.js', 'site', 'build/icon.png', 'package.json'];

async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fsp.copyFile(s, d);
  }
}

async function dirSize(dir) {
  let sum = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sum += await dirSize(p);
    else { try { sum += (await fsp.stat(p)).size; } catch (err) { /* 忽略 */ } }
  }
  return sum;
}

async function main() {
  console.log('1) 清理旧产物');
  await fsp.rm(STAGE, { recursive: true, force: true });
  await fsp.rm(path.join(DIST, 'app-staging'), { recursive: true, force: true });
  await fsp.mkdir(DIST, { recursive: true });

  console.log('2) 复制 Electron 运行时');
  await copyDir(ELECTRON_DIR, STAGE);

  console.log('3) 准备应用目录');
  const staging = path.join(DIST, 'app-staging');
  await fsp.mkdir(staging, { recursive: true });
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    const dst = path.join(staging, item);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) { console.warn('   跳过缺失项:', item); continue; }
    if (st.isDirectory()) await copyDir(src, dst);
    else { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(src, dst); }
  }

  // 打包用的精简 package.json
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const slim = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    author: pkg.author,
    license: pkg.license,
  };
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(slim, null, 2), 'utf8');

  console.log('4) 打成 app.asar');
  const asarOut = path.join(STAGE, 'resources', 'app.asar');
  const defaultAsar = path.join(STAGE, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultAsar)) fs.unlinkSync(defaultAsar);
  if (fs.existsSync(asarOut)) fs.unlinkSync(asarOut);
  execFileSync(NODE_EXE, [ASAR_BIN, 'pack', staging, asarOut], { stdio: 'inherit' });
  console.log('   app.asar:', fs.statSync(asarOut).size, 'bytes');

  console.log('5) 重命名主程序');
  const electronExe = path.join(STAGE, 'electron.exe');
  const targetExe = path.join(STAGE, EXE_NAME);
  if (fs.existsSync(targetExe)) fs.unlinkSync(targetExe);
  fs.renameSync(electronExe, targetExe);
  console.log('   ->', EXE_NAME);

  console.log('6) 精简语言包（只留简中/繁中/英文）');
  const localesDir = path.join(STAGE, 'locales');
  const KEEP = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
  let removed = 0;
  if (fs.existsSync(localesDir)) {
    for (const f of await fsp.readdir(localesDir)) {
      if (!KEEP.has(f)) {
        await fsp.rm(path.join(localesDir, f), { force: true });
        removed++;
      }
    }
  }
  console.log('   删除', removed, '个语言包');

  console.log('7) 复制安装脚本与说明书');
  const installerDir = path.join(ROOT, 'installer');
  if (fs.existsSync(installerDir)) {
    for (const f of await fsp.readdir(installerDir)) {
      await fsp.copyFile(path.join(installerDir, f), path.join(STAGE, f));
    }
    console.log('   已放入:', (await fsp.readdir(installerDir)).join(', '));
  }

  console.log('8) 清理临时目录');
  await fsp.rm(staging, { recursive: true, force: true });

  console.log('完成。目录:', STAGE);
  console.log('体积:', ((await dirSize(STAGE)) / 1024 / 1024).toFixed(1), 'MB');
}

main().catch((e) => { console.error('打包失败:', e); process.exit(1); });
