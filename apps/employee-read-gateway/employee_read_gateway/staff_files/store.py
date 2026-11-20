"""Durable state for staff writes: operations (typed results), uploads and chunks, trash, and the local audit trail.

SQLite with synchronous=FULL: a row is on disk before the filesystem change it describes. Single process only.
"""
from __future__ import annotations

import json
import os
import sqlite3
import stat
import time
from contextlib import contextmanager

from ..errors import Denied

SCHEMA = """
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL, staff_id TEXT NOT NULL,
  grant_id TEXT NOT NULL, grant_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','intent','applied','rejected','unknown')),
  intent TEXT NOT NULL, status INTEGER, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY REFERENCES operations(operation_id), staff_id TEXT NOT NULL, grant_id TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, chunk_size INTEGER NOT NULL, part_inode INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','committing','committed','conflict','expired')),
  lease_until INTEGER NOT NULL, hard_deadline INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (
  upload_id TEXT NOT NULL REFERENCES uploads(upload_id), idx INTEGER NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY (upload_id, idx));
CREATE TABLE IF NOT EXISTS trash (
  trash_id TEXT PRIMARY KEY, original_path TEXT NOT NULL, name TEXT NOT NULL, object_id TEXT NOT NULL,
  deleted_by TEXT NOT NULL, deleted_at INTEGER NOT NULL, restored_by_operation TEXT);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
  staff_id TEXT NOT NULL, phase TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS audit_append_only_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_append_only_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'append-only'); END;
"""

# Uploads whose bytes are still on disk count against quota (purge is off; an expired upload keeps its bytes).
RESERVED_STATES = ("open", "committing", "conflict", "expired")


def dumps(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


class Store:
    def __init__(self, path: str, clock=time.time):
        self.path, self.clock = path, clock
        if os.path.lexists(path):
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() \
                    or stat.S_IMODE(info.st_mode) & 0o077:
                raise Denied("state-unavailable", 503)
        else:
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600))
        db = sqlite3.connect(path, timeout=5)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
        except sqlite3.Error:
            raise Denied("state-unavailable", 503) from None
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        except sqlite3.Error:
            raise Denied("state-unavailable", 503) from None
        finally:
            db.close()

    def audit(self, db, operation_id: str, kind: str, staff_id: str, phase: str, detail) -> None:
        db.execute("INSERT INTO audit(at,operation_id,kind,staff_id,phase,detail) VALUES(?,?,?,?,?,?)",
                   (int(self.clock()), operation_id, kind, staff_id, phase, dumps(detail)))

    def operation(self, db, operation_id: str):
        return db.execute("SELECT * FROM operations WHERE operation_id=?", (operation_id,)).fetchone()

    def holds(self, db) -> int:
        return db.execute("SELECT COUNT(*) FROM operations WHERE state='unknown'").fetchone()[0]

    def finish(self, db, operation_id: str, state: str, status: int, result) -> None:
        db.execute("UPDATE operations SET state=?, status=?, result=?, updated_at=? WHERE operation_id=?",
                   (state, status, dumps(result), int(self.clock()), operation_id))
