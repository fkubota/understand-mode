#!/usr/bin/env bash
# understand-mode（/understand スキル）を Claude Code にインストールする
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.claude/skills/understand"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。Node 18 以上を入れてから、もう一度実行してください。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "Node.js ${NODE_MAJOR} は古すぎます。18 以上にしてください。" >&2
  exit 1
fi

mkdir -p "${HOME}/.claude/skills"
rm -rf "${DEST}"
cp -R "${HERE}/skill/understand" "${DEST}"

echo "インストールしました：${DEST}"
echo "Claude Code を開き直すと /understand が使えます。"
