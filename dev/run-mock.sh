#!/usr/bin/env bash
# 偽の claude（dev/mock-claude.js）でサーバーを起動する。Claudeの費用をかけずにUIを触れる。
# 使い方: bash dev/run-mock.sh [ポート(既定 4502)] [本筋のMarkdown(既定 dev/fixtures/sample-main.md)] [全体像の付箋のJSON(省略可)]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-4502}"
MAIN="${2:-$ROOT/dev/fixtures/sample-main.md}"
STICKIES="${3:-}"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/understand-dev-XXXXXX")"
cp "$MAIN" "$DIR/main.md"
echo "サンプル" > "$DIR/title.txt"
# `-o` で貼る付箋。渡したときだけ置く（省略すれば付箋なしの起動になる）
if [ -n "$STICKIES" ]; then cp "$STICKIES" "$DIR/stickies.json"; fi

echo "作業フォルダ: $DIR"
# 合言葉つきのURLを e2e が読める場所に写す
( while [ ! -f "$DIR/url.txt" ]; do sleep 0.2; done; cp "$DIR/url.txt" "$ROOT/dev/.mock-url" ) &
UNDERSTAND_CLAUDE_BIN="$ROOT/dev/mock-claude.js" \
  exec node "$ROOT/skill/understand/app/server.js" \
  --dir "$DIR" --session mock-main-session --cwd "$ROOT" --port "$PORT" ${NO_OPEN:+--no-open}
