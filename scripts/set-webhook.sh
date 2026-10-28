#!/usr/bin/env bash
# Register (or inspect / remove) the Telegram webhook for the Cloudflare Worker.
#
# Usage:
#   TELEGRAM_BOT_TOKEN=123:abc WEBHOOK_SECRET=xyz \
#     ./scripts/set-webhook.sh https://social-media-bot.<you>.workers.dev
#   ./scripts/set-webhook.sh --info      # show current webhook status
#   ./scripts/set-webhook.sh --delete    # remove the webhook
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN (from @BotFather)}"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
arg="${1:-}"

case "$arg" in
  --info)   curl -fsS "$API/getWebhookInfo"; echo; exit 0 ;;
  --delete) curl -fsS "$API/deleteWebhook?drop_pending_updates=true"; echo; exit 0 ;;
  "")       echo "Usage: $0 https://<worker>.workers.dev | --info | --delete" >&2; exit 1 ;;
esac

: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET (same value you gave wrangler secret put)}"
if [[ ! "$WEBHOOK_SECRET" =~ ^[A-Za-z0-9_-]{1,256}$ ]]; then
  echo "WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ - (1-256 chars)" >&2; exit 1
fi
base="${arg%/}"
[[ "$base" == https://* ]] || { echo "Worker URL must start with https://" >&2; exit 1; }

curl -fsS -X POST "$API/setWebhook" \
  --data-urlencode "url=${base}/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  --data-urlencode "drop_pending_updates=true"
echo
curl -fsS -X POST "$API/setMyCommands" -H 'content-type: application/json' \
  -d '{"commands":[{"command":"start","description":"Start the bot"},{"command":"help","description":"How to use"},{"command":"cancel","description":"Cancel watermark input"}]}'
echo
echo "Webhook set to ${base}/webhook"
