#!/usr/bin/env node
// SQL実行まわりの確認（Claudeを呼ばないので費用ゼロ）
//   1. パスワードがプロンプトに混ざらず、環境変数 PGPASSWORD だけで渡ること
//   2. 参照以外のSQLが弾かれること
//   3. DBに届かないときは実行されないこと
//   4. SQLはファイルに書き出され、コマンドが psql で始まること
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
  const pi = argv.indexOf('-p');
  const sqlFile = (argv[pi + 1] || '').match(/-f (\S+\.sql)/);
  fs.writeFileSync(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({
    prompt: argv[pi + 1] || '',
    allowedTools: argv.includes('--allowedTools') ? argv[argv.indexOf('--allowedTools') + 1] : null,
    disallowedTools: argv.includes('--disallowedTools') ? argv[argv.indexOf('--disallowedTools') + 1] : null,
    pgpassword: process.env.PGPASSWORD || null,
    sqlFileContent: sqlFile && fs.existsSync(sqlFile[1]) ? fs.readFileSync(sqlFile[1], 'utf8') : null,
  }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok', session_id: 'fake-session', total_cost_usd: 0 }));
  process.exit(0);
}

// ---------- 確認を回すモード ----------
const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'skill', 'understand', 'app', 'server.js');
const PASSWORD = 'p@ssw0rd-himitsu-9z';
const CONN = { host: 'localhost', port: 15432, user: 'reader', name: 'shopdb' };

let failed = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? '  OK  ' : '  NG  '} ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed++;
}

function startServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'understand-test-'));
  fs.writeFileSync(path.join(dir, 'main.md'), '# テスト\n');
  fs.writeFileSync(path.join(dir, 'title.txt'), 'テスト\n');
  const dump = path.join(dir, 'dump.json');
  const child = spawn(process.execPath, [SERVER, '--dir', dir, '--session', 'test-session', '--cwd', ROOT, '--port', '0', '--no-open'], {
    env: Object.assign({}, process.env, { UNDERSTAND_CLAUDE_BIN: __filename, FAKE_CLAUDE_DUMP: dump }, extraEnv),
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

const runsql = (base, body) =>
  fetch(base + '/api/runsql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

(async () => {
  console.log('\n1. パスワードの渡り方と、組み立てられるコマンド');
  {
    const s = await startServer({ UNDERSTAND_SKIP_TUNNEL_CHECK: '1' });
    const sql = "select\n    shop_id\n    , count(*) as cnt\nfrom orders\nwhere 1=1\n    and name = 'テスト\"店\"'\ngroup by 1";
    const r = await runsql(s.base, Object.assign({ sessionId: 'x', sql, password: PASSWORD }, CONN));
    ok('実行が通る', r.ok === true, r.error);
    const d = JSON.parse(fs.readFileSync(s.dump, 'utf8'));
    ok('プロンプトにパスワードが入っていない', !d.prompt.includes(PASSWORD));
    ok('環境変数 PGPASSWORD で渡っている', d.pgpassword === PASSWORD);
    ok('許可されるのは psql だけ', d.allowedTools === 'Bash(psql:*)', String(d.allowedTools));
    ok('Edit/Write は禁止のまま', /Edit/.test(d.disallowedTools || ''), String(d.disallowedTools));
    ok('コマンドが psql で始まる', /```bash\npsql -h localhost -p 15432 -U reader -d shopdb /.test(d.prompt), d.prompt.slice(0, 200));
    ok('SQLはファイルに書き出されている', (d.sqlFileContent || '').includes('テスト"店"'), String(d.sqlFileContent));
    ok('一時SQLファイルは消されている', fs.readdirSync(s.dir).every((f) => !f.endsWith('.sql')), fs.readdirSync(s.dir).join(','));
    s.stop();
  }

  console.log('\n2. 参照以外のSQLを弾く');
  {
    const s = await startServer({ UNDERSTAND_SKIP_TUNNEL_CHECK: '1' });
    const cases = [
      ['delete 文', 'delete from orders where id = 1', false],
      ['update 文', 'update orders set qty = 0', false],
      ['drop 文', 'drop table orders', false],
      ['複数の文', 'select 1; delete from orders', false],
      ['コメントに隠した書き込み', '-- select 1\ndelete from orders', false],
      ['普通の select', 'select 1', true],
      ['with で始まる select', 'with t as (select 1 as a)\nselect * from t', true],
      ['created_at のような列名', 'select created_at from orders', true],
    ];
    for (const [name, sql, shouldPass] of cases) {
      const r = await runsql(s.base, Object.assign({ sessionId: 'x', sql, password: PASSWORD }, CONN));
      ok(`${name} → ${shouldPass ? '通る' : '弾く'}`, r.ok === shouldPass, r.error);
    }
    let r = await runsql(s.base, Object.assign({ sessionId: 'x', sql: 'select 1', password: '' }, CONN));
    ok('パスワードなしは弾く', r.ok === false, r.error);
    r = await runsql(s.base, { sessionId: 'x', sql: 'select 1', password: PASSWORD, host: 'localhost', port: 15432 });
    ok('ユーザー・DB名が未設定だと弾く', r.ok === false && /ユーザー名/.test(r.error || ''), r.error);
    r = await runsql(s.base, Object.assign({}, CONN, { sessionId: 'x', sql: 'select 1', password: PASSWORD, name: 'db; rm -rf /' }));
    ok('接続情報への混入を弾く', r.ok === false && /使えない文字/.test(r.error || ''), r.error);
    s.stop();
  }

  console.log('\n3. DBに届かないときは実行しない');
  {
    const s = await startServer({});
    const r = await runsql(s.base, Object.assign({}, CONN, { sessionId: 'x', sql: 'select 1', port: 59999, password: PASSWORD }));
    ok('つながらないポートでは実行しない', r.ok === false && /つながりません/.test(r.error || ''), r.error);
    ok('Claudeを呼んでもいない', !fs.existsSync(s.dump));
    s.stop();
  }

  console.log(failed ? `\n${failed}件 失敗しました\n` : '\nすべて通りました\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
