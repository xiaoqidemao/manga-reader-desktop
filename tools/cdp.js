/* ============================================================
   cdp.js · 通过 Chrome DevTools Protocol 操作运行中的程序
   ------------------------------------------------------------
   用法：
     node tools/cdp.js js "表达式"       执行 JS 并打印结果
     node tools/cdp.js shot 输出路径     截图
     node tools/cdp.js click x y         点一下
     node tools/cdp.js wheel x y dy      滚一下
     node tools/cdp.js logs              只看控制台

   程序需要带 --remote-debugging-port=9222 启动。
   ============================================================ */

const http = require('http');
const fs = require('fs');

const PORT = Number(process.env.CDP_PORT || 9222);

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  const targets = await getTargets();
  // 排除 devtools 自身的页面，只挑真正加载应用的那个
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file://'))
    || targets.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到页面目标');

  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const logs = [];

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
    });
  }

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push('[EXCEPTION] ' + d.text + ' ' + (d.exception && d.exception.description || ''));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push('[error] ' + (msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      logs.push('[log] ' + msg.params.entry.text);
    }
  });

  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = (expr) => send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }).then((r) => {
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '') };
    }
    return r.result.value;
  });

  try {
    if (cmd === 'js') {
      console.log(JSON.stringify(await evaluate(args.slice(1).join(' ')), null, 2));
    } else if (cmd === 'shot') {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(args[1], Buffer.from(shot.data, 'base64'));
      console.log('saved ' + args[1]);
    } else if (cmd === 'click') {
      const x = Number(args[1]), y = Number(args[2]);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 60));
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      console.log('clicked ' + x + ',' + y);
    } else if (cmd === 'wheel') {
      const x = Number(args[1]), y = Number(args[2]), dy = Number(args[3] || 100);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
      console.log('wheel ' + dy);
    }
  } finally {
    if (logs.length) {
      console.log('--- 控制台 ---');
      console.log([...new Set(logs)].join('\n'));
    }
    ws.close();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
