const { chromium } = require('playwright');
// モック（npm run mock）で起動したサーバーに対して、付箋の作成からメインへの返却までを一通り操作する。
// 使い方: node dev/e2e.js [スクリーンショットの保存先] [URL]
const OUT = process.argv[2] || require('path').join(__dirname, 'shots');
const fs = require('fs');
// 合言葉つきのURL。run-mock.sh が dev/.mock-url に書く
const URL = process.argv[3] || fs.readFileSync(require('path').join(__dirname, '.mock-url'), 'utf8').trim();
fs.mkdirSync(OUT, { recursive: true });

async function select(page, rootSel, needle) {
  // 本物の選択と同じく、太字やインラインコードをまたいで選べるようにする
  await page.evaluate(([rootSel, needle]) => {
    const root = document.querySelector(rootSel);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = w.nextNode())) nodes.push(n);
    const flat = nodes.map((x) => x.data).join('');
    // 本物の選択と同じく、段落途中の改行は空白として扱う
    let norm = ''; const back = [];
    for (let i = 0; i < flat.length; i++) {
      if (/\s/.test(flat[i])) { if (norm.endsWith(' ')) continue; norm += ' '; } else { norm += flat[i]; }
      back.push(i);
    }
    const want = needle.replace(/\s+/g, ' ').trim();
    const hit = norm.indexOf(want);
    if (hit < 0) throw new Error('not found: ' + needle);
    const at = back[hit];
    const endAt = back[hit + want.length - 1] + 1;
    const locate = (offset) => {
      let pos = 0;
      for (const node of nodes) {
        if (offset <= pos + node.data.length) return { node, offset: offset - pos };
        pos += node.data.length;
      }
      const last = nodes[nodes.length - 1];
      return { node: last, offset: last.data.length };
    };
    const a = locate(at), b = locate(endAt);
    const r = document.createRange();
    r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const rect = r.getBoundingClientRect();
    a.node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
  }, [rootSel, needle]);
  await page.waitForSelector('#sel-menu:not([hidden])');
}
const action = (page, a) => page.click(`#sel-menu button[data-action="${a}"]`);
const idle = (page) => page.waitForFunction(() => document.querySelector('#pending').hidden, null, { timeout: 20000 });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForSelector('#main-body h1');
  await page.screenshot({ path: `${OUT}/1-start.png` });

  // 用語
  await select(page, '#main-body', '日別に見ると12日と13日が突出していて');
  await page.screenshot({ path: `${OUT}/2-menu.png` });
  await action(page, 'question');
  await page.fill('.sticky.focused textarea', 'この2日間だけで説明できるの？');
  await page.click('.sticky.focused .st-input button');
  await idle(page);

  // 付箋の中から子付箋（用語）
  await select(page, '.sticky.focused .msg.assistant .md', 'イベント当日の売上が高かったこと');
  await action(page, 'diagram');
  await idle(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/3-diagram.png` });

  // 本筋から用語
  await select(page, '#main-body', '客単価');
  await action(page, 'term');
  await idle(page);

  // インラインコードをまたぐ選択でも、出どころにマーカーが付くこと
  // 段落途中の改行（画面では空白）と、インラインコードの両方をまたぐ選択
  await select(page, '#main-body', '集計は daily_sales テーブルの amount 列を日別に合計したものです。 実績値なので、取り消し分は差し引いてあります。');
  await action(page, 'detail');
  await idle(page);
  const crossed = await page.evaluate(() => {
    const marks = [...document.querySelectorAll('#main-body mark.anc')];
    const last = marks.filter((m) => m.className.includes('t-detail'));
    return { count: last.length, text: last.map((m) => m.textContent).join('') };
  });
  if (crossed.count < 3 || !crossed.text.includes('daily_sales') || !crossed.text.includes('amount') || !crossed.text.includes('取り消し分')) {
    errors.push(`またぎのマーカーが付いていない: ${JSON.stringify(crossed)}`);
  }

  // データで確かめる
  await select(page, '#main-body', 'イベントの来場者が立ち寄ったものと考えられます');
  await action(page, 'data');
  await idle(page);
  await page.screenshot({ path: `${OUT}/4-sql.png` });
  await page.click('.sticky.focused .btn-run');
  await idle(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/5-chart.png` });

  // 付箋を動かしても、他が勝手にたたまれないこと
  const foldedBefore = await page.evaluate(() => [...document.querySelectorAll('.sticky')].map((s) => s.classList.contains('folded')));
  const headBox = await (await page.$('.sticky .st-head')).boundingBox();
  await page.mouse.move(headBox.x + 40, headBox.y + 10);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(headBox.x + 40, headBox.y + 70, { steps: 6 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const foldedAfter = await page.evaluate(() => [...document.querySelectorAll('.sticky')].map((s) => s.classList.contains('folded')));
  if (JSON.stringify(foldedBefore) !== JSON.stringify(foldedAfter)) {
    errors.push(`動かしただけでたたまれた: ${JSON.stringify(foldedBefore)} → ${JSON.stringify(foldedAfter)}`);
  }

  // 影響あり→整列
  await page.click('.sticky.focused .impact-line .btn-mini');
  await page.click('#btn-arrange');
  await page.waitForTimeout(500);
  await page.click('#btn-zoom-out');
  await page.waitForTimeout(300);

  // 右下のつまみで大きさを変えられること（画面の中にあるつまみを選ぶ。縮小中なので倍率の換算も効く）
  const pick = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    for (const g of document.querySelectorAll('.sticky:not(.folded) .st-resize')) {
      const r = g.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx > 0 && cy > 0 && cx < vw && cy < vh && document.elementFromPoint(cx, cy) === g) {
        g.closest('.sticky').dataset.resizeTarget = '1';
        return { cx, cy, width: g.closest('.sticky').offsetWidth };
      }
    }
    return null;
  });
  if (!pick) {
    errors.push('画面の中に操作できるつまみが見つからない');
  } else {
    await page.mouse.move(pick.cx, pick.cy);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.move(pick.cx + 150, pick.cy + 120, { steps: 8 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelector('[data-resize-target]').offsetWidth);
    const savedW = await page.evaluate(() => Object.values(JSON.parse(sessionStorage.getItem('understand-state') || '{}').stickies || {}).some((s) => s.w));
    if (after <= pick.width || !savedW) errors.push(`大きさが変えられない: ${pick.width} → ${after} / 保存=${savedW}`);
  }
  await page.screenshot({ path: `${OUT}/6-arranged.png` });

  // 理解を終える
  await page.click('#btn-finish');
  await page.click('#btn-draft');
  await page.waitForFunction(() => document.querySelector('#ret-text').value.length > 0);
  await page.screenshot({ path: `${OUT}/7-return.png` });
  await page.click('#btn-ret-send');
  await page.waitForSelector('#done:not([hidden])');
  console.log('errors:', JSON.stringify(errors, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
