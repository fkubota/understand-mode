#!/usr/bin/env bash
# 理解モード（/understand スキル）を Claude Code にインストールする
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

# 既存の設定ファイルは残す
KEEP_CONFIG=""
if [ -f "${DEST}/app/config.json" ]; then
  KEEP_CONFIG="$(mktemp)"
  cp "${DEST}/app/config.json" "${KEEP_CONFIG}"
fi

mkdir -p "${HOME}/.claude/skills"
rm -rf "${DEST}"
cp -R "${HERE}/skill/understand" "${DEST}"

if [ -n "${KEEP_CONFIG}" ]; then
  cp "${KEEP_CONFIG}" "${DEST}/app/config.json"
  rm -f "${KEEP_CONFIG}"
else
  cp "${DEST}/app/config.example.json" "${DEST}/app/config.json"
fi

echo "インストールしました：${DEST}"
echo "SQL実行を使うなら、${DEST}/app/config.json の dbPort / dbUser / dbName を環境に合わせてください。"
echo "Claude Code を開き直すと /understand が使えます。"
