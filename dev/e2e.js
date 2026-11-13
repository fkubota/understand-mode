const { chromium } = require('playwright');
// モック（npm run mock）で起動したサーバーに対して、付箋の作成からメインへの返却までを一通り操作する。
// 使い方: node dev/e2e.js [スクリーンショットの保存先] [URL]
const OUT = process.argv[2] || require('path').join(__dirname, 'shots');
const URL = process.argv[3] || 'http://127.0.0.1:4502/';
const fs = require('fs');
fs.mkdirSync(OUT, { recursive: true });

async function select(page, rootSel, needle) {
  await page.evaluate(([rootSel, needle]) => {
    const root = document.querySelector(rootSel);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = n.data.indexOf(needle);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + needle.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        const rect = r.getBoundingClientRect();
        n.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right, clientY: rect.bottom }));
        return;
      }
    }
    throw new Error('not found: ' + needle);
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

  // データで確かめる
  await select(page, '#main-body', 'イベントの来場者が立ち寄ったものと考えられます');
  await action(page, 'data');
  await idle(page);
  await page.screenshot({ path: `${OUT}/4-sql.png` });
  await page.click('.sticky.focused .btn-run');
  await idle(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/5-chart.png` });

  // 影響あり→整列
  await page.click('.sticky.focused .impact-line .btn-mini');
  await page.click('#btn-arrange');
  await page.waitForTimeout(500);
  await page.click('#btn-zoom-out');
  await page.waitForTimeout(300);
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
