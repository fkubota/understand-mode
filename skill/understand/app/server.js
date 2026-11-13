#!/usr/bin/env node
// 理解モード ローカルサーバー
// 使い方: node server.js --dir <作業フォルダ> --session <メインのセッションID> --cwd <プロジェクトのパス> [--port 0] [--no-open]
// 依存パッケージなし（Node 18+ の標準モジュールのみ）

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ---------- 引数と設定 ----------
const args = parseArgs(process.argv.slice(2));
const WORK_DIR = path.resolve(args.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'understand-')));
const PROJECT_CWD = path.resolve(args.cwd || process.cwd());
const PUBLIC_DIR = path.join(__dirname, 'public');
const CLAUDE_BIN = process.env.UNDERSTAND_CLAUDE_BIN || 'claude';

// このサーバーは誰でも叩ける場所（127.0.0.1）にいる。同じマシンの別のページや別のプロセスから
// 勝手に操作されないよう、起動ごとに合言葉を作る。URLに載せてブラウザに渡し、APIでは毎回照合する。
const TOKEN = crypto.randomBytes(16).toString('hex');
let PORT = 0; // listen してから決まる

// 設定ファイルは持たない。モデルも道具もSQLの書き方も、分身がメインの文脈から引き継ぐ。
// 変えられるのは待ち時間だけ。重い調べものをさせるときに伸ばす。
const TIMEOUT_SEC = Number(process.env.UNDERSTAND_TIMEOUT_SEC) || 300;

// 以下はアプリがユーザーにした約束なので、変えられないようにしている。
// 承認前は、ファイル編集もコマンド実行もさせない
const ASK_DISALLOWED = ['Edit', 'Write', 'NotebookEdit', 'Bash'];
// 承認して実行するときも、編集だけは禁じる。許可は足さない（その人の普段の許可に従う）
const RUN_DISALLOWED = ['Edit', 'Write', 'NotebookEdit'];
let mainSessionId = (args.session && !args.session.includes('${')) ? args.session : findLatestSession(PROJECT_CWD);
// claude --resume は、実行時のカレントディレクトリでセッションを探す。
// 渡された --cwd がずれていても動くように、セッションの記録から本当のcwdを拾う。
const SPAWN_CWD = cwdOfSession(mainSessionId) || PROJECT_CWD;
const MAIN_MODE = permissionModeOf(mainSessionId);
// メインが確認なしで動いているなら、アプリも承認ボタンを挟まない
const AUTO_RUN = MAIN_MODE === 'bypassPermissions';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

// メインがどの権限モードで動いているかを、セッションの記録から拾う。
// bypassPermissions なら、本人は「いちいち聞くな」と言っているので、アプリも聞かない。
function permissionModeOf(id) {
  if (!id) return null;
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const slug of fs.readdirSync(base)) {
      const file = path.join(base, slug, id + '.jsonl');
      if (!fs.existsSync(file)) continue;
      let mode = null;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('permissionMode')) continue;
        try { const j = JSON.parse(line); if (j.permissionMode) mode = j.permissionMode; } catch (_) {}
      }
      return mode;
    }
  } catch (_) {}
  return null;
}

// セッションの記録の先頭には、そのセッションが動いていた cwd が入っている。それを拾う
function cwdOfSession(id) {
  if (!id) return null;
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const slug of fs.readdirSync(base)) {
      const file = path.join(base, slug, id + '.jsonl');
      if (!fs.existsSync(file)) continue;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
        try { const j = JSON.parse(line); if (j.cwd) return j.cwd; } catch (_) {}
      }
      return null;
    }
  } catch (_) {}
  return null;
}

// ~/.claude/projects/<cwdのスラッグ>/ の中で一番新しいセッションを探す（セッションIDが渡されなかったときの保険）
function findLatestSession(cwd) {
  try {
    const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', slug);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].f.replace(/\.jsonl$/, '') : null;
  } catch (_) {
    return null;
  }
}

