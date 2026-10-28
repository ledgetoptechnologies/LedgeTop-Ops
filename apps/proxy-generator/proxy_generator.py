#!/usr/bin/env python3
"""Bounded, restartable local Resolve proxy generation. Python standard library only."""
import argparse
import concurrent.futures
import contextlib
import dataclasses
import fractions
import hashlib
import json
import math
import os
import pathlib
import queue
import secrets
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time

EXTENSIONS = frozenset("mp4 mov mxf avi mkv mts m2ts wmv flv webm 3gp mpg mpeg ts".split())
SKIP = frozenset(("proxy", "avata raw", "avata_raw", "avataraw", ".previews", "_ltds",
    "tmp", "temp", "trash", "recycle", "snapshots", ".snapshot", "archive", "map", "model",
    "edited vs nonedited", "edited vs. nonedited", "deliverables", "deliverable", "exports",
    "export", "final", "finals", "output", "outputs", "rendered", "renders"))
STOP = threading.Event()


class JobError(Exception):
    pass


def log(event, **counts):
    # No media names, paths, probe output, or commands in production logs.
    print(json.dumps({"event": event, **counts}), flush=True)


@dataclasses.dataclass(frozen=True)
class Config:
    root: pathlib.Path
    state: pathlib.Path
    concurrency: int = 6
    sleep: int = 900
    stable: int = 60
    probe_timeout: int = 30
    encode_timeout: int = 7200
    threads: int = 2
    attempts: int = 3
    retry_base: int = 60
    retry_max: int = 3600
    version: str = "6"
    scan_dirs: tuple = ("Clients", "Recurring", "Extended", "2024", "2025", "2026")
    include: frozenset = frozenset(("dump", "unedited", "raw", "stabilized"))
    max_height: int = 720

    @property
    def render_version(self):
        # Receipts and retry budgets belong to the complete output profile.
        return f"{self.version}-prores-proxy-h{self.max_height}"

    @classmethod
    def environment(cls):
        def number(name, default, maximum):
            try:
                result = int(os.environ.get(name, default))
                if not 1 <= result <= maximum:
                    raise ValueError()
                return result
            except ValueError:
                raise JobError("invalid_configuration") from None
        dirs = tuple(os.environ.get("PROXY_SCAN_DIRS", "Clients Recurring Extended 2024 2025 2026").split())
        include = frozenset(os.environ.get("PROXY_INCLUDE_SEGMENTS", "Dump Unedited Raw Stabilized").casefold().split())
        version = os.environ.get("FORCE_PROXY_REGENERATION_VERSION", "6")
        max_height = number("PROXY_MAX_HEIGHT", 720, 1080)
        if max_height < 144 or max_height % 2:
            raise JobError("invalid_configuration")
        if not dirs or not include or any(x in (".", "..") or "/" in x or "\\" in x for x in dirs) or not version.isdecimal() or len(version) > 8:
            raise JobError("invalid_configuration")
        return cls(pathlib.Path(os.environ.get("JOBS_ROOT", "/data/jobs")),
            pathlib.Path(os.environ.get("STATE_DIR", "/state")),
            number("MAX_CONCURRENT", 6, 32), number("SLEEP_SECONDS", 900, 86400),
            number("SOURCE_STABLE_SECONDS", 60, 86400), number("PROBE_TIMEOUT_SECONDS", 30, 600),
            number("ENCODE_TIMEOUT_SECONDS", 7200, 86400), number("FFMPEG_THREADS", 2, 64),
            number("MAX_ATTEMPTS", 3, 10), number("RETRY_BASE_SECONDS", 60, 86400),
            number("RETRY_MAX_SECONDS", 3600, 86400), version, dirs, include, max_height)


def identity(path):
    stat = path.stat(follow_symlinks=False)
    if not path.is_file() or path.is_symlink():
        raise JobError("unsafe_source")
    return f"{stat.st_dev}:{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}"


def key_for(root, path):
    return hashlib.sha256(path.relative_to(root).as_posix().encode()).hexdigest()


def safe_path(root, path):
    """Reject link components, including broken links; never resolve them for writing."""
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False
    if root.is_symlink():
        return False
    current = root
    for part in relative.parts:
        if part in (".", ".."):
            return False
        current = current / part
        if current.is_symlink():
            return False
    return True


