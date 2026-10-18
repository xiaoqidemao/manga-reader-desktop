/* ============================================================
   离线能力验证
   ------------------------------------------------------------
   直接断网会影响用户正在用的网络，改用等价验证：
     1. 静态扫描：所有源码里是否残留 http(s) 外链
     2. 运行时：页面真的去 fetch 外网，必须失败
     3. 功能：拦截状态下读图 / 翻页 / 进度 必须照常
   ============================================================ */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const PORT = Number(process.env.CDP_PORT || 9222);

/* ---------- 1. 静态扫描 ---------- */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const TEXT_EXT = new Set(['.js', '.html', '.css', '.json', '.mjs']);
const files = walk(SITE).filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()));

const hits = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    const m = line.match(/https?:\/\/[a-zA-Z0-9.\-]+[^\s'"`)<]*/g);
    if (!m) return;
    if (line.includes('xmlns') || line.includes('w3.org')) return;
    hits.push(`  ${path.relative(ROOT, f)}:${i + 1}  ${m.join(' ')}`);
  });
}

console.log('=== 1. 静态扫描外链 ===');
console.log('扫描文件数:', files.length);
console.log(hits.length ? hits.join('\n') : '  未发现任何外部链接 [OK]');

/* ---------- 2~3. 运行时 ---------- */
function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  let targets;
  try {
    targets = await getTargets();
  } catch (e) {
    console.log('\n（程序未在调试端口运行，跳过运行时验证）');
    return;
  }

  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file://'));
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  });

  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');

  const evaluate = (expr) => send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  }).then((r) => r.exceptionDetails ? { __error: r.exceptionDetails.text } : r.result.value);

  console.log('\n=== 2. 运行时阻止外网请求 ===');
  const net = await evaluate(`(async () => {
    const results = {};
    for (const url of ['https://www.google.com', 'https://api.github.com', 'https://cdn.jsdelivr.net/npm/vue']) {
      try {
        await fetch(url, { mode: 'no-cors' });
        results[url] = '未拦截（异常！）';
      } catch (e) {
        results[url] = '已拦截 [OK]';
      }
    }
    return results;
  })()`);
  console.log(net);

  console.log('\n=== 3. 拦截状态下核心功能 ===');
  const fn = await evaluate(`(async () => {
    const out = {};
    const card = document.querySelector('.card');
    if (!card) return { error: '书架为空' };
    if (!document.getElementById('view-reader').classList.contains('is-active')) {
      card.click();
      await new Promise(r => setTimeout(r, 1600));
    }
    out.openBook = document.getElementById('rd-title').textContent;

    document.querySelector('[data-mode=strip]').click();
    await new Promise(r => setTimeout(r, 2500));
    out.stripImgs = document.querySelectorAll('.strip-cell img').length;

    const st = document.getElementById('stage-strip');
    st.scrollLeft = 0;
    await new Promise(r => setTimeout(r, 200));
    st.dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 500));
    out.wheelWorks = st.scrollLeft > 0;
    out.pageLabel = document.getElementById('rd-scrub-label').textContent;

    await new Promise(r => setTimeout(r, 1200));
    const s = await window.mangaHost.getSettings();
    out.progressSaved = Object.keys(s.progress || {}).length > 0;

    document.getElementById('rd-back').click();
    await new Promise(r => setTimeout(r, 800));
    out.backOk = !document.getElementById('view-reader').classList.contains('is-active');
    return out;
  })()`);
  console.log(fn);

  const allBlocked = Object.values(net).every((v) => String(v).includes('已拦截'));
  const coreOk = fn.openBook && fn.stripImgs > 0 && fn.wheelWorks && fn.backOk && !fn.error;

  console.log('\n=== 结论 ===');
  console.log('外网全部被拦截:', allBlocked ? '是 [OK]' : '否 [FAIL]');
  console.log('断网状态下功能正常:', coreOk ? '是 [OK]' : '否 [FAIL]');

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
