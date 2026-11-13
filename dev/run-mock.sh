#!/usr/bin/env bash
# 偽の claude（dev/mock-claude.js）でサーバーを起動する。Claudeの費用をかけずにUIを触れる。
# 使い方: bash dev/run-mock.sh [ポート(既定 4502)] [本筋のMarkdown(既定 dev/fixtures/sample-main.md)]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-4502}"
MAIN="${2:-$ROOT/dev/fixtures/sample-main.md}"

DIR="$(mktemp -d "${TMPDIR:-/tmp}/understand-dev-XXXXXX")"
cp "$MAIN" "$DIR/main.md"
echo "サンプル" > "$DIR/title.txt"

echo "作業フォルダ: $DIR"
# モックではSSHトンネルを張らないので、疎通確認は飛ばす
UNDERSTAND_CLAUDE_BIN="$ROOT/dev/mock-claude.js" \
UNDERSTAND_SKIP_TUNNEL_CHECK=1 \
  exec node "$ROOT/skill/understand/app/server.js" \
  --dir "$DIR" --session mock-main-session --cwd "$ROOT" --port "$PORT" ${NO_OPEN:+--no-open}
