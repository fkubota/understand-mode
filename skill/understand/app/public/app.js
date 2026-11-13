'use strict';
// understand-mode フロントエンド（依存：marked / DOMPurify / mermaid / vega-embed）

const $ = (s) => document.querySelector(s);
const KIND = { question: '質問', detail: '詳しく', term: '用語', diagram: '図', data: 'データ', review: 'レビュー', memo: 'メモ' };
const ACTION_LABEL = { detail: 'もっと詳しく', term: 'この用語を調べる', diagram: '図で見せて', data: 'データで確かめたい', review: 'ここをレビューして' };
const WIRE_COLOR = { question: '#c9a400', detail: '#c9a400', term: '#5f70b6', diagram: '#9a937f', data: '#476b92', review: '#3f8f5a', memo: '#9fbddf' };
const STORE_KEY = 'understand-state';
// サーバーが発行した合言葉。URLから受け取り、API呼び出しのたびに添える
const TOKEN = new URLSearchParams(location.search).get('t') || '';
const apiHeaders = { 'Content-Type': 'application/json', 'X-Understand-Token': TOKEN };

const S = { stickies: {}, order: [], pan: { x: 40, y: 20 }, zoom: 1, seq: 0, focus: null };
let pendingCount = 0;
let selCtx = null;
let mmSeq = 0;
// メインが確認なしで動いているか。/api/init で届く
let autoRun = false;

const board = $('#board'), world = $('#world'), wires = $('#wires');
const mainCard = $('#main-card'), mainBody = $('#main-body');

marked.setOptions({ gfm: true, breaks: false });
// コードブロックの見出し行「~~~~python src/accuracy.py:12」から、ファイル名と開始行を受け取る
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
marked.use({
  renderer: {
    code(code, info) {
      const parts = (info || '').trim().split(/\s+/);
      const lang = parts[0] || '';
      const ref = parts[1];
      if (!ref) return false; // ファイルの指定がなければ通常の描画
      const m = ref.match(/^(.+?)(?::(\d+)(?:-\d+)?)?$/);
      const file = m ? m[1] : ref;
      const start = m && m[2] ? m[2] : '';
      return `<pre data-file="${escHtml(file)}" data-start="${escHtml(start)}"><code class="language-${escHtml(lang)}">${escHtml(code.replace(/\n$/, ''))}\n</code></pre>\n`;
    },
  },
});
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

const md = (text) => DOMPurify.sanitize(marked.parse(text || ''));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const short = (t, n = 28) => { const s = (t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const now = () => new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: apiHeaders, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) {
    return { ok: false, error: 'ローカルサーバーに接続できませんでした。understand-modeを起動し直してください。' };
  }
}

// ---------------- 初期化 ----------------
async function init() {
  let data;
  try { data = await fetch('/api/init', { headers: apiHeaders }).then((r) => r.json()); }
  catch (_) { data = { markdown: '# 接続できません', project: '' }; }
  mainBody.innerHTML = md(data.markdown);
  mainBody.querySelectorAll('pre > code').forEach((code) => {
    if (code.classList.contains('language-mermaid')) {
      const box = el('div', 'diagram-box'); code.parentElement.replaceWith(box); renderMermaid(box, code.textContent);
    } else if (code.classList.contains('language-vega-lite') || code.classList.contains('language-vegalite')) {
      // 本筋のグラフは自前のデータを持っている（付箋のようにSQL結果を差し込まない）
      const box = el('div', 'chart-box'); code.parentElement.replaceWith(box); renderChart(box, code.textContent, null);
    } else {
      numberLines(code);
    }
  });
  autoRun = !!data.autoRun;
  $('#project').textContent = data.project ? `プロジェクト：${data.project}` : '';
  if (!data.hasSession) $('#project').textContent += '（メインのセッションが見つかりません）';
  restore();
  applyView();
  renderAll();
}

// 本筋のコードに行番号を付ける（diffなら追加・削除行に色）
function numberLines(code) {
  const pre = code.parentElement;
  const isDiff = code.classList.contains('language-diff');
  const file = pre.dataset.file || '';
  const start = parseInt(pre.dataset.start, 10) || 1;
  const lines = code.textContent.replace(/\n$/, '').split('\n');
  code.textContent = '';
  let oldNo = 0, newNo = 0;
  if (file) {
    const last = start + lines.length - 1;
    const label = isDiff ? file : (pre.dataset.start ? `${file}　${start}〜${last}行目` : file);
    pre.before(el('div', 'code-file', label));
  }
  const hasHunk = lines.some((l) => l.startsWith('@@'));
  let inHunk = false;
  lines.forEach((line, i) => {
    const span = el('span', 'ln', line);
    let label = String(i + start);
    if (isDiff) {
      // diff：@@ 見出しがあれば変更後の行番号、なければ番号なしで色だけ付ける
      label = '';
      const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (h) { oldNo = +h[1]; newNo = +h[2]; inHunk = true; span.classList.add('hunk'); }
      else if (/^(diff |index |--- |\+\+\+ )/.test(line)) { inHunk = false; span.classList.add('meta'); }
      else if (line.startsWith('+')) { span.classList.add('add'); if (hasHunk && inHunk) label = String(newNo++); }
      else if (line.startsWith('-')) { span.classList.add('del'); if (hasHunk && inHunk) label = String(oldNo++); }
      else if (hasHunk && inHunk) { label = String(newNo); oldNo++; newNo++; }
    }
    span.dataset.line = label;
    code.append(span);
  });
  code.parentElement.classList.add('numbered');
}

