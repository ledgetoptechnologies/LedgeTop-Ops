"""Staff writes over one exclusive, enrolled root: mkdir, chunked uploads, move/rename, delete to trash, restore.

Authority arrives already decided by Ops and signed (see signing.py); this module re-checks everything it can locally:
the root pin and exclusivity, the write right, that every affected path lies inside the grant folder, object identity
and content preconditions, Windows name rules and case-insensitive sibling collisions.

Durability: each change writes an `intent` operation row (and an audit row) before touching the filesystem, then a
typed result. A restart reconciles every unfinished row from filesystem evidence, or marks it `unknown`, which holds
all writes until an operator resolves it. Nothing is replayed automatically.
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import stat
import threading
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field

from ..core import ReplayStore, canonical_uuid, fingerprint, integer, open_absolute, path_parts, text
from ..errors import Denied
from . import linuxfs
from .names import fold, writable_name
from .store import RESERVED_STATES, Store, dumps

HEX64 = re.compile(r"[0-9a-f]{64}\Z")
HEX32 = re.compile(r"[0-9a-f]{32}\Z")
OBJECT_ID = HEX32
EMPTY_SHA = hashlib.sha256(b"").hexdigest()
ROUTE = "/v2/op"
COMMON = {"schemaVersion", "scope", "keyId", "nonce", "issuedAt", "expiresAt", "audience", "servicePrincipal",
          "method", "route", "operationId", "actor", "grant", "root", "operation", "args", "bodySha256"}
ARGS = {
    "mkdir": {"path", "parentId"},
    "upload.begin": {"path", "parentId", "size", "sha256", "precondition"},
    "upload.chunk": {"index", "chunkSha256", "chunkSize"},
    "upload.status": set(),
    "upload.commit": set(),
    "move": {"source", "sourceId", "sourceEtag", "destination", "destinationParentId"},
    "delete": {"path", "id", "etag"},
    "trash.restore": {"trashId"},
    "op.status": {"targetOperationId"},
}
SIMPLE = {"mkdir", "move", "delete", "trash.restore"}


@dataclass(frozen=True)
class Limits:
    chunk_size: int = 32 * 1024 * 1024
    max_file_bytes: int = 50 * 1024**3
    grant_quota_bytes: int = 64 * 1024**3
    global_quota_bytes: int = 256 * 1024**3
    free_margin_bytes: int = 10 * 1024**3
    sessions_per_staff: int = 8
    sessions_total: int = 64
    lease_seconds: int = 900
    upload_lifetime_seconds: int = 86400


@dataclass(frozen=True)
class Config:
    root_id: str
    root_generation: int
    root_fingerprint: str
    root_path: str          # the served folder, e.g. /data/root
    internal_path: str      # its sibling on the same filesystem, e.g. /data/.ltfiles
    audience: str
    client_id: str
    limits: Limits = field(default_factory=Limits)


@dataclass
class Result:
    status: int
    body: dict


class Rejected(Exception):
    """A typed, final refusal of one operation (stored so an identical retry gets the same answer)."""

    def __init__(self, code: str, status: int = 412):
        self.code, self.status = code, status
        super().__init__(code)


def _relative(parts: list[str]) -> str:
    return "/".join(parts)


def _inside(path: str, folder: str, strict: bool) -> bool:
    if folder == "":
        return path != "" if strict else True
    return path.startswith(folder + "/") or (not strict and path == folder)


class StaffFiles:
    def __init__(self, config: Config, clock=time.time):
        self.config, self.clock = config, clock
        self.locks: dict[str, threading.Lock] = {}
        self.locks_guard = threading.Lock()
        self.hash_slots = threading.BoundedSemaphore(2)
        self.root_fd = open_absolute(config.root_path)
        self.root_stat = linuxfs.statx(self.root_fd)
        expected = fingerprint(config.root_id, config.root_generation, os.fstat(self.root_fd).st_dev, self.root_stat.ino)
        if expected != config.root_fingerprint:
            raise Denied("root-changed", 503)
        self.internal_fd = open_absolute(config.internal_path)
        internal = linuxfs.statx(self.internal_fd)
        if internal.dev != self.root_stat.dev or internal.mount_id != self.root_stat.mount_id \
                or os.path.dirname(config.internal_path) != os.path.dirname(config.root_path) \
                or internal.uid != os.getuid() or stat.S_IMODE(internal.mode) & 0o077:
            raise Denied("internal-storage-invalid", 503)
        self.uploads_fd = self._private_child(self.internal_fd, "uploads")
        self.trash_fd = self._private_child(self.internal_fd, "trash")
        state_fd = self._private_child(self.internal_fd, "state")
        os.close(state_fd)
        state = os.path.join(config.internal_path, "state")
        self.store = Store(os.path.join(state, "files.sqlite3"), clock)
        self.replay = ReplayStore(os.path.join(state, "nonces.sqlite3"))
        self.reconcile()

    # ---------- filesystem helpers ----------

    def _private_child(self, parent_fd: int, name: str) -> int:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
        info = linuxfs.statx(fd)
        if info.dev != self.root_stat.dev or info.uid != os.getuid() or stat.S_IMODE(info.mode) & 0o077:
            os.close(fd)
            raise Denied("internal-storage-invalid", 503)
        return fd

    def _same_fs(self, info: linuxfs.Stat) -> None:
        if info.dev != self.root_stat.dev or info.mount_id != self.root_stat.mount_id:
            raise Rejected("mount-crossing", 403)

    @contextmanager
    def folder(self, parts: list[str]):
        """Opens the folder at `parts` below the root, one component at a time, never following symlinks."""
        fd = os.dup(self.root_fd)
        try:
            for part in parts:
                try:
                    next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                except FileNotFoundError:
                    raise Rejected("not-found", 404) from None
                except OSError as error:
                    if error.errno not in (errno.ELOOP, errno.ENOTDIR):
                        raise
                    if stat.S_ISLNK(linuxfs.statx(fd, part).mode):
                        raise Rejected("symlink-refused", 403) from None
                    raise Rejected("not-found", 404) from None
                os.close(fd)
                fd = next_fd
                self._same_fs(linuxfs.statx(fd))
            yield fd
        finally:
            os.close(fd)

    def entry(self, dir_fd: int, name: str) -> linuxfs.Stat | None:
        try:
            info = linuxfs.statx(dir_fd, name)
        except FileNotFoundError:
            return None
        self._same_fs(info)
        if stat.S_ISLNK(info.mode):
            raise Rejected("symlink-refused", 403)
        if not (stat.S_ISREG(info.mode) or stat.S_ISDIR(info.mode)):
            raise Rejected("special-file-refused", 403)
        if stat.S_ISREG(info.mode) and info.nlink != 1:
            raise Rejected("hard-link-refused", 403)
        return info

    def collision(self, dir_fd: int, name: str, allow: str | None = None) -> bool:
        """True when a sibling other than `allow` has the same Windows (case-folded) name."""
        key = fold(name)
        with os.scandir(dir_fd) as entries:
            return any(fold(item.name) == key and item.name != allow for item in entries)

    def content_sha(self, dir_fd: int, name: str, expected: linuxfs.Stat) -> str:
        with self.hash_slots:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
            try:
                if linuxfs.statx(fd).object_id != expected.object_id:
                    raise Rejected("changed", 412)
                digest = hashlib.sha256()
                while chunk := os.read(fd, 4 * 1024 * 1024):
                    digest.update(chunk)
                after = linuxfs.statx(fd)
                if (after.size, after.mtime_ns, after.ctime_ns) != (expected.size, expected.mtime_ns, expected.ctime_ns):
                    raise Rejected("changed", 412)
                return digest.hexdigest()
            finally:
                os.close(fd)

    @contextmanager
    def locked(self, *folders: str):
        with self.locks_guard:
            locks = [self.locks.setdefault(name, threading.Lock()) for name in sorted(set(folders))]
        with ExitStack() as stack:
            for lock in locks:
                stack.enter_context(lock)
            yield

    # ---------- request validation ----------

    def validate(self, envelope: dict, body_sha: str) -> dict:
        if set(envelope) != COMMON or envelope["schemaVersion"] != 2 or envelope["method"] != "POST" \
                or envelope["route"] != ROUTE or envelope["audience"] != self.config.audience \
                or envelope["servicePrincipal"] != self.config.client_id \
                or not isinstance(envelope["nonce"], str) or not HEX32.match(envelope["nonce"]) \
                or envelope["bodySha256"] != body_sha:
            raise Denied("unauthorized", 401)
        canonical_uuid(envelope["operationId"])
        actor, grant, root = envelope["actor"], envelope["grant"], envelope["root"]
        if not isinstance(actor, dict) or set(actor) != {"staffId", "accessSubject", "admissionVersion"} \
                or not isinstance(grant, dict) or set(grant) != {"grantId", "grantGeneration", "path", "rights"} \
                or not isinstance(root, dict) or set(root) != {"rootId", "rootGeneration", "rootFingerprint", "exclusive"}:
            raise Denied("unauthorized", 401)
        text(actor["staffId"]), text(actor["accessSubject"], opaque=True), integer(actor["admissionVersion"], 1)
        canonical_uuid(grant["grantId"]), integer(grant["grantGeneration"], 1)
        if grant["path"] != "":
            path_parts(grant["path"])
        if root != {"rootId": self.config.root_id, "rootGeneration": self.config.root_generation,
                    "rootFingerprint": self.config.root_fingerprint, "exclusive": True}:
            raise Denied("root-mismatch", 403)  # shared (non-exclusive) roots are read-only
        if grant["rights"] != ["read", "write"]:
            raise Denied("write-not-granted", 403)
        operation, args = envelope["operation"], envelope["args"]
        if operation not in ARGS or not isinstance(args, dict) or set(args) != ARGS[operation]:
            raise Denied("invalid-request")
        return envelope

    def digest(self, envelope: dict) -> str:
        grant = envelope["grant"]
        material = {"operation": envelope["operation"], "actor": envelope["actor"], "args": envelope["args"],
                    "grant": {"grantId": grant["grantId"], "grantGeneration": grant["grantGeneration"], "path": grant["path"]},
                    "root": {"rootId": self.config.root_id, "rootGeneration": self.config.root_generation}}
        return hashlib.sha256(dumps(material).encode("utf-8")).hexdigest()

    def scoped(self, envelope: dict, path: str, *, strict: bool, allow_empty=False) -> list[str]:
        parts = path_parts(path, allow_empty=allow_empty)
        if not _inside(_relative(parts), envelope["grant"]["path"], strict):
            raise Denied("outside-grant", 403)
        return parts

    # ---------- entry point ----------

    def execute(self, envelope: dict, body: bytes) -> Result:
        body_sha = hashlib.sha256(body).hexdigest()
        self.validate(envelope, body_sha)
        self.replay.claim(envelope["keyId"], envelope["nonce"], envelope["expiresAt"], int(self.clock()))
        operation = envelope["operation"]
        if operation == "op.status":
            return self.status_of(envelope)
        if operation.startswith("upload.") and operation != "upload.begin":
            return getattr(self, operation.replace(".", "_"))(envelope, body)
        if operation != "upload.chunk" and body:
            raise Denied("invalid-request")
        digest = self.digest(envelope)
        with self.store.transaction() as db:
            existing = self.store.operation(db, envelope["operationId"])
            if existing is not None:
                if existing["digest"] != digest:
                    raise Denied("operation-conflict", 409)
                if existing["state"] in ("applied", "rejected"):
                    return Result(existing["status"], json.loads(existing["result"]))
                if operation == "upload.begin" and existing["state"] == "open":
                    return self._upload_status(db, envelope["operationId"])
                raise Denied("operation-in-progress" if existing["state"] != "unknown" else "operation-hold", 409)
            if self.store.holds(db):
                raise Denied("operation-hold", 423)
        if operation == "upload.begin":
            return self.upload_begin(envelope, digest)
        return self.simple(envelope, digest)

    # ---------- single-step operations ----------

    def simple(self, envelope: dict, digest: str) -> Result:
        operation, args = envelope["operation"], envelope["args"]
        plan = getattr(self, "plan_" + operation.replace(".", "_"))(envelope, args)
        with self.locked(*plan["locks"]):
            try:
                intent = plan["check"]()
            except Rejected as rejection:
                return self._reject_new(envelope, digest, rejection)
            with self.store.transaction() as db:
                if self.store.holds(db):
                    raise Denied("operation-hold", 423)
                self._record(db, envelope, digest, "intent", intent)
            try:
                result = plan["apply"](intent)
            except Rejected as rejection:
                with self.store.transaction() as db:
                    self.store.finish(db, envelope["operationId"], "rejected", rejection.status, {"error": rejection.code})
                    self.store.audit(db, envelope["operationId"], operation, envelope["actor"]["staffId"], "rejected",
                                     {"error": rejection.code})
                return Result(rejection.status, {"error": rejection.code})
            except BaseException:
                self.reconcile_one(envelope["operationId"])
                raise
            with self.store.transaction() as db:
                body = {"operationId": envelope["operationId"], "state": "applied", "result": result}
                self.store.finish(db, envelope["operationId"], "applied", 200, body)
                self.store.audit(db, envelope["operationId"], operation, envelope["actor"]["staffId"], "applied", result)
            return Result(200, body)

    def _record(self, db, envelope: dict, digest: str, state: str, intent: dict) -> None:
        now = int(self.clock())
        db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?,?)",
                   (envelope["operationId"], envelope["operation"], digest, envelope["actor"]["staffId"],
                    envelope["grant"]["grantId"], envelope["grant"]["grantGeneration"], state, dumps(intent), now, now))
        self.store.audit(db, envelope["operationId"], envelope["operation"], envelope["actor"]["staffId"], state,
                         {"intent": intent, "accessSubject": envelope["actor"]["accessSubject"],
                          "grantId": envelope["grant"]["grantId"]})

    def _reject_new(self, envelope: dict, digest: str, rejection: Rejected) -> Result:
        body = {"error": rejection.code}
        with self.store.transaction() as db:
            self._record(db, envelope, digest, "rejected", {"refused": rejection.code})
            self.store.finish(db, envelope["operationId"], "rejected", rejection.status, body)
        return Result(rejection.status, body)

    def _parent_checked(self, fd: int, expected_id) -> None:
        if not isinstance(expected_id, str) or not OBJECT_ID.match(expected_id):
            raise Denied("invalid-request")
        if linuxfs.statx(fd).object_id != expected_id:
            raise Rejected("parent-changed", 412)

    def plan_mkdir(self, envelope, args):
        parts = self.scoped(envelope, args["path"], strict=True)
        writable_name(parts[-1])
        parent = _relative(parts[:-1])

        def check():
            with self.folder(parts[:-1]) as fd:
                self._parent_checked(fd, args["parentId"])
                if self.collision(fd, parts[-1]):
                    raise Rejected("name-exists", 409)
            return {"path": _relative(parts)}

        def apply(intent):
            with self.folder(parts[:-1]) as fd:
                os.mkdir(parts[-1], 0o750, dir_fd=fd)
                linuxfs.fsync_dir(fd)
                info = linuxfs.statx(fd, parts[-1])
            return {"path": intent["path"], "id": info.object_id, "kind": "folder"}

        return {"locks": [parent], "check": check, "apply": apply}

    def _source(self, fd: int, name: str, expected_id, expected_etag):
        info = self.entry(fd, name)
        if info is None:
            raise Rejected("not-found", 404)
        if not isinstance(expected_id, str) or not OBJECT_ID.match(expected_id):
            raise Denied("invalid-request")
        if info.object_id != expected_id:
            raise Rejected("changed", 412)
        if stat.S_ISREG(info.mode):
            if not isinstance(expected_etag, str) or not HEX64.match(expected_etag):
                raise Denied("invalid-request")
            if self.content_sha(fd, name, info) != expected_etag:
                raise Rejected("changed", 412)
        elif expected_etag is not None:
            raise Denied("invalid-request")
        return info

    def plan_move(self, envelope, args):
        source = self.scoped(envelope, args["source"], strict=True)
        destination = self.scoped(envelope, args["destination"], strict=True)
        writable_name(destination[-1])
        if _relative(destination) == _relative(source) or _relative(destination).startswith(_relative(source) + "/"):
            raise Denied("invalid-move", 409)

        def check():
            with self.folder(source[:-1]) as sfd, self.folder(destination[:-1]) as dfd:
                info = self._source(sfd, source[-1], args["sourceId"], args["sourceEtag"])
                self._parent_checked(dfd, args["destinationParentId"])
                same_parent = linuxfs.statx(sfd).object_id == linuxfs.statx(dfd).object_id
                if self.collision(dfd, destination[-1], allow=source[-1] if same_parent else None):
                    raise Rejected("name-exists", 409)
            return {"source": _relative(source), "destination": _relative(destination), "id": info.object_id}

        def apply(intent):
            with self.folder(source[:-1]) as sfd, self.folder(destination[:-1]) as dfd:
                current = self.entry(sfd, source[-1])
                if current is None or current.object_id != intent["id"]:
                    raise Rejected("changed", 412)
                try:
                    linuxfs.rename_noreplace(sfd, source[-1], dfd, destination[-1])
                except FileExistsError:
                    raise Rejected("name-exists", 409) from None
                linuxfs.fsync_dir(dfd)
                linuxfs.fsync_dir(sfd)
            return {"path": intent["destination"], "id": intent["id"]}

        return {"locks": [_relative(source[:-1]), _relative(destination[:-1])], "check": check, "apply": apply}

    def plan_delete(self, envelope, args):
        parts = self.scoped(envelope, args["path"], strict=True)
        trash_id = envelope["operationId"]

        def check():
            with self.folder(parts[:-1]) as fd:
                info = self._source(fd, parts[-1], args["id"], args["etag"])
            return {"path": _relative(parts), "name": parts[-1], "id": info.object_id, "trashId": trash_id}

        def apply(intent):
            os.mkdir(trash_id, 0o700, dir_fd=self.trash_fd)
            holder = os.open(trash_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.trash_fd)
            try:
                with self.folder(parts[:-1]) as fd:
                    linuxfs.rename_noreplace(fd, parts[-1], holder, parts[-1])
                    linuxfs.fsync_dir(fd)
                linuxfs.fsync_dir(holder)
                linuxfs.fsync_dir(self.trash_fd)
            finally:
                os.close(holder)
            with self.store.transaction() as db:
                db.execute("INSERT INTO trash VALUES(?,?,?,?,?,?,NULL)", (trash_id, intent["path"], parts[-1], intent["id"],
                                                                         envelope["actor"]["staffId"], int(self.clock())))
            return {"trashId": trash_id, "path": intent["path"]}

        return {"locks": [_relative(parts[:-1])], "check": check, "apply": apply}

    def plan_trash_restore(self, envelope, args):
        trash_id = canonical_uuid(args["trashId"])
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM trash WHERE trash_id=?", (trash_id,)).fetchone()
        if row is None or row["restored_by_operation"] is not None:
            raise Denied("not-found", 404)
        parts = self.scoped(envelope, row["original_path"], strict=True)

        def check():
            with self.folder(parts[:-1]) as fd:
                if self.collision(fd, parts[-1]):
                    raise Rejected("name-exists", 409)
            holder = os.open(trash_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.trash_fd)
            try:
                info = linuxfs.statx(holder, row["name"])
            finally:
                os.close(holder)
            if info.object_id != row["object_id"]:
                raise Rejected("changed", 412)
            return {"path": row["original_path"], "name": row["name"], "id": row["object_id"], "trashId": trash_id}

        def apply(intent):
            holder = os.open(trash_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.trash_fd)
            try:
                with self.folder(parts[:-1]) as fd:
                    try:
                        linuxfs.rename_noreplace(holder, row["name"], fd, parts[-1])
                    except FileExistsError:
                        raise Rejected("name-exists", 409) from None
                    linuxfs.fsync_dir(fd)
                linuxfs.fsync_dir(holder)
            finally:
                os.close(holder)
            os.rmdir(trash_id, dir_fd=self.trash_fd)
            with self.store.transaction() as db:
                db.execute("UPDATE trash SET restored_by_operation=? WHERE trash_id=?", (envelope["operationId"], trash_id))
            return {"path": intent["path"], "id": intent["id"]}

        return {"locks": [_relative(parts[:-1])], "check": check, "apply": apply}

    # ---------- uploads ----------

    def upload_begin(self, envelope: dict, digest: str) -> Result:
        args, limits = envelope["args"], self.config.limits
        parts = self.scoped(envelope, args["path"], strict=True)
        writable_name(parts[-1])
        size = integer(args["size"])
        if size > limits.max_file_bytes:
            raise Denied("too-large", 413)
        if not isinstance(args["sha256"], str) or not HEX64.match(args["sha256"]):
            raise Denied("invalid-request")
        precondition = args["precondition"]
        if precondition == {"kind": "create"}:
            replace = None
        elif isinstance(precondition, dict) and set(precondition) == {"kind", "id", "etag"} and precondition["kind"] == "replace" \
                and isinstance(precondition["id"], str) and OBJECT_ID.match(precondition["id"]) \
                and isinstance(precondition["etag"], str) and HEX64.match(precondition["etag"]):
            replace = precondition
        else:
            raise Denied("invalid-request")
        with self.folder(parts[:-1]) as fd:
            self._parent_checked(fd, args["parentId"])
            current = self.entry(fd, parts[-1])
            if replace is None and self.collision(fd, parts[-1]):
                return self._reject_new(envelope, digest, Rejected("name-exists", 409))
            if replace is not None and (current is None or not stat.S_ISREG(current.mode) or current.object_id != replace["id"]):
                return self._reject_new(envelope, digest, Rejected("changed", 412))
        free = os.statvfs(self.uploads_fd)
        now = int(self.clock())
        operation_id = envelope["operationId"]
        with self.store.transaction() as db:
            if self.store.holds(db):
                raise Denied("operation-hold", 423)
            marks = ",".join("?" * len(RESERVED_STATES))
            reserved = lambda where, *values: db.execute(  # noqa: E731
                f"SELECT COALESCE(SUM(size),0) FROM uploads WHERE state IN ({marks}) {where}", (*RESERVED_STATES, *values)).fetchone()[0]
            if db.execute("SELECT COUNT(*) FROM uploads WHERE state='open' AND staff_id=?", (envelope["actor"]["staffId"],)).fetchone()[0] \
                    >= limits.sessions_per_staff or \
                    db.execute("SELECT COUNT(*) FROM uploads WHERE state='open'").fetchone()[0] >= limits.sessions_total:
                raise Denied("too-many-uploads", 429)
            total = reserved("")
            if reserved("AND grant_id=?", envelope["grant"]["grantId"]) + size > limits.grant_quota_bytes \
                    or total + size > limits.global_quota_bytes \
                    or free.f_bavail * free.f_frsize - limits.free_margin_bytes < size:
                raise Denied("insufficient-storage", 507)
            part = operation_id + ".part"
            fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.uploads_fd)
            try:
                os.fsync(fd)
                inode = linuxfs.statx(fd).ino
            finally:
                os.close(fd)
            linuxfs.fsync_dir(self.uploads_fd)
            intent = {"path": _relative(parts), "name": parts[-1], "parentId": args["parentId"], "replace": replace}
            self._record(db, envelope, digest, "open", intent)
            db.execute("INSERT INTO uploads VALUES(?,?,?,?,?,?,?,'open',?,?)",
                       (operation_id, envelope["actor"]["staffId"], envelope["grant"]["grantId"], size, args["sha256"],
                        limits.chunk_size, inode, now + limits.lease_seconds, now + limits.upload_lifetime_seconds))
            return self._upload_status(db, operation_id)

    def _upload_status(self, db, upload_id: str) -> Result:
        row = db.execute("SELECT * FROM uploads WHERE upload_id=?", (upload_id,)).fetchone()
        received = [r[0] for r in db.execute("SELECT idx FROM chunks WHERE upload_id=? ORDER BY idx", (upload_id,))]
        count = max(1, -(-row["size"] // row["chunk_size"]))
        return Result(200, {"operationId": upload_id, "state": row["state"], "chunkSize": row["chunk_size"],
                            "chunkCount": count, "received": received, "leaseUntil": row["lease_until"]})

    def _upload_context(self, db, envelope: dict):
        operation = self.store.operation(db, envelope["operationId"])
        upload = db.execute("SELECT * FROM uploads WHERE upload_id=?", (envelope["operationId"],)).fetchone()
        if operation is None or upload is None or operation["kind"] != "upload.begin":
            raise Denied("not-found", 404)
        if (operation["staff_id"], operation["grant_id"], operation["grant_generation"]) != \
                (envelope["actor"]["staffId"], envelope["grant"]["grantId"], envelope["grant"]["grantGeneration"]):
            raise Denied("upload-context-mismatch", 403)
        intent = json.loads(operation["intent"])
        self.scoped(envelope, intent["path"], strict=True)
        now = int(self.clock())
        if upload["state"] == "open" and (now > upload["lease_until"] or now > upload["hard_deadline"]):
            db.execute("UPDATE uploads SET state='expired' WHERE upload_id=?", (upload["upload_id"],))
            self.store.audit(db, upload["upload_id"], "upload.begin", upload["staff_id"], "expired", {})
            return operation, dict(upload, state="expired"), intent
        return operation, upload, intent

    def upload_status(self, envelope: dict, body: bytes) -> Result:
        if body:
            raise Denied("invalid-request")
        with self.store.transaction() as db:
            operation, upload, _ = self._upload_context(db, envelope)
            if operation["state"] in ("applied", "rejected"):
                return Result(operation["status"], json.loads(operation["result"]))
            return self._upload_status(db, envelope["operationId"])

    def upload_chunk(self, envelope: dict, body: bytes) -> Result:
        args = envelope["args"]
        index, size = integer(args["index"]), integer(args["chunkSize"], 1)
        if not isinstance(args["chunkSha256"], str) or args["chunkSha256"] != envelope["bodySha256"] or len(body) != size:
            raise Denied("invalid-request")
        with self.store.transaction() as db:
            _, upload, _ = self._upload_context(db, envelope)
            if upload["state"] == "expired":
                raise Denied("upload-expired", 410)
            if upload["state"] != "open":
                raise Denied("upload-closed", 409)
            count = max(1, -(-upload["size"] // upload["chunk_size"]))
            expected = upload["size"] - index * upload["chunk_size"] if index == count - 1 else upload["chunk_size"]
            if index >= count or size != expected:
                raise Denied("invalid-chunk", 413 if size > upload["chunk_size"] else 400)
            existing = db.execute("SELECT sha256 FROM chunks WHERE upload_id=? AND idx=?", (upload["upload_id"], index)).fetchone()
            if existing is not None:
                if existing[0] != args["chunkSha256"]:
                    raise Denied("chunk-conflict", 409)
                return self._upload_status(db, upload["upload_id"])
            fd = os.open(upload["upload_id"] + ".part", os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.uploads_fd)
            try:
                if linuxfs.statx(fd).ino != upload["part_inode"]:
                    raise Denied("upload-corrupt", 409)
                offset, view = index * upload["chunk_size"], memoryview(body)
                while view:
                    written = os.pwrite(fd, view, offset)
                    offset, view = offset + written, view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            db.execute("INSERT INTO chunks VALUES(?,?,?)", (upload["upload_id"], index, args["chunkSha256"]))
            db.execute("UPDATE uploads SET lease_until=MIN(?, hard_deadline) WHERE upload_id=?",
                       (int(self.clock()) + self.config.limits.lease_seconds, upload["upload_id"]))
            return self._upload_status(db, upload["upload_id"])

    def upload_commit(self, envelope: dict, body: bytes) -> Result:
        if body:
            raise Denied("invalid-request")
        upload_id = envelope["operationId"]
        with self.store.transaction() as db:
            operation, upload, intent = self._upload_context(db, envelope)
            if operation["state"] in ("applied", "rejected"):
                return Result(operation["status"], json.loads(operation["result"]))
            if self.store.holds(db):
                raise Denied("operation-hold", 423)
            if upload["state"] == "expired":
                raise Denied("upload-expired", 410)
            if upload["state"] != "open":
                raise Denied("operation-in-progress", 409)
            count = max(1, -(-upload["size"] // upload["chunk_size"]))
            if db.execute("SELECT COUNT(*) FROM chunks WHERE upload_id=?", (upload_id,)).fetchone()[0] != count:
                raise Denied("upload-incomplete", 409)
            db.execute("UPDATE uploads SET state='committing' WHERE upload_id=?", (upload_id,))
        part = upload_id + ".part"
        fd = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.uploads_fd)
        try:
            digest = hashlib.sha256()
            with self.hash_slots:
                while chunk := os.read(fd, 4 * 1024 * 1024):
                    digest.update(chunk)
            info = linuxfs.statx(fd)
            os.fsync(fd)
        finally:
            os.close(fd)
        if digest.hexdigest() != upload["sha256"] or info.size != upload["size"]:
            return self._commit_rejected(envelope, Rejected("checksum-mismatch", 422), "open")
        parts = path_parts(intent["path"])
        with self.locked(_relative(parts[:-1])):
            try:
                with self.folder(parts[:-1]) as pfd:
                    self._parent_checked(pfd, intent["parentId"])
                    replace = intent["replace"]
                    if replace is None:
                        if self.collision(pfd, parts[-1]):
                            raise Rejected("name-exists", 409)
                    else:
                        current = self.entry(pfd, parts[-1])
                        if current is None or not stat.S_ISREG(current.mode) or current.object_id != replace["id"] \
                                or self.content_sha(pfd, parts[-1], current) != replace["etag"]:
                            raise Rejected("changed", 412)
            except Rejected as rejection:
                return self._commit_rejected(envelope, rejection, "conflict")
            step = {"path": intent["path"], "name": parts[-1], "partInode": info.ino,
                    "oldId": None if intent["replace"] is None else intent["replace"]["id"], "trashId": upload_id}
            with self.store.transaction() as db:
                db.execute("UPDATE operations SET state='intent', intent=?, updated_at=? WHERE operation_id=?",
                           (dumps(step), int(self.clock()), upload_id))
                self.store.audit(db, upload_id, "upload.commit", envelope["actor"]["staffId"], "intent", step)
            try:
                with self.folder(parts[:-1]) as pfd:
                    if step["oldId"] is not None:
                        os.mkdir(upload_id, 0o700, dir_fd=self.trash_fd)
                        holder = os.open(upload_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.trash_fd)
                        try:
                            linuxfs.rename_noreplace(pfd, parts[-1], holder, parts[-1])
                            linuxfs.fsync_dir(holder)
                        finally:
                            os.close(holder)
                        with self.store.transaction() as db:
                            db.execute("INSERT INTO trash VALUES(?,?,?,?,?,?,NULL)", (upload_id, intent["path"], parts[-1], step["oldId"],
                                                                                     envelope["actor"]["staffId"], int(self.clock())))
                    linuxfs.rename_noreplace(self.uploads_fd, part, pfd, parts[-1])
                    linuxfs.fsync_dir(pfd)
                    linuxfs.fsync_dir(self.uploads_fd)
                    placed = linuxfs.statx(pfd, parts[-1])
            except BaseException:
                self.reconcile_one(upload_id)
                raise
        result = {"operationId": upload_id, "state": "applied",
                  "result": {"path": intent["path"], "id": placed.object_id, "etag": upload["sha256"], "size": upload["size"],
                             "replacedTrashId": upload_id if step["oldId"] else None}}
        with self.store.transaction() as db:
            self.store.finish(db, upload_id, "applied", 200, result)
            db.execute("UPDATE uploads SET state='committed' WHERE upload_id=?", (upload_id,))
            self.store.audit(db, upload_id, "upload.commit", envelope["actor"]["staffId"], "applied", result["result"])
        return Result(200, result)

    def _commit_rejected(self, envelope: dict, rejection: Rejected, upload_state: str) -> Result:
        body = {"error": rejection.code}
        with self.store.transaction() as db:
            if upload_state == "open":
                db.execute("UPDATE uploads SET state='open' WHERE upload_id=?", (envelope["operationId"],))
                self.store.audit(db, envelope["operationId"], "upload.commit", envelope["actor"]["staffId"], "refused", body)
            else:
                # The bytes stay in staging (never purged automatically); the app keeps its local conflict copy.
                db.execute("UPDATE uploads SET state='conflict' WHERE upload_id=?", (envelope["operationId"],))
                self.store.finish(db, envelope["operationId"], "rejected", rejection.status, body)
                self.store.audit(db, envelope["operationId"], "upload.commit", envelope["actor"]["staffId"], "rejected", body)
        return Result(rejection.status, body)

    # ---------- status and recovery ----------

    def status_of(self, envelope: dict) -> Result:
        target = canonical_uuid(envelope["args"]["targetOperationId"])
        with self.store.transaction() as db:
            row = self.store.operation(db, target)
        if row is None or (row["staff_id"], row["grant_id"]) != (envelope["actor"]["staffId"], envelope["grant"]["grantId"]):
            return Result(404, {"error": "not-found"})
        body = {"operationId": target, "state": row["state"]}
        if row["result"] is not None:
            body["status"], body["result"] = row["status"], json.loads(row["result"])
        return Result(200, body)

    def _stat_at(self, path: str) -> linuxfs.Stat | None:
        parts = path_parts(path)
        try:
            with self.folder(parts[:-1]) as fd:
                return linuxfs.statx(fd, parts[-1])
        except (Rejected, FileNotFoundError, NotADirectoryError):
            return None

    def _stat_in(self, dir_fd: int, *names: str) -> linuxfs.Stat | None:
        fds = []
        try:
            fd = dir_fd
            for name in names[:-1]:
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                fds.append(fd)
            return linuxfs.statx(fd, names[-1])
        except (FileNotFoundError, NotADirectoryError):
            return None
        finally:
            for fd in fds:
                os.close(fd)

    def decide(self, row) -> str:
        """applied / rejected from filesystem evidence, or unknown when the evidence cannot tell."""
        intent = json.loads(row["intent"])
        kind = row["kind"]
        if kind == "mkdir":
            info = self._stat_at(intent["path"])
            return "applied" if info is not None and stat.S_ISDIR(info.mode) else "rejected"
        if kind == "move":
            at_destination, at_source = self._stat_at(intent["destination"]), self._stat_at(intent["source"])
            if at_destination is not None and at_destination.object_id == intent["id"]:
                return "applied"
            return "rejected" if at_source is not None and at_source.object_id == intent["id"] else "unknown"
        if kind == "delete":
            in_trash, at_path = self._stat_in(self.trash_fd, intent["trashId"], intent["name"]), self._stat_at(intent["path"])
            if in_trash is not None and in_trash.object_id == intent["id"]:
                return "applied"
            return "rejected" if at_path is not None and at_path.object_id == intent["id"] else "unknown"
        if kind == "trash.restore":
            at_path, in_trash = self._stat_at(intent["path"]), self._stat_in(self.trash_fd, intent["trashId"], intent["name"])
            if at_path is not None and at_path.object_id == intent["id"]:
                return "applied"
            return "rejected" if in_trash is not None and in_trash.object_id == intent["id"] else "unknown"
        if kind == "upload.begin":
            placed = self._stat_at(intent["path"])
            part = self._stat_in(self.uploads_fd, row["operation_id"] + ".part")
            if placed is not None and placed.ino == intent["partInode"]:
                return "applied"
            old_in_place = intent["oldId"] is None or (placed is not None and placed.object_id == intent["oldId"])
            return "rejected" if part is not None and part.ino == intent["partInode"] and old_in_place else "unknown"
        return "unknown"

    def reconcile_one(self, operation_id: str) -> str:
        with self.store.transaction() as db:
            row = self.store.operation(db, operation_id)
            if row is None or row["state"] != "intent":
                return row["state"] if row is not None else "missing"
            decision = self.decide(row)
            intent = json.loads(row["intent"])
            if decision == "applied" and (row["kind"] == "delete" or (row["kind"] == "upload.begin" and intent.get("oldId"))):
                # The trash record is written after the move; make sure a restorable record exists.
                db.execute("INSERT OR IGNORE INTO trash VALUES(?,?,?,?,?,?,NULL)",
                           (intent["trashId"], intent["path"], intent["name"], intent.get("id") or intent["oldId"],
                            row["staff_id"], int(self.clock())))
            if decision == "applied" and row["kind"] == "trash.restore":
                db.execute("UPDATE trash SET restored_by_operation=? WHERE trash_id=?", (operation_id, intent["trashId"]))
            if decision == "applied" and row["kind"] == "upload.begin":
                db.execute("UPDATE uploads SET state='committed' WHERE upload_id=?", (operation_id,))
            elif decision == "rejected" and row["kind"] == "upload.begin":
                # Nothing moved: the upload is open again and an identical commit may be retried.
                db.execute("UPDATE operations SET state='open', updated_at=? WHERE operation_id=?", (int(self.clock()), operation_id))
                db.execute("UPDATE uploads SET state='open' WHERE upload_id=?", (operation_id,))
                self.store.audit(db, operation_id, row["kind"], row["staff_id"], "reconciled", {"decision": "not-applied"})
                return "open"
            body = {"operationId": operation_id, "state": decision, "reconciled": True}
            self.store.finish(db, operation_id, decision, {"applied": 200, "rejected": 409, "unknown": 409}[decision], body)
            if decision == "unknown":
                db.execute("UPDATE operations SET result=NULL, status=NULL WHERE operation_id=?", (operation_id,))
            self.store.audit(db, operation_id, row["kind"], row["staff_id"], "reconciled", {"decision": decision})
            return decision

    def reconcile(self) -> dict:
        with self.store.transaction() as db:
            pending = [r["operation_id"] for r in db.execute("SELECT operation_id FROM operations WHERE state='intent'")]
            db.execute("UPDATE uploads SET state='open' WHERE state='committing' AND upload_id IN "
                       "(SELECT operation_id FROM operations WHERE state='open')")
        return {operation_id: self.reconcile_one(operation_id) for operation_id in pending}

    def resolve_hold(self, operation_id: str, decision: str, operator: str) -> None:
        if decision not in ("applied", "rejected"):
            raise ValueError("decision must be applied or rejected")
        with self.store.transaction() as db:
            row = self.store.operation(db, operation_id)
            if row is None or row["state"] != "unknown":
                raise ValueError("operation is not on hold")
            self.store.finish(db, operation_id, decision, 200 if decision == "applied" else 409,
                              {"operationId": operation_id, "state": decision, "resolvedByOperator": True})
            self.store.audit(db, operation_id, row["kind"], row["staff_id"], "operator-resolved", {"decision": decision, "operator": operator})

    def ready(self) -> bool:
        try:
            if linuxfs.statx(self.root_fd).object_id != self.root_stat.object_id:
                return False
            with self.store.transaction() as db:
                return self.store.holds(db) == 0
        except (OSError, Denied):
            return False
