"""Cache contract tests use synthetic Linux files and no remote services."""
import hashlib
import hmac
import json
import os
import threading
import time
import unittest
import uuid
from unittest import mock

from employee_read_gateway import core
from employee_read_gateway.core import Denied
import test_gateway


class SnapshotCacheTests(unittest.TestCase):
    def setUp(self):
        self.f = test_gateway.GatewayTests("runTest")
        self.f.setUp()

    def tearDown(self):
        self.f.tearDown()

    def manifest(self, gateway=None):
        return json.loads(self.f.run_request(gateway=gateway).body)

    def content(self, manifest, **changes):
        return self.f.request("content", snapshotId=manifest["snapshotId"], expectedSha256=manifest["sha256"], **changes)

    def test_full_and_repeated_ranges_reuse_one_copy_without_source_reads(self):
        manifest = self.manifest()
        with mock.patch.object(core.os, "read", side_effect=AssertionError("Content must not read live source bytes")), \
                mock.patch.object(core.tempfile, "TemporaryFile", side_effect=AssertionError("Content must not recopy")):
            for byte_range in (None, {"start": 2, "end": 9}, {"start": 10, "end": len(self.f.data) - 1}):
                request = self.content(manifest, range=byte_range)
                reply = self.f.run_request(request)
                expected = self.f.data if byte_range is None else self.f.data[byte_range["start"]:byte_range["end"] + 1]
                self.assertEqual(expected, b"".join(reply.body.chunks()))
        self.assertEqual(1, len(self.f.gateway.cache.entries))
        self.assertEqual(len(self.f.data), self.f.gateway.reserved)
        self.assertEqual(0, self.f.gateway.cache.readers)

    def test_concurrent_range_readers_have_independent_pread_offsets(self):
        with open(self.f.file, "wb") as stream:
            stream.write(bytes(range(256)) * 16384)
        self.f.data = bytes(range(256)) * 16384
        manifest = self.manifest()
        ranges = [(0, 2 * 1024**2 - 1), (1024**2 + 23, 3 * 1024**2 + 47)]
        replies = [self.f.run_request(self.content(manifest, range={"start": start, "end": end})) for start, end in ranges]
        barrier, results, errors = threading.Barrier(2), {}, []
        def consume(index):
            try:
                barrier.wait()
                chunks = []
                for chunk in replies[index].body.chunks():
                    chunks.append(chunk)
                    time.sleep(0.005)
                results[index] = b"".join(chunks)
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=consume, args=(index,)) for index in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual([], errors)
        for index, (start, end) in enumerate(ranges):
            self.assertEqual(self.f.data[start:end + 1], results[index])
        self.assertEqual(0, self.f.gateway.cache.readers)

    def test_content_reopens_and_checks_source_after_preparation(self):
        for alteration in ("mutate", "delete", "replace", "hardlink", "symlink"):
            with self.subTest(alteration=alteration):
                if os.path.lexists(self.f.file):
                    os.unlink(self.f.file)
                with open(self.f.file, "wb") as stream:
                    stream.write(self.f.data)
                manifest = self.manifest()
                before = os.stat(self.f.file)
                if alteration == "mutate":
                    time.sleep(0.01)
                    with open(self.f.file, "wb") as stream:
                        stream.write(b"x" * len(self.f.data))
                    os.utime(self.f.file, ns=(before.st_atime_ns, before.st_mtime_ns))
                elif alteration == "delete":
                    os.unlink(self.f.file)
                elif alteration == "replace":
                    replacement = self.f.file + ".replacement"
                    with open(replacement, "wb") as stream:
                        stream.write(self.f.data)
                    os.replace(replacement, self.f.file)
                elif alteration == "hardlink":
                    os.link(self.f.file, self.f.file + ".link")
                else:
                    os.unlink(self.f.file)
                    os.symlink(os.path.join(self.f.home, "unavailable"), self.f.file)
                self.f.denied(lambda: self.f.run_request(self.content(manifest)), 412, "content-version-changed")
                self.assertEqual(0, self.f.gateway.cache.readers)
                self.assertEqual(0, self.f.gateway.reserved)

    def test_each_person_root_grant_path_epoch_and_key_pin_is_bound(self):
        manifest = self.manifest()
        changes = ({"rootId": str(uuid.uuid4())}, {"rootGeneration": 2}, {"rootFingerprint": "b" * 64},
                   {"staffId": "other-staff"}, {"accessSubject": "other-subject"}, {"admissionVersion": 2},
                   {"profileVersion": 2}, {"grantId": str(uuid.uuid4())}, {"grantGeneration": 2}, {"path": "other.bin"})
        for changed in changes:
            with self.subTest(changed=changed):
                self.f.denied(lambda: self.f.run_request({**self.content(manifest), **changed}), 409, "snapshot-unavailable")
        self.f.gateway.keys["second_key"] = self.f.key
        headers, body = self.f.signed(self.content(manifest))
        headers["X-Ops-Read-Key-Id"] = "second_key"
        message = "\n".join(["ops-employee-read-v1", self.f.gateway_id, "second_key", headers["X-Ops-Read-Time"],
                             headers["X-Ops-Read-Nonce"], "POST", "/v1/read", hashlib.sha256(body).hexdigest()])
        headers["X-Ops-Read-Signature"] = hmac.digest(self.f.key, message.encode(), "sha256").hex()
        self.f.denied(lambda: self.f.gateway.execute(headers, body), 409, "snapshot-unavailable")

    def test_unknown_snapshot_and_restarted_cache_require_new_manifest(self):
        manifest = self.manifest()
        missing = {**manifest, "snapshotId": str(uuid.uuid4())}
        self.f.denied(lambda: self.f.run_request(self.content(missing)), 409)
        restarted = self.f.make_gateway()
        self.f.denied(lambda: self.f.run_request(self.content(manifest), gateway=restarted), 409)
        renewed = self.manifest(restarted)
        self.assertNotEqual(manifest["snapshotId"], renewed["snapshotId"])
        self.assertEqual(self.f.data, b"".join(self.f.run_request(self.content(renewed), gateway=restarted).body.chunks()))

    def test_wrong_expected_digest_is_rejected_without_copy_or_lease(self):
        manifest = self.manifest()
        request = {**self.content(manifest), "expectedSha256": "0" * 64}
        with mock.patch.object(core.os, "read", side_effect=AssertionError("No live source read")):
            self.f.denied(lambda: self.f.run_request(request), 412)
        self.assertEqual(0, self.f.gateway.cache.readers)
        self.assertIn(manifest["snapshotId"], self.f.gateway.cache.entries)

    def test_idle_entry_count_eviction_and_active_lease_pin(self):
        gateway = self.f.make_gateway(max_snapshot_entries=1)
        first = self.manifest(gateway)
        entry = gateway.cache.entries[first["snapshotId"]]
        active = self.f.run_request(self.content(first), gateway=gateway)
        self.f.denied(lambda: self.manifest(gateway), 507)
        self.assertFalse(entry.stream.closed)
        active.body.close()
        second = self.manifest(gateway)
        self.assertTrue(entry.stream.closed)
        self.f.denied(lambda: self.f.run_request(self.content(first), gateway=gateway), 409)
        self.assertEqual(self.f.data, b"".join(self.f.run_request(self.content(second), gateway=gateway).body.chunks()))

    def test_expiry_does_not_close_active_fd_until_safe_lease_release(self):
        manifest = self.manifest()
        entry = self.f.gateway.cache.entries[manifest["snapshotId"]]
        active = self.f.run_request(self.content(manifest))
        self.f.gateway.cache.expire(manifest["snapshotId"])
        self.assertFalse(entry.stream.closed)
        self.f.denied(lambda: self.f.run_request(self.content(manifest)), 409)
        active.body.close()
        self.assertTrue(entry.stream.closed)
        self.assertEqual(0, self.f.gateway.reserved)

    def test_observed_source_invalidation_reclaims_only_after_other_active_lease_closes(self):
        manifest = self.manifest()
        active = self.f.run_request(self.content(manifest))
        entry = active.body.entry
        with open(self.f.file, "ab") as stream:
            stream.write(b"changed")
        self.f.denied(lambda: self.f.run_request(self.content(manifest)), 412)
        self.assertFalse(entry.stream.closed)
        self.assertEqual(len(self.f.data), self.f.gateway.reserved)
        self.f.denied(lambda: self.f.run_request(self.content(manifest)), 409)
        active.body.close()
        self.assertTrue(entry.stream.closed)
        self.assertEqual(0, self.f.gateway.reserved)

    def test_abandoned_reader_ttl_frees_lease_and_cache_bytes(self):
        gateway = self.f.make_gateway(snapshot_ttl=1)
        manifest = self.manifest(gateway)
        reply = self.f.run_request(self.content(manifest), gateway=gateway)
        deadline = time.monotonic() + 3
        while not reply.body.closed and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(reply.body.closed)
        self.assertEqual(0, gateway.cache.readers)
        self.assertEqual(0, gateway.reserved)
        self.f.denied(lambda: self.f.run_request(self.content(manifest), gateway=gateway), 409)

    def test_reader_limit_disconnect_and_error_release_only_lease(self):
        gateway = self.f.make_gateway(max_snapshot_readers=1)
        manifest = self.manifest(gateway)
        reply = self.f.run_request(self.content(manifest), gateway=gateway)
        self.f.denied(lambda: self.f.run_request(self.content(manifest), gateway=gateway), 503)
        self.f.denied(lambda: b"".join(reply.body.chunks(lambda: True)), 408)
        self.assertEqual(0, gateway.cache.readers)
        self.assertEqual(len(self.f.data), gateway.reserved)
        next_reply = self.f.run_request(self.content(manifest), gateway=gateway)
        with mock.patch.object(os, "pread", side_effect=OSError("synthetic I/O failure")):
            with self.assertRaises(OSError):
                b"".join(next_reply.body.chunks())
        self.assertEqual(0, gateway.cache.readers)

    def test_reader_checks_renewed_request_deadline_not_manifest_admission_expiry(self):
        manifest = self.manifest()
        request = self.content(manifest)
        reply = self.f.run_request(request)
        self.f.gateway.clock = lambda: request["deadlineAt"] + 1
        self.f.denied(lambda: b"".join(reply.body.chunks()), 408, "deadline-exceeded")
        self.assertEqual(0, self.f.gateway.cache.readers)

    def test_pread_returning_after_deadline_never_yields_its_late_chunk(self):
        manifest = self.manifest()
        request = self.content(manifest)
        reply = self.f.run_request(request)
        original = os.pread
        def delayed(fd, count, offset):
            data = original(fd, count, offset)
            self.f.gateway.clock = lambda: request["deadlineAt"] + 1
            return data
        received = []
        with mock.patch.object(os, "pread", side_effect=delayed):
            self.f.denied(lambda: received.extend(reply.body.chunks()), 408, "deadline-exceeded")
        self.assertEqual([], received)
        self.assertEqual(0, self.f.gateway.cache.readers)

    def test_manifest_preparation_slots_release_without_discarding_retained_entry(self):
        gateway = self.f.make_gateway(concurrency=1)
        first = self.manifest(gateway)
        self.assertTrue(gateway.slots.acquire(blocking=False))
        gateway.slots.release()
        second = self.manifest(gateway)
        self.assertNotEqual(first["snapshotId"], second["snapshotId"])
        self.assertEqual(2, len(gateway.cache.entries))
        self.assertEqual(0, gateway.cache.pending)
        self.assertEqual(0, gateway.cache.pending_bytes)

    def test_busy_preparation_does_not_block_existing_content_or_leak_reservation(self):
        gateway = self.f.make_gateway(concurrency=1)
        manifest = self.manifest(gateway)
        self.assertTrue(gateway.slots.acquire(blocking=False))
        try:
            self.f.denied(lambda: self.manifest(gateway), 503, "gateway-busy")
            reply = self.f.run_request(self.content(manifest), gateway=gateway)
            self.assertEqual(self.f.data, b"".join(reply.body.chunks()))
            self.assertEqual(0, gateway.cache.pending)
        finally:
            gateway.slots.release()

    def test_disk_free_preflight_does_not_double_count_retained_bytes(self):
        first = self.manifest()
        entry = self.f.gateway.cache.entries[first["snapshotId"]]
        # Available space already excludes the retained first copy. Exactly one
        # new file's capacity is sufficient, without counting that old file again.
        with mock.patch.object(core.shutil, "disk_usage", return_value=type("Disk", (), {"free": len(self.f.data)})()):
            second = self.manifest()
        self.assertFalse(entry.stream.closed)
        self.assertEqual(2, len(self.f.gateway.cache.entries))
        self.assertNotEqual(first["snapshotId"], second["snapshotId"])

    def test_physical_pressure_evicts_idle_only_and_rechecks_actual_free(self):
        first = self.manifest()
        entry = self.f.gateway.cache.entries[first["snapshotId"]]
        def available(_):
            return type("Disk", (), {"free": len(self.f.data) if entry.stream.closed else 0})()
        with mock.patch.object(core.shutil, "disk_usage", side_effect=available):
            second = self.manifest()
        self.assertTrue(entry.stream.closed)
        active = self.f.run_request(self.content(second))
        with mock.patch.object(core.shutil, "disk_usage", return_value=type("Disk", (), {"free": 0})()):
            self.f.denied(lambda: self.manifest(), 507)
        self.assertFalse(active.body.entry.stream.closed)
        active.body.close()

    def test_pending_byte_reservations_are_bounded_and_released_on_abort(self):
        gateway = self.f.make_gateway(max_file_bytes=100, max_spool_bytes=100)
        with mock.patch.object(core.shutil, "disk_usage", return_value=type("Disk", (), {"free": 90})()):
            with gateway.cache.reserve(60):
                self.assertEqual(60, gateway.cache.pending_bytes)
                self.f.denied(lambda: gateway.cache.reserve(40), 507)
                with gateway.cache.reserve(30):
                    self.assertEqual(90, gateway.cache.pending_bytes)
            self.assertEqual(0, gateway.cache.pending_bytes)
            self.assertEqual(0, gateway.cache.pending)
            self.assertEqual(0, gateway.reserved)

    def test_entry_timer_start_failure_rolls_back_publication_fd_and_reservations(self):
        created = []
        original = core.tempfile.TemporaryFile
        def capture(*args, **kwargs):
            stream = original(*args, **kwargs)
            created.append(stream)
            return stream
        with mock.patch.object(core.tempfile, "TemporaryFile", side_effect=capture), \
                mock.patch.object(threading.Timer, "start", side_effect=RuntimeError("synthetic timer start refusal")):
            with self.assertRaises(RuntimeError):
                self.manifest()
        cache = self.f.gateway.cache
        self.assertEqual(1, len(created))
        self.assertTrue(created[0].closed)
        self.assertEqual({}, cache.entries)
        self.assertEqual((0, 0, 0, 0), (cache.reserved, cache.pending, cache.pending_bytes, cache.readers))
        self.assertTrue(self.f.gateway.slots.acquire(blocking=False))
        self.f.gateway.slots.release()
        manifest = self.manifest()
        self.assertEqual(self.f.data, b"".join(self.f.run_request(self.content(manifest)).body.chunks()))

    def test_lease_timer_start_failure_rolls_back_readers_and_permits_retry(self):
        manifest = self.manifest()
        cache = self.f.gateway.cache
        entry = cache.entries[manifest["snapshotId"]]
        with mock.patch.object(threading.Timer, "start", side_effect=RuntimeError("synthetic timer start refusal")):
            with self.assertRaises(RuntimeError):
                self.f.run_request(self.content(manifest))
        self.assertEqual((0, 0), (entry.readers, cache.readers))
        self.assertFalse(entry.stream.closed)
        self.assertEqual(len(self.f.data), cache.reserved)
        self.assertIs(entry, cache.entries[manifest["snapshotId"]])
        self.assertEqual(self.f.data, b"".join(self.f.run_request(self.content(manifest)).body.chunks()))
        self.assertEqual((0, 0), (entry.readers, cache.readers))


if __name__ == "__main__":
    unittest.main()
