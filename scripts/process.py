#!/usr/bin/env python3
"""Media processing for the Telegram social-media bot.

Runs on an ephemeral GitHub Actions runner (or locally for testing):
  1. download the link with yt-dlp
  2. process it with ffmpeg (mp3 / watermark / crop / frames)
  3. make sure the result fits Telegram's 50 MB bot upload limit
  4. send it back to the chat, then delete every file

Local testing (no Telegram, no download):
  python scripts/process.py --input sample.mp4 --action crop --crop 9:16 --out-dir out/
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# Telegram Bot API upload limit is 50 MB; keep a safety margin for multipart overhead.
TELEGRAM_LIMIT_BYTES = 50 * 1024 * 1024
TARGET_BYTES = int(49 * 1024 * 1024)
MAX_FRAMES_SECONDS = 60
ACTIONS = {"video", "mp3", "watermark", "crop", "frames"}
CROP_PRESETS = {
    # ratio name -> (w expression, h expression); result is the largest centred box
    "9:16": ("min(iw,ih*9/16)", "min(ih,iw*16/9)"),
    "1:1": ("min(iw,ih)", "min(ih,iw)"),
    "16:9": ("min(iw,ih*16/9)", "min(ih,iw*9/16)"),
}
ALLOWED_HOSTS = (
    "youtube.com", "youtu.be", "tiktok.com", "instagram.com",
    "facebook.com", "fb.watch", "fb.com", "x.com", "twitter.com",
)
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
)


class UserError(Exception):
    """An error whose message is safe and useful to show to the Telegram user.

    code is a short machine-readable reason stored in the usage database.
    """

    def __init__(self, message: str, code: str = "user_error"):
        super().__init__(message)
        self.code = code


# ----------------------------------------------------------------------------- helpers

def run(cmd: list[str], *, quiet: bool = True) -> subprocess.CompletedProcess:
    """Run a command; raise RuntimeError with the tail of stderr on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise RuntimeError(f"{Path(cmd[0]).name} failed (exit {proc.returncode}):\n{tail}")
    if not quiet:
        print(proc.stdout)
    return proc


def probe_duration(path: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", str(path)]).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def has_audio(path: Path) -> bool:
    out = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
               "stream=index", "-of", "csv=p=0", str(path)]).stdout.strip()
    return bool(out)


def find_font() -> str | None:
    for f in FONT_CANDIDATES:
        if Path(f).exists():
            return f
    return None


def is_supported_url(url: str) -> bool:
    m = re.match(r"^https?://([^/?#:]+)", url.strip(), re.I)
    if not m:
        return False
    host = m.group(1).lower()
    return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


