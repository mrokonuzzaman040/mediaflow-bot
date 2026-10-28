"""Local tests for scripts/process.py using ffmpeg-generated sample media.

Run:  python -m unittest discover -s tests -v
"""
import json
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


if __name__ == "__main__":
    unittest.main()
