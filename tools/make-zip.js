/* ============================================================
   把 win-unpacked 打成一个「解压即用」的 zip
   ------------------------------------------------------------
   要求：解压后第一层是「漫画阅读器」文件夹，
        里面直接是 漫画阅读器.exe 与使用说明，不多套层级。
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'win-unpacked');
const OUT = path.join(ROOT, 'dist', '漫画阅读器-便携版-1.0.0.zip');
const TOP = '漫画阅读器';

const TMPROOT = path.join(ROOT, 'dist', '.zip-tmp');
const TMPTOP = path.join(TMPROOT, TOP);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(SRC)) {
  console.error('找不到 dist/win-unpacked，请先运行 node tools/build-portable.js');
  process.exit(1);
}

console.log('1) 准备临时目录');
fs.rmSync(TMPROOT, { recursive: true, force: true });
copyDir(SRC, TMPTOP);

console.log('2) 压缩');
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dir = '${TMPROOT.replace(/'/g, "''")}'
$dst = '${OUT.replace(/'/g, "''")}'
$zip = [System.IO.Compression.ZipFile]::Open($dst, 'Create')
try {
  Get-ChildItem -Path $dir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($dir.Length).TrimStart('\\').Replace('\\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $_.FullName, $rel,
      [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}
`;
execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });

console.log('3) 清理');
fs.rmSync(TMPROOT, { recursive: true, force: true });

const st = fs.statSync(OUT);
console.log('完成:', path.basename(OUT), (st.size / 1024 / 1024).toFixed(1), 'MB');
