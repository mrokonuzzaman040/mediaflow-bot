# Social Media Telegram Bot (free: Cloudflare Workers + GitHub Actions)

Send the bot a link from **YouTube, TikTok, Instagram, Facebook or X** and choose:

| Button | Result |
|---|---|
| 🎬 Download video | MP4 (shrunk automatically to fit Telegram's 50 MB bot limit) |
| 🎵 Convert to MP3 | MP3 audio (bitrate lowered automatically if needed) |
| 💧 Add watermark | Your own text (or the default: the bot's @username) burned into the video |
| ✂️ Crop | 9:16 vertical, 1:1 square or 16:9, centre crop |
| 🖼 Frames | 1 JPEG per second (first 60 s) in a ZIP |

**Cost: $0.** Nothing is stored permanently. Media only lives on the throwaway GitHub runner
while it's processed and is deleted afterwards. Cloudflare KV only holds the link and menu state
for 10 minutes.

> ⚠️ Only download content you own or have the rights to use. Most platforms' terms forbid
> downloading other people's posts.

## How it works

```
Telegram ──webhook──▶ Cloudflare Worker (free) ──repository_dispatch──▶ GitHub Actions (free)
   ▲                  • /start /help, menus                              • yt-dlp download
   │                  • KV state, 10 min TTL                             • ffmpeg edit
   └──────────────────────────── sendVideo / sendAudio / sendDocument ◀──┘ • files deleted
```

A Worker can't run `yt-dlp`/`ffmpeg` (10 ms CPU limit on the free plan), so it only handles chat
and starts a GitHub Actions job, which does the heavy work and replies straight to the chat.

## Project layout

```
.github/workflows/process.yml   GitHub Actions job (download → process → send → delete)
scripts/process.py              all media logic (one function per action), CLI for local tests
scripts/requirements.txt        yt-dlp, requests
scripts/set-webhook.sh          registers the Telegram webhook + command list
tests/test_process.py           local ffmpeg tests (generated sample video)
worker/src/index.ts             Cloudflare Worker (Telegram webhook)
worker/wrangler.toml            Worker config (KV binding, vars)
worker/test/worker.test.mjs     Worker tests (mocked Telegram/GitHub/KV)
```

## Setup (about 20 minutes, all free)

You need: a Telegram account, a GitHub account, a Cloudflare account, Node.js 20+ and git.

### 1. Create the bot
1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → pick a name and username.
2. Copy the **bot token** (looks like `123456789:AA...`). Keep it secret.

### 2. Create the GitHub repository
1. Create a new repo on GitHub, e.g. `social-media-bot`.
   - **Public repo = unlimited free Actions minutes.** The code is public, but your secrets are
     not, and the bot masks each user's link and chat id in the logs. Workflow logs of a public
     repo are still public, so anyone can see *that* a job ran and which action it was.
   - **Private repo = 2,000 free minutes/month** (each job takes about 1–3 min, so roughly
     700–2,000 jobs a month).
2. Push this project:
   ```bash
   cd social-media-bot
   git init && git add . && git commit -m "Telegram media bot"
   git branch -M main
   git remote add origin https://github.com/<you>/social-media-bot.git
   git push -u origin main
   ```
3. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `TELEGRAM_BOT_TOKEN` = the token from BotFather
   - `YT_DLP_COOKIES` *(optional, see "Cookies" below)*
4. Repo → **Settings → Actions → General**: make sure Actions are allowed.

### 3. Create a GitHub token for the Worker
GitHub → your avatar → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:
- Repository access: **Only select repositories** → your bot repo
- Repository permissions: **Contents: Read and write** (required by the
  `repository_dispatch` API; Metadata: Read is added automatically). No other permissions.
- Expiration: choose a date and set a reminder to renew it (max 1 year).

Copy the token (`github_pat_...`).

### 4. Deploy the Cloudflare Worker
```bash
cd worker
npm install
npx wrangler login                      # opens the browser, free account is fine
npx wrangler kv namespace create STATE  # copy the printed id
```
Paste the id into `worker/wrangler.toml` (`id = "..."` under `[[kv_namespaces]]`).

Optional: in `wrangler.toml` set `ALLOWED_USER_IDS = "123456789"` so only you can use the bot
(send the bot a message with the allowlist on and it will tell you your id).

Create a random webhook secret (letters, digits, `_` and `-` only):
```bash
openssl rand -hex 32
```

Set the Worker secrets (each command asks for the value):
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN   # BotFather token
npx wrangler secret put WEBHOOK_SECRET       # the random string from above
npx wrangler secret put GITHUB_TOKEN         # github_pat_... from step 3
npx wrangler secret put GITHUB_REPO          # e.g. rokon/social-media-bot
npx wrangler deploy
```
`wrangler deploy` prints your URL, e.g. `https://social-media-bot.<you>.workers.dev`.

### 5. Register the webhook
```bash
cd ..
export TELEGRAM_BOT_TOKEN='123456789:AA...'
export WEBHOOK_SECRET='the-same-random-string'
./scripts/set-webhook.sh https://social-media-bot.<you>.workers.dev
./scripts/set-webhook.sh --info     # should show the url and no last_error
```
Or with plain curl:
```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://social-media-bot.<you>.workers.dev/webhook" \
  -d "secret_token=$WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```

### 6. Try it
Open your bot in Telegram → `/start` → send a link → pick an action. You get a "⏳ Processing"
message, then the file usually 1–3 minutes later.

## Cookies (Instagram / Facebook / X / YouTube "confirm you're not a bot")
Some posts need a logged-in session, and YouTube sometimes blocks GitHub's servers.
1. Install a "Get cookies.txt LOCALLY" type browser extension, log in to the site (ideally with a
   **secondary account**), and export cookies in Netscape `cookies.txt` format.
2. Paste the whole file content into the GitHub secret `YT_DLP_COOKIES`.
Cookies expire. If downloads start failing again, export them again. Treat this secret like a
password: it gives access to that account.

## Local testing
```bash
pip install -r scripts/requirements.txt        # plus ffmpeg from your OS package manager
python -m unittest discover -s tests -v        # generates a test video and checks every action
python scripts/process.py --input my.mp4 --action crop --crop 9:16 --out-dir out
python scripts/process.py --url "https://youtu.be/..." --action mp3 --out-dir out

cd worker && npm install && npm run check && npm test
```

## Limits
- **50 MB per file** (Telegram Bot API). Videos are re-encoded down to 720p/480p/360p to fit.
  Very long videos (roughly over 25–40 min) can't fit and the bot will suggest MP3 instead.
- **Frames**: first 60 seconds only (`FRAMES_MAX_SECONDS` in `wrangler.toml`, max 60).
- Only the **first video** of a carousel/playlist is processed.
- GitHub Actions jobs take about 30–60 s to start, so expect 1–3 minutes per request.
- Free Cloudflare plan: 100k Worker requests/day, KV 1,000 writes/day (about 2 writes per
  request), which is plenty for personal or small-team use.
- Sites change often. The workflow always installs the latest `yt-dlp`; if a site breaks,
  re-running usually works once yt-dlp ships a fix.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Bot doesn't answer | `./scripts/set-webhook.sh --info` → check `last_error_message`; `npx wrangler tail` for Worker logs |
| "GitHub dispatch failed" | Check `GITHUB_TOKEN` (Contents: write, right repo, not expired) and `GITHUB_REPO` = `owner/repo` |
| "Processing…" never finishes | Repo → Actions tab → open the failed run |
| "The site refused the download" | Add/refresh the `YT_DLP_COOKIES` secret |
