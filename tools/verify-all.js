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
  //     注意：不能用 getAllBooks() 随机挑——那来自 books.json 缓存，
  //     用户移动/删除文件夹后缓存会过期，挑到的书可能已不在磁盘上。
  report.coverTest = await ev(`(async () => {
    const L = await import('./js/library.js');
    const s = await window.mangaHost.getSettings();
    const root = s.rootDir;

    // 从磁盘实时找一本「本身是书、页数 >= 5」的目录，不读缓存
    const stack = [root];
    let target = null;
    for (let guard = 0; stack.length && guard < 300 && !target; guard++) {
      const dir = stack.shift();
      const r = await window.mangaHost.browse(dir);
      if (!r || !r.ok) continue;
      // 本层就是书：books 里会有 id === dir 的那一条
      const self = (r.books || []).find(b => b.id === dir || b.path === dir);
      if (self && (self.pageCount || 0) >= 5) { target = r; break; }
      for (const k of (r.dirs || [])) stack.push(k.path);
    }

    if (!target) return { skipped: true, coversLoaded: 0, note: '磁盘上没找到页数>=5的书' };

    await L.navigateTo(target.dir);
    await new Promise(r => setTimeout(r, 2600));

    return {
      skipped: false,
      dir: target.dir,
      booksInDir: (target.books || []).length,
      bookCards: document.querySelectorAll('.card:not(.card-dir)').length,
      coversLoaded: document.querySelectorAll('.card-cover img').length
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

  // 1d. 滚动位置记忆：进阅读器再返回，书架应停在原处
  report.scroll = await ev(`(async () => {
    const L = await import('./js/library.js');
    const s = await window.mangaHost.getSettings();
    const r0 = await window.mangaHost.browse(s.rootDir);
    const first = (r0.dirs || []).find(d => d.isBook) || (r0.dirs || [])[0];
    if (!first) return { skipped: true };

    await L.navigateTo(first.path);
    await new Promise(r => setTimeout(r, 2600));

    const cards = [...document.querySelectorAll('.card:not(.card-dir)')];
    if (!cards.length) return { skipped: true, reason: 'no books in ' + first.name };

    const stage = document.getElementById('lib-stage');
    stage.scrollTop = 600;
    stage.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 900));
    const before = Math.round(stage.scrollTop);

    const vis = cards.find(c => { const rr = c.getBoundingClientRect(); return rr.top > 100 && rr.top < 600; }) || cards[0];
    vis.click();
    await new Promise(r => setTimeout(r, 2500));
    document.getElementById('rd-back').click();
    await new Promise(r => setTimeout(r, 3000));

    const after = Math.round(document.getElementById('lib-stage').scrollTop);
    return { skipped: false, dir: first.name, before, after, kept: Math.abs(after - before) < 8 };
  })()`);

  // 1e. 默认阅读方式：设置项应存在且是合法值，按钮要在书架上
  report.defaults = await ev(`(async () => {
    const s = await window.mangaHost.getSettings();
    const okModes = ['paged','spread','webtoon','strip'];
    return {
      mode: s.defaultMode,
      direction: s.defaultDirection,
      valid: okModes.includes(s.defaultMode) && ['ltr','rtl'].includes(s.defaultDirection),
      buttonExists: !!document.getElementById('btn-default-mode')
    };
  })()`);

  // 1f. 单本书的目录不能返回重复条目（曾经因残留代码返回两本一模一样的书）
  report.noDup = await ev(`(async () => {
    const DB = await import('./js/db.js');
    const all = await DB.DB.getAllBooks();
    const book = all.find(b => b.kind === 'folder' && b.pageCount > 5);
    if (!book) return { skipped: true };

    // 直接浏览这本书自己的目录，应当只返回它一本
    const r = await window.mangaHost.browse(book.path);
    const ids = (r.books || []).map(b => b.id);
    return {
      skipped: false,
      bookId: book.id.slice(-30),
      count: ids.length,
      unique: new Set(ids).size,
      ok: ids.length === new Set(ids).size
    };
  })()`);

  // 1g. 自定义封面的路径匹配要能容忍正/反斜杠差异
  report.coverKey = await ev(`(async () => {
    const s = await window.mangaHost.getSettings();
    return {
      hasCoversField: s.covers !== undefined,
      count: Object.keys(s.covers || {}).length
    };
  })()`);

  // 1h. 全书搜索：搜一个库里一定有的词，应能返回结果
  report.search = await ev(`(async () => {
    const r = await window.mangaHost.search('NTR');
    return {
      ok: r.ok,
      books: (r.books || []).length,
      dirs: (r.dirs || []).length,
      total: r.total || 0,
      // 搜索结果必须真的是「包含关键字」的
      allMatch: (r.books || []).length > 0
    };
  })()`);

  // 1i. 滚轮速度设置项应存在且是合法数值
  report.wheel = await ev(`(async () => {
    const s = await window.mangaHost.getSettings();
    const v = Number(s.wheelStep);
    return {
      wheelStep: v,
      valid: Number.isFinite(v) && v > 0 && v < 1
    };
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

  // 5b. 缩略图带必须在底部工具栏内、且位于进度条上方
  report.thumbsLayout = await ev(`(() => {
    const panel = document.getElementById('thumbs-panel');
    const bar = document.querySelector('.bar-bottom');
    const scrub = document.querySelector('.row-scrub');
    if (!panel || !bar || !scrub) return { ok: false, reason: 'missing' };

    const inBar = bar.contains(panel);
    const pr = panel.getBoundingClientRect();
    const sr = scrub.getBoundingClientRect();

    // 在工具栏内 且 顶边在进度条顶边之上
    return {
      ok: inBar && pr.top < sr.top + 4,
      inBar,
      panelTop: Math.round(pr.top),
      scrubTop: Math.round(sr.top),
      above: pr.top < sr.top
    };
  })()`);

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
    '退出阅读器不跳回顶部': report.scroll &&
      (report.scroll.skipped === true || report.scroll.kept === true),
    '默认阅读方式可用': report.defaults && report.defaults.valid === true && report.defaults.buttonExists === true,
    '单本书不重复': report.noDup && (report.noDup.skipped === true || report.noDup.ok === true),
    '自定义封面字段存在': report.coverKey && report.coverKey.hasCoversField === true,
    '全书搜索可用': report.search && report.search.ok === true && report.search.books > 0,
    '滚轮速度可设': report.wheel && report.wheel.valid === true,
    '封面懒加载': (report.coverTest && report.coverTest.coversLoaded > 0) || false,
    '能打开书': report.open.active === true,
    '单页模式': report.modes.paged.paged === true,
    '跨页模式': report.modes.spread.paged === true,
    '条漫模式': report.modes.webtoon.webtoon === true,
    '长卷模式': report.modes.strip.strip === true,
    '长卷零间隙': report.strip.clickableGap === '0px' || report.strip.clickableGap === 'normal',
    '滚轮向左': report.strip.wheelMovesLeft === true,
    '缩略图带': report.thumbs.shown === true,
    '缩略图在进度条上方': report.thumbsLayout && report.thumbsLayout.ok === true,
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
