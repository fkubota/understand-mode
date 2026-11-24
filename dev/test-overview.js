#!/usr/bin/env node
// `-o` で貼る「全体像」の付箋を確かめる（Claudeは呼ばないので費用ゼロ）
//   1. 開いた瞬間に1枚貼ってあること（中のマークダウンと図が描けていること）
//   2. 本筋から線が引かれていること
//   3. そのまま続けて質問できること（メインのセッションから分岐する）
//   4. 描き直しで増えないこと、消したらリロードで戻らないこと
// 使い方: 別の端末で `npm run mock -- 4503 dev/fixtures/sample-main.md dev/fixtures/sample-stickies.json` を
//         動かしてから node dev/test-overview.js
// 引数でURLを渡さなければ dev/.mock-url を読む。

'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = process.argv[2] || fs.readFileSync(path.join(__dirname, '.mock-url'), 'utf8').trim();

let failed = 0;
const ok = (name, cond, detail) => {
  console.log(`${cond ? '  OK  ' : '  NG  '} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed++;
};
const idle = (page) => page.waitForFunction(() => document.querySelector('#pending').hidden, null, { timeout: 20000 });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForSelector('#main-body h1');
  await page.waitForTimeout(1500);

  const first = await page.evaluate(() => {
    const st = document.querySelector('.sticky.t-overview');
    return {
      count: document.querySelectorAll('.sticky.t-overview').length,
      kind: st && st.querySelector('.st-kind').textContent,
      title: st && st.querySelector('.st-title').textContent,
      bold: st ? st.querySelectorAll('.msg.assistant .md strong').length : 0,
      diagrams: st ? st.querySelectorAll('.diagram-box svg').length : 0,
      wide: st ? st.classList.contains('wide') : false,
      hasInput: st ? !!st.querySelector('.st-input textarea') : false,
      anchor: st ? !!st.querySelector('.st-anchor') : false,
    };
  });
  ok('開いた瞬間に1枚だけ貼ってある', first.count === 1, JSON.stringify(first));
  ok('チップが「全体像」', first.kind === '全体像', String(first.kind));
  ok('タイトルが出ている', !!first.title, String(first.title));
  ok('マークダウンが描けている', first.bold >= 1, `strong=${first.bold}`);
  ok('中の mermaid が図になっている', first.diagrams === 1, `図=${first.diagrams}`);
  ok('広い付箋になっている', first.wide);
  ok('続けて質問する欄がある', first.hasInput);
  ok('本筋から選んだ文の引用は付かない', !first.anchor);

  const wires = await page.evaluate(() => document.querySelectorAll('#wires path').length);
  ok('本筋から線が引かれている', wires === 1, `線=${wires}`);

  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(__dirname, 'shots', 'overview.png') });

  // 続けて質問できること。sessionId がまだ無いので、メインのセッションから分岐する
  await page.fill('.sticky.t-overview .st-input textarea', 'この話の結論だけ先に教えて');
  await page.click('.sticky.t-overview .st-input button');
  await idle(page);
  await page.waitForTimeout(300);
  const asked = await page.evaluate(() => {
    const st = document.querySelector('.sticky.t-overview');
    const S = JSON.parse(sessionStorage.getItem('understand-state') || '{}');
    const me = Object.values(S.stickies || {}).find((s) => s.type === 'overview');
    return {
      msgs: st.querySelectorAll('.msg').length,
      errors: st.querySelectorAll('.msg.error').length,
      sessionId: me && me.sessionId,
      parent: me && me.parent,
      count: document.querySelectorAll('.sticky.t-overview').length,
    };
  });
  ok('質問して回答が増える', asked.msgs >= 3 && asked.errors === 0, JSON.stringify(asked));
  ok('分身のセッションが付く', !!asked.sessionId, String(asked.sessionId));
  ok('本筋の子になっている', asked.parent === 'main', String(asked.parent));
  ok('描き直しで増えない', asked.count === 1, `枚数=${asked.count}`);

  // リロードしても、保存した状態が使われる（同じ付箋が1枚のまま、やりとりも残る）
  await page.reload();
  await page.waitForSelector('#main-body h1');
  await page.waitForTimeout(1200);
  const afterReload = await page.evaluate(() => ({
    count: document.querySelectorAll('.sticky.t-overview').length,
    msgs: document.querySelectorAll('.sticky.t-overview .msg').length,
  }));
  ok('リロードで二重に貼られない', afterReload.count === 1, JSON.stringify(afterReload));
  ok('やりとりが残っている', afterReload.msgs >= 3, JSON.stringify(afterReload));

  // 消したら、リロードしても戻ってこない
  page.on('dialog', (d) => d.accept());
  await page.click('.sticky.t-overview .st-head .st-btn:last-child');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('#main-body h1');
  await page.waitForTimeout(1200);
  const afterDelete = await page.evaluate(() => document.querySelectorAll('.sticky.t-overview').length);
  ok('消したらリロードで戻らない', afterDelete === 0, `枚数=${afterDelete}`);

  ok('ページのエラーが出ていない', errors.length === 0, errors.join(' / '));

  await browser.close();
  console.log(failed ? `\n${failed}件 失敗しました\n` : '\nすべて通りました\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
