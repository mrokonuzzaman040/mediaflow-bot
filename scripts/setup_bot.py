#!/usr/bin/env python3
"""Configure the MediaFlow bot's Telegram profile and webhook (stdlib only).

Usage (token/secret come from the environment, never from arguments):
  export TELEGRAM_BOT_TOKEN=...            # from @BotFather
  export WEBHOOK_SECRET=...                # same value as the Worker secret
  python scripts/setup_bot.py --profile                        # commands, descriptions, menu button
  python scripts/setup_bot.py --webhook https://mediaflow-bot.<you>.workers.dev
  python scripts/setup_bot.py --profile --admin-ids 8604335127  # + admin-only /stats /users /recent menu
  python scripts/setup_bot.py --info                           # webhook status (no secrets printed)
  python scripts/setup_bot.py --delete-webhook
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

COMMANDS = [
    {"command": "start", "description": "🎬 Welcome & quick start"},
    {"command": "help", "description": "📖 How to use MediaFlow"},
    {"command": "features", "description": "⚙️ What I can do"},
    {"command": "cancel", "description": "❌ Cancel the current menu or input"},
    {"command": "about", "description": "💬 About, privacy & support"},
]

ADMIN_COMMANDS = COMMANDS + [
    {"command": "stats", "description": "📊 Usage stats (admin)"},
    {"command": "users", "description": "👥 Last 10 active users (admin)"},
    {"command": "recent", "description": "🧾 Last 10 jobs (admin)"},
]

DESCRIPTION = (
    "🎬 MediaFlow: download & edit social videos in seconds.\n\n"
    "Paste a link from YouTube, TikTok, Instagram, Facebook or X and choose:\n"
    "📥 Download video (Best / 720p / 480p)\n"
    "🎵 Convert to MP3\n"
    "💧 Add a watermark\n"
    "✂️ Crop to 9:16, 1:1 or 16:9\n"
    "🖼 Extract frames (1 per second)\n\n"
    "🔒 Nothing is stored. Files are deleted right after delivery.\n"
    "Please only download content you own or have the rights to use."
)
SHORT_DESCRIPTION = "Download & edit videos from YouTube, TikTok, Instagram, Facebook & X: MP4, MP3, watermark, crop, frames."


def api(method: str, payload: dict | None = None) -> dict:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        sys.exit("Set TELEGRAM_BOT_TOKEN")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload or {}).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        body = json.load(e)
    except Exception as e:  # never echo the URL (it contains the token)
        sys.exit(f"{method}: network error {type(e).__name__}")
    if not body.get("ok"):
        sys.exit(f"{method} failed: {body.get('description')}")
    return body


def profile() -> None:
    assert len(SHORT_DESCRIPTION) <= 120 and len(DESCRIPTION) <= 512
    api("setMyCommands", {"commands": COMMANDS})
    api("setMyDescription", {"description": DESCRIPTION})
    api("setMyShortDescription", {"short_description": SHORT_DESCRIPTION})
    api("setChatMenuButton", {"menu_button": {"type": "commands"}})
    print("profile: commands, description, short description and menu button set")


def admin_commands(ids: str) -> None:
    """Show the admin commands in the menu only in each admin's private chat."""
    for uid in [x.strip() for x in ids.split(",") if x.strip()]:
        if not re.fullmatch(r"\d+", uid):
            sys.exit(f"invalid admin id {uid!r}")
        api("setMyCommands", {"commands": ADMIN_COMMANDS, "scope": {"type": "chat", "chat_id": int(uid)}})
        print(f"admin command menu set for {uid}")


def webhook(base: str) -> None:
    secret = os.environ.get("WEBHOOK_SECRET", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", secret):
        sys.exit("Set WEBHOOK_SECRET (A-Z a-z 0-9 _ -, 1-256 chars)")
    base = base.rstrip("/")
    if not base.startswith("https://"):
        sys.exit("Worker URL must start with https://")
    api("setWebhook", {"url": f"{base}/webhook", "secret_token": secret,
                       "allowed_updates": ["message", "callback_query"], "drop_pending_updates": True})
    print(f"webhook set to {base}/webhook")


def info() -> None:
    r = api("getWebhookInfo")["result"]
    print(json.dumps({"url": r.get("url"), "pending_update_count": r.get("pending_update_count"),
                      "last_error_message": r.get("last_error_message")}, ensure_ascii=False))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", action="store_true")
    ap.add_argument("--webhook", metavar="WORKER_URL")
    ap.add_argument("--admin-ids", metavar="ID[,ID]", help="show /stats /users /recent in these users' menu")
    ap.add_argument("--info", action="store_true")
    ap.add_argument("--delete-webhook", action="store_true")
    a = ap.parse_args()
    if not (a.profile or a.webhook or a.info or a.delete_webhook or a.admin_ids):
        ap.print_help()
        return
    if a.profile:
        profile()
    if a.admin_ids:
        admin_commands(a.admin_ids)
    if a.delete_webhook:
        api("deleteWebhook", {"drop_pending_updates": True})
        print("webhook deleted")
    if a.webhook:
        webhook(a.webhook)
    if a.info:
        info()


if __name__ == "__main__":
    main()
