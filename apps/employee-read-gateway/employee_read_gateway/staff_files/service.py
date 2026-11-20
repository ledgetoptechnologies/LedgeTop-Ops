"""Staff writes over one exclusive, enrolled root: mkdir, chunked create-only uploads, move/rename, delete to trash,
restore.

Authority arrives already decided by Ops and signed (see signing.py); this module re-checks everything it can locally:
the root pin and exclusivity, the write right, that every affected path lies inside the grant folder, object identity
and content preconditions, Windows name rules and case-insensitive sibling collisions. The signature's freshness is
checked at intake (after the body is read) and again immediately before every irreversible filesystem change.

Coordination: one process owns the root (an exclusive flock a second instance cannot take), and every mutation runs
under one root-wide write lock, so ancestor and descendant changes are serialized. Folder handles opened for a change
are bound to the object ids observed when it was checked.

Durability: each change writes an `intent` operation row (and an audit row) before touching the filesystem. Every
outcome, normal or recovered, goes through one transition (`_settle`) that also applies its upload and trash effects.
A restart settles unfinished rows from filesystem evidence, or marks them `unknown`, which holds all writes until an
operator resolves them; resolution also needs filesystem evidence. Nothing is replayed automatically.

Overwrite is DISABLED in v1: uploads are create-only (no atomic replace with restore evidence yet).
"""
from __future__ import annotations

import errno
import fcntl
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
ROUTE = "/v2/op"
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
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
PATH_KEYS = ("path", "source", "destination")


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


class Expired(Exception):
    """The authorization lapsed at the final boundary, after the intent was recorded but before the syscall."""


def _relative(parts: list[str]) -> str:
    return "/".join(parts)


def _inside(path: str, folder: str, strict: bool) -> bool:
    if folder == "":
        return path != "" if strict else True
    return path.startswith(folder + "/") or (not strict and path == folder)