// ---------- 寄り道で作ったセッションの後片付け ----------
// 「理解したらログは捨てる」方針なので、このアプリが分岐で作ったセッションの記録だけを削除する（メインには触れない）
const createdSessions = new Set();
function cleanupForkedSessions() {
  const dir = path.join(os.homedir(), '.claude', 'projects', SPAWN_CWD.replace(/[^A-Za-z0-9]/g, '-'));
  for (const id of createdSessions) {
    if (!/^[0-9a-f-]{36}$/.test(id) || id === mainSessionId) continue;
    try { fs.rmSync(path.join(dir, id + '.jsonl'), { force: true }); } catch (_) {}
    try { fs.rmSync(path.join(dir, id), { recursive: true, force: true }); } catch (_) {}
  }
}

// ---------- Claude 呼び出し ----------
const SYSTEM_APPEND = [
  'あなたは今「理解モード」の説明役です。ユーザーは、この会話でClaudeが出した内容（本筋）を理解しようとしています。',
  '目的は説明して理解を助けることです。ファイルの編集はしないでください。',
  'コマンドの実行は、ユーザーが承認したSQLを実行するときだけ行ってください。それ以外では実行しないでください。',
  '日本語で、短く、具体例を使って答えてください。見出しは使わず、段落と短い箇条書きだけにしてください。',
  '「何を読んだか」「これから調べます」のような作業の説明は書かず、答えから書き始めてください。',
  '図があると分かりやすい場合は ```mermaid のコードブロックで図を添えてください（flowchart か sequenceDiagram を推奨。ラベルは日本語可、記号は避ける）。',
  'データを見ないと確かめられない場合は、SQLを実行せずに ```sql のコードブロックで提案だけしてください。ユーザーが承認してから実行します。',
  '説明にコードが必要なときは、必要な部分だけ（15行以内）を載せてください。必ずReadツールなどで実際のファイルを読んでから、そのままの内容を写すこと（記憶で書かない）。',
  'コードを載せるときの見出し行は「~~~~言語名 ファイルパス:開始行番号」にしてください（例：~~~~python src/accuracy.py:12）。差分なら「~~~~diff ファイルパス」。',
  '本筋の記述に誤りや見直すべき点を見つけたら、最後に一文で「本筋への影響：…」と書いてください。',
].join('\n');

const target = (anchor) => `\n\n【対象】\n${anchor}`;
const ACTION_PROMPTS = {
  question: (anchor, q) => `本筋のこの部分について質問です。${target(anchor)}\n\n【質問】\n${q || 'これはどういう意味ですか？'}`,
  detail: (anchor) => `本筋のこの部分を、もう一段詳しく、具体例を使って説明してください。コードなら、何をしているかを1行ずつではなく処理のまとまりごとに説明してください。${target(anchor)}`,
  term: (anchor) => `この用語（または表現・関数名）を、この会話の文脈での意味に絞って説明してください。一般的な定義と、ここでの使われ方の両方を短く。${target(anchor)}`,
  diagram: (anchor) => `この部分を図で説明してください。必ず \`\`\`mermaid の図を1つ含め、図の読み方を2〜3文で添えてください。コードなら処理の流れかデータの流れを図にしてください。${target(anchor)}`,
  data: (anchor) => `この部分をデータで確かめたいです。確かめるためのSQLを \`\`\`sql で1つ提案し、何を見れば確かめられるかを2〜3文で説明してください。まだ実行はしないでください。${target(anchor)}`,
  review: (anchor) => [
    'この部分をレビューしてください。必要ならリポジトリのファイルを読んで前後の文脈も確認してください（編集はしないこと）。',
    '観点：不具合、境界値（0・空・欠損・重複・型）、前提の誤り、読みやすさ。',
    '重要な順に最大3点。各点は「**重大度（高/中/低）** 何が起きるか（具体的な入力例つき）→ 直し方」を2〜3文で。直し方にコードが要るときは短いコードブロックで。',
    '問題がなければ「問題なし」と、その理由を一文で書いてください。',
    '直すべき点があれば、最後に一文で「本筋への影響：…」と書いてください。',
  ].join('\n') + target(anchor),
};