def output_directory_fd(root, directory):
    """Pin each Jobs directory without following a swapped symlink."""
    relative = directory.relative_to(root)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(root, flags)
    try:
        for part in relative.parts:
            child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def run_process(args, timeout, capture=False, pass_fds=(), cwd=None):
    if STOP.is_set():
        raise JobError("stopped")
    diagnostics = not capture and os.environ.get("PROXY_GENERATOR_DIAGNOSTICS") == "1"
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if diagnostics else subprocess.DEVNULL,
        start_new_session=True, cwd=cwd, **({"pass_fds": pass_fds} if os.name == "posix" else {}))
    deadline = time.monotonic() + timeout
    error_tail = bytearray()
    if diagnostics:
        def read_stderr():
            while chunk := process.stderr.read(4096):
                error_tail.extend(chunk)
                del error_tail[:-1024]
        error_reader = threading.Thread(target=read_stderr, daemon=True)
        error_reader.start()
    try:
        if capture:
            chunks = queue.Queue(maxsize=2)
            def read_stdout():
                while True:
                    chunk = process.stdout.read(65536)
                    chunks.put(chunk)
                    if not chunk:
                        return
            threading.Thread(target=read_stdout, daemon=True).start()
            output = bytearray()
            while True:
                if STOP.is_set() or time.monotonic() >= deadline:
                    raise JobError("stopped" if STOP.is_set() else "process_timeout")
                try:
                    chunk = chunks.get(timeout=min(0.5, max(0.01, deadline - time.monotonic())))
                except queue.Empty:
                    continue
                if not chunk:
                    break
                if len(output) + len(chunk) > 1024 * 1024:
                    raise JobError("probe_too_large")
                output.extend(chunk)
            try:
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise JobError("process_timeout") from None
            if process.returncode:
                raise JobError("process_failed")
            return bytes(output)
        while True:
            if STOP.is_set() or time.monotonic() >= deadline:
                raise JobError("stopped" if STOP.is_set() else "process_timeout")
            try:
                if diagnostics:
                    process.wait(timeout=min(0.5, max(0.01, deadline - time.monotonic())))
                    error_reader.join(timeout=1)
                    output = None
                else:
                    output, _ = process.communicate(timeout=min(0.5, max(0.01, deadline - time.monotonic())))
                if process.returncode:
                    if diagnostics:
                        log("process_diagnostic", stderr=error_tail.decode("utf-8", "replace"))
                    raise JobError("process_failed")
                return output
            except subprocess.TimeoutExpired:
                continue
    finally:
        if process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                if hasattr(os, "killpg"):
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    if hasattr(os, "killpg"):
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                process.wait(timeout=5)


def probe(path, config):
    try:
        data = json.loads(run_process(["ffprobe", "-v", "error", "-show_entries",
            "stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,time_base,start_time,duration,nb_frames:stream_tags=timecode:format=duration:format_tags=timecode",
            "-of", "json", str(path)], config.probe_timeout, capture=True))
        streams = data["streams"]
        video = next(x for x in streams if x.get("codec_type") == "video")
        fps = fractions.Fraction(video.get("avg_frame_rate", "0/1"))
        if fps <= 0:
            fps = fractions.Fraction(video.get("r_frame_rate", "0/1"))
        nominal = fractions.Fraction(video.get("r_frame_rate", str(fps)))
        if nominal > 0 and nominal != fps:
            raise JobError("variable_frame_rate_unsupported")
        if fps <= 0 or not 0 < int(video["height"]) <= 65536 or not 0 < int(video["width"]) <= 65536:
            raise ValueError()
        duration = float(video.get("duration") or data.get("format", {}).get("duration", 0))
        start = float(video.get("start_time", 0) or 0)
        if not math.isfinite(start) or not 0 < duration < 7 * 86400:
            raise ValueError()
        tc = video.get("tags", {}).get("timecode")
        if not tc:
            tc = next((x.get("tags", {}).get("timecode") for x in streams if x.get("tags", {}).get("timecode")), None)
        tc = tc or data.get("format", {}).get("tags", {}).get("timecode")
        # Preserve actual source drop/non-drop notation rather than guessing from frame rate.
        if tc and (len(tc) != 11 or tc[2] != ":" or tc[5] != ":" or tc[8] not in ":;" or not tc.replace(":", "").replace(";", "").isdigit()):
            raise ValueError()
        return {"video": video, "fps": fps, "duration": duration, "timecode": tc,
            "audio": sum(x.get("codec_type") == "audio" for x in streams)}
    except (KeyError, ValueError, TypeError, StopIteration, ZeroDivisionError, json.JSONDecodeError):
        raise JobError("invalid_media") from None