// 選択範囲がコードの何行目かを返す
function lineRangeOf(range) {
  const ln = (n) => (n.nodeType === 1 ? n : n.parentElement).closest('.ln');
  const a = ln(range.startContainer), b = ln(range.endContainer);
  if (!a && !b) return '';
  const x = (a || b).dataset.line, y = (b || a).dataset.line;
  const pre = (a || b).closest('pre');
  const file = pre && pre.dataset.file ? pre.dataset.file + ' ' : '';
  if (!x && !y) return file.trim();
  return file + (x === y || !y ? `${x}行目` : `${x}〜${y}行目`);
}

function save() {
  try {
    const copy = JSON.parse(JSON.stringify(S));
    Object.values(copy.stickies).forEach((s) => { s.busy = false; });
    sessionStorage.setItem(STORE_KEY, JSON.stringify(copy));
  } catch (_) {}
}
function restore() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) Object.assign(S, JSON.parse(raw));
  } catch (_) {}
}

// ---------------- 表示（パン・ズーム） ----------------
function applyView() {
  world.style.transform = `translate(${S.pan.x}px, ${S.pan.y}px) scale(${S.zoom})`;
  $('#zoom-label').textContent = Math.round(S.zoom * 100) + '%';
}
function toWorld(clientX, clientY) {
  const b = board.getBoundingClientRect();
  return { x: (clientX - b.left - S.pan.x) / S.zoom, y: (clientY - b.top - S.pan.y) / S.zoom };
}
function setZoom(z, cx, cy) {
  const b = board.getBoundingClientRect();
  if (cx == null) { cx = b.left + b.width / 2; cy = b.top + b.height / 2; }
  const p = toWorld(cx, cy);
  S.zoom = Math.min(2, Math.max(0.3, z));
  S.pan.x = cx - b.left - p.x * S.zoom;
  S.pan.y = cy - b.top - p.y * S.zoom;
  applyView(); save();
}

let panState = null;
board.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.sticky, .main-card')) return;
  panState = { x: e.clientX, y: e.clientY, px: S.pan.x, py: S.pan.y };
  board.classList.add('panning');
});
window.addEventListener('mousemove', (e) => {
  if (!panState) return;
  S.pan.x = panState.px + (e.clientX - panState.x);
  S.pan.y = panState.py + (e.clientY - panState.y);
  applyView();
});
window.addEventListener('mouseup', () => {
  if (panState) { panState = null; board.classList.remove('panning'); save(); }
});
board.addEventListener('wheel', (e) => {
  if (e.target.closest('.st-body, .modal')) return; // 付箋の中はスクロールさせる
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY);
  else { S.pan.x -= e.deltaX; S.pan.y -= e.deltaY; applyView(); }
}, { passive: false });

// ---------------- 選択メニュー ----------------
document.addEventListener('mouseup', (e) => {
  if (e.target.closest('#sel-menu')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text || !sel.rangeCount) return hideMenu();
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const host = (node.nodeType === 1 ? node : node.parentElement).closest('.selectable');
    if (!host) return hideMenu();
    const source = host.dataset.source;
    const srcEl = source === 'main' ? mainCard : document.getElementById('st-' + source);
    if (!srcEl) return hideMenu();
    const rect = range.getBoundingClientRect();
    const srcRect = srcEl.getBoundingClientRect();
    const inCode = !!(node.nodeType === 1 ? node : node.parentElement).closest('pre') || !!(range.startContainer.parentElement && range.startContainer.parentElement.closest('pre'));
    selCtx = { text: text.slice(0, inCode ? 3000 : 600), source, anchorY: (rect.top + rect.height / 2 - srcRect.top) / S.zoom, code: inCode, lines: inCode ? lineRangeOf(range) : '' };
    showMenu(rect);
  }, 0);
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#sel-menu')) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });

function showMenu(rect) {
  const m = $('#sel-menu');
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  let left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left));
  let top = rect.bottom + 8;
  if (top + h > window.innerHeight - 8) top = rect.top - h - 8;
  top = Math.min(Math.max(64, top), window.innerHeight - h - 8);
  m.style.left = left + 'px'; m.style.top = top + 'px';
}
function hideMenu() { $('#sel-menu').hidden = true; }

$('#sel-menu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b || !selCtx) return;
  hideMenu();
  window.getSelection().removeAllRanges();
  createSticky(b.dataset.action, selCtx);
  selCtx = null;
});

