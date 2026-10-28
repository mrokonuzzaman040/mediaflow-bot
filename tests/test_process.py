"""Local tests for scripts/process.py using ffmpeg-generated sample media.

Run:  python -m unittest discover -s tests -v
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import process as P  # noqa: E402


def make_sample(path: Path, seconds: int = 8, size: str = "1280x720", audio: bool = True) -> Path:
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate=30"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac"] if audio else []
    cmd += ["-shortest", str(path)]
    subprocess.run(cmd, check=True)
    return path


def dims(path: Path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    return s["width"], s["height"]


class ProcessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.sample = make_sample(cls.tmp / "sample.mp4")
        cls.silent = make_sample(cls.tmp / "silent.mp4", seconds=3, audio=False)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def workdir(self):
        d = tempfile.mkdtemp(dir=self.tmp)
        return Path(d)

    def test_mp3(self):
        out, kind = P.process(self.sample, self.workdir(), "mp3", {})
        self.assertEqual(kind, "audio")
        self.assertEqual(out.suffix, ".mp3")
        self.assertAlmostEqual(P.probe_duration(out), 8, delta=0.5)

    def test_mp3_without_audio_is_user_error(self):
        with self.assertRaises(P.UserError):
            P.process(self.silent, self.workdir(), "mp3", {})

    def test_watermark(self):
        out, kind = P.process(self.sample, self.workdir(), "watermark",
                              {"text": "Rokon's Bot: 100% \"quoted\" \\ test", "position": "bottom-right"})
        self.assertEqual(kind, "video")
        self.assertEqual(dims(out), (1280, 720))
        self.assertTrue(P.has_audio(out))

    def test_crop_presets(self):
        expected = {"9:16": (404, 720), "1:1": (720, 720), "16:9": (1280, 720)}
        for preset, wh in expected.items():
            with self.subTest(preset=preset):
                out, _ = P.process(self.sample, self.workdir(), "crop", {"preset": preset})
                self.assertEqual(dims(out), wh)

    def test_crop_portrait_source_to_16_9(self):
        portrait = make_sample(self.tmp / "portrait.mp4", seconds=2, size="720x1280")
        out, _ = P.process(portrait, self.workdir(), "crop", {"preset": "16:9"})
        self.assertEqual(dims(out), (720, 404))

    def test_frames_one_per_second(self):
        out, kind = P.process(self.sample, self.workdir(), "frames", {})
        self.assertEqual(kind, "document")
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
        self.assertEqual(len(names), 8)
        self.assertTrue(all(n.endswith(".jpg") for n in names))

    def test_frames_cap(self):
        out, _ = P.process(self.sample, self.workdir(), "frames", {"max_seconds": 3})
        with zipfile.ZipFile(out) as zf:
            self.assertEqual(len(zf.namelist()), 3)

    def test_fit_video_shrinks_large_file(self):
        old = P.TARGET_BYTES
        P.TARGET_BYTES = 300 * 1024  # pretend the limit is 300 KB
        try:
            big = make_sample(self.tmp / "big.mp4", seconds=10, size="1920x1080")
            self.assertGreater(big.stat().st_size, P.TARGET_BYTES)
            out = P.fit_video(big, self.workdir())
            self.assertLessEqual(out.stat().st_size, P.TARGET_BYTES)
        finally:
            P.TARGET_BYTES = old

    def test_url_allowlist(self):
        ok = ["https://www.youtube.com/watch?v=x", "https://youtu.be/x", "https://vm.tiktok.com/x",
              "https://www.instagram.com/reel/x", "https://fb.watch/x", "https://x.com/a/status/1",
              "https://mobile.twitter.com/a/status/1", "https://m.facebook.com/watch?v=1"]
        bad = ["https://evil.com/youtube.com", "file:///etc/passwd", "https://notyoutube.com/x",
               "https://youtube.com.evil.io/x"]
        for u in ok:
            self.assertTrue(P.is_supported_url(u), u)
        for u in bad:
            self.assertFalse(P.is_supported_url(u), u)


class FakeTelegram:
    """Records calls instead of talking to Telegram."""
    instances = []

    def __init__(self, token, chat_id):
        self.calls = []
        FakeTelegram.instances.append(self)

    def edit(self, message_id, text, keyboard=None):
        self.calls.append(("edit", message_id, text, keyboard))
        return message_id

    def message(self, text, keyboard=None):
        self.calls.append(("message", text, keyboard))
        return 555

    def delete(self, message_id):
        self.calls.append(("delete", message_id))
        return True

    def action(self, kind):
        self.calls.append(("action", kind))

    def username(self):
        return "mediaflobot"

    def send_file(self, path, kind, caption="", title=""):
        self.calls.append(("send_file", path.suffix, kind, caption, title))


class UxTests(unittest.TestCase):
    def test_progress_bar(self):
        self.assertEqual(P.progress_bar(40), "▰▰▰▰▱▱▱▱▱▱ 40%")
        self.assertEqual(P.progress_bar(-5), "▱▱▱▱▱▱▱▱▱▱ 0%")

    def test_caption_escapes_html(self):
        cap = P.build_caption("A <b> & C", "▶️ YouTube  ·  🎵 MP3 Audio", "mediaflobot")
        self.assertIn("<b>A &lt;b&gt; &amp; C</b>", cap)
        self.assertTrue(cap.endswith("⚡ via @mediaflobot"))

    def test_friendly_errors(self):
        cases = {
            "ERROR: [youtube] x: Sign in to confirm you're not a bot": "bot check",
            "ERROR: [instagram] x: This account is private": "private",
            "ERROR: [youtube] x: Video unavailable": "unavailable",
            "ERROR: HTTP Error 429: Too Many Requests": "rate-limiting",
            "ERROR: [youtube] x: The uploader has not made this video available in your country": "region",
        }
        for out, needle in cases.items():
            with self.subTest(out=out):
                self.assertIn(needle, P.friendly_download_error(out) or "")
        self.assertIsNone(P.friendly_download_error("ERROR: something odd"))

    def test_progress_throttles_edits(self):
        t = [0.0]
        tg = FakeTelegram("t", 1)
        prog = P.Progress(tg, 8, "line", min_interval=3.0, clock=lambda: t[0])
        prog.download_hook(10)       # first edit goes through
        prog.download_hook(50)       # too soon
        t[0] = 5
        prog.download_hook(50)       # ok
        prog.download_hook(50)       # same bar
        prog.update("⚙️ <b>Processing…</b>", 70, force=True)
        edits = [c for c in tg.calls if c[0] == "edit"]
        self.assertEqual(len(edits), 3)
        self.assertIn("Downloading", edits[0][2])
        self.assertIn("▰▰▰", edits[1][2])


class GithubJobTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.sample = make_sample(self.tmp / "s.mp4", seconds=3)
        self.released = []
        self._orig = (P.Telegram, P.download, P.release_slot)
        FakeTelegram.instances.clear()
        P.Telegram = FakeTelegram
        P.release_slot = lambda ctx: self.released.append(ctx.get("release_token"))

    def tearDown(self):
        P.Telegram, P.download, P.release_slot = self._orig
        self._tmp.cleanup()

    def run_job(self, action="mp3", options=None):
        event = {"client_payload": {"chat_id": 99, "url": "https://youtu.be/x", "action": action,
                                    "options": options or {},
                                    "ctx": {"job_id": "abcdef123456", "status_message_id": 8, "user_id": 42,
                                            "platform": "YouTube", "platform_emoji": "▶️",
                                            "label": "🎵 MP3 Audio", "bot_username": "mediaflobot",
                                            "release_url": "https://w.dev/release", "release_token": "tok"}}}
        ev = self.tmp / "event.json"
        ev.write_text(json.dumps(event))
        env = {"GITHUB_EVENT_PATH": str(ev), "TELEGRAM_BOT_TOKEN": "123:abc", "RUNNER_TEMP": str(self.tmp)}
        old = {k: P.os.environ.get(k) for k in env}
        P.os.environ.update(env)
        try:
            return P.run_github_job(), FakeTelegram.instances[-1].calls
        finally:
            for k, v in old.items():
                if v is None:
                    P.os.environ.pop(k, None)
                else:
                    P.os.environ[k] = v

    def test_success_flow_edits_status_sends_file_and_deletes_status(self):
        def fake_download(url, workdir, **kw):
            (workdir / "title.txt").write_text("My <Clip>\n")
            kw["on_progress"](100.0)
            dst = workdir / "source.mp4"
            shutil.copy(self.sample, dst)
            return dst
        P.download = fake_download
        rc, calls = self.run_job()
        self.assertEqual(rc, 0)
        stages = [c[2] for c in calls if c[0] == "edit"]
        for word in ("Preparing", "Downloading", "Processing", "Uploading"):
            self.assertTrue(any(word in s for s in stages), word)
        self.assertTrue(all(c[1] == 8 for c in calls if c[0] == "edit"), "always the same status message")
        self.assertIn(("action", "audio"), calls)
        sent = [c for c in calls if c[0] == "send_file"][0]
        self.assertEqual(sent[1:3], (".mp3", "audio"))
        self.assertIn("<b>My &lt;Clip&gt;</b>", sent[3])
        self.assertIn("⚡ via @mediaflobot", sent[3])
        self.assertEqual(calls[-1], ("delete", 8))
        self.assertEqual(self.released, ["tok"])

    def test_user_error_shows_try_again(self):
        def fake_download(url, workdir, **kw):
            raise P.UserError("🔐 This post is private or needs a login, so it can't be downloaded.")
        P.download = fake_download
        rc, calls = self.run_job()
        self.assertEqual(rc, 0)
        last = [c for c in calls if c[0] == "edit"][-1]
        self.assertIn("private", last[2])
        self.assertEqual(last[3], [[{"text": "🔁 Try again", "callback_data": "r:abcdef123456"}]])
        self.assertEqual(self.released, ["tok"])


if __name__ == "__main__":
    unittest.main()
