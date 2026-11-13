#!/usr/bin/env bash
# 開発中のスキルを ~/.claude/skills/understand にシンボリックリンクする。
# リポジトリを編集すると、そのまま Claude Code の /understand に反映される。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${HOME}/.claude/skills/understand"
mkdir -p "${HOME}/.claude/skills"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  mv "$DEST" "${DEST}.bak.$(date +%Y%m%d%H%M%S)"
  echo "既存のインストールを退避しました: ${DEST}.bak.*"
fi
ln -sfn "$ROOT/skill/understand" "$DEST"
[ -f "$ROOT/skill/understand/app/config.json" ] || cp "$ROOT/skill/understand/app/config.example.json" "$ROOT/skill/understand/app/config.json"
echo "リンクしました: $DEST -> $ROOT/skill/understand"