// ---------------- 付箋の作成・配置 ----------------
function titleFor(type, text, lines) {
  const s = lines || short(text);
  switch (type) {
    case 'question': return `「${s}」について`;
    case 'detail': return `「${s}」を詳しく`;
    case 'term': return s;
    case 'diagram': return `「${s}」を図で`;
    case 'data': return `「${s}」をデータで確かめる`;
    case 'review': return lines ? `${lines}をレビュー` : `「${s}」をレビュー`;
    default: return 'メモ';
  }
}

function boxOf(id) {
  const e = id === 'main' ? mainCard : document.getElementById('st-' + id);
  if (!e || e.style.display === 'none') return null;
  return { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight };
}

function placeNew(parentId, anchorY, type) {
  const p = boxOf(parentId) || boxOf('main');
  const w = type === 'diagram' || type === 'data' || type === 'review' ? 560 : 380;
  let x = p.x + p.w + 70, y = Math.max(0, p.y + (anchorY || 0) - 24);
  for (let i = 0; i < 60; i++) {
    const hit = S.order.map(boxOf).find((b) => b && x < b.x + b.w && x + w > b.x && y < b.y + b.h + 12 && y + 120 > b.y);
    if (!hit) break;
    y = hit.y + hit.h + 16;
  }
  return { x, y };
}

function createSticky(type, ctx) {
  const id = 's' + (++S.seq);
  const parent = ctx ? ctx.source : null;
  let pos;
  if (ctx) pos = placeNew(parent, ctx.anchorY, type);
  else {
    const b = board.getBoundingClientRect();
    pos = toWorld(b.left + b.width / 2 - 150, b.top + b.height / 2 - 80);
  }
  const st = {
    id, type, parent,
    title: titleFor(type, ctx ? ctx.text : '', ctx && ctx.lines),
    code: !!(ctx && ctx.code), lines: (ctx && ctx.lines) || '',
    anchorText: ctx ? ctx.text : '',
    anchorY: ctx ? ctx.anchorY : 0,
    x: Math.round(pos.x), y: Math.round(pos.y),
    folded: false, impact: false, sessionId: null, messages: [], memo: '', busy: false,
  };
  S.stickies[id] = st;
  S.order.push(id);
  focusSticky(id);
  if (type === 'memo' || type === 'question') {
    const ta = document.querySelector(`#st-${id} textarea`);
    if (ta) ta.focus();
  } else {
    ask(st, { action: type });
  }
}

function ancestors(st) {
  const out = [];
  let p = st.parent;
  while (p && p !== 'main' && S.stickies[p]) { out.push(p); p = S.stickies[p].parent; }
  return out;
}
function isHidden(st) { return ancestors(st).some((id) => S.stickies[id].folded); }
function childrenOf(id) { return S.order.filter((k) => S.stickies[k].parent === id); }
function descendantsCount(id) { return childrenOf(id).reduce((n, k) => n + 1 + descendantsCount(k), 0); }

// 対象（とその祖先）を開いて、そこに目を向ける。
// 以前はこのとき他を全部たたんでいたが、付箋を動かしただけで畳まれて驚くので、やめた。
// まとめてたたみたいときは、上の「すべてたたむ」を使う。
function focusSticky(id) {
  const st = S.stickies[id];
  ancestors(st).forEach((a) => { S.stickies[a].folded = false; });
  st.folded = false;
  S.focus = id;
  renderAll();
}

// ---------------- Claude とのやりとり ----------------
function setPending(d) {
  pendingCount += d;
  const p = $('#pending');
  p.hidden = pendingCount <= 0;
  p.textContent = pendingCount > 1 ? `Claudeが考えています…（${pendingCount}）` : 'Claudeが考えています…';
}

function anchorFor(st) {
  if (!st.code) return st.anchorText;
  return `${st.lines ? st.lines + '\n' : ''}~~~~\n${st.anchorText}\n~~~~`;
}

async function ask(st, { action, question, followUp }) {
  if (st.busy) return;
  const parentSession = st.parent && st.parent !== 'main' && S.stickies[st.parent] ? S.stickies[st.parent].sessionId : null;
  const first = !st.sessionId;
  const body = first
    ? { action, anchor: anchorFor(st), question, sessionId: parentSession, continueSession: false }
    : { followUp, sessionId: st.sessionId, continueSession: true };
  st.messages.push({ role: 'user', text: question || followUp || ACTION_LABEL[action] || '質問' });
  if (first && action === 'question' && question) st.title = short(question, 40);
  st.busy = true; setPending(1); renderSticky(st);
  const r = await post('/api/ask', body);
  st.busy = false; setPending(-1);
  if (r.ok) { st.sessionId = r.sessionId || st.sessionId; st.messages.push({ role: 'assistant', text: r.text }); }
  else st.messages.push({ role: 'error', text: r.error || '失敗しました' });
  save(); renderSticky(st); refreshStatus(); drawWires();

  // メインが確認なしで動いているなら、提案されたSQLはそのまま実行する
  if (r.ok && autoRun) {
    const msg = st.messages[st.messages.length - 1];
    const sql = firstSql(msg.text);
    if (sql) await runSql(st, msg, sql);
  }
}

