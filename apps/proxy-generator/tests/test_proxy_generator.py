import dataclasses
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import proxy_generator as app


def media(height=2160, fps="30000/1001", timecode="01:00:00:00", duration=1, audio=1):
    return {"video": {"height": height, "width": height * 16 // 9, "codec_name": "h264", "profile": "High", "pix_fmt": "yuv420p", "time_base": "1/30000", "start_time": "0"},
        "fps": app.fractions.Fraction(fps), "timecode": timecode, "duration": duration, "audio": audio}


def sony_xml(ltc):
    """A trailing MP4 free box holding the shape of Sony's NonRealTimeMeta timecode table."""
    xml = (f'<?xml version="1.0" encoding="UTF-8"?>\n<NonRealTimeMeta>\n\t<LtcChangeTable tcFps="30" halfStep="true">\n'
        f'\t\t<LtcChange frameCount="0" value="{ltc}" status="increment"/>\n\t</LtcChangeTable>\n</NonRealTimeMeta>\n').encode()
    return (len(xml) + 8).to_bytes(4, "big") + b"free" + xml


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        app.STOP.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / "jobs"
        self.state = pathlib.Path(self.tmp.name) / "state"
        self.state.mkdir()
        self.folder = self.root / "2026" / "Synthetic" / "Raw"
        self.folder.mkdir(parents=True)
        self.path = self.folder / "clip.mp4"
        self.path.write_bytes(b"synthetic")
        os.utime(self.path, (1000, 1000))
        self.config = app.Config(self.root, self.state, stable=1, retry_base=1, retry_max=2)
        self.generator = app.Generator(self.config)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.generator.store.close)

    def test_stability_requires_two_unchanged_observations(self):
        with mock.patch.object(self.generator, "render", return_value=("failed", None)) as render:
            self.generator.scan(now=2000)
            render.assert_not_called()
            self.path.write_bytes(b"changed")
            os.utime(self.path, (1001, 1001))
            self.generator.scan(now=2002)
            render.assert_not_called()
            self.generator.scan(now=2004)
            render.assert_called_once()

    def test_case_insensitive_same_stem_collision_and_exclusions(self):
        (self.folder / "CLIP.mov").write_bytes(b"other")
        for skip in ("Proxy", "Avata Raw", "exports", ".hidden"):
            folder = self.folder / skip
            folder.mkdir()
            (folder / "other.mp4").write_bytes(b"x")
        self.assertEqual(list(self.generator.candidates()), [])

    @unittest.skipIf(os.name == "nt", "symlink privilege and process groups require Linux")
    def test_symlink_output_and_directory_are_never_used(self):
        outside = pathlib.Path(self.tmp.name) / "outside"
        outside.mkdir()
        (self.folder / "Proxy").symlink_to(outside, target_is_directory=True)
        self.generator.scan(now=2000)
        with mock.patch.object(self.generator, "render") as render:
            self.generator.scan(now=2002)
            render.assert_not_called()
        self.assertEqual(list(outside.iterdir()), [])
        link = self.root / "2026" / "link"
        link.symlink_to(self.folder, target_is_directory=True)
        self.assertEqual(len(list(self.generator.candidates())), 1)

    def test_failure_isolation_and_bounded_retry_then_version_reset(self):
        self.generator.scan(now=2000)
        with mock.patch.object(self.generator, "render", return_value=("failed", None)) as render:
            for now in (2002, 2005, 2008, 2011, 2014):
                self.generator.scan(now=now)
            self.assertEqual(render.call_count, 3)
            self.generator.config = dataclasses.replace(self.config, version="8")
            self.generator.scan(now=2017)
            self.assertEqual(render.call_count, 4)
            self.generator.scan(now=2018)
            self.assertEqual(render.call_count, 5)
            self.generator.scan(now=2020)
            self.generator.scan(now=2024)
            self.assertEqual(render.call_count, 6)

    def test_non_drop_timecode_is_not_rewritten_and_audio_is_mapped(self):
        args = app.encode_args(self.path, self.path.with_suffix(".tmp.mov"), media(), self.config)
        self.assertEqual(args[args.index("-timecode") + 1], "01:00:00:00")
        self.assertIn("0:a?", args)
        self.assertEqual(args[args.index("-r") + 1], "30000/1001")

    def skipped(self):
        return json.loads((self.state / app.SKIPPED_REPORT).read_text())["files"]

    def test_skipped_report_names_failed_files_and_clears_when_fixed(self):
        self.generator.scan(now=2000)
        self.assertEqual(self.skipped(), [])
        with mock.patch.object(app, "probe", side_effect=app.JobError("process_failed")):
            for now in (2002, 2005, 2008):
                self.generator.scan(now=now)
        self.assertEqual(self.skipped(), [{"path": "2026/Synthetic/Raw/clip.mp4", "reason": "process_failed", "attempts": 3, "gave_up": True}])
        self.generator.store.success(app.key_for(self.root, self.path), self.config.render_version, "proxy")
        self.generator.write_skipped(2011)
        self.assertEqual(self.skipped(), [])

    def test_skipped_report_keeps_paths_out_of_logs_and_drops_deleted_sources(self):
        self.generator.scan(now=2000)
        with mock.patch.object(app, "probe", side_effect=app.JobError("variable_frame_rate_unsupported")), mock.patch("builtins.print") as printed:
            self.generator.scan(now=2002)
        self.assertNotIn("clip.mp4", str(printed.call_args_list))
        self.assertEqual(self.skipped()[0]["reason"], "variable_frame_rate_unsupported")
        self.assertFalse(self.skipped()[0]["gave_up"])
        self.path.unlink()
        self.generator.scan(now=2005)
        self.assertEqual(self.skipped(), [], "a deleted source is not reported")

    def test_skipped_report_ignores_a_stopped_job(self):
        self.generator.scan(now=2000)
        def stop(*_):
            app.STOP.set()
            raise app.JobError("stopped")
        with mock.patch.object(app, "probe", side_effect=stop):
            self.generator.scan(now=2002)
        app.STOP.clear()
        self.assertEqual(self.skipped(), [])

    def test_skipped_report_lists_same_name_collisions(self):
        (self.folder / "CLIP.mov").write_bytes(b"other")
        self.generator.scan(now=2000)
        self.assertEqual({row["reason"] for row in self.skipped()}, {"same_name_collision"})
        self.assertEqual(len(self.skipped()), 2)

    def test_skipped_report_includes_failures_from_before_the_report_without_retrying(self):
        self.generator.scan(now=2000)
        key = app.key_for(self.root, self.path)
        self.generator.store.db.execute("UPDATE jobs SET failures=3,version=?,retry_at=0 WHERE key=?", (self.config.render_version, key))
        self.generator.store.db.commit()
        with mock.patch.object(self.generator, "render") as render:
            self.generator.scan(now=2002)
            render.assert_not_called()
        self.assertEqual(self.skipped(), [{"path": "2026/Synthetic/Raw/clip.mp4", "reason": "earlier_failure_reason_unknown", "attempts": 3, "gave_up": True}])

    def test_existing_state_database_gains_report_columns(self):
        state = pathlib.Path(self.tmp.name) / "old-state"
        state.mkdir()
        db = app.sqlite3.connect(state / "jobs.sqlite")
        db.execute("CREATE TABLE jobs (key TEXT PRIMARY KEY, identity TEXT, observed REAL, version TEXT, output_identity TEXT, failures INTEGER DEFAULT 0, retry_at REAL DEFAULT 0, legacy_eligible INTEGER DEFAULT 1)")
        db.execute("INSERT INTO jobs(key,identity,observed,failures) VALUES('k','i',1,3)")
        db.commit()
        db.close()
        store = app.Store(state)
        self.addCleanup(store.close)
        self.assertEqual(store.failed(), [], "older failures have no path yet")
        self.assertEqual(store.db.execute("SELECT failures FROM jobs WHERE key='k'").fetchone()[0], 3)

    def test_encode_is_all_intra_h264_420(self):
        args = app.encode_args(self.path, self.path.with_suffix(".tmp.mov"), media(), self.config)
        self.assertEqual(args[args.index("-c:v") + 1], "libx264")
        self.assertEqual(args[args.index("-g") + 1], "1")
        self.assertIn("scale=-2:720,format=yuv420p", args)
        self.assertEqual(self.config.render_version, "7-h264-intra-h720")

    def test_sony_drop_frame_flag_is_read_from_trailing_metadata(self):
        # FX30 C2852: 01:53:56;18 at 59.94p is stored as frames 0x49 (0x40 drop flag, 9 x2 half-step).
        self.path.write_bytes(b"\0" * 4096 + sony_xml("49565301"))
        self.assertTrue(app.sony_drop_frame(self.path, "01:53:56:18"))
        self.assertFalse(app.sony_drop_frame(self.path, "01:53:57:18"), "metadata for another time is ignored")
        self.path.write_bytes(sony_xml("09565301"))
        self.assertFalse(app.sony_drop_frame(self.path, "01:53:56:18"), "non-drop Sony clips stay non-drop")
        self.path.write_bytes(b"no metadata")
        self.assertFalse(app.sony_drop_frame(self.path, "01:53:56:18"))

    def test_probe_marks_sony_drop_frame_only_at_drop_frame_rates(self):
        self.path.write_bytes(sony_xml("49565301"))
        for fps, expected in (("60000/1001", "01:53:56;18"), ("30000/1001", "01:53:56;18"), ("25/1", "01:53:56:18"), ("24000/1001", "01:53:56:18")):
            report = {"streams": [{"codec_type": "video", "width": 3840, "height": 2160, "r_frame_rate": fps, "avg_frame_rate": fps, "duration": "1"},
                {"codec_type": "data", "tags": {"timecode": "01:53:56:18"}}], "format": {"duration": "1"}}
            with self.subTest(fps=fps), mock.patch.object(app, "run_process", return_value=json.dumps(report).encode()):
                self.assertEqual(app.probe(self.path, self.config)["timecode"], expected)

    def test_explicit_timecode_notation_and_missing_timecode_are_kept(self):
        self.path.write_bytes(sony_xml("09565301"))
        for tags, expected in (({"timecode": "01:00:00;00"}, "01:00:00;00"), ({}, None)):
            report = {"streams": [{"codec_type": "video", "width": 1920, "height": 1080, "r_frame_rate": "30000/1001", "avg_frame_rate": "30000/1001", "duration": "1", "tags": tags}], "format": {"duration": "1"}}
            with self.subTest(tags=tags), mock.patch.object(app, "run_process", return_value=json.dumps(report).encode()):
                self.assertEqual(app.probe(self.path, self.config)["timecode"], expected)

    def test_changed_source_preserves_old_proxy_and_cleans_temporary(self):
        output = self.folder / "Proxy" / "clip.mov"
        output.parent.mkdir()
        output.write_bytes(b"old proxy")
        source_id = app.identity(self.path)
        key = app.key_for(self.root, self.path)
        self.generator.store_snapshot = {key: (source_id, 1000, "4", "old", 0, 0, 0)}
        def encode(args, timeout):
            pathlib.Path(args[-1]).write_bytes(b"new proxy")
            self.path.write_bytes(b"replaced source")
        with mock.patch.object(app, "probe", return_value=media(height=1080)), mock.patch.object(app, "validate_proxy", return_value=True), mock.patch.object(app, "run_process", side_effect=encode):
            self.assertEqual(self.generator.render(self.path, source_id), ("failed", None))
        self.assertEqual(output.read_bytes(), b"old proxy")
        self.assertEqual(list(output.parent.glob(".proxy-gen-*.mov")), [])

    def test_adopts_healthy_legacy_without_reencoding(self):
        output = self.folder / "Proxy" / "clip.mov"
        output.parent.mkdir()
        output.write_bytes(b"healthy legacy proxy")
        (output.parent / ".proxy-gen-v7").touch()
        self.generator.scan(now=2000)
        with mock.patch.object(app, "probe", side_effect=[media(), media(height=720)]), mock.patch.object(app, "run_process") as run:
            counts = self.generator.scan(now=2002)
            self.assertEqual(counts["adopted"], 1)
            run.assert_not_called()
        with mock.patch.object(app, "probe") as probe:
            self.assertEqual(self.generator.scan(now=2004)["current"], 1)
            probe.assert_not_called()
        self.assertEqual(output.read_bytes(), b"healthy legacy proxy")

    def test_rejects_bad_legacy_codec_duration_fps_and_timecode(self):
        source = media()
        self.assertFalse(app.validate_proxy(source, media(height=720, fps="30")))
        self.assertFalse(app.validate_proxy(source, media(height=720, duration=10)))
        self.assertFalse(app.validate_proxy(source, media(height=720, timecode="02:00:00:00")))
        wrong = media(height=720)
        wrong["video"]["codec_name"] = "prores"
        self.assertFalse(app.validate_proxy(source, wrong))
        wrong = media(height=720)
        wrong["video"]["start_time"] = "12"
        self.assertFalse(app.validate_proxy(source, wrong))
        wrong = media(height=720)
        wrong["video"]["width"] = 1920
        self.assertFalse(app.validate_proxy(source, wrong))
        wrong = media(height=720)
        wrong["video"]["pix_fmt"] = "yuv422p10le"
        self.assertFalse(app.validate_proxy(source, wrong))

    def test_known_source_replacement_cannot_adopt_old_proxy(self):
        self.generator.scan(now=2000)
        key = app.key_for(self.root, self.path)
        self.generator.store.success(key, "5", "old_proxy_identity")
        self.path.write_bytes(b"different same path source")
        os.utime(self.path, (1001, 1001))
        self.generator.scan(now=2002)
        row = self.generator.store.observe(key, app.identity(self.path), 2004)
        self.assertEqual(row[6], 0)

    @unittest.skipIf(os.name == "nt", "process groups require Linux")
    def test_hung_process_timeout_and_shutdown(self):
        start = time.monotonic()
        with self.assertRaises(app.JobError):
            app.run_process([sys.executable, "-c", "import time; time.sleep(60)"], 0.1)
        self.assertLess(time.monotonic() - start, 5)
        app.STOP.set()
        with self.assertRaises(app.JobError):
            app.run_process([sys.executable, "-c", "raise SystemExit(0)"], 1)

    def test_invalid_numeric_configuration(self):
        with mock.patch.dict(os.environ, {"MAX_CONCURRENT": "0"}):
            with self.assertRaises(app.JobError):
                app.Config.environment()

    def test_smaller_profile_height_validation_and_legacy_rejection(self):
        self.assertEqual(app.target_height(media()), 720)
        self.assertEqual(app.target_height(media(height=1080)), 540)
        self.assertEqual(app.target_height(media(), dataclasses.replace(self.config, max_height=1080)), 1080)
        self.assertTrue(app.validate_proxy(media(), media(height=720), self.config))
        self.assertFalse(app.validate_proxy(media(), media(height=1080), self.config))
        for height in ("0", "143", "719", "1082", "bad"):
            with self.subTest(height=height), mock.patch.dict(os.environ, {"PROXY_MAX_HEIGHT": height}):
                with self.assertRaises(app.JobError):
                    app.Config.environment()

    def test_height_change_invalidates_receipt_and_resets_failure_budget(self):
        output = self.folder / "Proxy" / "clip.mov"
        output.parent.mkdir()
        output.write_bytes(b"existing1080proxy")
        self.generator.scan(now=2000)
        key = app.key_for(self.root, self.path)
        old = dataclasses.replace(self.config, max_height=1080)
        self.generator.store.success(key, old.render_version, app.identity(output))
        with mock.patch.object(self.generator, "render", return_value=("failed", None)) as render:
            for now in (2002, 2005, 2008, 2011):
                self.generator.scan(now=now)
            self.assertEqual(render.call_count, 3)
            row = self.generator.store.observe(key, app.identity(self.path), 2011)
            self.assertEqual(row[2], self.config.render_version)
            self.generator.config = old
            self.generator.scan(now=2014)
            self.assertEqual(render.call_count, 4)

    def test_invalid_timebase_failure_is_isolated_per_file(self):
        second = self.folder / "second.mp4"
        second.write_bytes(b"synthetic")
        os.utime(second, (1000, 1000))
        self.generator.scan(now=2000)
        invalid = media()
        invalid["video"]["time_base"] = "0/0"
        with mock.patch.object(app, "probe", return_value=invalid):
            result = self.generator.scan(now=2002)
        self.assertEqual(result["failed"], 2)
        self.assertEqual(list((self.folder / "Proxy").glob(".proxy-gen-*.mov")), [])

    def test_parallelism_is_bounded_and_bad_jobs_do_not_block_later_files(self):
        for index in range(4):
            path = self.folder / f"extra{index}.mp4"
            path.write_bytes(b"synthetic")
            os.utime(path, (1000, 1000))
        self.generator.config = dataclasses.replace(self.config, concurrency=2)
        self.generator.scan(now=2000)
        lock = threading.Lock()
        running = peak = completed = 0
        def render(*_):
            nonlocal running, peak, completed
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.03)
            with lock:
                running -= 1
                completed += 1
            return "failed", None
        with mock.patch.object(self.generator, "render", side_effect=render):
            result = self.generator.scan(now=2002)
        self.assertEqual(peak, 2)
        self.assertEqual(completed, 5)
        self.assertEqual(result["failed"], 5)

    @unittest.skipIf(os.name == "nt", "flock and process groups require Linux")
    def test_singleton_lock_health_and_graceful_shutdown(self):
        environment = {**os.environ, "JOBS_ROOT": str(self.root), "STATE_DIR": str(self.state)}
        command = [sys.executable, "-B", app.__file__]
        process = subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 5
            while not (self.state / "health.json").exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertIsNone(process.poll())
            self.assertEqual(subprocess.run(command + ["--healthcheck"], env=environment, timeout=5, capture_output=True).returncode, 0)
            self.assertEqual(subprocess.run(command + ["--once"], env=environment, timeout=5, capture_output=True).returncode, 1)
            process.terminate()
            self.assertEqual(process.wait(timeout=5), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    @unittest.skipIf(os.name == "nt", "process groups require Linux")
    def test_timeout_terminates_descendant_process(self):
        pid_file = pathlib.Path(self.tmp.name) / "child-pid"
        script = "import subprocess,sys,time,pathlib; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
        with self.assertRaises(app.JobError):
            app.run_process([sys.executable, "-c", script, str(pid_file)], 0.5)
        pid = int(pid_file.read_text())
        status = pathlib.Path(f"/proc/{pid}/status")
        # A terminated child may remain a zombie until the container init reaps it.
        if status.exists():
            state = next(line for line in status.read_text().splitlines() if line.startswith("State:"))
            self.assertIn("Z", state)


@unittest.skipUnless(os.name != "nt" and shutil.which("ffmpeg") and shutil.which("ffprobe"), "Linux ffmpeg and ffprobe required for media smoke")
class RealMediaSmokeTests(unittest.TestCase):
    setUp = RuntimeTests.setUp
    def test_real_4k_smaller_profile_size_and_metadata(self):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=25", "-t", "0.24", "-c:v", "mpeg4", "-threads", "2", "-q:v", "4", "-timecode", "01:00:00:00", str(self.path)], check=True, timeout=30)
        source = app.probe(self.path, self.config)
        sizes = {}
        for height in (1080, 720):
            config = dataclasses.replace(self.config, max_height=height)
            output = self.folder / f"synthetic-proxy-{height}.mov"
            app.run_process(app.encode_args(self.path, output, source, config), 30)
            result = app.probe(output, config)
            self.assertTrue(app.validate_proxy(source, result, config))
            self.assertEqual(result["video"]["height"], height)
            self.assertEqual(result["video"]["width"], height * 16 // 9)
            self.assertEqual(result["video"]["codec_name"], "h264")
            self.assertEqual(result["video"]["pix_fmt"], "yuv420p")
            self.assertEqual(result["timecode"], "01:00:00:00")
            sizes[height] = output.stat().st_size
        self.assertLess(sizes[720], sizes[1080])
        print(json.dumps({"event": "synthetic_size_comparison", "proxy_1080_bytes": sizes[1080], "proxy_720_bytes": sizes[720]}), flush=True)

    def test_real_fractional_fps_audio_timecode_render_and_reuse(self):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30000/1001", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "mpeg4", "-q:v", "4", "-c:a", "aac", "-timecode", "01:00:00:00", str(self.path)], check=True, timeout=30)
        os.utime(self.path, (1000, 1000))
        original = self.path.read_bytes()
        self.generator.scan(now=2000)
        result = self.generator.scan(now=2002)
        self.assertEqual(result["generated"], 1)
        output = self.folder / "Proxy" / "clip.mov"
        source_probe, output_probe = app.probe(self.path, self.config), app.probe(output, self.config)
        self.assertTrue(app.validate_proxy(source_probe, output_probe))
        self.assertEqual(output_probe["timecode"], "01:00:00:00")
        self.assertEqual(self.generator.scan(now=2004)["current"], 1)
        self.assertEqual(self.path.read_bytes(), original)

    def test_real_nonzero_start_time_preserved(self):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "1", "-c:v", "mpeg4", "-output_ts_offset", "12", str(self.path)], check=True, timeout=30)
        os.utime(self.path, (1000, 1000))
        self.generator.scan(now=2000)
        self.assertEqual(self.generator.scan(now=2002)["generated"], 1)
        source = app.probe(self.path, self.config)
        output = app.probe(self.folder / "Proxy" / "clip.mov", self.config)
        self.assertAlmostEqual(float(source["video"]["start_time"]), 12, places=2)
        self.assertTrue(app.validate_proxy(source, output))

    def test_real_drop_frame_timecode_preserved(self):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30000/1001", "-t", "1", "-c:v", "mpeg4", "-timecode", "01:00:00;00", str(self.path)], check=True, timeout=30)
        os.utime(self.path, (1000, 1000))
        self.generator.scan(now=2000)
        self.assertEqual(self.generator.scan(now=2002)["generated"], 1)
        output = app.probe(self.folder / "Proxy" / "clip.mov", self.config)
        self.assertEqual(output["timecode"], "01:00:00;00")

    def test_real_sony_style_drop_frame_proxy_is_all_intra(self):
        # Like XAVC: timecode FFprobe reports with ":" and the drop flag only in trailing Sony XML.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60000/1001", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", "1", "-c:v", "libx264", "-g", "30", "-c:a", "aac", "-timecode", "01:53:56:18", "-f", "mp4", str(self.path)], check=True, timeout=30)
        with self.path.open("ab") as file:
            file.write(sony_xml("49565301"))
        os.utime(self.path, (1000, 1000))
        self.generator.scan(now=2000)
        self.assertEqual(self.generator.scan(now=2002)["generated"], 1)
        output = self.folder / "Proxy" / "clip.mov"
        result = app.probe(output, self.config)
        self.assertEqual(result["timecode"], "01:53:56;18")
        self.assertEqual((result["video"]["codec_name"], result["video"]["pix_fmt"]), ("h264", "yuv420p"))
        frames = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pict_type", "-of", "csv=p=0", str(output)],
            check=True, capture_output=True, text=True, timeout=30).stdout.split()
        self.assertEqual({frame.strip(",") for frame in frames}, {"I"})
        self.assertEqual(self.generator.scan(now=2004)["current"], 1)


if __name__ == "__main__":
    unittest.main()