def human(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB"


# ----------------------------------------------------------------------------- download

QUALITY_FORMATS = {
    # Prefer something that already fits Telegram, then fall back to the cap, then anything.
    "best": "bv*[height<=1080][filesize<45M]+ba/b[height<=1080][filesize<48M]/"
            "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
    "720": "bv*[height<=720][filesize<45M]+ba/b[height<=720][filesize<48M]/"
           "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
    "480": "bv*[height<=480]+ba/b[height<=480]/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
}

# (pattern in yt-dlp output, friendly message for the user)
# (pattern in yt-dlp output, error code, friendly message for the user)
DOWNLOAD_ERRORS = (
    (r"confirm you.re not a bot|sign in to confirm", "bot_check", "🤖 The site asked for a bot check and "
     "blocked the download server. The bot owner can fix this by adding a YT_DLP_COOKIES secret."),
    (r"private (video|account|post)|this account is private|login required|log in|"
     r"you need to log in|requires authentication|members.only", "private",
     "🔐 This post is private or needs a login, so it can't be downloaded."),
    (r"age.restricted|confirm your age|inappropriate for some users", "age_restricted",
     "🔞 This video is age-restricted and needs a signed-in account."),
    (r"available in your country|geo.?restrict|blocked it in your country", "geo_blocked",
     "🌍 This video isn't available in the download server's region."),
    (r"video unavailable|has been removed|does not exist|404|no longer available|deleted", "unavailable",
     "🚫 This video is unavailable. It may have been removed or the link is wrong."),
    (r"no video formats found|there is no video in this post|unsupported url", "no_video",
     "🎞 I couldn't find a downloadable video in that post."),
    (r"live event|is live|premieres in", "live", "📡 Live streams and premieres can't be downloaded."),
    (r"rate.?limit|too many requests|http error 429", "rate_limited",
     "🚦 The site is rate-limiting downloads right now. Please try again in a few minutes."),
    (r"cookies", "login_required", "🔐 The site requires a login (cookies) for this link."),
)

PROGRESS_PREFIX = "MFPROG"


def classify_download_error(output: str) -> tuple[str, str] | None:
    """Return (error_code, friendly message) for known yt-dlp failures."""
    for pattern, code, message in DOWNLOAD_ERRORS:
        if re.search(pattern, output, re.I):
            return code, message
    return None


def friendly_download_error(output: str) -> str | None:
    found = classify_download_error(output)
    return found[1] if found else None


def download(url: str, workdir: Path, *, audio_only: bool = False, quality: str = "720",
             cookies_file: Path | None = None, on_progress=None) -> Path:
    """Download one media item with yt-dlp into workdir and return the file path.

    on_progress(percent: float) is called while downloading. The title (if known)
    is written to workdir/title.txt.
    """
    if not is_supported_url(url):
        raise UserError("🔗 Unsupported link. Send a YouTube, TikTok, Instagram, Facebook or X link.",
                        "unsupported_url")
    out_tmpl = str(workdir / "source.%(ext)s")
    cmd = ["yt-dlp", "--no-playlist", "--restrict-filenames", "--no-warnings", "--newline",
           "--progress", "--progress-template", f"download:{PROGRESS_PREFIX} %(progress._percent_str)s",
           "--print-to-file", "%(title)s", str(workdir / "title.txt"),
           "--max-filesize", "1500M", "-o", out_tmpl]
    if audio_only:
        cmd += ["-f", "bestaudio/best"]
    else:
        cmd += ["-f", QUALITY_FORMATS.get(str(quality), QUALITY_FORMATS["720"]),
                "--merge-output-format", "mp4"]
    if cookies_file:
        cmd += ["--cookies", str(cookies_file)]
    cmd.append(url)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if line.startswith(PROGRESS_PREFIX):
            m = re.search(r"([\d.]+)%", line)
            if m and on_progress:
                try:
                    on_progress(float(m.group(1)))
                except Exception as e:  # progress is cosmetic; never fail the job over it
                    print(f"progress callback failed: {e}", file=sys.stderr)
            continue
        tail = (tail + [line])[-40:]
    rc = proc.wait()
    output = "\n".join(tail)
    if rc != 0:
        if "File is larger than max-filesize" in output:
            raise UserError("📦 That video is too large to process (over 1.5 GB).", "too_large")
        found = classify_download_error(output)
        print("yt-dlp failed:\n" + "\n".join(tail[-15:]), file=sys.stderr)
        if found:
            raise UserError(found[1], found[0])
        raise RuntimeError(f"yt-dlp failed (exit {rc})")
    files = [p for p in workdir.glob("source.*") if p.suffix not in (".part", ".ytdl")]
    if not files:
        raise UserError("🎞 Nothing was downloaded from that link.", "no_video")
    return max(files, key=lambda p: p.stat().st_size)


def read_title(workdir: Path) -> str:
    try:
        lines = (workdir / "title.txt").read_text(encoding="utf-8").strip().splitlines()
        return lines[0].strip()[:200] if lines else ""
    except OSError:
        return ""


# ----------------------------------------------------------------------------- actions

def _encode_video(src: Path, dst: Path, vf: str | None = None, *, max_height: int | None = None,
                  video_kbps: int | None = None, audio_kbps: int = 128, crf: int = 23) -> Path:
    filters = []
    if vf:
        filters.append(vf)
    if max_height:
        filters.append(f"scale=-2:'min({max_height},ih)'")
    filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")  # H.264 needs even dimensions
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
           "-vf", ",".join(filters), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
    if video_kbps:
        cmd += ["-b:v", f"{video_kbps}k", "-maxrate", f"{int(video_kbps * 1.2)}k",
                "-bufsize", f"{video_kbps * 2}k"]
    else:
        cmd += ["-crf", str(crf)]
    if has_audio(src):
        cmd += ["-c:a", "aac", "-b:a", f"{audio_kbps}k"]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", str(dst)]
    run(cmd)
    return dst


def to_mp3(src: Path, workdir: Path, bitrate_kbps: int = 192) -> Path:
    """Extract audio as MP3, lowering the bitrate if needed to fit Telegram's limit."""
    if not has_audio(src):
        raise UserError("🔇 This media has no audio track, so there's nothing to convert to MP3.", "no_audio")
    duration = probe_duration(src)
    if duration > 0:
        max_kbps = int(TARGET_BYTES * 8 / duration / 1000)
        bitrate_kbps = max(32, min(bitrate_kbps, max_kbps))
    dst = workdir / "audio.mp3"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-vn",
         "-c:a", "libmp3lame", "-b:a", f"{bitrate_kbps}k", str(dst)])
    return dst