// 回答の中の最初の ```sql を取り出す
function firstSql(text) {
  const m = (text || '').match(/```sql\s*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

async function runSql(st, msg, sql) {
  if (st.busy) return;
  if (!st.sessionId) { st.messages.push({ role: 'error', text: 'この付箋にはまだセッションがありません。' }); return renderSticky(st); }
  msg.ranSql = (msg.ranSql || []).concat([sql.trim()]);
  st.messages.push({ role: 'user', text: autoRun ? 'このSQLを実行（メインと同じく確認なし）' : 'このSQLを承認して実行' });
  st.busy = true; setPending(1); renderSticky(st);
  const r = await post('/api/runsql', { sessionId: st.sessionId, sql });
  st.busy = false; setPending(-1);
  if (r.ok) { st.sessionId = r.sessionId || st.sessionId; st.messages.push({ role: 'assistant', kind: 'result', at: now(), sql, auto: autoRun, text: r.text }); }
  else st.messages.push({ role: 'error', text: r.error || 'SQLを実行できませんでした' });
  save(); renderSticky(st); drawWires();
}

// ---------------- 描画 ----------------
function renderAll() {
  S.order.forEach((id) => renderSticky(S.stickies[id], true));
  rehighlight(mainBody, 'main');
  refreshStatus();
  drawWires();
  save();
}

function refreshStatus() {
  const n = S.order.length;
  const m = S.order.filter((k) => S.stickies[k].impact).length;
  $('#status').textContent = n ? `付箋 ${n}枚・本筋に影響あり ${m}枚` : '本文を選択すると付箋が作れます';
}

function renderSticky(st, skipWires) {
  let box = document.getElementById('st-' + st.id);
  if (!box) {
    box = el('section');
    box.id = 'st-' + st.id;
    box.addEventListener('mousedown', () => { if (S.focus !== st.id) { S.focus = st.id; document.querySelectorAll('.sticky.focused').forEach((x) => x.classList.remove('focused')); box.classList.add('focused'); } });
    world.appendChild(box);
  }
  const wide = st.type === 'diagram' || st.type === 'data' || st.type === 'review';
  box.className = `sticky t-${st.type}${wide ? ' wide' : ''}${st.impact ? ' impact' : ''}${st.folded ? ' folded' : ''}${S.focus === st.id ? ' focused' : ''}`;
  box.setAttribute('aria-label', `付箋：${st.title}`);
  box.style.left = st.x + 'px';
  box.style.top = st.y + 'px';
  box.style.display = isHidden(st) ? 'none' : '';
  box.style.width = st.folded || !st.w ? '' : st.w + 'px';
  box.innerHTML = '';

  // ヘッダー
  const head = el('div', 'st-head');
  head.append(el('span', 'st-kind', st.impact ? '影響あり' : KIND[st.type]));
  head.append(el('span', 'st-title', st.title));
  if (st.folded) {
    const kids = descendantsCount(st.id);
    if (kids) head.append(el('span', 'kids', `子 +${kids}`));
    box.append(head);
    const last = [...st.messages].reverse().find((m) => m.role === 'assistant');
    const peek = el('div', 'peek', last ? short(last.text.replace(/```[\s\S]*?```/g, '［図・コード］').replace(/[#*_>`]/g, ''), 160) : (st.memo || 'まだやりとりはありません'));
    box.append(peek);
    attachDrag(head, st, () => focusSticky(st.id));
    return finish();
  }
  const impactBtn = el('button', 'st-btn' + (st.impact ? ' on' : ''), '本筋に影響あり');
  impactBtn.title = 'メインに返す候補にする';
  impactBtn.onclick = () => { st.impact = !st.impact; renderAll(); };
  const foldBtn = el('button', 'st-btn', 'たたむ');
  foldBtn.onclick = () => { st.folded = true; renderAll(); };
  const delBtn = el('button', 'st-btn', '×');
  delBtn.setAttribute('aria-label', 'この付箋を消す');
  delBtn.onclick = () => removeSticky(st.id);
  head.append(impactBtn, foldBtn, delBtn);
  box.append(head);
  attachDrag(head, st);

  if (st.anchorText) {
    const an = el('div', 'st-anchor' + (st.code ? ' code' : ''), (st.lines ? st.lines + '　' : '') + st.anchorText);
    box.append(an);
  }

  const body = el('div', 'st-body');
  applyBodyHeight(body, st);
  if (st.type === 'memo') {
    const ta = el('textarea', 'memo-edit');
    ta.placeholder = '自分の言葉でまとめる…';
    ta.value = st.memo;
    ta.oninput = () => { st.memo = ta.value; save(); };
    body.append(ta);
    box.append(body);
    return finish();
  }
  st.messages.forEach((m) => body.append(renderMessage(st, m)));
  if (st.busy) body.append(el('div', 'msg thinking', 'Claudeが考えています…'));
  box.append(body);

  // 入力欄
  const row = el('div', 'st-input');
  const ta = el('textarea');
  ta.rows = 2;
  const firstQuestion = st.type === 'question' && !st.sessionId && !st.messages.some((m) => m.role === 'user');
  ta.placeholder = firstQuestion ? '何がわからない？（⌘/Ctrl+Enterで送信）' : '続けて聞く（⌘/Ctrl+Enterで送信）';
  ta.setAttribute('aria-label', '質問を入力');
  const send = el('button', null, '送信');
  send.disabled = !!st.busy;
  const go = () => {
    const q = ta.value.trim();
    if (!q || st.busy) return;
    if (!st.sessionId) ask(st, { action: 'question', question: q });
    else ask(st, { followUp: q });
  };
  send.onclick = go;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); go(); } });
  row.append(ta, send);
  box.append(row);
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  return finish();

  function finish() {
    if (!st.folded) { rehighlight(box, st.id); attachResize(box, st); }
    if (!skipWires) { refreshStatus(); drawWires(); }
  }
}