class StaffFiles:
    def __init__(self, config: Config, clock=time.time):
        self.config, self.clock = config, clock
        self.write_lock = threading.RLock()   # one mutation at a time on the whole root (hierarchy-safe)
        self.committing: set[str] = set()
        self.hash_slots = threading.BoundedSemaphore(2)
        self._fds: list[int] = []
        try:
            self.root_fd = self._keep(open_absolute(config.root_path))
            self.root_stat = linuxfs.statx(self.root_fd)
            expected = fingerprint(config.root_id, config.root_generation, os.fstat(self.root_fd).st_dev, self.root_stat.ino)
            if expected != config.root_fingerprint:
                raise Denied("root-changed", 503)
            self.internal_fd = self._keep(open_absolute(config.internal_path))
            internal = linuxfs.statx(self.internal_fd)
            if internal.dev != self.root_stat.dev or internal.mount_id != self.root_stat.mount_id \
                    or os.path.dirname(config.internal_path) != os.path.dirname(config.root_path) \
                    or internal.uid != os.getuid() or stat.S_IMODE(internal.mode) & 0o077:
                raise Denied("internal-storage-invalid", 503)
            self.uploads_fd = self._keep(self._private_child(self.internal_fd, "uploads"))
            self.trash_fd = self._keep(self._private_child(self.internal_fd, "trash"))
            state_fd = self._keep(self._private_child(self.internal_fd, "state"))
            # Single writer: a second instance (another container or process) cannot take this lock.
            owner = self._keep(os.open("owner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                                       dir_fd=state_fd))
            try:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Denied("root-owned-by-another-instance", 503) from None
            state = os.path.join(config.internal_path, "state")
            self.store = Store(os.path.join(state, "files.sqlite3"), clock)
            self.replay = ReplayStore(os.path.join(state, "nonces.sqlite3"))
            self.reconcile()
        except BaseException:
            self.close()
            raise

    def _keep(self, fd: int) -> int:
        self._fds.append(fd)
        return fd

    def close(self) -> None:
        """Releases the root ownership lock and every held descriptor."""
        while self._fds:
            try:
                os.close(self._fds.pop())
            except OSError:
                pass

    # ---------- filesystem helpers ----------

    def _private_child(self, parent_fd: int, name: str) -> int:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
        fd = os.open(name, DIRECTORY, dir_fd=parent_fd)
        info = linuxfs.statx(fd)
        if info.dev != self.root_stat.dev or info.mount_id != self.root_stat.mount_id \
                or info.uid != os.getuid() or stat.S_IMODE(info.mode) & 0o077:
            os.close(fd)
            raise Denied("internal-storage-invalid", 503)
        return fd

    def _same_fs(self, info: linuxfs.Stat) -> None:
        if info.dev != self.root_stat.dev or info.mount_id != self.root_stat.mount_id:
            raise Rejected("mount-crossing", 403)

    @contextmanager
    def folder(self, parts: list[str], bound: str | None = None):
        """Opens the folder at `parts` below the root, one component at a time, never following symlinks.

        With `bound`, the opened folder must still be the object observed when the change was checked."""
        fd = os.dup(self.root_fd)
        try:
            for part in parts:
                try:
                    next_fd = os.open(part, DIRECTORY, dir_fd=fd)
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
            if bound is not None and linuxfs.statx(fd).object_id != bound:
                raise Rejected("parent-changed", 412)
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

    def _parent_id(self, fd: int, expected_id) -> str:
        if not isinstance(expected_id, str) or not OBJECT_ID.match(expected_id):
            raise Denied("invalid-request")
        actual = linuxfs.statx(fd).object_id
        if actual != expected_id:
            raise Rejected("parent-changed", 412)
        return actual

    # ---------- request validation ----------

    def fresh(self, envelope: dict) -> None:
        """The Ops authorization must still be live: checked at intake and at every irreversible boundary."""
        if int(self.clock()) >= envelope["expiresAt"]:
            raise Denied("expired", 401)

    def final(self, envelope: dict) -> None:
        """Freshness immediately before the irreversible syscall (after the intent is durable and handles reopened)."""
        if int(self.clock()) >= envelope["expiresAt"]:
            raise Expired()

    def validate(self, envelope: dict, body_sha: str) -> dict:
        if set(envelope) != COMMON or envelope["schemaVersion"] != 2 or envelope["method"] != "POST" \
                or envelope["route"] != ROUTE or envelope["audience"] != self.config.audience \
                or envelope["servicePrincipal"] != self.config.client_id \
                or not isinstance(envelope["nonce"], str) or not HEX32.match(envelope["nonce"]) \
                or type(envelope["expiresAt"]) is not int or envelope["bodySha256"] != body_sha:
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
        """Called after the body has been read: the authorization is checked again here (intake)."""
        body_sha = hashlib.sha256(body).hexdigest()
        self.validate(envelope, body_sha)
        self.fresh(envelope)
        self.replay.claim(envelope["keyId"], envelope["nonce"], envelope["expiresAt"], int(self.clock()))
        operation = envelope["operation"]
        if operation == "op.status":
            return self.status_of(envelope)
        if operation.startswith("upload.") and operation != "upload.begin":
            return getattr(self, operation.replace(".", "_"))(envelope, body)
        if body:
            raise Denied("invalid-request")
        digest = self.digest(envelope)
        resume = False
        with self.store.transaction() as db:
            existing = self.store.operation(db, envelope["operationId"])
            if existing is not None:
                if existing["digest"] != digest:
                    raise Denied("operation-conflict", 409)
                if existing["state"] in ("applied", "rejected"):
                    return Result(existing["status"], json.loads(existing["result"]))
                if operation != "upload.begin" or existing["state"] != "open":
                    raise Denied("operation-in-progress" if existing["state"] != "unknown" else "operation-hold", 409)
                resume = True
            elif self.store.holds(db):
                raise Denied("operation-hold", 423)
        if resume:  # identical retry of a reservation: finish creating its staging file if a crash interrupted it
            self._ensure_part(envelope["operationId"], envelope)
            with self.store.transaction() as db:
                return self._upload_status(db, envelope["operationId"])
        if operation == "upload.begin":
            return self.upload_begin(envelope, digest)
        return self.simple(envelope, digest)

    # ---------- outcomes ----------

    def _record(self, db, envelope: dict, digest: str, state: str, intent: dict) -> None:
        now = int(self.clock())
        db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)",
                   (envelope["operationId"], envelope["operation"], digest, envelope["actor"]["staffId"],
                    envelope["grant"]["grantId"], envelope["grant"]["grantGeneration"], envelope["grant"]["path"],
                    state, dumps(intent), now, now))
        self.store.audit(db, envelope["operationId"], envelope["operation"], envelope["actor"]["staffId"], state,
                         {"intent": intent, "accessSubject": envelope["actor"]["accessSubject"],
                          "grantId": envelope["grant"]["grantId"]})

    def _settle(self, db, operation_id: str, outcome: str, status: int | None, body: dict | None, phase: str, detail) -> None:
        """The one durable outcome transition, with its upload and trash effects, for normal and recovered paths.

        outcome: applied | rejected | unknown | open (an upload commit that changed nothing: the upload is open again)
        | withdrawn (a single-step change that provably did not happen, e.g. its authorization lapsed right before the
        syscall: the intent is removed so an identical, freshly signed retry can proceed)."""
        row = self.store.operation(db, operation_id)
        kind, intent = row["kind"], json.loads(row["intent"])
        now = int(self.clock())
        if outcome == "withdrawn":
            db.execute("DELETE FROM operations WHERE operation_id=? AND state='intent'", (operation_id,))
            self.store.audit(db, operation_id, kind, row["staff_id"], phase, detail)
            return
        if kind == "upload.begin":
            upload_state = {"applied": "committed", "rejected": "conflict", "open": "open"}.get(outcome)
            if upload_state:
                db.execute("UPDATE uploads SET state=? WHERE upload_id=?", (upload_state, operation_id))
        if outcome == "applied" and kind == "delete":
            db.execute("INSERT OR IGNORE INTO trash VALUES(?,?,?,?,?,?,NULL)",
                       (intent["trashId"], intent["path"], intent["name"], intent["id"], row["staff_id"], now))
        if outcome == "applied" and kind == "trash.restore":
            db.execute("UPDATE trash SET restored_by_operation=? WHERE trash_id=?", (operation_id, intent["trashId"]))
        if outcome == "open":
            db.execute("UPDATE operations SET state='open', status=NULL, result=NULL, updated_at=? WHERE operation_id=?",
                       (now, operation_id))
        elif outcome == "unknown":
            db.execute("UPDATE operations SET state='unknown', status=NULL, result=NULL, updated_at=? WHERE operation_id=?",
                       (now, operation_id))
        else:
            self.store.finish(db, operation_id, outcome, status, body)
        self.store.audit(db, operation_id, kind, row["staff_id"], phase, detail)

    def _reject_new(self, envelope: dict, digest: str, rejection: Rejected) -> Result:
        body = {"error": rejection.code}
        with self.store.transaction() as db:
            self._record(db, envelope, digest, "rejected", {"refused": rejection.code})
            self.store.finish(db, envelope["operationId"], "rejected", rejection.status, body)
        return Result(rejection.status, body)

    # ---------- single-step operations ----------

    def simple(self, envelope: dict, digest: str) -> Result:
        operation, operation_id = envelope["operation"], envelope["operationId"]
        plan = getattr(self, "plan_" + operation.replace(".", "_"))(envelope, envelope["args"])
        with self.write_lock:
            try:
                intent = plan["check"]()
            except Rejected as rejection:
                return self._reject_new(envelope, digest, rejection)
            self.fresh(envelope)  # before recording; apply checks again right before its syscall
            with self.store.transaction() as db:
                if self.store.holds(db):
                    raise Denied("operation-hold", 423)
                self._record(db, envelope, digest, "intent", intent)
            try:
                result = plan["apply"](intent)  # re-checks freshness immediately before its one syscall
            except Expired:
                with self.store.transaction() as db:
                    self._settle(db, operation_id, "withdrawn", None, None, "expired-no-change", {})
                raise Denied("expired", 401) from None
            except Rejected as rejection:
                # apply refuses only before its single filesystem change, so nothing changed
                with self.store.transaction() as db:
                    self._settle(db, operation_id, "rejected", rejection.status, {"error": rejection.code}, "rejected",
                                 {"error": rejection.code})
                return Result(rejection.status, {"error": rejection.code})
            except BaseException:
                self.reconcile_one(operation_id)
                raise
            body = {"operationId": operation_id, "state": "applied", "result": result}
            with self.store.transaction() as db:
                self._settle(db, operation_id, "applied", 200, body, "applied", result)
            return Result(200, body)

    def plan_mkdir(self, envelope, args):
        parts = self.scoped(envelope, args["path"], strict=True)
        writable_name(parts[-1])

        def check():
            with self.folder(parts[:-1]) as fd:
                parent = self._parent_id(fd, args["parentId"])
                if self.collision(fd, parts[-1]):
                    raise Rejected("name-exists", 409)
            return {"path": _relative(parts), "parentId": parent}

        def apply(intent):
            with self.folder(parts[:-1], bound=intent["parentId"]) as fd:
                self.final(envelope)
                os.mkdir(parts[-1], 0o750, dir_fd=fd)
                linuxfs.fsync_dir(fd)
                info = linuxfs.statx(fd, parts[-1])
            return {"path": intent["path"], "id": info.object_id, "kind": "folder"}

        return {"check": check, "apply": apply}

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
                destination_parent = self._parent_id(dfd, args["destinationParentId"])
                source_parent = linuxfs.statx(sfd).object_id
                same_parent = source_parent == destination_parent
                if self.collision(dfd, destination[-1], allow=source[-1] if same_parent else None):
                    raise Rejected("name-exists", 409)
            return {"source": _relative(source), "destination": _relative(destination), "id": info.object_id,
                    "sourceParentId": source_parent, "destinationParentId": destination_parent}

        def apply(intent):
            with self.folder(source[:-1], bound=intent["sourceParentId"]) as sfd, \
                    self.folder(destination[:-1], bound=intent["destinationParentId"]) as dfd:
                current = self.entry(sfd, source[-1])
                if current is None or current.object_id != intent["id"]:
                    raise Rejected("changed", 412)
                self.final(envelope)
                try:
                    linuxfs.rename_noreplace(sfd, source[-1], dfd, destination[-1])
                except FileExistsError:
                    raise Rejected("name-exists", 409) from None
                linuxfs.fsync_dir(dfd)
                linuxfs.fsync_dir(sfd)
            return {"path": intent["destination"], "id": intent["id"]}

        return {"check": check, "apply": apply}

    def plan_delete(self, envelope, args):
        parts = self.scoped(envelope, args["path"], strict=True)
        trash_id = envelope["operationId"]

        def check():
            with self.folder(parts[:-1]) as fd:
                info = self._source(fd, parts[-1], args["id"], args["etag"])
                parent = linuxfs.statx(fd).object_id
            return {"path": _relative(parts), "name": parts[-1], "id": info.object_id, "trashId": trash_id, "parentId": parent}

        def apply(intent):
            with self.folder(parts[:-1], bound=intent["parentId"]) as fd:
                current = self.entry(fd, parts[-1])
                if current is None or current.object_id != intent["id"]:
                    raise Rejected("changed", 412)
                self.final(envelope)
                os.mkdir(trash_id, 0o700, dir_fd=self.trash_fd)
                holder = os.open(trash_id, DIRECTORY, dir_fd=self.trash_fd)
                try:
                    try:
                        self.final(envelope)  # immediately before the source-to-trash rename
                    except Expired:
                        os.close(holder)
                        holder = -1
                        os.rmdir(trash_id, dir_fd=self.trash_fd)  # the owned, still-empty holder
                        linuxfs.fsync_dir(self.trash_fd)
                        raise
                    linuxfs.rename_noreplace(fd, parts[-1], holder, parts[-1])
                    linuxfs.fsync_dir(fd)
                    linuxfs.fsync_dir(holder)
                    linuxfs.fsync_dir(self.trash_fd)
                finally:
                    if holder >= 0:
                        os.close(holder)
            return {"trashId": trash_id, "path": intent["path"]}

        return {"check": check, "apply": apply}

    def plan_trash_restore(self, envelope, args):
        trash_id = canonical_uuid(args["trashId"])
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM trash WHERE trash_id=?", (trash_id,)).fetchone()
        if row is None or row["restored_by_operation"] is not None:
            raise Denied("not-found", 404)
        parts = self.scoped(envelope, row["original_path"], strict=True)

        def check():
            with self.folder(parts[:-1]) as fd:
                parent = linuxfs.statx(fd).object_id
                if self.collision(fd, parts[-1]):
                    raise Rejected("name-exists", 409)
            if self._stat_in(self.trash_fd, trash_id, row["name"]) is None \
                    or self._stat_in(self.trash_fd, trash_id, row["name"]).object_id != row["object_id"]:
                raise Rejected("changed", 412)
            return {"path": row["original_path"], "name": row["name"], "id": row["object_id"], "trashId": trash_id,
                    "parentId": parent}

        def apply(intent):
            holder = os.open(trash_id, DIRECTORY, dir_fd=self.trash_fd)
            try:
                with self.folder(parts[:-1], bound=intent["parentId"]) as fd:
                    self.final(envelope)
                    try:
                        linuxfs.rename_noreplace(holder, row["name"], fd, parts[-1])
                    except FileExistsError:
                        raise Rejected("name-exists", 409) from None
                    linuxfs.fsync_dir(fd)
                linuxfs.fsync_dir(holder)
            finally:
                os.close(holder)
            try:
                os.rmdir(trash_id, dir_fd=self.trash_fd)
            except OSError:
                pass  # an empty holder left behind is harmless
            return {"path": intent["path"], "id": intent["id"]}

        return {"check": check, "apply": apply}

    # ---------- uploads (create-only in v1) ----------

    def upload_begin(self, envelope: dict, digest: str) -> Result:
        args, limits = envelope["args"], self.config.limits
        parts = self.scoped(envelope, args["path"], strict=True)
        writable_name(parts[-1])
        size = integer(args["size"])
        if size > limits.max_file_bytes:
            raise Denied("too-large", 413)
        if not isinstance(args["sha256"], str) or not HEX64.match(args["sha256"]):
            raise Denied("invalid-request")
        if args["precondition"] != {"kind": "create"}:
            raise Denied("overwrite-unsupported")  # v1: no atomic replace; uploads are create-only
        with self.folder(parts[:-1]) as fd:
            self._parent_id(fd, args["parentId"])
            if self.collision(fd, parts[-1]):
                return self._reject_new(envelope, digest, Rejected("name-exists", 409))
        free = os.statvfs(self.uploads_fd)
        now = int(self.clock())
        operation_id = envelope["operationId"]
        with self.store.transaction() as db:
            if self.store.holds(db):
                raise Denied("operation-hold", 423)
            marks = ",".join("?" * len(RESERVED_STATES))

            def reserved(where="", *values):
                return db.execute(f"SELECT COALESCE(SUM(size),0) FROM uploads WHERE state IN ({marks}) {where}",
                                  (*RESERVED_STATES, *values)).fetchone()[0]

            if db.execute("SELECT COUNT(*) FROM uploads WHERE state='open' AND staff_id=?",
                          (envelope["actor"]["staffId"],)).fetchone()[0] >= limits.sessions_per_staff \
                    or db.execute("SELECT COUNT(*) FROM uploads WHERE state='open'").fetchone()[0] >= limits.sessions_total:
                raise Denied("too-many-uploads", 429)
            if reserved("AND grant_id=?", envelope["grant"]["grantId"]) + size > limits.grant_quota_bytes \
                    or reserved() + size > limits.global_quota_bytes \
                    or free.f_bavail * free.f_frsize - limits.free_margin_bytes < size:
                raise Denied("insufficient-storage", 507)
            # The durable reservation comes first (part_inode 0 = staging file not yet created); only then the file.
            self._record(db, envelope, digest, "open", {"path": _relative(parts), "name": parts[-1], "parentId": args["parentId"]})
            db.execute("INSERT INTO uploads VALUES(?,?,?,?,?,?,0,'open',?,?,NULL)",
                       (operation_id, envelope["actor"]["staffId"], envelope["grant"]["grantId"], size, args["sha256"],
                        limits.chunk_size, now + limits.lease_seconds, now + limits.upload_lifetime_seconds))
        self._ensure_part(operation_id, envelope)
        with self.store.transaction() as db:
            return self._upload_status(db, operation_id)

    def _ensure_part(self, upload_id: str, envelope: dict | None = None) -> None:
        """Creates the staging file of a durable reservation, or adopts the one a crash left behind.

        Runs under the root write lock. The reservation must still be open, without a recorded inode, and inside its
        lease and lifetime; a live request's authorization is re-checked immediately before the create. An existing
        file is opened only non-blocking and without following links, and adopted only when it is a regular,
        single-link, empty file owned by this service on the staging folder's own device and mount. Anything else is
        refused (409) and left in place for reconciliation; nothing is deleted."""
        with self.write_lock:
            with self.store.transaction() as db:
                row = db.execute("SELECT * FROM uploads WHERE upload_id=?", (upload_id,)).fetchone()
                if row is None or row["part_inode"] != 0:
                    return
                if row["state"] != "open":
                    raise Denied("upload-closed", 409)
                now = int(self.clock())
                if now > row["lease_until"] or now > row["hard_deadline"]:
                    db.execute("UPDATE uploads SET state='expired' WHERE upload_id=?", (upload_id,))
                    self.store.audit(db, upload_id, "upload.begin", row["staff_id"], "expired", {"partCreated": False})
                    expired = True
                else:
                    expired = False
            if expired:
                raise Denied("upload-expired", 410)
            if envelope is not None:
                self.fresh(envelope)  # immediately before the live write
            name = upload_id + ".part"
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                             dir_fd=self.uploads_fd)
            except FileExistsError:
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_NOCTTY | os.O_CLOEXEC,
                                 dir_fd=self.uploads_fd)
                except OSError:
                    raise Denied("upload-corrupt", 409) from None  # e.g. a symlink (ELOOP)
                info = linuxfs.statx(fd)
                uploads = linuxfs.statx(self.uploads_fd)
                if not stat.S_ISREG(info.mode) or info.nlink != 1 or info.uid != os.getuid() or info.size != 0 \
                        or info.dev != uploads.dev or info.mount_id != uploads.mount_id:
                    os.close(fd)
                    raise Denied("upload-corrupt", 409)
            try:
                os.fsync(fd)
                inode = linuxfs.statx(fd).ino
            finally:
                os.close(fd)
            linuxfs.fsync_dir(self.uploads_fd)
            with self.store.transaction() as db:
                db.execute("UPDATE uploads SET part_inode=? WHERE upload_id=? AND part_inode=0 AND state='open'",
                           (inode, upload_id))
                self.store.audit(db, upload_id, "upload.begin", row["staff_id"], "staging-file", {"inode": inode})

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
        if (operation["staff_id"], operation["grant_id"], operation["grant_generation"], operation["grant_path"]) != \
                (envelope["actor"]["staffId"], envelope["grant"]["grantId"], envelope["grant"]["grantGeneration"],
                 envelope["grant"]["path"]):
            raise Denied("upload-context-mismatch", 403)
        intent = json.loads(operation["intent"])
        self.scoped(envelope, intent["path"], strict=True)
        now = int(self.clock())
        if upload["state"] == "open" and (now > upload["lease_until"] or now > upload["hard_deadline"]) \
                and upload["upload_id"] not in self.committing:
            db.execute("UPDATE uploads SET state='expired' WHERE upload_id=?", (upload["upload_id"],))
            self.store.audit(db, upload["upload_id"], "upload.begin", upload["staff_id"], "expired", {})
            return operation, dict(upload, state="expired"), intent
        return operation, upload, intent

    def upload_status(self, envelope: dict, body: bytes) -> Result:
        if body:
            raise Denied("invalid-request")
        with self.store.transaction() as db:
            operation, _, _ = self._upload_context(db, envelope)
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
            if upload["state"] != "open" or upload["upload_id"] in self.committing:
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
            self.fresh(envelope)  # before the bytes are written
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
            db.execute("UPDATE uploads SET lease_until=MIN(?, hard_deadline), verified=NULL WHERE upload_id=?",
                       (int(self.clock()) + self.config.limits.lease_seconds, upload["upload_id"]))
            return self._upload_status(db, upload["upload_id"])

    def _verified_sha(self, upload) -> tuple[str, linuxfs.Stat]:
        """The staged file's SHA-256, re-hashed only when the staged bytes may have changed since the last check.

        Hashing a large file outlives any single signature; the result is kept so a freshly signed commit retry is
        short."""
        fd = os.open(upload["upload_id"] + ".part", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.uploads_fd)
        try:
            before = linuxfs.statx(fd)
            if before.ino != upload["part_inode"]:
                raise Denied("upload-corrupt", 409)
            mark = [before.ino, before.size, before.mtime_ns, before.ctime_ns]
            cached = json.loads(upload["verified"]) if upload["verified"] else None
            if cached and cached["mark"] == mark:
                return cached["sha256"], before
            digest = hashlib.sha256()
            with self.hash_slots:
                while chunk := os.read(fd, 4 * 1024 * 1024):
                    digest.update(chunk)
            os.fsync(fd)
            after = linuxfs.statx(fd)
            if [after.ino, after.size, after.mtime_ns, after.ctime_ns] != mark:
                raise Denied("upload-changed", 409)
        finally:
            os.close(fd)
        with self.store.transaction() as db:
            db.execute("UPDATE uploads SET verified=? WHERE upload_id=?",
                       (dumps({"mark": mark, "sha256": digest.hexdigest()}), upload["upload_id"]))
        return digest.hexdigest(), after

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
            if upload["state"] != "open" or operation["state"] != "open" or upload_id in self.committing:
                raise Denied("operation-in-progress", 409)
            count = max(1, -(-upload["size"] // upload["chunk_size"]))
            if db.execute("SELECT COUNT(*) FROM chunks WHERE upload_id=?", (upload_id,)).fetchone()[0] != count:
                raise Denied("upload-incomplete", 409)
            self.committing.add(upload_id)  # in memory only: an interrupted prepare leaves nothing durable behind
        try:
            sha, info = self._verified_sha(upload)     # long: may outlive the signature
            if sha != upload["sha256"] or info.size != upload["size"]:
                with self.store.transaction() as db:
                    self.store.audit(db, upload_id, "upload.commit", envelope["actor"]["staffId"], "refused",
                                     {"error": "checksum-mismatch"})
                return Result(422, {"error": "checksum-mismatch"})
            parts = path_parts(intent["path"])
            with self.write_lock:
                # Everything from here to the durable settlement runs under the root lock: the hold, context and lease
                # checks cannot be overtaken by another mutation turning unknown during the (long) hash above.
                with self.store.transaction() as db:
                    operation, current, _ = self._upload_context(db, envelope)
                    now = int(self.clock())
                    if self.store.holds(db):
                        raise Denied("operation-hold", 423)
                    if operation["state"] != "open" or current["state"] != "open":
                        raise Denied("operation-in-progress", 409)
                    if now > current["lease_until"] or now > current["hard_deadline"]:
                        raise Denied("upload-expired", 410)
                try:
                    with self.folder(parts[:-1]) as pfd:
                        parent = self._parent_id(pfd, intent["parentId"])
                        if self.collision(pfd, parts[-1]):
                            raise Rejected("name-exists", 409)
                except Rejected as rejection:
                    with self.store.transaction() as db:
                        self._settle(db, upload_id, "rejected", rejection.status, {"error": rejection.code}, "rejected",
                                     {"error": rejection.code})
                    return Result(rejection.status, {"error": rejection.code})
                self.fresh(envelope)  # before recording; checked again right before the syscall
                step ={"path": intent["path"], "name": parts[-1], "partInode": info.ino, "parentId": parent}
                with self.store.transaction() as db:
                    db.execute("UPDATE operations SET state='intent', intent=?, updated_at=? WHERE operation_id=?",
                               (dumps(step), int(self.clock()), upload_id))
                    self.store.audit(db, upload_id, "upload.commit", envelope["actor"]["staffId"], "intent", step)
                try:
                    with self.folder(parts[:-1], bound=parent) as pfd:
                        self.final(envelope)  # after the durable intent and the reopen, right before the syscall
                        try:
                            linuxfs.rename_noreplace(self.uploads_fd, upload_id + ".part", pfd, parts[-1])
                        except FileExistsError:
                            raise Rejected("name-exists", 409) from None
                        linuxfs.fsync_dir(pfd)
                        linuxfs.fsync_dir(self.uploads_fd)
                        placed = linuxfs.statx(pfd, parts[-1])
                except Expired:
                    # Known no-change: nothing was placed; the upload is open again for a freshly signed commit.
                    with self.store.transaction() as db:
                        self._settle(db, upload_id, "open", None, None, "expired-no-change", {})
                    raise Denied("expired", 401) from None
                except Rejected as rejection:
                    with self.store.transaction() as db:
                        self._settle(db, upload_id, "rejected", rejection.status, {"error": rejection.code}, "rejected",
                                     {"error": rejection.code})
                    return Result(rejection.status, {"error": rejection.code})
                except BaseException:
                    self.reconcile_one(upload_id)
                    raise
                result = {"operationId": upload_id, "state": "applied",
                          "result": {"path": intent["path"], "id": placed.object_id, "etag": upload["sha256"],
                                     "size": upload["size"]}}
                with self.store.transaction() as db:  # settled before the root lock is released
                    self._settle(db, upload_id, "applied", 200, result, "applied", result["result"])
                return Result(200, result)
        finally:
            self.committing.discard(upload_id)

    # ---------- status and recovery ----------

    def status_of(self, envelope: dict) -> Result:
        target = canonical_uuid(envelope["args"]["targetOperationId"])
        with self.store.transaction() as db:
            row = self.store.operation(db, target)
        not_found = Result(404, {"error": "not-found"})
        if row is None or (row["staff_id"], row["grant_id"], row["grant_generation"]) != \
                (envelope["actor"]["staffId"], envelope["grant"]["grantId"], envelope["grant"]["grantGeneration"]):
            return not_found
        intent = json.loads(row["intent"])
        for key in PATH_KEYS:  # never return a path-bearing result outside the caller's current grant folder
            if key in intent and not _inside(intent[key], envelope["grant"]["path"], strict=True):
                return not_found
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
                fd = os.open(name, DIRECTORY, dir_fd=fd)
                fds.append(fd)
            return linuxfs.statx(fd, names[-1])
        except (FileNotFoundError, NotADirectoryError):
            return None
        finally:
            for fd in fds:
                os.close(fd)

    def decide(self, row) -> tuple[str, dict]:
        """(outcome, evidence) from the filesystem: applied / rejected (open for an upload) / unknown."""
        intent, kind = json.loads(row["intent"]), row["kind"]
        if kind == "mkdir":
            info = self._stat_at(intent["path"])
            exists = info is not None and stat.S_ISDIR(info.mode)
            return ("applied" if exists else "rejected"), {"folderAtPath": exists}
        if kind == "move":
            target, origin = self._stat_at(intent["destination"]), self._stat_at(intent["source"])
            evidence = {"atDestination": bool(target and target.object_id == intent["id"]),
                        "atSource": bool(origin and origin.object_id == intent["id"])}
        elif kind == "delete":
            target, origin = self._stat_in(self.trash_fd, intent["trashId"], intent["name"]), self._stat_at(intent["path"])
            evidence = {"atDestination": bool(target and target.object_id == intent["id"]),
                        "atSource": bool(origin and origin.object_id == intent["id"])}
        elif kind == "trash.restore":
            target, origin = self._stat_at(intent["path"]), self._stat_in(self.trash_fd, intent["trashId"], intent["name"])
            evidence = {"atDestination": bool(target and target.object_id == intent["id"]),
                        "atSource": bool(origin and origin.object_id == intent["id"])}
        elif kind == "upload.begin":
            target, origin = self._stat_at(intent["path"]), self._stat_in(self.uploads_fd, row["operation_id"] + ".part")
            evidence = {"atDestination": bool(target and target.ino == intent["partInode"]),
                        "atSource": bool(origin and origin.ino == intent["partInode"])}
        else:
            return "unknown", {}
        if evidence["atDestination"] and not evidence["atSource"]:
            return "applied", evidence
        if evidence["atSource"] and not evidence["atDestination"]:
            return ("open" if kind == "upload.begin" else "rejected"), evidence
        return "unknown", evidence

    def reconcile_one(self, operation_id: str) -> str:
        with self.store.transaction() as db:
            row = self.store.operation(db, operation_id)
            if row is None or row["state"] != "intent":
                return row["state"] if row is not None else "missing"
            outcome, evidence = self.decide(row)
            body = {"operationId": operation_id, "state": outcome, "reconciled": True}
            status = {"applied": 200, "rejected": 409}.get(outcome)
            self._settle(db, operation_id, outcome, status, body, "reconciled", {"outcome": outcome, "evidence": evidence})
            return outcome

    def reconcile(self) -> dict:
        with self.store.transaction() as db:
            pending = [r["operation_id"] for r in db.execute("SELECT operation_id FROM operations WHERE state='intent'")]
            reserved = [r[0] for r in db.execute("SELECT upload_id FROM uploads WHERE part_inode=0 AND state='open'")]
        for upload_id in reserved:  # only staging files attributable to a durable reservation are created or adopted
            try:
                self._ensure_part(upload_id)
            except Denied:
                pass  # not adoptable: left for an operator; the upload's chunks and commit refuse it
        return {operation_id: self.reconcile_one(operation_id) for operation_id in pending}

    def resolve_hold(self, operation_id: str, decision: str, operator: str) -> None:
        """Settles an `unknown` operation. The filesystem must support the decision:
        if the evidence is now decisive it must agree; otherwise only `rejected` is accepted, and only when the
        object is not at its destination (an operator can never declare a change applied without evidence)."""
        if decision not in ("applied", "rejected"):
            raise ValueError("decision must be applied or rejected")
        with self.store.transaction() as db:
            row = self.store.operation(db, operation_id)
            if row is None or row["state"] != "unknown":
                raise ValueError("operation is not on hold")
            outcome, evidence = self.decide(row)
            normalized = "rejected" if outcome == "open" else outcome
            if normalized != "unknown" and normalized != decision:
                raise ValueError(f"filesystem evidence says {normalized}")
            if normalized == "unknown" and (decision == "applied" or evidence.get("atDestination")):
                raise ValueError("no filesystem evidence for this decision")
            final = "open" if outcome == "open" else decision
            body = {"operationId": operation_id, "state": decision, "resolvedByOperator": True}
            self._settle(db, operation_id, final, 200 if decision == "applied" else 409, body, "operator-resolved",
                         {"decision": decision, "operator": operator, "evidence": evidence})

    def ready(self) -> bool:
        try:
            if linuxfs.statx(self.root_fd).object_id != self.root_stat.object_id:
                return False
            with self.store.transaction() as db:
                return self.store.holds(db) == 0
        except (OSError, Denied):
            return False