def watermark(src: Path, workdir: Path, text: str, position: str = "bottom-right") -> Path:
    """Burn a semi-transparent text watermark into the video."""
    text = (text or "").strip()[:60] or "watermark"
    text_file = workdir / "watermark.txt"
    text_file.write_text(text, encoding="utf-8")  # textfile= avoids all drawtext escaping issues
    pos = {
        "bottom-right": ("w-tw-20", "h-th-20"),
        "bottom-left": ("20", "h-th-20"),
        "top-right": ("w-tw-20", "20"),
        "top-left": ("20", "20"),
        "center": ("(w-tw)/2", "(h-th)/2"),
    }.get(position, ("w-tw-20", "h-th-20"))
    font = find_font()
    font_opt = f"fontfile='{font}':" if font else ""
    vf = (f"drawtext={font_opt}textfile='{text_file}':fontsize='max(18,h/18)':"
          f"fontcolor=white@0.75:borderw=2:bordercolor=black@0.5:x={pos[0]}:y={pos[1]}")
    return _encode_video(src, workdir / "watermarked.mp4", vf)


def crop(src: Path, workdir: Path, preset: str = "9:16") -> Path:
    """Centre-crop to 9:16, 1:1 or 16:9."""
    if preset not in CROP_PRESETS:
        raise UserError(f"Unknown crop preset {preset!r}.")
    w, h = CROP_PRESETS[preset]
    vf = f"crop=w='{w}':h='{h}'"
    return _encode_video(src, workdir / f"crop_{preset.replace(':', 'x')}.mp4", vf)


def frames(src: Path, workdir: Path, max_seconds: int = MAX_FRAMES_SECONDS, fps: float = 1.0) -> Path:
    """Extract 1 frame per second (first max_seconds) as JPEGs and zip them."""
    fdir = workdir / "frames"
    fdir.mkdir(exist_ok=True)
    for scale, q in ((1920, 3), (1280, 5), (854, 8)):
        for old in fdir.glob("*.jpg"):
            old.unlink()
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
             "-t", str(max_seconds), "-vf", f"fps={fps},scale='min({scale},iw)':-2",
             "-q:v", str(q), str(fdir / "frame_%04d.jpg")])
        imgs = sorted(fdir.glob("*.jpg"))
        if not imgs:
            raise UserError("🖼 Could not extract any frames from this media.", "no_frames")
        zpath = workdir / "frames.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED) as zf:  # JPEGs don't compress further
            for i, img in enumerate(imgs):
                zf.write(img, f"second_{i:04d}.jpg")
        if zpath.stat().st_size <= TARGET_BYTES:
            return zpath
    raise UserError("📦 The frames archive is larger than Telegram's 50 MB limit.", "too_large")


def fit_video(path: Path, workdir: Path) -> Path:
    """Re-encode a video so it fits under Telegram's 50 MB bot upload limit."""
    if path.stat().st_size <= TARGET_BYTES:
        return path
    duration = probe_duration(path)
    if duration <= 0:
        raise UserError("📦 The result is over 50 MB and its length is unknown, so it can't be shrunk.", "too_large")
    audio_kbps = 96 if has_audio(path) else 0
    for i, max_h in enumerate((720, 480, 360)):
        total_kbps = TARGET_BYTES * 8 * 0.93 / duration / 1000
        video_kbps = int(total_kbps - audio_kbps)
        if video_kbps < 80:
            break
        out = _encode_video(path, workdir / f"fit_{i}.mp4", max_height=max_h,
                            video_kbps=video_kbps, audio_kbps=audio_kbps or 96)
        if out.stat().st_size <= TARGET_BYTES:
            return out
    raise UserError(f"The video is too long to fit Telegram's 50 MB bot limit "
                    f"({duration / 60:.0f} min). Try 🎵 MP3 Audio or a shorter clip.", "too_large")