function renderMessage(st, m) {
  if (m.role === 'user') return el('div', 'msg user', m.text);
  if (m.role === 'error') return el('div', 'msg error', m.text);

  const wrap = el('div', 'msg assistant');
  const div = el('div', 'md selectable');
  div.dataset.source = st.id;
  div.innerHTML = md(m.text);
  let result = null;

  div.querySelectorAll('pre > code').forEach((code) => {
    const lang = (code.className.match(/language-([\w-]+)/) || [])[1];
    const pre = code.parentElement;
    if (lang === 'mermaid') {
      const box = el('div', 'diagram-box');
      pre.replaceWith(box);
      renderMermaid(box, code.textContent);
    } else if (lang === 'json') {
      try {
        const j = JSON.parse(code.textContent);
        if (Array.isArray(j.columns) && Array.isArray(j.rows)) {
          result = j;
          const d = el('details', 'result');
          d.append(el('summary', null, `結果の表（${j.rows.length}行）`));
          d.append(tableEl(j));
          pre.replaceWith(d);
        }
      } catch (_) {}
    } else if (lang === 'sql') {
      const ph = el('div');
      pre.replaceWith(ph);
      ph.replaceWith(sqlBox(st, m, code.textContent, pre));
    } else if (pre.dataset.file || lang === 'diff') {
      numberLines(code);
    }
  });

  div.querySelectorAll('pre > code.language-vega-lite, pre > code.language-vegalite').forEach((code) => {
    const box = el('div', 'chart-box');
    code.parentElement.replaceWith(box);
    renderChart(box, code.textContent, result, st);
  });

  wrap.append(div);

  if (m.kind === 'result') {
    wrap.append(el('div', 'source-line', `出典：Claudeが取得した結果（${m.at} に${m.auto ? '実行' : '承認して実行'}）。グラフの値は結果の表から描いています。`));
  }

  // 「本筋への影響：」を見つけたら目立たせる
  const hit = (m.text || '').match(/本筋への影響[：:]\s*(.+)/);
  if (hit) {
    const line = el('div', 'impact-line', '本筋への影響：' + hit[1]);
    if (!st.impact) {
      const b = el('button', 'btn-mini', '影響ありにする');
      b.onclick = () => { st.impact = true; renderAll(); };
      line.append(b);
    }
    wrap.append(line);
  }
  return wrap;
}

function sqlBox(st, m, sql, pre) {
  const ran = (m.ranSql || []).includes(sql.trim()) || m.kind === 'result';
  const box = el('div', 'sql-box' + (ran ? ' ran' : ''));
  const head = el('div', 'sql-head');
  head.append(el('span', null, ran ? '実行したSQL' : (autoRun ? '提案されたSQL（まもなく実行します）' : '提案されたSQL（まだ実行していません）')));
  head.append(el('span', 'spacer'));
  const code = pre.querySelector('code');
  if (!ran) {
    const edit = el('button', 'btn-mini', '直す');
    edit.onclick = () => {
      const on = code.getAttribute('contenteditable') === 'true';
      code.setAttribute('contenteditable', on ? 'false' : 'true');
      edit.textContent = on ? '直す' : '直し終わった';
      if (!on) code.focus();
    };
    const run = el('button', 'btn-run', '承認して実行');
    run.disabled = !!st.busy;
    run.onclick = () => runSql(st, m, code.textContent);
    head.append(edit, run);
  }
  const copy = el('button', 'btn-mini', 'コピー');
  copy.onclick = () => navigator.clipboard && navigator.clipboard.writeText(code.textContent);
  head.append(copy);
  box.append(head, pre);
  return box;
}

