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
    """An error whose message is safe and useful to show to the Telegram user."""


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

def download(url: str, workdir: Path, *, audio_only: bool = False,
             cookies_file: Path | None = None) -> Path:
    """Download one media item with yt-dlp into workdir and return the file path."""
    if not is_supported_url(url):
        raise UserError("Unsupported link. Send a YouTube, TikTok, Instagram, Facebook or X link.")
    out_tmpl = str(workdir / "source.%(ext)s")
    cmd = ["yt-dlp", "--no-playlist", "--no-progress", "--restrict-filenames",
           "--no-warnings", "--max-filesize", "1500M", "-o", out_tmpl]
    if audio_only:
        cmd += ["-f", "bestaudio/best"]
    else:
        # Prefer something that already fits Telegram, then fall back to <=720p, then anything.
        cmd += ["-f", "bv*[height<=720][filesize<45M]+ba/b[height<=720][filesize<48M]/"
                      "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
                "--merge-output-format", "mp4"]
    if cookies_file:
        cmd += ["--cookies", str(cookies_file)]
    cmd.append(url)
    try:
        run(cmd)
    except RuntimeError as e:
        msg = str(e)
        if re.search(r"(login|sign in|cookies|private|confirm you.re not a bot|rate.limit)", msg, re.I):
            raise UserError("The site refused the download (login, private post, or bot check). "
                            "The bot owner can add a YT_DLP_COOKIES secret to fix this.") from e
        if "File is larger than max-filesize" in msg:
            raise UserError("That video is too large to process.") from e
        raise
    files = [p for p in workdir.glob("source.*") if p.suffix not in (".part", ".ytdl")]
    if not files:
        raise UserError("Nothing was downloaded from that link.")
    return max(files, key=lambda p: p.stat().st_size)


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
        raise UserError("This media has no audio track.")
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
            raise UserError("Could not extract any frames from this media.")
        zpath = workdir / "frames.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED) as zf:  # JPEGs don't compress further
            for i, img in enumerate(imgs):
                zf.write(img, f"second_{i:04d}.jpg")
        if zpath.stat().st_size <= TARGET_BYTES:
            return zpath
    raise UserError("The frames archive is larger than Telegram's 50 MB limit.")


def fit_video(path: Path, workdir: Path) -> Path:
    """Re-encode a video so it fits under Telegram's 50 MB bot upload limit."""
    if path.stat().st_size <= TARGET_BYTES:
        return path
    duration = probe_duration(path)
    if duration <= 0:
        raise UserError("Result is over 50 MB and its length is unknown, so it can't be shrunk.")
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
                    f"({duration / 60:.0f} min). Try 'Convert to MP3' or a shorter clip.")


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

    def message(self, text: str) -> int | None:
        try:
            return self._call("sendMessage", {"chat_id": self.chat_id, "text": text})["message_id"]
        except RuntimeError as e:
            print(e, file=sys.stderr)
            return None

    def edit(self, message_id: int | None, text: str) -> None:
        if message_id is None:
            self.message(text)
            return
        try:
            self._call("editMessageText", {"chat_id": self.chat_id, "message_id": message_id, "text": text})
        except RuntimeError:
            self.message(text)

    def send_file(self, path: Path, kind: str, caption: str = "") -> None:
        if path.stat().st_size > TELEGRAM_LIMIT_BYTES:
            raise UserError(f"Result is {human(path.stat().st_size)}, over Telegram's 50 MB bot limit.")
        method, field = {"video": ("sendVideo", "video"), "audio": ("sendAudio", "audio")}.get(
            kind, ("sendDocument", "document"))
        data = {"chat_id": self.chat_id, "caption": caption[:1000]}
        if kind == "video":
            data["supports_streaming"] = "true"
        try:
            with path.open("rb") as fh:
                self._call(method, data, {field: (path.name, fh)})
        except RuntimeError:
            if method == "sendDocument":
                raise
            with path.open("rb") as fh:  # fall back to plain file upload
                self._call("sendDocument", {"chat_id": self.chat_id, "caption": caption[:1000]},
                           {"document": (path.name, fh)})


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
    # Hide the user's link and chat id from public Actions logs.
    for secret in (payload.get("url"), payload.get("chat_id")):
        if secret:
            print(f"::add-mask::{secret}", flush=True)
    return payload


def run_github_job() -> int:
    job = load_job_from_github_event()
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = str(job.get("chat_id", ""))
    url = str(job.get("url", ""))
    action = str(job.get("action", ""))
    options = job.get("options") or {}
    if not token or not re.fullmatch(r"-?\d+", chat_id) or action not in ACTIONS:
        print("Invalid job payload or missing TELEGRAM_BOT_TOKEN", file=sys.stderr)
        return 1
    tg = Telegram(token, chat_id)
    status = tg.message(f"⏳ Processing ({action})… this usually takes 1–3 minutes.")
    workdir = Path(tempfile.mkdtemp(prefix="job_", dir=os.environ.get("RUNNER_TEMP")))
    try:
        cookies = None
        if os.environ.get("YT_DLP_COOKIES", "").strip():
            cookies = workdir / "cookies.txt"
            cookies.write_text(os.environ["YT_DLP_COOKIES"])
            cookies.chmod(0o600)
        src = download(url, workdir, audio_only=(action == "mp3"), cookies_file=cookies)
        if cookies:
            cookies.unlink(missing_ok=True)
        result, kind = process(src, workdir, action, options)
        tg.edit(status, f"📤 Uploading {human(result.stat().st_size)}…")
        tg.send_file(result, kind, caption=f"✅ {action}")
        tg.edit(status, "✅ Done. Nothing was stored; all files were deleted.")
        return 0
    except UserError as e:
        tg.edit(status, f"❌ {e}")
        return 0  # an expected failure, not a broken workflow
    except Exception as e:
        print(f"Unexpected error: {str(e).replace(token, '***')}", file=sys.stderr)
        tg.edit(status, "❌ Something went wrong while processing. Try again or try another link.")
        return 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--github", action="store_true", help="run as a GitHub Actions job (reads event payload)")
    ap.add_argument("--input", type=Path, help="local media file (skips download and Telegram)")
    ap.add_argument("--url", help="download this URL instead of --input (still no Telegram)")
    ap.add_argument("--action", choices=sorted(ACTIONS), default="video")
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
        src = args.input or download(args.url, workdir, audio_only=args.action == "mp3")
        opts = {"text": args.text, "position": args.position, "preset": args.crop,
                "max_seconds": args.max_seconds}
        try:
            result, kind = process(Path(src), workdir, args.action, opts)
        except UserError as e:
            print(f"UserError: {e}", file=sys.stderr)
            return 2
        dst = args.out_dir / result.name
        shutil.copy2(result, dst)
        print(f"{kind}: {dst} ({human(dst.stat().st_size)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