def target_height(media, config=None):
    half = int(media["video"]["height"]) // 2
    return max(144, min(config.max_height if config else 720, half + half % 2))


def validate_proxy(source, output, config=None):
    height = target_height(source, config)
    video = output["video"]
    expected_width = int(source["video"]["width"]) * height / int(source["video"]["height"])
    width = int(video["width"])
    if (video.get("codec_name") != "prores" or video.get("profile") != "Proxy" or video.get("pix_fmt") != "yuv422p10le"
            or int(video["height"]) != height or width % 2 or abs(width - expected_width) > 2):
        return False
    if source["fps"] != output["fps"] or source["audio"] != output["audio"]:
        return False
    source_frames, output_frames = source["video"].get("nb_frames"), video.get("nb_frames")
    if source_frames and source_frames != "N/A" and output_frames and output_frames != "N/A" and int(source_frames) != int(output_frames):
        return False
    if source["timecode"] and source["timecode"] != output["timecode"]:
        return False
    if abs(source["duration"] - output["duration"]) > max(0.15, 2 / float(source["fps"])):
        return False
    try:
        if abs(float(source["video"].get("start_time", 0)) - float(output["video"].get("start_time", 0))) > max(0.05, 1 / float(source["fps"])):
            return False
    except (ValueError, TypeError):
        return False
    return True


def encode_args(source, tmp, media, config):
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-threads", str(config.threads), "-i", str(source),
        "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0",
        "-vf", f"scale=-2:{target_height(media, config)},format=yuv422p10le", "-c:v", "prores_ks", "-profile:v", "0", "-vendor", "apl0",
        "-threads", str(config.threads), "-c:a", "pcm_s16le", "-ar", "48000", "-r", str(media["fps"])]
    tb = fractions.Fraction(media["video"].get("time_base", "1/60000"))
    if tb > 0 and tb.denominator <= 2147483647:
        args += ["-video_track_timescale", str(tb.denominator)]
    start = float(media["video"].get("start_time", 0) or 0)
    if start:
        args += ["-output_ts_offset", str(start)]
    if media["timecode"]:
        args += ["-timecode", media["timecode"]]
    return args + ["-f", "mov", str(tmp)]


class Store:
    def __init__(self, state):
        self.db = sqlite3.connect(state / "jobs.sqlite")
        self.db.execute("CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, identity TEXT, observed REAL, version TEXT, output_identity TEXT, failures INTEGER DEFAULT 0, retry_at REAL DEFAULT 0, legacy_eligible INTEGER DEFAULT 1)")

    def observe(self, key, source_id, now):
        row = self.db.execute("SELECT identity, observed, version, output_identity, failures, retry_at, legacy_eligible FROM jobs WHERE key=?", (key,)).fetchone()
        if not row or row[0] != source_id:
            self.db.execute("INSERT INTO jobs(key,identity,observed) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET identity=excluded.identity,observed=excluded.observed,version=NULL,output_identity=NULL,failures=0,retry_at=0,legacy_eligible=0", (key, source_id, now))
            self.db.commit()
            return None
        return row

    def success(self, key, version, output_id):
        self.db.execute("UPDATE jobs SET version=?,output_identity=?,failures=0,retry_at=0,legacy_eligible=0 WHERE key=?", (version, output_id, key))
        self.db.commit()

    def failure(self, key, now, config):
        self.db.execute("UPDATE jobs SET version=?,output_identity=NULL,failures=failures+1,retry_at=?+MIN(?,?*(1 << MIN(failures,16))),legacy_eligible=0 WHERE key=?", (config.render_version, now, config.retry_max, config.retry_base, key))
        self.db.commit()

    def close(self):
        self.db.close()