function tableEl(j) {
  const wrap = el('div', 'result-table md');
  const t = el('table');
  const tr = el('tr');
  j.columns.forEach((c) => tr.append(el('th', null, String(c))));
  t.append(tr);
  j.rows.slice(0, 200).forEach((r) => {
    const row = el('tr');
    r.forEach((v) => row.append(el('td', null, v == null ? '' : String(v))));
    t.append(row);
  });
  wrap.append(t);
  return wrap;
}

// Vega-Lite のグラフを描く。
// result があれば（付箋のSQL結果）その値を差し込み、なければ spec が持っているデータをそのまま使う（本筋）。
function renderChart(box, text, result, st) {
  try {
    const spec = JSON.parse(text);
    if (result) {
      spec.data = { values: result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c, r[i]]))) };
    } else if (!spec.data || (!spec.data.values && !spec.data.url)) {
      throw new Error('グラフのデータがありません');
    }
    spec.width = 'container';
    spec.autosize = { type: 'fit', contains: 'padding' };
    if (!spec.height) spec.height = 220;
    spec.$schema = spec.$schema || 'https://vega.github.io/schema/vega-lite/v6.json';
    vegaEmbed(box, spec, { actions: false, renderer: 'svg' })
      .then(({ view }) => {
        // 値を押して質問できるのは、付箋のSQL結果から描いたグラフだけ
        if (!result || !st) return drawWires();
        box.title = '点や棒をクリックすると、その値について質問できます';
        view.addEventListener('click', (_e, item) => {
          if (!item || !item.datum) return;
          const datum = Object.fromEntries(Object.entries(item.datum).filter(([k]) => !k.startsWith('Symbol') && result.columns.includes(k)));
          const r = box.getBoundingClientRect();
          const srcRect = document.getElementById('st-' + st.id).getBoundingClientRect();
          createSticky('question', { text: 'グラフの値：' + JSON.stringify(datum), source: st.id, anchorY: (r.top + r.height / 2 - srcRect.top) / S.zoom });
        });
        drawWires();
      })
      .catch((err) => { box.textContent = 'グラフを描けませんでした：' + err.message; });
  } catch (e) {
    box.textContent = e.message;
  }
}

async function renderMermaid(box, code) {
  const id = 'mm' + (++mmSeq);
  try {
    const { svg } = await mermaid.render(id, code);
    box.innerHTML = svg;
  } catch (e) {
    const tmp = document.getElementById('d' + id); if (tmp) tmp.remove();
    box.innerHTML = '';
    box.append(el('p', null, '図を描けませんでした。元の記述：'));
    const p = el('pre'); p.textContent = code; box.append(p);
  }
  drawWires();
}

// 付箋の出どころになった文字をマーカーで示す
function rehighlight(root, sourceId) {
  root.querySelectorAll('mark.anc').forEach((mk) => { mk.replaceWith(...mk.childNodes); });
  root.normalize();
  childrenOf(sourceId).forEach((cid) => {
    const c = S.stickies[cid];
    if (!c.anchorText || c.anchorText.startsWith('グラフの値：')) return;
    const scope = sourceId === 'main' ? root : root.querySelector('.st-body') || root;
    highlightText(scope, c.anchorText).forEach((mk) => {
      mk.className = `anc t-${c.type}${c.impact ? ' impact' : ''}`;
      mk.dataset.sid = cid;
      mk.title = c.title;
      mk.onclick = () => { focusSticky(cid); };
    });
  });
}

// 選んだ文を、本筋のどこから来たか探して mark で包む。
// つまずきどころが2つある。
//   1. 太字やインラインコードをまたぐと、テキストノードが分かれる → つないでから探す
//   2. 段落の途中の改行は、画面では空白に見える。ブラウザが返す選択文字列は空白だが、
//      DOMの中は改行のまま → 空白の種類をそろえてから比べる
function highlightText(root, text) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.parentElement.closest('mark.anc, .diagram-box, .chart-box, .sql-box, textarea, .st-anchor, .msg.user')) continue;
    nodes.push(n);
  }
  const flat = nodes.map((x) => x.data).join('');

  // 連続する空白を1つにそろえた文字列と、もとの位置への対応表を作る
  let norm = '';
  const back = [];
  for (let i = 0; i < flat.length; i++) {
    if (/\s/.test(flat[i])) {
      if (norm.endsWith(' ')) continue;
      norm += ' ';
    } else {
      norm += flat[i];
    }
    back.push(i);
  }
  const squash = (s) => s.replace(/\s+/g, ' ').trim();

  const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) || '';
  const candidates = [text, firstLine, firstLine.slice(0, 40)]
    .map(squash).filter((s, i, a) => s && a.indexOf(s) === i);

  let start = -1, end = -1;
  for (const c of candidates) {
    const at = norm.indexOf(c);
    if (at >= 0) { start = back[at]; end = back[at + c.length - 1] + 1; break; }
  }
  if (start < 0) return [];

  // つないだ文字列の [start, end) を、もとのテキストノードの範囲に割り戻す
  const segments = [];
  let pos = 0;
  for (const node of nodes) {
    const len = node.data.length;
    const s = Math.max(start, pos), e = Math.min(end, pos + len);
    if (s < e) segments.push({ node, from: s - pos, to: e - pos });
    pos += len;
    if (pos >= end) break;
  }
  return segments.map(({ node, from, to }) => {
    const r = document.createRange();
    r.setStart(node, from); r.setEnd(node, to);
    const mk = document.createElement('mark');
    r.surroundContents(mk); // 1つのテキストノードの中なので安全に包める
    return mk;
  });
}

