"""Linux-only fd traversal and immutable disk snapshots; standard library only."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable
from .errors import Denied
from .snapshot_cache import SnapshotCache, SnapshotLease as Snapshot, authority_binding, source_identity

SAFE = 9_007_199_254_740_991
HEX = re.compile(r"[a-f0-9]{64}\Z")
FIELDS = {"schemaVersion", "gatewayId", "rootId", "rootGeneration", "rootFingerprint", "staffId",
          "accessSubject", "admissionVersion", "profileVersion", "grantId", "grantGeneration",
          "operation", "path", "expectedSha256", "range", "cursor", "snapshotId", "expiresAt", "deadlineAt"}


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= SAFE:
        raise Denied()
    return value


def canonical_uuid(value):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value) is None:
        raise Denied()
    try:
        if str(uuid.UUID(value)) != value:
            raise Denied()
    except ValueError:
        raise Denied() from None
    return value


def text(value, maximum=191, *, opaque=False):
    if not isinstance(value, str) or not value.strip() or (not opaque and value.strip() != value) or len(value) > maximum \
            or any(unicodedata.category(c).startswith("C") for c in value) or len(value.encode("utf-8")) > 764:
        raise Denied()
    return value


def path_parts(value, allow_empty=False):
    if not isinstance(value, str):
        raise Denied()
    if value == "" and allow_empty:
        return []
    if any(c in value for c in "\\%:") or any(unicodedata.category(c) in ("Cc", "Cf", "Cs") for c in value):
        raise Denied()
    parts = value.split("/")
    if len(value.encode("utf-8")) > 4096 or len(parts) > 64 \
            or any(p in ("", ".", "..") or len(p.encode("utf-8")) > 255 for p in parts):
        raise Denied()
    return parts


def unique_json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise Denied()
            result[key] = value
        return result
    if len(body) > 16384:
        raise Denied()
    try:
        return json.loads(body.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(Denied()))
    except (UnicodeError, ValueError, RecursionError):
        raise Denied() from None


def mount_id(fd):
    # Device alone does not distinguish same-filesystem bind mounts.
    with open(f"/proc/self/fdinfo/{fd}", encoding="ascii") as info:
        for line in info:
            if line.startswith("mnt_id:"):
                return int(line.split(":", 1)[1].strip())
    raise Denied("filesystem-unavailable", 503)


def open_absolute(path):
    if not isinstance(path, str) or not path.startswith("/") or path == "/" or os.path.normpath(path) != path:
        raise Denied("invalid-root", 503)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.split("/")[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def fingerprint(root_id, generation, device, inode):
    value = f"ops-employee-root-v1\n{root_id}\n{generation}\n{device}\n{inode}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Root:
    root_id: str
    generation: int
    path: str
    device: int
    inode: int
    fingerprint: str


def enroll(path, root_id, generation):
    canonical_uuid(root_id)
    integer(generation, 1)
    fd = open_absolute(path)
    try:
        source = os.fstat(fd)
        mount_id(fd)  # Fail closed if Linux mount identity is unavailable.
        return Root(root_id, generation, path, source.st_dev, source.st_ino,
                    fingerprint(root_id, generation, source.st_dev, source.st_ino))
    finally:
        os.close(fd)


def private_directory(path):
    fd = open_absolute(path)
    try:
        current = os.fstat(fd)
        if current.st_uid != os.getuid() or stat.S_IMODE(current.st_mode) & 0o077:
            raise Denied("private-storage-required", 503)
    finally:
        os.close(fd)


class ReplayStore:
    def __init__(self, path, capacity=10000):
        private_directory(os.path.dirname(path))
        self.path, self.capacity = path, capacity
        if capacity < 1:
            raise ValueError("Invalid replay capacity")
        if os.path.lexists(path):
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise Denied("replay-store-unavailable", 503)
        else:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, expiry INTEGER NOT NULL, PRIMARY KEY(key_id,nonce))")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=2)
        try:
            db.execute("PRAGMA journal_mode=DELETE")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA max_page_count=16384")
            with db:
                yield db
        finally:
            db.close()

    def claim(self, key_id, nonce, expiry, now):
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("DELETE FROM nonces WHERE expiry<=?", (now,))
                if db.execute("SELECT COUNT(*) FROM nonces").fetchone()[0] >= self.capacity:
                    raise Denied("replay-store-full", 503)
                try:
                    db.execute("INSERT INTO nonces VALUES(?,?,?)", (key_id, nonce, expiry))
                except sqlite3.IntegrityError:
                    raise Denied("replayed-request", 409) from None
        except sqlite3.Error:
            raise Denied("replay-store-unavailable", 503) from None


@dataclass
class Reply:
    status: int
    headers: dict
    body: bytes | Snapshot


class Gateway:
    def __init__(self, gateway_id, roots, keys, replay, spool, *, max_file_bytes=64 * 1024**3,
                 max_spool_bytes=128 * 1024**3, minimum_free_bytes=1024**3, concurrency=2,
                 snapshot_ttl=1800, max_snapshot_entries=32, max_snapshot_readers=32, clock=time.time):
        canonical_uuid(gateway_id)
        if not keys or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key_id) or not isinstance(key, bytes) or len(key) < 32 for key_id, key in keys.items()):
            raise ValueError("Dedicated signing keys are required")
        if not 1 <= concurrency <= 32 or not 1 <= max_file_bytes <= SAFE or not max_file_bytes <= max_spool_bytes <= SAFE \
                or minimum_free_bytes < 0 or not 1 <= snapshot_ttl <= 1800:
            raise ValueError("Invalid resource limits")
        private_directory(spool)
        self.gateway_id, self.keys, self.replay, self.spool = gateway_id, dict(keys), replay, spool
        self.roots = {}
        for root in roots:
            if root.root_id in self.roots or enroll(root.path, root.root_id, root.generation) != root:
                raise Denied("root-enrollment-mismatch", 503)
            self.roots[root.root_id] = root
        if not self.roots:
            raise ValueError("Explicit root enrollment required")
        self.max_file_bytes, self.max_spool_bytes, self.minimum_free = max_file_bytes, max_spool_bytes, minimum_free_bytes
        self.snapshot_ttl, self.clock = snapshot_ttl, clock
        self.slots = threading.BoundedSemaphore(concurrency)
        self.cache = SnapshotCache(spool, max_bytes=max_spool_bytes, minimum_free=minimum_free_bytes,
                                   max_entries=max_snapshot_entries, max_readers=max_snapshot_readers,
                                   ttl=snapshot_ttl, clock=clock)
        self.directory_pages, self.directory_lock = None, threading.Lock()

    @property
    def reserved(self):
        return self.cache.reserved

    def close(self):
        self.cache.close()
        if self.directory_pages is not None and hasattr(self.directory_pages, "close"):
            self.directory_pages.close()

    def authenticate(self, headers, body):
        def header(name, pattern):
            value = headers.get(name)
            if not isinstance(value, str) or re.fullmatch(pattern, value) is None:
                raise Denied("unauthorized", 401)
            return value
        if len(body) > 16384 or headers.get("Content-Type") != "application/json":
            raise Denied()
        key_id = header("X-Ops-Read-Key-Id", r"[A-Za-z0-9_-]{1,64}")
        timestamp = header("X-Ops-Read-Time", r"[1-9][0-9]{0,15}")
        nonce = header("X-Ops-Read-Nonce", r"[a-f0-9]{32}")
        signature = header("X-Ops-Read-Signature", r"[a-f0-9]{64}")
        key = self.keys.get(key_id)
        if key is None:
            raise Denied("unauthorized", 401)
        message = "\n".join(["ops-employee-read-v1", self.gateway_id, key_id, timestamp, nonce, "POST", "/v1/read", hashlib.sha256(body).hexdigest()])
        if not hmac.compare_digest(signature, hmac.digest(key, message.encode(), "sha256").hex()):
            raise Denied("unauthorized", 401)
        now = self.clock()
        if int(timestamp) > SAFE or abs(now - int(timestamp)) > 30:
            raise Denied("expired-request", 401)
        request = unique_json(body)
        if not isinstance(request, dict) or set(request) != FIELDS or type(request["schemaVersion"]) is not int or request["schemaVersion"] != 1:
            raise Denied()
        for name in ("gatewayId", "rootId", "grantId"):
            canonical_uuid(request[name])
        if request["gatewayId"] != self.gateway_id:
            raise Denied("unauthorized", 401)
        for name in ("rootGeneration", "admissionVersion", "profileVersion", "grantGeneration"):
            integer(request[name], 1)
        text(request["staffId"])
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,190}", request["staffId"]) is None:
            raise Denied()
        # Native Access subjects are opaque: admission preserves surrounding whitespace.
        text(request["accessSubject"], opaque=True)
        if not isinstance(request["rootFingerprint"], str) or not HEX.fullmatch(request["rootFingerprint"]):
            raise Denied()
        expiry, deadline = integer(request["expiresAt"]), integer(request["deadlineAt"])
        if not int(timestamp) <= expiry <= int(timestamp) + 30 or now >= expiry \
                or not expiry <= deadline <= int(timestamp) + 900:
            raise Denied("expired-request", 401)
        operation = request["operation"]
        if operation not in ("list", "manifest", "content"):
            raise Denied()
        path_parts(request["path"], operation == "list")
        digest = request["expectedSha256"]
        if operation == "content":
            if not isinstance(digest, str) or HEX.fullmatch(digest) is None:
                raise Denied()
        elif digest is not None:
            raise Denied()
        byte_range = request["range"]
        if byte_range is not None:
            if operation != "content" or not isinstance(byte_range, dict) or set(byte_range) != {"start", "end"}:
                raise Denied()
            if integer(byte_range["start"]) > integer(byte_range["end"]):
                raise Denied("invalid-range", 416)
        if operation == "content":
            canonical_uuid(request["snapshotId"])
        elif request["snapshotId"] is not None:
            raise Denied()
        cursor = request["cursor"]
        if cursor is not None and (operation != "list" or not isinstance(cursor, str) or not 1 <= len(cursor) <= 8192
                                   or not cursor.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in cursor)):
            raise Denied()
        self.replay.claim(key_id, nonce, expiry, now)
        request["_keyId"] = key_id
        return request

    def open_source(self, request):
        root = self.roots.get(request["rootId"])
        if root is None or root.generation != request["rootGeneration"] or not hmac.compare_digest(root.fingerprint, request["rootFingerprint"]):
            raise Denied("root-unavailable", 404)
        fd = open_absolute(root.path)
        try:
            info = os.fstat(fd)
            if (info.st_dev, info.st_ino) != (root.device, root.inode):
                raise Denied("root-enrollment-mismatch", 409)
            expected_mount = mount_id(fd)
            parts = path_parts(request["path"], request["operation"] == "list")
            for index, part in enumerate(parts):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
                if index < len(parts) - 1 or request["operation"] == "list":
                    flags |= os.O_DIRECTORY
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
                if mount_id(fd) != expected_mount:
                    raise Denied("nested-mount-denied", 404)
            info = os.fstat(fd)
            if request["operation"] == "list":
                if not stat.S_ISDIR(info.st_mode):
                    raise Denied("resource-unavailable", 404)
            elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise Denied("resource-unavailable", 404)
            return fd, expected_mount
        except BaseException:
            os.close(fd)
            raise

    def check_deadline(self, request, cancelled):
        if cancelled():
            raise Denied("request-cancelled", 408)
        if self.clock() >= request["deadlineAt"] or time.monotonic() >= request["_monotonicDeadline"]:
            raise Denied("deadline-exceeded", 408)

    def execute(self, headers, body, cancelled: Callable[[], bool] = lambda: False):
        request = self.authenticate(headers, body)
        request["_monotonicDeadline"] = time.monotonic() + max(0, request["deadlineAt"] - self.clock())
        fd, snapshot, preparing = None, None, False
        try:
            self.check_deadline(request, cancelled)
            if request["operation"] == "content":
                snapshot = self.cache.acquire(request["snapshotId"], authority_binding(request), request["expectedSha256"],
                                              request["_monotonicDeadline"], lambda: self.check_deadline(request, cancelled))
                try:
                    fd, _ = self.open_source(request)
                    if source_identity(os.fstat(fd)) != snapshot.source:
                        raise Denied("content-version-changed", 412)
                except (OSError, Denied):
                    # This exact bound, digest-matching entry is now known stale.
                    # Existing leases retain their fd, but idle bytes need not wait for TTL.
                    self.cache.expire(request["snapshotId"])
                    raise Denied("content-version-changed", 412) from None
                self.check_deadline(request, cancelled)
                response_headers = {"Content-Type": "application/octet-stream", "ETag": '"' + snapshot.sha256 + '"',
                                    "Content-Length": str(snapshot.length)}
                byte_range, status_code = request["range"], 200
                if byte_range is not None:
                    if byte_range["end"] >= snapshot.length:
                        raise Denied("invalid-range", 416)
                    snapshot.start, snapshot.end = byte_range["start"], byte_range["end"]
                    response_headers["Content-Length"] = str(snapshot.end - snapshot.start + 1)
                    response_headers["Content-Range"] = f"bytes {snapshot.start}-{snapshot.end}/{snapshot.length}"
                    status_code = 206
                reply = Reply(status_code, response_headers, snapshot)
                snapshot = None  # Response consumer owns the lease, not the cache entry.
                return reply
            fd, expected_mount = self.open_source(request)
            if request["operation"] == "list":
                with self.directory_lock:
                    if self.directory_pages is None:
                        from .directory_pages import DirectoryPages
                        self.directory_pages = DirectoryPages(self.keys, self.clock)
                return self.json_reply(self.directory_pages.list_page(fd, expected_mount, request,
                                                                     lambda: self.check_deadline(request, cancelled)))
            if not self.slots.acquire(blocking=False):
                raise Denied("gateway-busy", 503)
            preparing = True
            entry = self.prepare_snapshot(fd, request, cancelled)
            try:
                self.check_deadline(request, cancelled)
            except BaseException:
                self.cache.expire(entry.snapshot_id)
                raise
            return self.json_reply({"schemaVersion": 1, "sha256": entry.sha256, "size": entry.length,
                                    "etag": '"' + entry.sha256 + '"', "snapshotId": entry.snapshot_id,
                                    "snapshotExpiresAt": entry.expires_at})
        except OSError:
            raise Denied("resource-unavailable", 404) from None
        finally:
            if snapshot is not None:
                snapshot.close()
            if fd is not None:
                os.close(fd)
            if preparing:
                self.slots.release()

    @staticmethod
    def json_reply(value):
        body = json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode()
        return Reply(200, {"Content-Type": "application/json", "Content-Length": str(len(body))}, body)

    def prepare_snapshot(self, fd, request, cancelled):
        before = os.fstat(fd)
        length = before.st_size
        if length > self.max_file_bytes:
            raise Denied("file-too-large", 413)
        with self.cache.reserve(length) as reservation:
            stream = tempfile.TemporaryFile(mode="w+b", dir=self.spool)
            try:
                digest, remaining = hashlib.sha256(), length
                while remaining:
                    self.check_deadline(request, cancelled)
                    data = os.read(fd, min(1024 * 1024, remaining))
                    if not data:
                        raise Denied("source-changed", 409)
                    stream.write(data)
                    digest.update(data)
                    remaining -= len(data)
                if os.read(fd, 1):
                    raise Denied("source-changed", 409)
                after = os.fstat(fd)
                if source_identity(before) != source_identity(after) or after.st_nlink != 1:
                    raise Denied("source-changed", 409)
                self.check_deadline(request, cancelled)
                stream.flush()
                return reservation.commit(stream, digest.hexdigest(), authority_binding(request), source_identity(after))
            except BaseException:
                stream.close()
                raise