// ---------- SQL実行の下ごしらえ ----------
// 文字列リテラルを壊さずにコメントだけ取り除く（'a--b' のような値を守るため）
function stripComments(src) {
  const s = String(src);
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c; out += c; i++;
      while (i < s.length) {
        if (s[i] === q) {
          if (s[i + 1] === q) { out += q + q; i += 2; continue; } // 連続した引用符は値の一部
          out += q; i++; break;
        }
        out += s[i]; i++;
      }
      continue;
    }
    if (c === '-' && s[i + 1] === '-') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

// 承認済みでも、参照以外のSQLは実行させない（ボタンの約束はアプリが守る。道具が何かは問わない）。
// 検査したものと実行するものを同じにするため、正規化したSQLを返す。
// コメントを落とすのは、そこに紛れ込ませた指示が分身に渡るのを防ぐため。
function checkSql(raw) {
  const sql = stripComments(raw).trim().replace(/;\s*$/, '');
  if (!sql) return { error: 'SQLが空です。' };
  if (sql.includes(';')) return { error: '複数の文はまとめて実行できません。SELECT を1つにしてください。' };
  if (!/^(select|with)\b/i.test(sql)) return { error: 'select か with で始まるSQLだけ実行できます。' };
  if (/\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|vacuum|call|do)\b/i.test(sql)) {
    return { error: '参照以外の操作が含まれています。実行できるのは参照だけです。' };
  }
  return { sql };
}

function runClaude({ prompt, resume, fork, allowedTools, disallowedTools, appendSystem, matchMainMode }) {
  return new Promise((resolve) => {
    const cmd = ['-p', prompt, '--output-format', 'json'];
    if (resume) { cmd.push('--resume', resume); if (fork) cmd.push('--fork-session'); }
    if (appendSystem) cmd.push('--append-system-prompt', appendSystem);
    if (allowedTools && allowedTools.length) cmd.push('--allowedTools', ...allowedTools);
    if (disallowedTools && disallowedTools.length) cmd.push('--disallowedTools', ...disallowedTools);
    // メインが確認なしなら分身も合わせる。禁止したツールは、このモードでも使えないままになる
    if (matchMainMode && AUTO_RUN) cmd.push('--permission-mode', 'bypassPermissions');

    // stdin を開けたままにすると claude が入力を3秒待つので、最初から閉じておく
    const child = spawn(CLAUDE_BIN, cmd, { cwd: SPAWN_CWD, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_SEC * 1000);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: `Claudeを起動できませんでした: ${err.message}` }); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(stdout);
        if (j.session_id && j.session_id !== mainSessionId) createdSessions.add(j.session_id);
        if (j.is_error) return resolve({ ok: false, error: j.result || 'Claudeがエラーを返しました', sessionId: j.session_id });
        resolve({ ok: true, text: j.result || '', sessionId: j.session_id, costUsd: j.total_cost_usd });
      } catch (_) {
        resolve({ ok: false, error: `Claudeの応答を読めませんでした（終了コード ${code}）\n${(stderr || stdout).slice(0, 800)}` });
      }
    });
  });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

