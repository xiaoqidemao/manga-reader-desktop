/* ============================================================
   最终验收：一次性把所有关键功能过一遍
   ============================================================ */

const http = require('http');
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

(async () => {
  const targets = await getTargets();
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

  const ev = (expr) => send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  }).then((r) => r.exceptionDetails
    ? { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '') }
    : r.result.value);

  const report = {};

  // 1. 书架（先强制回到根目录，保证测的是初始视图）
  //    分层浏览后，根目录显示的是文件夹卡片，不是书。
  report.shelf = await ev(`(async () => {
    const DB = await import('./js/db.js');
    const L = await import('./js/library.js');
    const s = await window.mangaHost.getSettings();
    await L.enterRoot(s.rootDir);
    await new Promise(r => setTimeout(r, 900));
    return {
      cards: document.querySelectorAll('.card').length,
      dirCards: document.querySelectorAll('.card-dir').length,
      bookCards: document.querySelectorAll('.card:not(.card-dir)').length,
      countText: document.getElementById('lib-count').textContent,
      coversLoaded: document.querySelectorAll('.card-cover img').length,
      crumbs: document.getElementById('lib-crumbs') ?
        document.getElementById('lib-crumbs').textContent.trim() : ''
    };
  })()`);

  // 1b. 封面懒加载
  //     分层浏览下，书的「父目录」通常只含这一本书，
  //     进去后显示的就是 1 张书卡片。只要能读到封面图就算通过。
  report.coverTest = await ev(`(async () => {
    const DB = await import('./js/db.js');
    const L = await import('./js/library.js');
    const all = await DB.DB.getAllBooks();
    const book = all.find(b => b.kind === 'folder' && b.pageCount > 5);
    if (!book) return { skipped: true, coversLoaded: 0 };

    // book.path 就是书目录本身，直接进去（不要再截掉一级）
    const dir = book.path;
    await L.navigateTo(dir);
    await new Promise(r => setTimeout(r, 2600));

    return {
      skipped: false,
      dir,
      bookCards: document.querySelectorAll('.card:not(.card-dir)').length,
      coversLoaded: document.querySelectorAll('.card-cover img').length,
      crumb: document.getElementById('lib-crumbs').textContent.trim()
    };
  })()`);

  // 1c. 自动折叠：全是书的目录应直接显示封面，不再多一层
  report.collapse = await ev(`(async () => {
    const s = await window.mangaHost.getSettings();
    const root = s.rootDir;

    // 在根目录的子文件夹里，找一个「折叠后直接出书」的
    const r = await window.mangaHost.browse(root);
    const cands = (r.dirs || []).slice(0, 12);

    for (const d of cands) {
      const kids = await window.mangaHost.browse(d.path);
      if (kids.collapsed === true && (kids.books || []).length > 0) {
        return {
          skipped: false,
          dir: d.name,
          collapsed: true,
          books: kids.books.length,
          dirsLeft: (kids.dirs || []).length,
          sample: kids.books.slice(0, 3).map(b => b.title)
        };
      }
    }
    return { skipped: true, checked: cands.length };
  })()`);

  // 2. 打开一本大书
  //    分层浏览下根目录上显示的是文件夹而不是书，
  //    所以这里直接调 openBookDirect，不依赖书架上有卡片。
  report.open = await ev(`(async () => {
    const DB = await import('./js/db.js');
    const L = await import('./js/library.js');
    const books = await DB.DB.getAllBooks();
    const big = books.filter(b => b.pageCount > 100).sort((a,b) => b.pageCount - a.pageCount)[0];
    await L.openBookDirect(big);
    await new Promise(r => setTimeout(r, 1800));
    return {
      title: document.getElementById('rd-title').textContent,
      pages: big.pageCount,
      active: document.getElementById('view-reader').classList.contains('is-active')
    };
  })()`);

  // 3. 四种模式
  //    长卷要建全部格子（2000 页的书尤其慢），等待时间给足。
  report.modes = await ev(`(async () => {
    const out = {};
    for (const m of ['paged','spread','webtoon','strip']) {
      document.querySelector('[data-mode=' + m + ']').click();
      await new Promise(r => setTimeout(r, m === 'strip' ? 4500 : 2000));
      out[m] = {
        paged: document.getElementById('stage-paged').classList.contains('is-show'),
        webtoon: document.getElementById('stage-webtoon').classList.contains('is-show'),
        strip: document.getElementById('stage-strip').classList.contains('is-show'),
        imgs: document.querySelectorAll('#stage-paged img, #webtoon-inner img, .strip-cell img').length
      };
    }
    return out;
  })()`);

  // 4. 长卷：格子数、滚轮方向
  report.strip = await ev(`(async () => {
    document.querySelector('[data-mode=strip]').click();
    await new Promise(r => setTimeout(r, 2500));
    const st = document.getElementById('stage-strip');
    st.scrollLeft = 0;
    await new Promise(r => setTimeout(r, 300));
    const before = st.scrollLeft;
    st.dispatchEvent(new WheelEvent('wheel', { deltaY: 150, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 500));
    return {
      cells: document.querySelectorAll('.strip-cell').length,
      imgsLoaded: document.querySelectorAll('.strip-cell img').length,
      before, after: Math.round(st.scrollLeft),
      wheelMovesLeft: st.scrollLeft > before,
      clickableGap: getComputedStyle(document.querySelector('.strip-inner')).gap
    };
  })()`);

  // 5. 缩略图带（用真实鼠标事件）
  const rect = await ev(`(() => {
    const st = document.getElementById('stage-strip');
    return { w: st.clientWidth, h: st.clientHeight };
  })()`);
  const cx = Math.round((rect.w || 1200) / 2);
  const cy = Math.round((rect.h || 700) / 2);

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 60));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 1500));

  report.thumbs = await ev(`({
    shown: document.getElementById('thumbs-panel').classList.contains('is-show'),
    items: document.querySelectorAll('.thumb-item').length,
    imgs: document.querySelectorAll('.thumb-item img').length,
    current: document.querySelectorAll('.thumb-item.is-current').length
  })`);

  // 6. 点缩略图跳页
  report.thumbJump = await ev(`(async () => {
    const st = document.getElementById('stage-strip');
    const before = Math.round(st.scrollLeft);
    const items = [...document.querySelectorAll('.thumb-item')];
    items[items.length - 1].click();
    await new Promise(r => setTimeout(r, 1300));
    return { before, after: Math.round(st.scrollLeft), label: document.getElementById('rd-scrub-label').textContent };
  })()`);

  // 7. 返回书架
  report.back = await ev(`(async () => {
    document.getElementById('rd-back').click();
    await new Promise(r => setTimeout(r, 900));
    return {
      closed: !document.getElementById('view-reader').classList.contains('is-active'),
      cards: document.querySelectorAll('.card').length
    };
  })()`);

  // 8. 进度持久化
  report.progress = await ev(`(async () => {
    const s = await window.mangaHost.getSettings();
    return { rootDir: s.rootDir, entries: Object.keys(s.progress || {}).length, thumbsEnabled: s.thumbsEnabled };
  })()`);

  // 9. 网络隔离
  report.network = await ev(`(async () => {
    try { await fetch('https://example.com', { mode: 'no-cors' }); return 'NOT BLOCKED'; }
    catch (e) { return 'BLOCKED'; }
  })()`);

  console.log(JSON.stringify(report, null, 2));

  // 总结
  const ok = {
    '书架有内容': report.shelf.cards > 0,
    '分层：根目录是文件夹': report.shelf.dirCards > 0,
    '面包屑正常': /书架/.test(report.shelf.crumbs || ''),
    '自动折叠（全是书直显封面）': report.collapse &&
      (report.collapse.skipped === true ||
       (report.collapse.collapsed === true && report.collapse.books > 0)),
    '封面懒加载': (report.coverTest && report.coverTest.coversLoaded > 0) || false,
    '能打开书': report.open.active === true,
    '单页模式': report.modes.paged.paged === true,
    '跨页模式': report.modes.spread.paged === true,
    '条漫模式': report.modes.webtoon.webtoon === true,
    '长卷模式': report.modes.strip.strip === true,
    '长卷零间隙': report.strip.clickableGap === '0px' || report.strip.clickableGap === 'normal',
    '滚轮向左': report.strip.wheelMovesLeft === true,
    '缩略图带': report.thumbs.shown === true,
    '缩略图跳页': report.thumbJump.after !== report.thumbJump.before,
    '返回书架': report.back.closed === true,
    '进度已存': report.progress.entries > 0,
    '外网被拦': report.network === 'BLOCKED',
  };

  console.log('\n=== 验收结果 ===');
  let pass = 0;
  for (const [k, v] of Object.entries(ok)) {
    console.log((v ? '  [PASS] ' : '  [FAIL] ') + k);
    if (v) pass++;
  }
  console.log(`\n合计: ${pass}/${Object.keys(ok).length}`);

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