def process(src: Path, workdir: Path, action: str, options: dict) -> tuple[Path, str]:
    """Run one action on src. Returns (result_path, kind) where kind is video/audio/document."""
    if action == "mp3":
        return to_mp3(src, workdir), "audio"
    if action == "frames":
        secs = int(options.get("max_seconds") or MAX_FRAMES_SECONDS)
        return frames(src, workdir, max_seconds=max(1, min(secs, MAX_FRAMES_SECONDS))), "document"
    if action == "watermark":
        out = watermark(src, workdir, str(options.get("text") or "watermark"),
                        str(options.get("position") or "bottom-right"))
    elif action == "crop":
        out = crop(src, workdir, str(options.get("preset") or "9:16"))
    elif action == "video":
        out = src
        if src.suffix.lower() != ".mp4":
            out = _encode_video(src, workdir / "video.mp4")
    else:
        raise UserError(f"Unknown action {action!r}.")
    return fit_video(out, workdir), "video"


# ----------------------------------------------------------------------------- telegram

def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def progress_bar(pct: float, width: int = 10) -> str:
    p = max(0, min(100, round(pct)))
    filled = round(p / 100 * width)
    return "▰" * filled + "▱" * (width - filled) + f" {p}%"


def status_text(stage: str, pct: float, platform_line: str, note: str = "") -> str:
    text = f"{stage}\n{progress_bar(pct)}\n\n{platform_line}"
    return text + (f"\n\n<i>{note}</i>" if note else "")


def build_caption(title: str, platform_line: str, bot_username: str) -> str:
    parts = []
    if title:
        parts.append(f"<b>{esc(title[:200])}</b>")
    parts.append(platform_line)
    parts.append(f"⚡ via @{esc(bot_username)}" if bot_username else "⚡ via MediaFlow")
    return "\n".join(parts)


class Telegram:
    def __init__(self, token: str, chat_id: int | str):
        import requests  # only needed when actually talking to Telegram
        self._requests = requests
        self._token = token
        self.chat_id = chat_id

    def _call(self, method: str, data: dict | None = None, files: dict | None = None) -> dict:
        url = f"{os.environ.get('TELEGRAM_API_BASE', 'https://api.telegram.org')}/bot{self._token}/{method}"
        try:
            r = self._requests.post(url, data=data, files=files, timeout=300)
            body = r.json()
        except Exception as e:  # never let the token leak through an exception message
            raise RuntimeError(f"Telegram {method} failed: {str(e).replace(self._token, '***')}") from None
        if not body.get("ok"):
            raise RuntimeError(f"Telegram {method} error: {body.get('description', 'unknown')}")
        return body["result"]

    def try_call(self, method: str, data: dict) -> dict | None:
        try:
            return self._call(method, data)
        except RuntimeError as e:
            print(e, file=sys.stderr)
            return None

    def username(self) -> str:
        me = self.try_call("getMe", {})
        return (me or {}).get("username", "")

    def message(self, text: str, keyboard: list | None = None) -> int | None:
        data = {"chat_id": self.chat_id, "text": text, "parse_mode": "HTML",
                "link_preview_options": json.dumps({"is_disabled": True})}
        if keyboard:
            data["reply_markup"] = json.dumps({"inline_keyboard": keyboard})
        res = self.try_call("sendMessage", data)
        return res["message_id"] if res else None

    def edit(self, message_id: int | None, text: str, keyboard: list | None = None) -> int | None:
        """Edit the status message (falls back to a new message). Returns the message id used."""
        if message_id is None:
            return self.message(text, keyboard)
        data = {"chat_id": self.chat_id, "message_id": message_id, "text": text, "parse_mode": "HTML",
                "link_preview_options": json.dumps({"is_disabled": True}),
                "reply_markup": json.dumps({"inline_keyboard": keyboard or []})}
        try:
            self._call("editMessageText", data)
            return message_id
        except RuntimeError as e:
            if "message is not modified" in str(e):
                return message_id
            return self.message(text, keyboard)

    def delete(self, message_id: int | None) -> bool:
        if message_id is None:
            return False
        return self.try_call("deleteMessage", {"chat_id": self.chat_id, "message_id": message_id}) is not None

    def action(self, kind: str) -> None:
        chat_action = {"video": "upload_video", "audio": "upload_voice"}.get(kind, "upload_document")
        self.try_call("sendChatAction", {"chat_id": self.chat_id, "action": chat_action})

    def send_file(self, path: Path, kind: str, caption: str = "", title: str = "") -> None:
        if path.stat().st_size > TELEGRAM_LIMIT_BYTES:
            raise UserError(f"📦 The result is {human(path.stat().st_size)}, over Telegram's 50 MB bot limit.",
                            "too_large")
        method, field = {"video": ("sendVideo", "video"), "audio": ("sendAudio", "audio")}.get(
            kind, ("sendDocument", "document"))
        data = {"chat_id": self.chat_id, "caption": caption[:1024], "parse_mode": "HTML"}
        if kind == "video":
            data["supports_streaming"] = "true"
        if kind == "audio" and title:
            data["title"] = title[:64]
        name = path.name
        if title:
            safe = re.sub(r"[^\w\- ]+", "", title).strip().replace(" ", "_")[:60]
            if safe:
                name = f"{safe}{path.suffix}"
        try:
            with path.open("rb") as fh:
                self._call(method, data, {field: (name, fh)})
        except RuntimeError:
            if method == "sendDocument":
                raise
            with path.open("rb") as fh:  # fall back to plain file upload
                self._call("sendDocument", {"chat_id": self.chat_id, "caption": caption[:1024],
                                            "parse_mode": "HTML"}, {"document": (name, fh)})


