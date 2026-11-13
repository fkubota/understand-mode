#!/usr/bin/env node
// SQL実行まわりの確認（Claudeもデータベースも使わないので費用ゼロ）
//   1. 承認して初めて実行され、そのとき道具の指定をしないこと
//   2. 承認前は、ファイル編集もコマンド実行も禁止のまま渡ること
//   3. 参照以外のSQLは、Claudeを呼ぶ前に弾くこと
//   4. SQLは書き換えずにそのままプロンプトへ渡ること
// 使い方: node dev/test-sql.js
//
// このファイルは偽の claude としても動く（FAKE_CLAUDE_DUMP が設定されているとき）。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ---------- 偽の claude として動くモード ----------
if (process.env.FAKE_CLAUDE_DUMP) {
  const argv = process.argv.slice(2);
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  // --allowedTools / --disallowedTools は値を複数取るので、次の -- まで集める
  const listAt = (flag) => {
    if (!argv.includes(flag)) return null;
    const out = [];
    for (let i = argv.indexOf(flag) + 1; i < argv.length && !argv[i].startsWith('--'); i++) out.push(argv[i]);
    return out;
  };
  fs.writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({
    prompt: at('-p') || '',
    allowedTools: listAt('--allowedTools'),
    disallowedTools: listAt('--disallowedTools'),
    pgpassword: process.env.PGPASSWORD || null,
  }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 'fake-session', total_cost_usd: 0 }));
  process.exit(0);
}

// ---------- 確認を回すモード ----------
const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'skill', 'understand', 'app', 'server.js');

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  OK  ' : '  NG  '} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed++;
}

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-test-'));
  fs.writeFileSync(path.join(dir, 'main.md'), '# テスト\n');
  fs.writeFileSync(path.join(dir, 'title.txt'), 'テスト\n');
  const dump = path.join(dir, 'dump.json');
  const child = spawn(process.execPath, [SERVER, '--dir', dir, '--session', 'test-session', '--cwd', ROOT, '--port', '0', '--no-open'], {
    env: Object.assign({}, process.env, { UNDERSTAND_CLAUDE_BIN: __filename, FAKE_CLAUDE_DUMP: dump }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('サーバーが起動しませんでした')), 8000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve({ base: m[0], dir, dump, stop: () => child.kill() }); }
    });
    child.on('error', reject);
  });
}

const post = (base, route, body) =>
  fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

(async () => {
  console.log('\n1. 承認して実行したとき、道具を指定しないこと');
  {
    const s = await startServer();
    const sql = "select\n    shop_id\n    , count(*) as cnt\nfrom orders\nwhere name = 'テスト\"店\"'\ngroup by 1";
    const r = await post(s.base, '/api/runsql', { sessionId: 'x', sql });
    ok('実行が通る', r.ok === true, r.error);
    const d = JSON.parse(fs.readFileSync(s.dump, 'utf8'));
    ok('--allowedTools を渡していない', d.allowedTools === null, JSON.stringify(d.allowedTools));
    ok('道具の名前がプロンプトに出てこない', !/psql|redash|bq |mysql/i.test(d.prompt), d.prompt.slice(0, 120));
    ok('接続情報を組み立てていない', !/-h localhost|-U |PGPASSWORD/.test(d.prompt), d.prompt.slice(0, 120));
    ok('パスワードを環境変数で渡していない', d.pgpassword === null);
    ok('SQLはそのまま渡る', d.prompt.includes('テスト"店"'), d.prompt.slice(-200));
    ok('編集だけは禁止したまま', JSON.stringify(d.disallowedTools) === '["Edit","Write","NotebookEdit"]', JSON.stringify(d.disallowedTools));
    ok('出力の約束は伝えている', d.prompt.includes('vega-lite') && d.prompt.includes('columns'));
    s.stop();
  }

  console.log('\n2. 承認前（ふつうの質問）は、実行させないこと');
  {
    const s = await startServer();
    const r = await post(s.base, '/api/ask', { action: 'data', anchor: 'ここ', sessionId: 'x' });
    ok('質問は通る', r.ok === true, r.error);
    const d = JSON.parse(fs.readFileSync(s.dump, 'utf8'));
    ok('Bash が禁止されている', (d.disallowedTools || []).includes('Bash'), JSON.stringify(d.disallowedTools));
    ok('ファイル編集も禁止されている', (d.disallowedTools || []).includes('Edit'), JSON.stringify(d.disallowedTools));
    ok('実行せず提案だけ、と伝えている', d.prompt.includes('まだ実行はしないでください'), d.prompt.slice(0, 120));
    s.stop();
  }

  console.log('\n3. 参照以外のSQLは、Claudeを呼ぶ前に弾くこと');
  {
    const s = await startServer();
    const cases = [
      ['delete 文', 'delete from orders where id = 1', false],
      ['update 文', 'update orders set qty = 0', false],
      ['drop 文', 'drop table orders', false],
      ['複数の文', 'select 1; delete from orders', false],
      ['コメントに隠した書き込み', '-- select 1\ndelete from orders', false],
      ['空のSQL', '   ', false],
      ['普通の select', 'select 1', true],
      ['with で始まる select', 'with t as (select 1 as a)\nselect * from t', true],
      ['created_at のような列名', 'select created_at from orders', true],
    ];
    for (const [name, sql, shouldPass] of cases) {
      fs.rmSync(s.dump, { force: true });
      const r = await post(s.base, '/api/runsql', { sessionId: 'x', sql });
      ok(`${name} → ${shouldPass ? '通る' : '弾く'}`, r.ok === shouldPass, r.error);
      if (!shouldPass) ok(`${name} → Claudeを呼んでもいない`, !fs.existsSync(s.dump));
    }
    s.stop();
  }

  console.log(failed ? `\n${failed}件 失敗しました\n` : '\nすべて通りました\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