// ---------------- 線 ----------------
function drawWires() {
  const parts = [];
  const b = board.getBoundingClientRect();
  S.order.forEach((id) => {
    const st = S.stickies[id];
    if (!st.parent || isHidden(st)) return;
    const me = document.getElementById('st-' + id);
    const src = st.parent === 'main' ? mainCard : document.getElementById('st-' + st.parent);
    if (!me || !src || src.style.display === 'none') return;
    const parentFolded = st.parent !== 'main' && S.stickies[st.parent] && S.stickies[st.parent].folded;
    let ay;
    const mk = src.querySelector(`mark.anc[data-sid="${id}"]`);
    if (mk && !parentFolded) {
      const r = mk.getBoundingClientRect();
      const srcR = src.getBoundingClientRect();
      if (r.height && r.top >= srcR.top && r.bottom <= srcR.bottom) ay = (r.top + r.height / 2 - b.top - S.pan.y) / S.zoom;
    }
    if (ay == null) ay = parentFolded ? src.offsetTop + src.offsetHeight / 2 : src.offsetTop + Math.min(Math.max(st.anchorY, 16), src.offsetHeight - 10);
    const ax = src.offsetLeft + src.offsetWidth;
    const bx = me.offsetLeft, by = me.offsetTop + 20;
    const dx = Math.max(30, Math.abs(bx - ax) / 2);
    parts.push(`<path d="M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}" stroke="${st.impact ? '#ec6d50' : WIRE_COLOR[st.type]}"/>`);
    parts.push(`<circle cx="${ax}" cy="${ay}" r="4" fill="${st.impact ? '#ec6d50' : WIRE_COLOR[st.type]}"/>`);
  });
  wires.innerHTML = parts.join('');
}

// ---------------- ドラッグ ----------------
// 付箋の大きさを変えるつまみを3つ付ける。
//   右の辺 → 横だけ / 下の辺 → 縦だけ / 右下の角 → 両方
// どれもダブルクリックで既定に戻す。
function attachResize(box, st) {
  const body = () => box.querySelector('.st-body');
  const make = (cls, axis, title) => {
    const grip = el('div', cls);
    grip.title = title + '（ダブルクリックで元に戻す）';
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const b = body();
      const start = { x: e.clientX, y: e.clientY, w: box.offsetWidth, h: b ? b.offsetHeight : 0 };
      const mv = (ev) => {
        if (axis !== 'y') {
          st.w = Math.max(280, Math.round(start.w + (ev.clientX - start.x) / S.zoom));
          box.style.width = st.w + 'px';
        }
        if (axis !== 'x' && b) {
          st.h = Math.max(100, Math.round(start.h + (ev.clientY - start.y) / S.zoom));
          applyBodyHeight(b, st);
        }
        drawWires();
      };
      const up = () => {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
        save(); drawWires();
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (axis !== 'y') delete st.w;
      if (axis !== 'x') delete st.h;
      save(); renderAll();
    });
    box.append(grip);
  };
  make('st-resize-x', 'x', '横幅を変える');
  make('st-resize-y', 'y', '高さを変える');
  make('st-resize', 'both', '大きさを変える');
}

// 高さを指定されたら、その高さの箱にして中をスクロールさせる。
// 指定がなければ既定の上限まで内容なりに伸びる。
function applyBodyHeight(bodyEl, st) {
  if (st.h) { bodyEl.style.height = st.h + 'px'; bodyEl.style.maxHeight = 'none'; }
  else { bodyEl.style.height = ''; bodyEl.style.maxHeight = ''; }
}

function attachDrag(handle, st, onClick) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y };
    let moved = false;
    const box = document.getElementById('st-' + st.id);
    const mv = (ev) => {
      const dx = (ev.clientX - start.x) / S.zoom, dy = (ev.clientY - start.y) / S.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      st.x = Math.round(start.sx + dx); st.y = Math.round(start.sy + dy);
      box.style.left = st.x + 'px'; box.style.top = st.y + 'px';
      drawWires();
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      save();
      if (!moved && onClick) onClick();
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
}

function removeSticky(id) {
  const st = S.stickies[id];
  const n = descendantsCount(id);
  if ((st.messages.length || n) && !confirm(n ? `この付箋と子付箋${n}枚を消しますか？` : 'この付箋を消しますか？')) return;
  const kill = (k) => { childrenOf(k).forEach(kill); const e = document.getElementById('st-' + k); if (e) e.remove(); delete S.stickies[k]; S.order = S.order.filter((x) => x !== k); };
  kill(id);
  renderAll();
}

