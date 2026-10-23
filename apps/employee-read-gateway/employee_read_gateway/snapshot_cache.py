"""Bounded ephemeral immutable copies, independent pread readers, no path-based reopening."""
from __future__ import annotations

import collections
import hmac
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass

from .errors import Denied

BINDING = ("gatewayId", "rootId", "rootGeneration", "rootFingerprint", "staffId", "accessSubject",
           "admissionVersion", "profileVersion", "grantId", "grantGeneration", "path", "_keyId")


def authority_binding(request):
    return tuple(request[key] for key in BINDING)


def source_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


@dataclass
class Entry:
    snapshot_id: str
    stream: object
    length: int
    sha256: str
    binding: tuple
    source: tuple
    expires_at: int
    monotonic_expiry: float
    readers: int = 0
    expired: bool = False
    timer: object = None


class SnapshotLease:
    """A lease never shares or mutates the underlying descriptor's file position."""
    def __init__(self, cache, entry, deadline, check):
        self.cache, self.entry, self.deadline, self.check = cache, entry, deadline, check
        self.length, self.sha256, self.source = entry.length, entry.sha256, entry.source
        self.start, self.end, self.closed = 0, entry.length - 1, False
        self.lock = threading.Lock()
        self.timer = threading.Timer(max(0, min(deadline, entry.monotonic_expiry) - time.monotonic()), self.close)
        self.timer.daemon = True

    def chunks(self, cancelled=lambda: False):
        try:
            offset, remaining = self.start, max(0, self.end - self.start + 1)
            while remaining:
                self.check()
                with self.lock:
                    if self.closed or cancelled() or time.monotonic() >= min(self.deadline, self.entry.monotonic_expiry):
                        raise Denied("request-cancelled", 408)
                    # close() cannot release this reader and permit fd eviction until pread returns.
                    data = os.pread(self.entry.stream.fileno(), min(1024 * 1024, remaining), offset)
                # A blocked syscall may return after the signed deadline or TTL. Do not
                # hand even that completed chunk to the transport after its lease expires.
                self.check()
                with self.lock:
                    if self.closed or cancelled() or time.monotonic() >= min(self.deadline, self.entry.monotonic_expiry):
                        raise Denied("request-cancelled", 408)
                if not data:
                    raise Denied("snapshot-unavailable", 503)
                offset += len(data)
                remaining -= len(data)
                yield data
        finally:
            self.close()

    def close(self):
        with self.lock:
            if not self.closed:
                self.closed = True
                self.timer.cancel()
                self.cache.release(self.entry)


