#!/bin/bash
# Morning digest: ephemeral serve-API session -> Telegram.
# Triggered by opencode-digest.timer (weekdays 07:00). Safe to run manually:
#   ./scripts/morning-digest.sh <telegram-chat-id>
# NOTE: never uses `opencode run` (its free-tier path can fail at night).
set -u
BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BOT_DIR" || exit 1
NODE_BIN="${NODE_BIN:-$(command -v node)}"
TSX_BIN="${TSX_BIN:-node_modules/.bin/tsx}"
CHAT_ID="${1:-${DIGEST_CHAT_ID:-}}"
if [ -z "$CHAT_ID" ]; then
  echo "usage: morning-digest.sh <telegram-chat-id>  (or set DIGEST_CHAT_ID)" >&2
  exit 2
fi
exec "$NODE_BIN" "$TSX_BIN" scripts/morning-digest.mts "$CHAT_ID"