// ---------------- 整列 ----------------
function arrange() {
  const main = boxOf('main');
  let cursor = main.y;
  const roots = S.order.filter((k) => S.stickies[k].parent === 'main' || !S.stickies[k].parent)
    .sort((a, b) => (S.stickies[a].anchorY || 0) - (S.stickies[b].anchorY || 0));
  const layout = (id, x, minY) => {
    const st = S.stickies[id];
    st.x = x; st.y = Math.round(minY);
    renderSticky(st, true);
    const me = boxOf(id);
    let bottom = me ? me.y + me.h : st.y;
    if (st.folded) return bottom;
    let cy = st.y;
    childrenOf(id).sort((a, b) => (S.stickies[a].anchorY || 0) - (S.stickies[b].anchorY || 0)).forEach((cid) => {
      const c = S.stickies[cid];
      const y = Math.max(cy, st.y + (c.anchorY || 0) - 24);
      const b = layout(cid, x + (me ? me.w : 380) + 60, y);
      cy = b + 16;
      bottom = Math.max(bottom, b);
    });
    return bottom;
  };
  roots.forEach((id) => {
    const st = S.stickies[id];
    const y = st.parent === 'main' ? Math.max(cursor, main.y + (st.anchorY || 0) - 24) : cursor;
    cursor = layout(id, main.x + main.w + 80, y) + 24;
  });
  renderAll();
}

// ---------------- ツールバー ----------------
$('#btn-memo').onclick = () => createSticky('memo', null);
$('#btn-arrange').onclick = arrange;
$('#btn-home').onclick = () => { S.zoom = 1; S.pan = { x: 40, y: 20 }; applyView(); save(); };
$('#btn-zoom-in').onclick = () => setZoom(S.zoom * 1.2);
$('#btn-zoom-out').onclick = () => setZoom(S.zoom / 1.2);
$('#btn-fold-all').onclick = () => { S.order.forEach((k) => { if (!S.stickies[k].impact) S.stickies[k].folded = true; }); renderAll(); };

// ---------------- 理解を終える ----------------
$('#btn-finish').onclick = () => {
  const list = $('#ret-list');
  list.innerHTML = '';
  const items = S.order.map((k) => S.stickies[k]).filter((s) => s.messages.length || s.memo);
  if (!items.length) list.append(el('p', 'muted', '付箋はまだありません。'));
  items.forEach((s) => {
    const lab = el('label', 'ret-item' + (s.impact ? ' impact' : ''));
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = s.impact; cb.dataset.id = s.id;
    const txt = el('div');
    txt.append(el('strong', null, `${s.impact ? '［影響あり］' : `［${KIND[s.type]}］`} ${s.title}`));
    if (s.anchorText) txt.append(el('div', null, '元の文：' + short(s.anchorText, 60)));
    lab.append(cb, txt);
    list.append(lab);
  });
  $('#return-modal').hidden = false;
};
$('#btn-ret-back').onclick = () => { $('#return-modal').hidden = true; };

$('#btn-draft').onclick = async () => {
  const ids = [...document.querySelectorAll('#ret-list input:checked')].map((c) => c.dataset.id);
  if (!ids.length) { alert('付箋を1枚以上選んでください。'); return; }
  const notes = ids.map((id) => {
    const s = S.stickies[id];
    const lastQ = [...s.messages].reverse().find((m) => m.role === 'user');
    const lastA = [...s.messages].reverse().find((m) => m.role === 'assistant');
    return [`### ${s.title}`, s.anchorText ? `本筋の該当箇所：${s.anchorText}` : '', s.memo ? `自分のメモ：${s.memo}` : '',
      lastQ ? `最後の質問：${lastQ.text}` : '', lastA ? `最後の回答：${lastA.text.slice(0, 1500)}` : ''].filter(Boolean).join('\n');
  }).join('\n\n');
  const btn = $('#btn-draft');
  btn.disabled = true; btn.textContent = '下書きを作っています…';
  const r = await post('/api/draft', { notes });
  btn.disabled = false; btn.textContent = '選んだ付箋から下書きを作る';
  const ta = $('#ret-text');
  if (!r.ok) { alert(r.error || '下書きを作れませんでした'); return; }
  if (!ta.value.trim() || confirm('今の文を下書きで置き換えますか？')) ta.value = r.text.trim();
};

async function finishWith(text) {
  const r = await post('/api/return', { text });
  if (!r.ok) { alert(r.error || '送れませんでした'); return; }
  try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
  $('#return-modal').hidden = true;
  $('#done').hidden = false;
}
$('#btn-ret-send').onclick = () => {
  const t = $('#ret-text').value.trim();
  if (!t && !confirm('返す文が空です。何も返さずに閉じますか？')) return;
  finishWith(t);
};
$('#btn-ret-none').onclick = () => { if (confirm('何も返さずに閉じますか？付箋はすべて破棄されます。')) finishWith(''); };

window.addEventListener('resize', drawWires);
init();