// 同じマシンの別のページ・別のプロセスからの操作を断る。
// ブラウザは合言葉を知らないオリジンから独自ヘッダを付けられないので、ここで止まる。
function denyReason(req, url) {
  const host = (req.headers.host || '').trim();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return 'ホスト名が違います';
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return '別のページからは操作できません';
  const given = req.headers['x-understand-token'] || url.searchParams.get('t') || '';
  // 長さが違っても時間差が出ないように、長さを先に見てから定数時間で比べる
  if (given.length !== TOKEN.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN))) return '合言葉が違います';
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const deny = denyReason(req, url);
      if (deny) return send(res, 403, { ok: false, error: `${deny}。理解モードのURLから開き直してください。` });
    }
    if (req.method === 'GET' && url.pathname === '/api/init') {
      const mdPath = path.join(WORK_DIR, 'main.md');
      const markdown = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '# 本筋がありません\n\nmain.md が見つかりませんでした。';
      let title = '';
      try { title = fs.readFileSync(path.join(WORK_DIR, 'title.txt'), 'utf8').trim(); } catch (_) {}
      return send(res, 200, { markdown, title, hasSession: !!mainSessionId, project: path.basename(PROJECT_CWD), autoRun: AUTO_RUN });
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const b = await readBody(req);
      if (!mainSessionId && !b.sessionId) return send(res, 200, { ok: false, error: 'メインのセッションが見つかりません。スキルからもう一度起動してください。' });
      const make = ACTION_PROMPTS[b.action] || ACTION_PROMPTS.question;
      const prompt = b.followUp ? b.followUp : make(b.anchor || '', b.question);
      const result = await runClaude({
        prompt,
        resume: b.sessionId || mainSessionId,
        // 付箋の最初の質問は親（本筋 or 親の付箋）から分岐する。続きの質問はその付箋のセッションに積む
        fork: !b.continueSession,
        appendSystem: SYSTEM_APPEND,
        disallowedTools: ASK_DISALLOWED,
      });
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/runsql') {
      const b = await readBody(req);
      const checked = checkSql(b.sql);
      if (checked.error) return send(res, 200, { ok: false, error: checked.error });
      // どの道具で実行するかは指定しない。メインの文脈を引き継いだ分身が、この環境のやり方で取る
      const prompt = [
        'ユーザーが次のSQLの実行を承認しました。この環境でいつもデータを取っているやり方で、読み取りとして1回だけ実行してください。',
        'SQLは書き換えずにそのまま実行してください。',
        '実行できたら、結果を必ず次の形式で返してください：',
        '1. ```json のブロックに {"columns": [...], "rows": [[...], ...]}（最大200行。値は結果のまま）',
        '2. グラフが理解に役立つなら ```vega-lite のブロックに Vega-Lite の spec。dataは {"name": "result"} とし、値は書かないこと（アプリが結果を差し込みます）。フィールド名はcolumnsと同じにすること。',
        '3. 結果から読み取れることを2〜3文で。',
        '実行できなかった場合は、理由だけを短く書いてください（接続の用意が要るなら、それも一言で）。',
        '',
        '```sql',
        checked.sql, // 検査したものをそのまま渡す
        '```',
      ].join('\n');
      const result = await runClaude({
        prompt,
        resume: b.sessionId,
        fork: false,
        appendSystem: SYSTEM_APPEND,
        // 実行の許可は、その人が普段 Claude Code に与えている設定に従う
        disallowedTools: RUN_DISALLOWED,
        matchMainMode: true,
      });
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/draft') {
      const b = await readBody(req);
      const prompt = [
        '以下は、ユーザーがClaudeの出力（本筋）を理解する過程で「本筋に影響あり」とした寄り道のメモです。',
        'これをもとに、メインの作業セッションのClaudeに返す短いメッセージを、ユーザーの一人称で下書きしてください。',
        '形式：1行目に理解できたことを一言、その後に本筋に反映してほしい点を番号付きで。各点は根拠を一文添える。全体で8行以内。前置きや説明は書かず、メッセージ本文だけを出力すること。',
        '',
        b.notes || '',
      ].join('\n');
      const result = await runClaude({ prompt, disallowedTools: ASK_DISALLOWED });
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/return') {
      const b = await readBody(req);
      const text = (b.text || '').trim();
      fs.writeFileSync(path.join(WORK_DIR, 'return.md'), text ? text + '\n' : '(本筋に返すことはありません)\n');
      cleanupForkedSessions();
      send(res, 200, { ok: true });
      setTimeout(() => { server.close(); process.exit(0); }, 500);
      return;
    }

    // 静的ファイル
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, p));
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(filePath), MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(Number(args.port || 0), '127.0.0.1', () => {
  PORT = server.address().port;
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  fs.writeFileSync(path.join(WORK_DIR, 'url.txt'), url + '\n');
  fs.writeFileSync(path.join(WORK_DIR, 'server.pid'), String(process.pid));
  console.log(`理解モード: ${url}`);
  console.log(`作業フォルダ: ${WORK_DIR}`);
  console.log(`メインのセッション: ${mainSessionId || '(見つかりません)'}`);
  console.log(`分身を動かす場所: ${SPAWN_CWD}`);
  console.log(`メインの権限モード: ${MAIN_MODE || '(分かりません)'}${AUTO_RUN ? ' → SQLは確認なしで実行します' : ''}`);
  if (!args['no-open']) openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, a, () => {});
}
