# 🎬 MediaFlow: Telegram bot to download & edit social videos (free: Cloudflare Workers + GitHub Actions)

Live bot: [@mediaflobot](https://t.me/mediaflobot)

Send the bot a link from **YouTube, TikTok, Instagram, Facebook or X**. It detects the platform
and shows a menu:

| Button | Result |
|---|---|
| 📥 Download Video | MP4 in 🌟 Best (≤1080p) / 📺 720p / 📱 480p, shrunk automatically to fit Telegram's 50 MB bot limit |
| 🎵 MP3 Audio | MP3 audio (bitrate lowered automatically if needed) |
| 💧 Watermark | Your own text (or the default: the bot's @username) burned into the video |
| ✂️ Crop | 📱 9:16 Vertical, ⬛ 1:1 Square or 🖥 16:9 Wide, centre crop |
| 🖼 Frames (1/sec) | 1 JPEG per second (first 60 s) in a ZIP |
| ❌ Cancel | Closes the menu |

**Cost: $0.** Media is never stored. It only lives on the throwaway GitHub runner while it's
processed and is deleted afterwards. Cloudflare KV holds short-lived state with a TTL on every key
(link/menu 30 min, watermark prompt 10 min, job lock 15 min, cooldown 1 min). Usage data
(users, jobs, command events) is kept in Cloudflare D1 (see below).

> ⚠️ Only download content you own or have the rights to use. Most platforms' terms forbid
> downloading other people's posts.

## UX at a glance
- **/start** shows a branded welcome (platforms, 3-step how-to) with 📖 Help · ⚙️ Features ·
  💬 About & Support buttons. Pages open in the same message and have a ⬅️ Back button.
- **Link card**: "▶️ YouTube link detected" plus a 2-column action keyboard. Sub-menus (quality,
  crop, watermark) edit the same message and have ⬅️ Back.
- **One live status message** that the runner edits through each stage:
  `🚀 Queued` → `🔧 Preparing` → `⏳ Downloading ▰▰▰▰▱▱▱▱▱▱ 40%` → `⚙️ Processing` → `📤 Uploading`.
  It's deleted once the file arrives with a caption (title · platform · action · ⚡ via @mediaflobot).
  Chat actions ("sending video…") are shown while uploading.
- **Friendly errors** (private post, bot check, unavailable, region, rate-limit, too large…) with a
  🔁 Try again button that reopens the menu while the link is still remembered (30 min).
- **Fair-use rate limit**: 1 active job per user, plus a short cooldown (`COOLDOWN_SECONDS`, default
  20 s) after each job. The runner frees the slot via the Worker's `/release` endpoint using a
  one-time random token. If a runner dies, the slot expires by itself after 15 min.
- **Bot profile** (commands menu, description, short description, menu button) is set by
  `scripts/setup_bot.py --profile`.

## Usage database (Cloudflare D1, free)
Database `mediaflow-db`, bound to the Worker as `DB`. Schema in `worker/migrations/`.

| Table | What's stored |
|---|---|
| `users` | Telegram user id (PK), username, first/last name, language, premium flag, first/last seen, total jobs, `is_blocked` |
| `jobs` | One row per started job: user/chat id, link, platform, action, options (JSON), status `queued → running → done/failed`, error code/message, title, file size, source duration, created/started/finished time, processing ms |
| `events` | Commands (`/start`, `/help`, …) and links sent, with timestamps |

Indexes cover `user_id`, `created_at` and `platform`. Timestamps are unix seconds (UTC).
No media and no credentials are stored. The runner's one-time callback token is stored only as
a SHA-256 hash.

- The Worker upserts the user on every message/button press and inserts a `jobs` row when a job
  starts. These writes run in `ctx.waitUntil`, so they never slow down or break the bot. If D1 is
  down, the bot keeps working.
- The GitHub runner reports `running` when it starts and `done`/`failed` (with error code, title,
  size, duration, processing time) when it ends, via the Worker's `/release` endpoint.
- Block a user: `npx wrangler d1 execute mediaflow-db --remote --command "UPDATE users SET is_blocked=1 WHERE user_id=123"`.

**Admin commands** (only for ids in `ADMIN_USER_IDS` in `wrangler.toml`; others get the normal
"unknown" reply):
- `/stats`: users (total, active today, new today/7d), jobs (today/7d/all), success rate,
  average processing time, top platforms and actions. "Today" uses `TZ_OFFSET_MINUTES` (360 = Dhaka).
- `/users`: last 10 active users. `/recent`: last 10 jobs.

Set up / change:
```bash
cd worker
npx wrangler d1 create mediaflow-db            # once; put the id in wrangler.toml
npx wrangler d1 migrations apply mediaflow-db --remote
npx wrangler d1 execute mediaflow-db --remote --command "SELECT COUNT(*) FROM jobs"
```

## How it works

```
Telegram ──webhook──▶ Cloudflare Worker (free) ──repository_dispatch──▶ GitHub Actions (free)
   ▲                  • /start, menus, rate limit                        • yt-dlp download
   │                  • KV state (TTL only)  ◀──── POST /release ──────  • ffmpeg edit
   └──────────── edit status (progress) + sendVideo / sendAudio / sendDocument ◀──┘ • files deleted
```

A Worker can't run `yt-dlp`/`ffmpeg` (10 ms CPU limit on the free plan), so it only handles chat
and starts a GitHub Actions job, which does the heavy work and replies straight to the chat.

## Project layout

```
.github/workflows/process.yml   GitHub Actions job (download → process → send → delete)
scripts/process.py              all media logic (one function per action), CLI for local tests
scripts/requirements.txt        yt-dlp, requests
scripts/setup_bot.py            bot profile (commands, descriptions, menu button) + webhook
tests/test_process.py           local ffmpeg tests (generated sample video)
worker/src/index.ts             Cloudflare Worker (Telegram webhook)
worker/src/db.ts                D1 usage database helpers + admin reports
worker/migrations/              D1 schema (users, jobs, events)
worker/wrangler.toml            Worker config (KV binding, vars)
worker/test/worker.test.mjs     Worker tests (mocked Telegram/GitHub/KV, in-memory SQLite D1 via sql.js)
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
npx wrangler secret put GITHUB_REPO          # e.g. mrokonuzzaman040/mediaflow-bot
npx wrangler deploy
```
`wrangler deploy` prints your URL, e.g. `https://mediaflow-bot.<you>.workers.dev`.

### 5. Set the bot profile and register the webhook
```bash
cd ..
export TELEGRAM_BOT_TOKEN='123456789:AA...'
export WEBHOOK_SECRET='the-same-random-string'
python scripts/setup_bot.py --profile --admin-ids <your-telegram-id> --webhook https://mediaflow-bot.<you>.workers.dev --info
```
`--info` prints only the webhook url, pending update count and last error.

### 6. Try it
Open your bot in Telegram → `/start` → send a link → pick an action. The menu turns into a live
progress message, and the file usually arrives 1–3 minutes later.

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
python scripts/process.py --url "https://youtu.be/..." --action video --quality 480 --out-dir out

cd worker && npm install && npm run check && npm test
```

## Limits
- **50 MB per file** (Telegram Bot API). Videos are re-encoded down to 720p/480p/360p to fit.
  Very long videos (roughly over 25–40 min) can't fit and the bot will suggest MP3 instead.
- **Frames**: first 60 seconds only (`FRAMES_MAX_SECONDS` in `wrangler.toml`, max 60).
- Only the **first video** of a carousel/playlist is processed.
- GitHub Actions jobs take about 30–60 s to start, so expect 1–3 minutes per request.
- Free D1: 5 GB, 5M row reads/day, 100k row writes/day (about 3–4 writes per job).
- Free Cloudflare plan: 100k Worker requests/day, KV 1,000 writes/day (about 5–6 writes per
  link + job, including deletes), so roughly 150+ jobs a day. Plenty for personal or small-team use.
- Sites change often. The workflow always installs the latest `yt-dlp`; if a site breaks,
  re-running usually works once yt-dlp ships a fix.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Bot doesn't answer | `python scripts/setup_bot.py --info` → check `last_error_message`; `npx wrangler tail` for Worker logs |
| "Couldn't start processing" | Check `GITHUB_TOKEN` (Contents: write, right repo, not expired) and `GITHUB_REPO` = `owner/repo` |
| "Processing…" never finishes | Repo → Actions tab → open the failed run |
| "🤖 bot check" / "🔐 needs a login" | Add/refresh the `YT_DLP_COOKIES` secret |
| "You already have a job running" stuck | Wait 15 min (lock auto-expires) or check the Actions run |
