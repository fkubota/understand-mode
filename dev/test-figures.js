#!/usr/bin/env node
// 本筋の中の図とグラフが描けることを確かめる（Claudeは呼ばないので費用ゼロ）
//   1. ```mermaid が図になること
//   2. ```vega-lite が自前のデータでグラフになること（SQL結果がなくても描ける）
//   3. データのない spec はエラー文になり、画面を壊さないこと
// 使い方: 別の端末で `npm run mock -- 4502 dev/fixtures/sample-figures.md` を動かしてから
//         node dev/test-figures.js
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

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(URL);
  await page.waitForSelector('#main-body h1');
  await page.waitForTimeout(2500);

  const found = await page.evaluate(() => ({
    diagrams: document.querySelectorAll('#main-body .diagram-box svg').length,
    charts: document.querySelectorAll('#main-body .chart-box svg').length,
    chartMarks: document.querySelectorAll('#main-body .chart-box svg path, #main-body .chart-box svg line').length,
    leftoverCode: document.querySelectorAll('#main-body pre > code.language-mermaid, #main-body pre > code.language-vega-lite').length,
  }));
  ok('mermaid が図になっている', found.diagrams >= 1, JSON.stringify(found));
  ok('vega-lite がグラフになっている', found.charts >= 1, JSON.stringify(found));
  ok('グラフに中身が描かれている', found.chartMarks > 5, `marks=${found.chartMarks}`);
  ok('コードブロックのまま残っていない', found.leftoverCode === 0, `残り=${found.leftoverCode}`);

  // データのない spec を流し込んでも、画面が壊れないこと
  const graceful = await page.evaluate(() => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    renderChart(box, JSON.stringify({ mark: 'bar' }), null);
    return box.textContent;
  });
  ok('データのないグラフは文言で知らせる', /データがありません/.test(graceful), graceful);

  ok('ページのエラーが出ていない', errors.length === 0, errors.join(' / '));

  await page.screenshot({ path: path.join(__dirname, 'shots', 'figures.png'), fullPage: false });
  await browser.close();
  console.log(failed ? `\n${failed}件 失敗しました\n` : '\nすべて通りました\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