class Progress:
    """Edits one status message through the job's stages, throttled to avoid Telegram limits."""

    def __init__(self, tg: Telegram, message_id: int | None, platform_line: str,
                 min_interval: float = 3.0, clock=None):
        import time
        self._clock = clock or time.monotonic
        self.tg = tg
        self.message_id = message_id
        self.platform_line = platform_line
        self.min_interval = min_interval
        self._last_time = -1e9
        self._last_bar = ""

    def update(self, stage: str, pct: float, note: str = "", force: bool = False) -> None:
        bar = progress_bar(pct)
        now = self._clock()
        if not force and (bar == self._last_bar or now - self._last_time < self.min_interval):
            return
        self._last_bar, self._last_time = bar, now
        self.message_id = self.tg.edit(self.message_id, status_text(stage, pct, self.platform_line, note))

    def download_hook(self, pct: float) -> None:
        # Downloading spans 10% → 60% of the overall bar.
        self.update("⏳ <b>Downloading…</b>", 10 + pct * 0.5)


# ----------------------------------------------------------------------------- entrypoints

def load_job_from_github_event() -> dict:
    """Read the repository_dispatch payload from the event file (never from env/logs)."""
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path:
        raise SystemExit("GITHUB_EVENT_PATH not set; use --input for local runs.")
    event = json.loads(Path(event_path).read_text())
    payload = event.get("client_payload") or event.get("inputs") or {}
    if isinstance(payload.get("options"), str):
        payload["options"] = json.loads(payload["options"] or "{}")
    ctx = payload.get("ctx") or {}
    # Hide the user's link, chat id and release token from public Actions logs.
    for secret in (payload.get("url"), payload.get("chat_id"), ctx.get("release_token"),
                   ctx.get("user_id")):
        if secret:
            print(f"::add-mask::{secret}", flush=True)
    return payload


def notify_worker(ctx: dict, status: str, **fields) -> None:
    """Report job status to the Worker (usage DB). A final status also frees the user's job slot."""
    url, token = ctx.get("release_url"), ctx.get("release_token")
    if not url or not token or not str(url).startswith("https://"):
        return
    body = {"user_id": ctx.get("user_id"), "token": token, "run_id": ctx.get("run_id"), "status": status,
            **{k: v for k, v in fields.items() if v is not None}}
    try:
        import requests
        r = requests.post(url, json=body, timeout=15)
        print(f"report {status}: HTTP {r.status_code}")
    except Exception as e:
        print(f"report {status} failed: {type(e).__name__}", file=sys.stderr)