class Reservation:
    def __init__(self, cache, length):
        self.cache, self.length, self.finished = cache, length, False

    def commit(self, stream, digest, binding, source):
        with self.cache.lock:
            if self.finished or self.cache.closed:
                raise Denied("snapshot-cache-unavailable", 503)
            now = self.cache.clock()
            entry = Entry(str(uuid.uuid4()), stream, self.length, digest, binding, source,
                          int(now) + self.cache.ttl, time.monotonic() + self.cache.ttl)
            entry.timer = threading.Timer(self.cache.ttl, self.cache.expire, args=(entry.snapshot_id,))
            entry.timer.daemon = True
            self.cache.entries[entry.snapshot_id] = entry
            try:
                entry.timer.start()
            except BaseException:
                # Keep reservation ownership unchanged for __exit__ to release.
                # An already scheduled callback cannot observe this rolled-back entry.
                self.cache.entries.pop(entry.snapshot_id, None)
                entry.timer.cancel()
                raise
            self.cache.pending -= 1
            self.cache.pending_bytes -= self.length
            self.finished = True
            return entry

    def close(self):
        with self.cache.lock:
            if not self.finished:
                self.finished = True
                self.cache.pending -= 1
                self.cache.pending_bytes -= self.length
                self.cache.reserved -= self.length

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class SnapshotCache:
    def __init__(self, spool, *, max_bytes, minimum_free, max_entries=32, max_readers=32, ttl=1800, clock=time.time):
        if not 1 <= max_entries <= 4096 or not 1 <= max_readers <= 256 or not 1 <= ttl <= 1800:
            raise ValueError("Invalid snapshot cache limits")
        self.spool, self.max_bytes, self.minimum_free, self.max_entries, self.max_readers, self.ttl = spool, max_bytes, minimum_free, max_entries, max_readers, ttl
        self.clock, self.lock, self.entries = clock, threading.RLock(), collections.OrderedDict()
        self.reserved, self.pending, self.pending_bytes, self.readers, self.closed = 0, 0, 0, 0, False

    def stale(self, entry):
        return entry.expired or self.clock() >= entry.expires_at or time.monotonic() >= entry.monotonic_expiry

    def remove(self, entry):
        # Caller holds lock; active leases always keep their exact open file alive.
        if entry.readers:
            return
        self.entries.pop(entry.snapshot_id, None)
        entry.timer.cancel()
        entry.stream.close()
        self.reserved -= entry.length

    def reserve(self, length):
        with self.lock:
            if self.closed:
                raise Denied("snapshot-cache-unavailable", 503)
            for entry in list(self.entries.values()):
                if self.stale(entry) and not entry.readers:
                    self.remove(entry)
            while self.reserved + length > self.max_bytes or len(self.entries) + self.pending >= self.max_entries:
                idle = next((entry for entry in self.entries.values() if not entry.readers), None)
                if idle is None:
                    raise Denied("snapshot-quota-exceeded", 507)
                self.remove(idle)
            # Retained physical copies are already reflected in available disk space.
            # Pending preparations conservatively reserve their full size, even if a
            # portion has already reached disk. Reclaim only idle cache entries.
            while shutil.disk_usage(self.spool).free < self.pending_bytes + length + self.minimum_free:
                idle = next((entry for entry in self.entries.values() if not entry.readers), None)
                if idle is None:
                    raise Denied("snapshot-quota-exceeded", 507)
                self.remove(idle)
            self.reserved += length
            self.pending += 1
            self.pending_bytes += length
            return Reservation(self, length)

    def acquire(self, snapshot_id, binding, digest, deadline, check):
        with self.lock:
            entry = self.entries.get(snapshot_id)
            if self.closed or entry is None or self.stale(entry):
                if entry is not None and not entry.readers:
                    self.remove(entry)
                raise Denied("snapshot-unavailable", 409)
            if entry.binding != binding:
                raise Denied("snapshot-unavailable", 409)
            if not hmac.compare_digest(entry.sha256, digest):
                raise Denied("content-version-changed", 412)
            if self.readers >= self.max_readers:
                raise Denied("gateway-busy", 503)
            entry.readers += 1
            self.readers += 1
            self.entries.move_to_end(snapshot_id)
            lease = None
            try:
                lease = SnapshotLease(self, entry, deadline, check)
                # Timer startup transfers ownership only on success. Holding the
                # lease lock prevents an already-scheduled callback from releasing
                # the count while a failed start is being rolled back.
                with lease.lock:
                    try:
                        lease.timer.start()
                    except BaseException:
                        lease.closed = True
                        lease.timer.cancel()
                        raise
                return lease
            except BaseException:
                entry.readers -= 1
                self.readers -= 1
                if (self.closed or self.stale(entry)) and not entry.readers:
                    self.remove(entry)
                raise

    def release(self, entry):
        with self.lock:
            entry.readers -= 1
            self.readers -= 1
            if self.closed or self.stale(entry):
                if not entry.readers:
                    self.remove(entry)

    def expire(self, snapshot_id):
        with self.lock:
            entry = self.entries.get(snapshot_id)
            if entry is not None:
                entry.expired = True
                if not entry.readers:
                    self.remove(entry)

    def close(self):
        with self.lock:
            self.closed = True
            for entry in list(self.entries.values()):
                entry.expired = True
                if not entry.readers:
                    self.remove(entry)
