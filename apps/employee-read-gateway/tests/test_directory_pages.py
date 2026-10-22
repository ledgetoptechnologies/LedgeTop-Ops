import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from employee_read_gateway.core import Denied, mount_id
from employee_read_gateway.directory_pages import DirectoryPages


class DirectoryPagesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.fd = os.open(self.directory.name, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.fd)
        self.mount = mount_id(self.fd)
        self.now = 1000
        self.keys = {"first": b"x" * 32, "second": b"y" * 32}
        self.pages = DirectoryPages(self.keys, lambda: self.now)
        self.request = {"gatewayId": "gateway", "rootId": "root", "rootGeneration": 1,
                        "rootFingerprint": "a" * 64, "staffId": "alice", "accessSubject": "alice-subject",
                        "admissionVersion": 1, "profileVersion": 1, "grantId": "grant", "grantGeneration": 1,
                        "path": "", "_keyId": "first", "operation": "list", "cursor": None}

    def files(self, count):
        for index in range(count):
            self.touch(f"photo-{index:06}.jpg")

    def touch(self, name):
        with open(os.path.join(self.directory.name, name), "wb"):
            pass

    def page(self, request=None, pages=None, check=lambda: None):
        return (pages or self.pages).list_page(self.fd, self.mount, request or self.request, check)

    def denied(self, callback, status=409):
        with self.assertRaises(Denied) as captured:
            callback()
        self.assertEqual(captured.exception.status, status)

    def test_2500_names_paginate_without_duplicates_and_utf8_sort(self):
        self.files(2501)
        for name in ["é", "Ω", "中", "😀", "folder"]:
            if name == "folder": os.mkdir(os.path.join(self.directory.name, name))
            else: self.touch(name)
        request, collected = dict(self.request), []
        while True:
            reply = self.page(request)
            self.assertEqual(set(reply), {"schemaVersion", "entries", "nextCursor"})
            self.assertLessEqual(len(reply["entries"]), 200)
            collected.extend(reply["entries"])
            if reply["nextCursor"] is None: break
            self.assertLessEqual(len(reply["nextCursor"]), 8192)
            self.assertTrue(reply["nextCursor"].isascii())
            request["cursor"] = reply["nextCursor"]
        names = [entry["name"] for entry in collected]
        self.assertEqual(len(names), 2506)
        self.assertEqual(len(set(names)), len(names))
        self.assertEqual(names, sorted(names, key=lambda name: name.encode("utf-8")))
        self.assertIn({"name": "folder", "kind": "folder"}, collected)
        # Independent first-page enumeration must not inherit scandir offsets.
        self.assertEqual(self.page()["entries"], collected[:200])

    def test_every_authority_pin_and_path_key_are_bound_but_deadline_can_renew(self):
        self.files(205)
        cursor = self.page()["nextCursor"]
        original = dict(self.request, cursor=cursor)
        for name in ("gatewayId", "rootId", "rootGeneration", "rootFingerprint", "staffId", "accessSubject",
                     "admissionVersion", "profileVersion", "grantId", "grantGeneration", "path", "_keyId"):
            altered = dict(original)
            altered[name] = "second" if name == "_keyId" else (2 if type(altered[name]) is int else altered[name] + "x")
            self.denied(lambda: self.page(altered))
        self.assertEqual(self.page(dict(original, expiresAt=1020, deadlineAt=1500)), self.page(original))
        self.assertEqual(len(self.page(original)["entries"]), 5)

    def test_tampered_expired_and_evicted_cursors_fail_static(self):
        self.files(201)
        cursor = self.page()["nextCursor"]
        self.denied(lambda: self.page(dict(self.request, cursor=cursor[:-1] + ("0" if cursor[-1] != "0" else "1"))))
        for bad in ["x" * 8193, "☃", "a.b", 2, ""]:
            self.denied(lambda: self.page(dict(self.request, cursor=bad)))
        self.now += 600
        self.denied(lambda: self.page(dict(self.request, cursor=cursor)))
        tiny = DirectoryPages(self.keys, lambda: self.now, max_caches=1)
        cursor = self.page(pages=tiny)["nextCursor"]
        self.page(pages=tiny)
        self.assertEqual(len(tiny.caches), 1)
        self.denied(lambda: self.page(dict(self.request, cursor=cursor), pages=tiny))

    def test_directory_mutation_between_pages_or_during_scan_requires_restart(self):
        self.files(201)
        cursor = self.page()["nextCursor"]
        self.touch("new-file")
        self.denied(lambda: self.page(dict(self.request, cursor=cursor)))
        checks = 0
        def mutate():
            nonlocal checks
            checks += 1
            if checks == 3:
                self.touch("another-file")
        self.denied(lambda: self.page(check=mutate))
        self.assertEqual(self.pages.reserved, sum(item.cost for item in self.pages.caches.values()))

    def test_memory_count_capacity_and_cancel_release_reservations(self):
        self.files(201)
        tiny = DirectoryPages(self.keys, max_bytes=100)
        self.denied(lambda: self.page(pages=tiny), 413)
        self.assertEqual(tiny.reserved, 0)
        tiny = DirectoryPages(self.keys, max_entries=200)
        self.denied(lambda: self.page(pages=tiny), 413)
        self.assertEqual(tiny.reserved, 0)
        checks = 0
        def cancel():
            nonlocal checks
            checks += 1
            if checks > 20: raise Denied("request-cancelled", 408)
        self.denied(lambda: self.page(check=cancel), 408)
        self.assertEqual(self.pages.reserved, 0)
        self.assertFalse(self.pages.caches)
        self.assertEqual(len(self.page()["entries"]), 200)

    def test_no_symlinks_fifo_hardlinks_or_nested_mounts(self):
        self.touch("ordinary")
        self.touch("hard-original")
        os.link(os.path.join(self.directory.name, "hard-original"), os.path.join(self.directory.name, "hard-copy"))
        os.symlink("ordinary", os.path.join(self.directory.name, "symlink"))
        os.mkfifo(os.path.join(self.directory.name, "fifo"))
        os.mkdir(os.path.join(self.directory.name, "nested"))
        real_mount = mount_id
        def simulated_mount(fd):
            return self.mount + 1 if os.readlink(f"/proc/self/fd/{fd}").endswith("/nested") else real_mount(fd)
        with patch("employee_read_gateway.core.mount_id", side_effect=simulated_mount):
            self.assertEqual(self.page()["entries"], [{"name": "ordinary", "kind": "file"}])

    def test_threadsafe_same_cursor_replay_and_cache_budget(self):
        self.files(250)
        cursor = self.page()["nextCursor"]
        request = dict(self.request, cursor=cursor)
        results, failures = [], []
        def read():
            try: results.append(self.page(request))
            except BaseException as error: failures.append(error)
        threads = [threading.Thread(target=read) for _ in range(8)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(5)
        self.assertFalse(failures)
        self.assertEqual(len(results), 8)
        self.assertTrue(all(reply == results[0] for reply in results))
        self.assertLessEqual(self.pages.reserved, self.pages.max_bytes)

    def test_default_budget_supports_at_least_100000_short_names(self):
        # Real filesystem test; short names ensure the bounded global budget is
        # the governing resource limit rather than an old 2000-entry cutoff.
        for index in range(100_000): self.touch(f"p{index:06}")
        first = self.page()
        self.assertEqual(len(first["entries"]), 200)
        self.assertIsNotNone(first["nextCursor"])
        listing = next(iter(self.pages.caches.values()))
        self.assertEqual(len(listing.entries), 100_000)
        self.assertLessEqual(self.pages.reserved, 32 * 1024**2)

    def test_active_page_lease_prevents_eviction_and_reuse_of_its_memory(self):
        self.files(201)
        pages = DirectoryPages(self.keys, lambda: self.now, max_bytes=80_000, max_caches=1)
        cursor = self.page(pages=pages)["nextCursor"]
        cache_id = next(iter(pages.caches))
        reserved = pages.reserved
        selected, release = threading.Event(), threading.Event()
        failures, results = [], []
        real_identity = pages._identity
        worker_id = None
        def paused_identity(fd, expected_mount):
            if threading.get_ident() == worker_id and not selected.is_set():
                selected.set()
                if not release.wait(5): raise AssertionError("page release timed out")
            return real_identity(fd, expected_mount)
        def read():
            nonlocal worker_id
            worker_id = threading.get_ident()
            try: results.append(self.page(dict(self.request, cursor=cursor), pages=pages))
            except BaseException as error: failures.append(error)
        with patch.object(pages, "_identity", side_effect=paused_identity):
            thread = threading.Thread(target=read)
            thread.start()
            try:
                self.assertTrue(selected.wait(5))
                self.assertEqual(pages.leases[cache_id], 1)
                self.denied(lambda: self.page(pages=pages), 413)
                self.assertEqual(pages.reserved, reserved)
                self.assertEqual(list(pages.caches), [cache_id])
                # Expiry cannot free entries that the active request still owns.
                self.now += 600
                with pages.lock: pages._prune()
                self.assertEqual(pages.reserved, reserved)
            finally:
                release.set()
                thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertFalse(results)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], Denied)
        self.assertEqual(failures[0].status, 409)
        self.assertEqual(pages.reserved, 0)
        self.assertFalse(pages.caches)
        self.assertFalse(pages.leases)
        self.assertEqual(len(self.page(pages=pages)["entries"]), 200)


if __name__ == "__main__":
    unittest.main()