def run_github_job() -> int:
    job = load_job_from_github_event()
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = str(job.get("chat_id", ""))
    url = str(job.get("url", ""))
    action = str(job.get("action", ""))
    options = job.get("options") or {}
    ctx = job.get("ctx") or {}
    if not token or not re.fullmatch(r"-?\d+", chat_id) or action not in ACTIONS:
        print("Invalid job payload or missing TELEGRAM_BOT_TOKEN", file=sys.stderr)
        notify_worker(ctx, "failed", error_code="invalid_payload")
        return 1
    tg = Telegram(token, chat_id)
    platform_line = f"{ctx.get('platform_emoji', '🎬')} {esc(str(ctx.get('platform', 'Media')))}  ·  " \
                    f"{esc(str(ctx.get('label', action)))}"
    status_id = ctx.get("status_message_id")
    status_id = int(status_id) if str(status_id or "").isdigit() else None
    job_id = str(ctx.get("job_id") or "")
    retry_kb = [[{"text": "🔁 Try again", "callback_data": f"r:{job_id}"}]] if re.fullmatch(
        r"[a-z0-9]{6,16}", job_id) else None
    import time
    started = time.monotonic()
    notify_worker(ctx, "running")
    report: dict = {"status": "failed", "error_code": "unexpected"}
    prog = Progress(tg, status_id, platform_line)
    prog.update("🔧 <b>Preparing…</b>", 5, "Server is ready, fetching your media.", force=True)

    workdir = Path(tempfile.mkdtemp(prefix="job_", dir=os.environ.get("RUNNER_TEMP")))
    try:
        cookies = None
        if os.environ.get("YT_DLP_COOKIES", "").strip():
            cookies = workdir / "cookies.txt"
            cookies.write_text(os.environ["YT_DLP_COOKIES"])
            cookies.chmod(0o600)
        prog.update("⏳ <b>Downloading…</b>", 10, force=True)
        src = download(url, workdir, audio_only=(action == "mp3"), quality=str(options.get("quality") or "720"),
                       cookies_file=cookies, on_progress=prog.download_hook)
        if cookies:
            cookies.unlink(missing_ok=True)
        print(f"downloaded {human(src.stat().st_size)}")
        title = read_title(workdir)
        report["title"] = title or None
        report["duration_sec"] = round(probe_duration(src), 2) or None
        prog.update("⚙️ <b>Processing…</b>", 70, "Applying your edit with ffmpeg.", force=True)
        result, kind = process(src, workdir, action, options)
        print(f"processed -> {kind} {human(result.stat().st_size)}")
        prog.update("📤 <b>Uploading…</b>", 90, f"Sending {human(result.stat().st_size)} to Telegram.", force=True)
        tg.action(kind)
        caption = build_caption(title, platform_line, str(ctx.get("bot_username") or tg.username()))
        tg.send_file(result, kind, caption=caption, title=title)
        report.update(status="done", error_code=None, file_size=result.stat().st_size)
        if not tg.delete(prog.message_id):
            prog.update("✅ <b>Done!</b>", 100, "Nothing was stored; all files were deleted.", force=True)
        print("sent")
        return 0
    except UserError as e:
        print(f"user error: {e}", file=sys.stderr)
        report.update(error_code=e.code, error_message=str(e)[:300])
        tg.edit(prog.message_id, f"😕 <b>Couldn't finish this one</b>\n\n{esc(str(e))}\n\n{platform_line}",
                retry_kb)
        return 0  # an expected failure, not a broken workflow
    except Exception as e:
        print(f"Unexpected error: {str(e).replace(token, '***')}", file=sys.stderr)
        report.update(error_code="unexpected", error_message=type(e).__name__)
        tg.edit(prog.message_id, "😕 <b>Something went wrong</b>\n\nThe processing step failed unexpectedly. "
                "Please try again, or try another link.\n\n" + platform_line, retry_kb)
        return 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        report["processing_ms"] = int((time.monotonic() - started) * 1000)
        notify_worker(ctx, report.pop("status"), **report)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--github", action="store_true", help="run as a GitHub Actions job (reads event payload)")
    ap.add_argument("--input", type=Path, help="local media file (skips download and Telegram)")
    ap.add_argument("--url", help="download this URL instead of --input (still no Telegram)")
    ap.add_argument("--action", choices=sorted(ACTIONS), default="video")
    ap.add_argument("--quality", choices=sorted(QUALITY_FORMATS), default="720")
    ap.add_argument("--text", default="watermark", help="watermark text")
    ap.add_argument("--position", default="bottom-right")
    ap.add_argument("--crop", default="9:16", choices=sorted(CROP_PRESETS))
    ap.add_argument("--max-seconds", type=int, default=MAX_FRAMES_SECONDS)
    ap.add_argument("--out-dir", type=Path, default=Path("out"))
    args = ap.parse_args(argv)

    if args.github:
        return run_github_job()
    if not args.input and not args.url:
        ap.error("use --input FILE or --url URL (or --github)")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        try:
            src = args.input or download(args.url, workdir, audio_only=args.action == "mp3",
                                         quality=args.quality,
                                         on_progress=lambda p: print(f"\rdownloading {p:.0f}%", end=""))
            opts = {"text": args.text, "position": args.position, "preset": args.crop,
                    "max_seconds": args.max_seconds}
            result, kind = process(Path(src), workdir, args.action, opts)
        except UserError as e:
            print(f"UserError: {e}", file=sys.stderr)
            return 2
        dst = args.out_dir / result.name
        shutil.copy2(result, dst)
        print(f"\n{kind}: {dst} ({human(dst.stat().st_size)}) title={read_title(workdir)!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
