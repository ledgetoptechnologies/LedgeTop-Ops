"""Bounded immutable directory-name pages; cursors select, never authorize."""
from __future__ import annotations

import base64
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
import re
import stat
import threading
import time
import uuid


_PINS = ("gatewayId", "rootId", "rootGeneration", "rootFingerprint", "staffId", "accessSubject",
         "admissionVersion", "profileVersion", "grantId", "grantGeneration", "path", "_keyId")
_PURPOSE = b"ops-employee-directory-cursor-v1\n"


@dataclass(frozen=True)
class _Listing:
    binding: str
    identity: tuple
    entries: tuple
    expiry: int
    cost: int


class DirectoryPages:
    def __init__(self, keys, clock=time.time, *, max_bytes=32 * 1024**2, max_entries=200_000,
                 ttl=600, max_caches=32, preparation_concurrency=2):
        if not keys or any(not isinstance(k, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", k)
                           or not isinstance(v, bytes) or len(v) < 32 for k, v in keys.items()):
            raise ValueError("Dedicated directory cursor keys required")
        limits = (max_bytes, max_entries, ttl, max_caches, preparation_concurrency)
        if any(type(n) is not int or n < 1 for n in limits) or ttl > 600 or max_caches > 32 \
                or max_bytes > 32 * 1024**2 or max_entries > 200_000 or preparation_concurrency > 32:
            raise ValueError("Invalid directory cache limits")
        self.keys, self.clock = dict(keys), clock
        self.max_bytes, self.max_entries, self.ttl, self.max_caches = max_bytes, max_entries, ttl, max_caches
        self.lock, self.slots = threading.Lock(), threading.BoundedSemaphore(preparation_concurrency)
        self.caches, self.leases, self.reserved = OrderedDict(), {}, 0

    @staticmethod
    def _deny():
        from .core import Denied
        raise Denied("listing-unavailable", 409)

    @staticmethod
    def _identity(fd, expected_mount):
        from .core import mount_id
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or mount_id(fd) != expected_mount:
            DirectoryPages._deny()
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def _prune(self):
        now = self.clock()
        for cache_id, listing in tuple(self.caches.items()):
            if listing.expiry <= now and not self.leases.get(cache_id, 0):
                self.reserved -= self.caches.pop(cache_id).cost
                self.leases.pop(cache_id, None)

    def _evict(self):
        for cache_id in self.caches:
            if not self.leases.get(cache_id, 0):
                listing = self.caches.pop(cache_id)
                self.reserved -= listing.cost
                self.leases.pop(cache_id, None)
                return True
        return False

    def _release(self, cache_id):
        with self.lock:
            self.leases[cache_id] -= 1
            self._prune()

    def _build(self, fd, expected_mount, binding, check):
        from .core import Denied, mount_id, path_parts
        if not self.slots.acquire(blocking=False):
            raise Denied("gateway-busy", 503)
        cost = 0
        entries = []
        listing = None
        try:
            before = self._identity(fd, expected_mount)
            # scandir duplicates fd but shares its directory offset. Use a fresh
            # fd-relative description so repeated first pages enumerate fully.
            scan_fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                with os.scandir(scan_fd) as iterator:
                    for scanned, entry in enumerate(iterator):
                        check()
                        if scanned >= self.max_entries:
                            raise Denied("folder-too-large", 413)
                        try:
                            if len(path_parts(entry.name)) != 1:
                                continue
                            child = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
                            try:
                                info = os.fstat(child)
                                if mount_id(child) != expected_mount:
                                    continue
                                if stat.S_ISDIR(info.st_mode):
                                    kind = "folder"
                                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                                    kind = "file"
                                else:
                                    continue
                            finally:
                                os.close(child)
                        except (OSError, Denied, UnicodeError):
                            continue
                        encoded = entry.name.encode("utf-8")
                        # Conservative charge covers strings, bytes, tuple/list
                        # pointers and sorting overhead, not only name bytes.
                        charge = 256 + 5 * len(encoded)
                        with self.lock:
                            self._prune()
                            while self.caches and self.reserved + charge > self.max_bytes:
                                if not self._evict():
                                    break
                            if self.reserved + charge > self.max_bytes:
                                raise Denied("folder-too-large", 413)
                            self.reserved += charge
                            cost += charge
                        entries.append((encoded, entry.name, kind))
            finally:
                os.close(scan_fd)
            check()
            entries.sort(key=lambda item: item[0])
            check()
            if self._identity(fd, expected_mount) != before:
                self._deny()
            listing = _Listing(binding, before, tuple(entries), int(self.clock()) + self.ttl, cost)
            cache_id = uuid.uuid4().hex
            with self.lock:
                self._prune()
                while len(self.caches) >= self.max_caches:
                    if not self._evict():
                        raise Denied("gateway-busy", 503)
                self.caches[cache_id] = listing
                self.leases[cache_id] = 1
                cost = 0  # cache owns reservation now
            return cache_id, listing
        finally:
            # Failed scans must not retain a full uncharged list through the
            # exception traceback after their reservation is returned.
            entries.clear()
            listing = None
            with self.lock:
                self.reserved -= cost
            self.slots.release()

    def _cursor(self, key_id, cache_id, listing, offset):
        value = {"cacheId": cache_id, "offset": offset, "binding": listing.binding, "expiry": listing.expiry}
        payload = base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).rstrip(b"=")
        signature = hmac.digest(self.keys[key_id], _PURPOSE + key_id.encode() + b"\n" + payload, "sha256").hex()
        return payload.decode() + "." + signature

    def _select(self, token, key_id, binding):
        if not isinstance(token, str) or len(token) > 8192 or re.fullmatch(r"[A-Za-z0-9_-]+\.[a-f0-9]{64}", token) is None:
            self._deny()
        payload, signature = token.split(".")
        expected = hmac.digest(self.keys[key_id], _PURPOSE + key_id.encode() + b"\n" + payload.encode(), "sha256").hex()
        if not hmac.compare_digest(expected, signature):
            self._deny()
        try:
            raw = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {"cacheId", "offset", "binding", "expiry"} \
                    or re.fullmatch(r"[a-f0-9]{32}", value["cacheId"]) is None \
                    or type(value["offset"]) is not int or value["offset"] < 200 or value["offset"] % 200 \
                    or type(value["expiry"]) is not int or value["expiry"] <= self.clock() \
                    or value["binding"] != binding:
                self._deny()
            with self.lock:
                self._prune()
                listing = self.caches.get(value["cacheId"])
                if listing is None or listing.binding != binding or listing.expiry != value["expiry"] \
                        or value["offset"] >= len(listing.entries):
                    self._deny()
                self.caches.move_to_end(value["cacheId"])
                self.leases[value["cacheId"]] += 1
                return value["cacheId"], listing, value["offset"]
        except (ValueError, TypeError, KeyError, UnicodeError):
            self._deny()

    def list_page(self, fd, mount_id, request, check):
        from .core import path_parts
        check()
        try:
            key_id = request["_keyId"]
            if request["operation"] != "list" or key_id not in self.keys:
                self._deny()
            path_parts(request["path"], True)
            binding = hashlib.sha256(json.dumps({k: request[k] for k in _PINS}, ensure_ascii=True,
                                                sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            cursor = request["cursor"]
        except (KeyError, TypeError, ValueError, UnicodeError):
            self._deny()
        if cursor is None:
            cache_id, listing = self._build(fd, mount_id, binding, check)
            offset = 0
        else:
            cache_id, listing, offset = self._select(cursor, key_id, binding)
        try:
            if self._identity(fd, mount_id) != listing.identity:
                self._deny()
            page = [{"name": name, "kind": kind} for _, name, kind in listing.entries[offset:offset + 200]]
            next_offset = offset + len(page)
            next_cursor = self._cursor(key_id, cache_id, listing, next_offset) if next_offset < len(listing.entries) else None
            check()
            if self._identity(fd, mount_id) != listing.identity:
                self._deny()
            with self.lock:
                if self.caches.get(cache_id) is not listing or listing.expiry <= self.clock():
                    self._deny()
            return {"schemaVersion": 1, "entries": page, "nextCursor": next_cursor}
        finally:
            # Drop our full tuple reference before its reservation may be freed.
            listing = None
            self._release(cache_id)