class Generator:
    def __init__(self, config):
        self.config = config
        self.store = Store(config.state)
        self.health = config.state / "health.json"

    def heartbeat(self):
        temp = self.config.state / "health.tmp"
        temp.write_text(json.dumps({"heartbeat": time.time()}))
        os.replace(temp, self.health)

    def candidates(self):
        root = self.config.root
        for top in self.config.scan_dirs:
            directory = root / top
            if not safe_path(root, directory) or not directory.is_dir():
                continue
            root_device = root.stat().st_dev
            if directory.stat().st_dev != root_device:
                continue
            for current, dirs, files in os.walk(directory, followlinks=False):
                self.heartbeat()
                current = pathlib.Path(current)
                if STOP.is_set():
                    return
                dirs[:] = [d for d in dirs if d.casefold() not in SKIP and not d.startswith(".") and safe_path(root, current / d) and (current / d).stat().st_dev == root_device]
                parts = current.relative_to(root).parts
                if not any(x.casefold() in self.config.include for x in parts) or any(x.casefold() in SKIP for x in parts):
                    continue
                eligible = [current / name for name in files if not name.startswith(".") and pathlib.Path(name).suffix[1:].casefold() in EXTENSIONS]
                # Resolve's same-stem proxy convention cannot safely represent two source extensions.
                counts = {}
                for path in eligible:
                    counts[path.stem.casefold()] = counts.get(path.stem.casefold(), 0) + 1
                for path in eligible:
                    if counts[path.stem.casefold()] == 1 and safe_path(root, path):
                        yield path
                    else:
                        log("source_skipped_unsafe_or_collision")

    def render(self, path, source_id):
        config = self.config
        output = path.parent / "Proxy" / (path.stem + ".mov")
        temp = None
        output_fd = None
        stage = None
        try:
            if not safe_path(config.root, path) or identity(path) != source_id or not safe_path(config.root, output):
                raise JobError("source_changed_or_unsafe")
            output.parent.mkdir(exist_ok=True)
            if not safe_path(config.root, output):
                raise JobError("unsafe_output")
            if os.name == "posix":
                output_fd = output_directory_fd(config.root, output.parent)
            if any(item.name != output.name and item.name.casefold() == output.name.casefold() for item in output.parent.iterdir()):
                raise JobError("output_name_collision")
            media = probe(path, config)
            # Adopt a verified pre-existing proxy on first migration, retaining its bytes.
            # An explicit old folder version prevents adoption after an operator version bump.
            key = key_for(config.root, path)
            row = self.store_snapshot[key]
            version_markers = list(output.parent.glob(".proxy-gen-v*"))
            version_ok = not version_markers or (output.parent / (".proxy-gen-v" + config.version)).is_file()
            if output.is_file() and row[6] and row[2] is None and version_ok and output.stat().st_mtime_ns >= path.stat().st_mtime_ns:
                try:
                    if validate_proxy(media, probe(output, config), config) and identity(path) == source_id:
                        return "adopted", identity(output)
                except JobError:
                    pass
            if output_fd is not None:
                stage = ".proxy-gen-" + secrets.token_hex(16)
                os.mkdir(stage, 0o700, dir_fd=output_fd)
                temp = pathlib.Path(f"/proc/self/fd/{output_fd}/{stage}/proxy.mov")
                run_process(encode_args(path, pathlib.Path(stage) / "proxy.mov", media, config),
                    config.encode_timeout, pass_fds=(output_fd,), cwd=f"/proc/self/fd/{output_fd}")
            else:
                descriptor, name = tempfile.mkstemp(prefix=".proxy-gen-", suffix=".mov", dir=output.parent)
                os.close(descriptor)
                temp = pathlib.Path(name)
                # ffmpeg -n requires an absent output; the private random name is owned by this attempt.
                temp.unlink()
                run_process(encode_args(path, temp, media, config), config.encode_timeout)
            if (temp.is_symlink() or not temp.is_file() or not validate_proxy(media, probe(temp, config), config)):
                raise JobError("invalid_output")
            if STOP.is_set() or not safe_path(config.root, path) or not safe_path(config.root, output) or identity(path) != source_id:
                raise JobError("source_changed_or_unsafe")
            with temp.open("rb") as file:
                os.fsync(file.fileno())
            if output_fd is not None:
                os.replace(f"{stage}/proxy.mov", output.name, src_dir_fd=output_fd, dst_dir_fd=output_fd)
            else:
                os.replace(temp, output)
            return "generated", identity(output)
        except (JobError, OSError, ValueError, ArithmeticError, subprocess.SubprocessError) as error:
            log("job_failed", code=str(error) if isinstance(error, JobError) else "io_or_media_failure")
            return "failed", None
        finally:
            if output_fd is not None:
                if stage is not None:
                    with contextlib.suppress(FileNotFoundError):
                        os.unlink(f"{stage}/proxy.mov", dir_fd=output_fd)
                    with contextlib.suppress(FileNotFoundError):
                        os.rmdir(stage, dir_fd=output_fd)
                os.close(output_fd)
            if output_fd is None and temp is not None and safe_path(config.root, temp):
                with contextlib.suppress(FileNotFoundError):
                    temp.unlink()

    def scan(self, now=None):
        config = self.config
        now = time.time() if now is None else now
        self.store_snapshot = {}
        counts = {"generated": 0, "adopted": 0, "failed": 0, "current": 0, "deferred": 0}
        pending = {}
        # Keep at most concurrency futures, rather than accumulating a whole Jobs tree in RAM.
        with concurrent.futures.ThreadPoolExecutor(max_workers=config.concurrency) as pool:
            def collect(block):
                if not pending:
                    return
                done, _ = concurrent.futures.wait(pending, timeout=1 if block else 0, return_when=concurrent.futures.FIRST_COMPLETED)
                self.heartbeat()
                for future in done:
                    key = pending.pop(future)
                    outcome, output_id = future.result()
                    counts[outcome] += 1
                    if output_id:
                        self.store.success(key, config.render_version, output_id)
                    elif not STOP.is_set():
                        self.store.failure(key, now, config)
                    self.store_snapshot.pop(key, None)
            for path in self.candidates():
                if STOP.is_set():
                    break
                try:
                    source_id = identity(path)
                    key = key_for(config.root, path)
                    row = self.store.observe(key, source_id, now)
                    if not row or now - row[1] < config.stable or now - path.stat().st_mtime < config.stable:
                        counts["deferred"] += 1
                        continue
                    output = path.parent / "Proxy" / (path.stem + ".mov")
                    if not safe_path(config.root, output):
                        counts["deferred"] += 1
                        continue
                    if row[2] == config.render_version and row[3] and output.exists() and row[3] == identity(output):
                        counts["current"] += 1
                        continue
                    # A version change is an explicit retry/reset request, even after exhaustion.
                    if row[2] and row[2] != config.render_version:
                        self.store.db.execute("UPDATE jobs SET failures=0,retry_at=0 WHERE key=?", (key,))
                        self.store.db.commit()
                    elif row[4] >= config.attempts or now < row[5]:
                        counts["deferred"] += 1
                        continue
                    while len(pending) >= config.concurrency:
                        collect(True)
                    self.store_snapshot[key] = row
                    pending[pool.submit(self.render, path, source_id)] = key
                    collect(False)
                except (OSError, JobError):
                    counts["failed"] += 1
            while pending:
                collect(True)
        self.heartbeat()
        log("scan_complete", **counts)
        return counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    try:
        config = Config.environment()
        if args.healthcheck:
            value = json.loads((config.state / "health.json").read_text())
            return 0 if 0 <= time.time() - value["heartbeat"] < 90 else 1
        import fcntl  # Linux container runtime; unit tests can import on Windows.
        if not config.root.is_absolute() or not config.root.is_dir() or config.root.is_symlink():
            raise JobError("invalid_jobs_mount")
        config.state.mkdir(parents=True, exist_ok=True)
        if config.state.is_symlink():
            raise JobError("invalid_state_mount")
        lock = (config.state / "instance.lock").open("a")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: STOP.set())
        generator = Generator(config)
        try:
            while not STOP.is_set():
                generator.scan()
                if args.once:
                    break
                deadline = time.monotonic() + config.sleep
                while not STOP.is_set() and time.monotonic() < deadline:
                    generator.heartbeat()
                    STOP.wait(min(10, max(0, deadline - time.monotonic())))
        finally:
            generator.store.close()
        return 0
    except (JobError, OSError, ValueError, KeyError, sqlite3.Error):
        log("startup_or_state_failure")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
