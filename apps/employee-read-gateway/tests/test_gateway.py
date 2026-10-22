import dataclasses
import hashlib
import hmac
import http.client
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock

from employee_read_gateway import core
from employee_read_gateway.core import Denied, Gateway, ReplayStore, Snapshot, enroll
from employee_read_gateway.http_adapter import ReadServer


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ops-read-synthetic-")
        self.home = self.temporary.name
        self.source, self.spool, self.state = [os.path.join(self.home, name) for name in ("source", "spool", "state")]
        for directory in (self.source, self.spool, self.state):
            os.mkdir(directory, 0o700)
        self.file = os.path.join(self.source, "map.bin")
        self.data = b"synthetic employee data, never client files"
        with open(self.file, "wb") as stream:
            stream.write(self.data)
        self.key = b"synthetic signing key only--32bytes-or-more"
        self.gateway_id, self.root_id, self.grant_id = [str(uuid.uuid4()) for _ in range(3)]
        self.root = enroll(self.source, self.root_id, 1)
        self.replay = ReplayStore(os.path.join(self.state, "nonces.sqlite3"))
        self.gateway = self.make_gateway()
        self.replies = []

    def make_gateway(self, **kwargs):
        return Gateway(self.gateway_id, [self.root], {"synthetic_key": self.key}, self.replay, self.spool,
                       minimum_free_bytes=0, **kwargs)

    def tearDown(self):
        for reply in self.replies:
            if isinstance(reply.body, Snapshot):
                reply.body.close()
        self.temporary.cleanup()

    def request(self, operation="manifest", path="map.bin", **changes):
        now = int(time.time())
        value = dict(schemaVersion=1, gatewayId=self.gateway_id, rootId=self.root_id, rootGeneration=1,
                     rootFingerprint=self.root.fingerprint, staffId="synthetic-staff-1", accessSubject="synthetic-human-subject",
                     admissionVersion=1, profileVersion=1, grantId=self.grant_id, grantGeneration=1,
                     operation=operation, path=path, expectedSha256=hashlib.sha256(self.data).hexdigest() if operation == "content" else None,
                     range=None, expiresAt=now + 25, deadlineAt=now + 120)
        value.update(changes)
        return value

    def signed(self, request=None, *, body=None, nonce=None, timestamp=None):
        timestamp = str(int(time.time()) if timestamp is None else timestamp)
        body = json.dumps(request or self.request(), separators=(",", ":")).encode() if body is None else body
        nonce = uuid.uuid4().hex if nonce is None else nonce
        message = "\n".join(["ops-employee-read-v1", self.gateway_id, "synthetic_key", timestamp, nonce,
                             "POST", "/v1/read", hashlib.sha256(body).hexdigest()])
        return {"Content-Type": "application/json", "X-Ops-Read-Key-Id": "synthetic_key", "X-Ops-Read-Time": timestamp,
                "X-Ops-Read-Nonce": nonce, "X-Ops-Read-Signature": hmac.digest(self.key, message.encode(), "sha256").hex()}, body

    def run_request(self, request=None, gateway=None, **kwargs):
        reply = (gateway or self.gateway).execute(*self.signed(request), **kwargs)
        self.replies.append(reply)
        return reply

    def denied(self, call, status=None, code=None):
        with self.assertRaises(Denied) as result:
            call()
        if status is not None:
            self.assertEqual(status, result.exception.status)
        if code is not None:
            self.assertEqual(code, result.exception.code)

    def test_manifest_snapshot_hash_and_no_named_spool_files(self):
        reply = self.run_request()
        value = json.loads(reply.body)
        self.assertEqual({"schemaVersion": 1, "sha256": hashlib.sha256(self.data).hexdigest(), "size": len(self.data),
                          "etag": '"' + hashlib.sha256(self.data).hexdigest() + '"'}, value)
        self.assertEqual([], os.listdir(self.spool))
        self.assertEqual(0, self.gateway.reserved)

    def test_full_content_returns_snapshot_not_live_descriptor(self):
        reply = self.run_request(self.request("content"))
        with open(self.file, "wb") as stream:
            stream.write(b"x" * len(self.data))
        self.assertEqual(self.data, b"".join(reply.body.chunks()))
        self.assertEqual(str(len(self.data)), reply.headers["Content-Length"])
        self.assertEqual(0, self.gateway.reserved)

    def test_inclusive_range_content_headers_and_bytes(self):
        reply = self.run_request(self.request("content", range={"start": 4, "end": 12}))
        self.assertEqual(206, reply.status)
        self.assertEqual(f"bytes 4-12/{len(self.data)}", reply.headers["Content-Range"])
        self.assertEqual("9", reply.headers["Content-Length"])
        self.assertEqual(self.data[4:13], b"".join(reply.body.chunks()))

    def test_range_invalid_and_unsatisfiable(self):
        for byte_range in ({"start": 8, "end": 2}, {"start": 0, "end": len(self.data)}, {"start": len(self.data), "end": len(self.data)}):
            with self.subTest(byte_range=byte_range):
                self.denied(lambda: self.run_request(self.request("content", range=byte_range)), 416)
        self.denied(lambda: self.run_request(self.request(range={"start": 0, "end": 1})), 400)

    def test_empty_file_full_content_but_no_range(self):
        with open(self.file, "wb"):
            pass
        self.data = b""
        reply = self.run_request(self.request("content"))
        self.assertEqual(b"", b"".join(reply.body.chunks()))
        self.denied(lambda: self.run_request(self.request("content", range={"start": 0, "end": 0})), 416)

    def test_same_size_preserved_mtime_stale_digest_is_rejected(self):
        before = os.stat(self.file)
        with open(self.file, "wb") as stream:
            stream.write(b"x" * len(self.data))
        os.utime(self.file, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.denied(lambda: self.run_request(self.request("content")), 412)
        self.assertEqual(hashlib.sha256(b"x" * len(self.data)).hexdigest(), json.loads(self.run_request().body)["sha256"])

    def test_source_mutates_during_copy_preserving_size_and_mtime(self):
        with open(self.file, "wb") as stream:
            stream.write(b"a" * (2 * 1024**2))
        before = os.stat(self.file)
        original = os.read
        mutated = False
        def reading(fd, length):
            nonlocal mutated
            data = original(fd, length)
            if not mutated:
                mutated = True
                # tmpfs may reuse an inode timestamp within a kernel clock tick.
                # This fixture tests a stat-observable mutation, not stronger filesystem snapshot semantics.
                time.sleep(0.02)
                with open(self.file, "r+b") as stream:
                    stream.write(b"b" * 1024)
                os.utime(self.file, ns=(before.st_atime_ns, before.st_mtime_ns))
            return data
        with mock.patch.object(core.os, "read", side_effect=reading):
            self.denied(lambda: self.run_request(), 409, "source-changed")
        self.assertEqual(0, self.gateway.reserved)

    def test_unobservable_same_tick_mutation_still_hashes_exact_snapshot_bytes(self):
        block = 1024**2
        with open(self.file, "wb") as stream:
            stream.write(b"a" * (2 * block))
        frozen_stat = os.stat(self.file)
        original_read, original_stat = os.read, os.fstat
        changed = False
        def reading(fd, length):
            nonlocal changed
            data = original_read(fd, length)
            if not changed:
                changed = True
                with open(self.file, "r+b") as stream:
                    stream.write(b"b" * (2 * block))
                os.utime(self.file, ns=(frozen_stat.st_atime_ns, frozen_stat.st_mtime_ns))
            return data
        def same_tick_stat(fd):
            current = original_stat(fd)
            # Reproduce the observed coarse-clock case deterministically rather than hope
            # that the kernel places this rewrite in exactly the same timestamp tick.
            return frozen_stat if current.st_ino == frozen_stat.st_ino and current.st_dev == frozen_stat.st_dev else current
        copied = b"a" * block + b"b" * block
        expected = hashlib.sha256(copied).hexdigest()
        with mock.patch.object(core.os, "read", side_effect=reading), mock.patch.object(core.os, "fstat", side_effect=same_tick_stat):
            reply = self.run_request(self.request("content", expectedSha256=expected))
        served = b"".join(reply.body.chunks())
        self.assertEqual(copied, served)
        self.assertEqual('"' + hashlib.sha256(served).hexdigest() + '"', reply.headers["ETag"])
        # The actual source is now entirely b. A future request must rebuild and
        # reject the earlier mixed snapshot's digest rather than reuse cached authority.
        self.denied(lambda: self.run_request(self.request("content", expectedSha256=expected)), 412)

    def test_source_truncate_and_growth_during_copy(self):
        original = os.read
        for grow in (False, True):
            with self.subTest(grow=grow):
                with open(self.file, "wb") as stream:
                    stream.write(self.data)
                changed = False
                def reading(fd, length):
                    nonlocal changed
                    data = original(fd, length)
                    if not changed:
                        changed = True
                        with open(self.file, "ab" if grow else "wb") as stream:
                            stream.write(b"changed")
                    return data
                with mock.patch.object(core.os, "read", side_effect=reading):
                    self.denied(lambda: self.run_request(), 409, "source-changed")

    def test_deleted_or_replaced_source_does_not_reuse_prior_snapshot(self):
        self.run_request()
        os.unlink(self.file)
        self.denied(lambda: self.run_request(), 404)
        with open(self.file, "wb") as stream:
            stream.write(b"different")
        self.denied(lambda: self.run_request(self.request("content")), 412)

    def test_symlink_file_and_intermediate_directory_are_denied(self):
        outside = os.path.join(self.home, "outside")
        os.mkdir(outside)
        with open(os.path.join(outside, "secret"), "wb") as stream:
            stream.write(b"not accessible")
        os.symlink(outside, os.path.join(self.source, "alias"))
        os.symlink(self.file, os.path.join(self.source, "link"))
        self.denied(lambda: self.run_request(self.request(path="alias/secret")), 404)
        self.denied(lambda: self.run_request(self.request(path="link")), 404)
        names = [entry["name"] for entry in json.loads(self.run_request(self.request("list", "")).body)["entries"]]
        self.assertEqual(["map.bin"], names)

    def test_fifo_socket_and_hardlinks_are_never_returned(self):
        os.mkfifo(os.path.join(self.source, "pipe"))
        os.link(self.file, os.path.join(self.source, "second-link"))
        with socket.socket(socket.AF_UNIX) as unix_socket:
            unix_socket.bind(os.path.join(self.source, "socket"))
            before = time.monotonic()
            for name in ("pipe", "socket", "map.bin", "second-link"):
                self.denied(lambda name=name: self.run_request(self.request(path=name)), 404)
            self.assertLess(time.monotonic() - before, 2)
            self.assertEqual([], json.loads(self.run_request(self.request("list", "")).body)["entries"])

    def test_nested_mount_id_mismatch_is_rejected(self):
        nested = os.path.join(self.source, "nested")
        os.mkdir(nested)
        with open(os.path.join(nested, "file"), "wb") as stream:
            stream.write(b"test")
        inode = os.stat(nested).st_ino
        original = core.mount_id
        def mount(fd):
            result = original(fd)
            return result + 999 if os.fstat(fd).st_ino == inode else result
        with mock.patch.object(core, "mount_id", side_effect=mount):
            self.denied(lambda: self.run_request(self.request(path="nested/file")), 404, "nested-mount-denied")
            entries = json.loads(self.run_request(self.request("list", "")).body)["entries"]
            self.assertNotIn("nested", [entry["name"] for entry in entries])

    def test_actual_nested_mount_capability_is_reported_without_elevation(self):
        source, target = os.path.join(self.home, "mount-source"), os.path.join(self.source, "mount-target")
        os.mkdir(source)
        os.mkdir(target)
        attempt = subprocess.run(["mount", "--bind", source, target], capture_output=True, timeout=5)
        if attempt.returncode != 0:
            print("REAL_NESTED_MOUNT_UNAVAILABLE: unprivileged synthetic container; mount-ID mismatch branch tested separately", flush=True)
            return
        try:
            self.denied(lambda: self.run_request(self.request("list", "mount-target")), 404, "nested-mount-denied")
        finally:
            subprocess.run(["umount", target], check=True, capture_output=True, timeout=5)

    def test_root_mapping_replacement_requires_reenrollment(self):
        os.rename(self.source, self.source + "-old")
        os.mkdir(self.source)
        self.denied(lambda: self.run_request(), 409, "root-enrollment-mismatch")

    def test_wrong_fingerprint_generation_and_unknown_root_are_denied(self):
        for changes in ({"rootFingerprint": "a" * 64}, {"rootGeneration": 2}, {"rootId": str(uuid.uuid4())}):
            self.denied(lambda changes=changes: self.run_request(self.request(**changes)), 404)
        bad = dataclasses.replace(self.root, inode=self.root.inode + 1)
        self.denied(lambda: Gateway(self.gateway_id, [bad], {"key": self.key}, self.replay, self.spool), 503)

    def test_explicit_fingerprint_algorithm_is_stable(self):
        expected = hashlib.sha256(f"ops-employee-root-v1\n{self.root_id}\n1\n{self.root.device}\n{self.root.inode}".encode()).hexdigest()
        self.assertEqual(expected, self.root.fingerprint)

    def test_list_is_utf8_sorted_and_exact_bounded_schema(self):
        os.mkdir(os.path.join(self.source, "folder"))
        for name in ("z", "é", "A", " padded "):
            with open(os.path.join(self.source, name), "wb"):
                pass
        value = json.loads(self.run_request(self.request("list", "")).body)
        self.assertEqual({"schemaVersion", "entries"}, set(value))
        self.assertEqual(sorted([entry["name"] for entry in value["entries"]], key=lambda name: name.encode()), [entry["name"] for entry in value["entries"]])
        self.assertTrue(all(set(entry) == {"name", "kind"} for entry in value["entries"]))

    def test_folder_over_200_fails_instead_of_truncating(self):
        for index in range(200):
            with open(os.path.join(self.source, f"file-{index}"), "wb"):
                pass
        self.denied(lambda: self.run_request(self.request("list", "")), 413, "folder-too-large")

    def test_invalid_canonical_paths(self):
        for path in ("", "/map.bin", "../map.bin", "a/./b", "a//b", "a/", "a\\b", "a%2fb", "a:b", "a\x00b", "a\ud800b", "a\u200bb", "a\u0085b", "a/" * 64 + "a", "é" * 128):
            with self.subTest(path=repr(path)):
                self.denied(lambda: self.run_request(self.request(path=path)), 400)

    def test_bad_signature_does_not_disclose_file_metadata(self):
        headers, body = self.signed()
        for field, value in (("X-Ops-Read-Signature", "0" * 64), ("X-Ops-Read-Key-Id", "unknown"),
                             ("X-Ops-Read-Nonce", "UPPER"), ("X-Ops-Read-Time", "01")):
            modified = {**headers, field: value}
            self.denied(lambda: self.gateway.execute(modified, body), 401)

    def test_exact_body_bytes_are_authenticated(self):
        headers, body = self.signed()
        self.denied(lambda: self.gateway.execute(headers, body + b" "), 401)

    def test_shared_independent_cross_language_hmac_vector(self):
        with open(os.path.join(os.path.dirname(__file__), "..", "testdata", "protocol-vector.json"), encoding="utf-8-sig") as stream:
            vector = json.load(stream)
        body = vector["body"].encode("utf-8")
        parsed = json.loads(body)
        gateway = Gateway(parsed["gatewayId"], [self.root], {vector["keyId"]: bytes.fromhex(vector["keyHex"])},
                          self.replay, self.spool, clock=lambda: vector["timestamp"] + 1)
        headers = {"Content-Type": "application/json", "X-Ops-Read-Key-Id": vector["keyId"],
                   "X-Ops-Read-Time": str(vector["timestamp"]), "X-Ops-Read-Nonce": vector["nonce"],
                   "X-Ops-Read-Signature": vector["signature"]}
        self.assertEqual(parsed, gateway.authenticate(headers, body))
        self.denied(lambda: gateway.authenticate(headers, body), 409, "replayed-request")

    def test_duplicate_unknown_missing_and_noncanonical_scalars(self):
        body = json.dumps(self.request()).encode()
        duplicate = body[:-1] + b',"path":"different"}'
        self.denied(lambda: self.gateway.execute(*self.signed(body=duplicate)), 400)
        for changes in ({"extra": 1}, {"schemaVersion": True}, {"rootGeneration": True}, {"admissionVersion": 1.0},
                        {"expiresAt": "100"}, {"profileVersion": 0}, {"gatewayId": self.gateway_id.upper()},
                        {"accessSubject": "   "}, {"accessSubject": "x" * 192}, {"staffId": "id\ue000"},
                        {"grantId": "00000000-0000-0000-0000-000000000000"},
                        {"range": {"start": 0, "end": 1, "extra": 2}},
                        {"expectedSha256": "a" * 64}, {"operation": "delete"}):
            with self.subTest(changes=changes):
                self.denied(lambda: self.run_request(self.request(**changes)), 400)
        missing = self.request()
        del missing["path"]
        self.denied(lambda: self.run_request(missing), 400)

    def test_native_access_subject_is_preserved_as_opaque_identity(self):
        subject = "  opaque-human-subject  "
        headers, body = self.signed(self.request(accessSubject=subject))
        self.assertEqual(subject, self.gateway.authenticate(headers, body)["accessSubject"])
        for invalid in (" ", "human\u200b", "human\ue000", "x" * 192):
            self.denied(lambda invalid=invalid: self.run_request(self.request(accessSubject=invalid)), 400)

    def test_expired_future_timestamp_and_invalid_deadline(self):
        now = int(time.time())
        for changes in ({"expiresAt": now}, {"expiresAt": now + 31}, {"deadlineAt": now + 901}, {"deadlineAt": now + 10}):
            self.denied(lambda: self.run_request(self.request(**changes)), 401)
        for timestamp in (now - 31, now + 31):
            self.denied(lambda: self.gateway.execute(*self.signed(timestamp=timestamp)), 401)

    def test_replay_is_durable_and_atomic(self):
        headers, body = self.signed()
        self.gateway.execute(headers, body)
        restarted = self.make_gateway()
        self.denied(lambda: restarted.execute(headers, body), 409, "replayed-request")
        signed = self.signed()
        barrier, results = threading.Barrier(2), []
        def call():
            barrier.wait()
            try:
                self.gateway.execute(*signed)
                results.append("ok")
            except Denied as error:
                results.append(error.code)
        threads = [threading.Thread(target=call) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertCountEqual(["ok", "replayed-request"], results)

    def test_nonce_capacity_fails_closed_and_expired_entries_are_reclaimed(self):
        replay = ReplayStore(os.path.join(self.state, "bounded.sqlite3"), capacity=1)
        replay.claim("key", "1" * 32, 100, 90)
        self.denied(lambda: replay.claim("key", "2" * 32, 100, 90), 503, "replay-store-full")
        replay.claim("key", "2" * 32, 110, 101)

    def test_snapshot_concurrency_and_quota_release(self):
        gateway = self.make_gateway(concurrency=1)
        reply = self.run_request(self.request("content"), gateway=gateway)
        self.denied(lambda: self.run_request(gateway=gateway), 503, "gateway-busy")
        reply.body.close()
        self.run_request(gateway=gateway)
        self.assertEqual(0, gateway.reserved)
        limited = self.make_gateway(max_file_bytes=100, max_spool_bytes=100, concurrency=3)
        first = self.run_request(self.request("content"), gateway=limited)
        second = self.run_request(self.request("content"), gateway=limited)
        self.denied(lambda: self.run_request(self.request("content"), gateway=limited), 507)
        first.body.close()
        second.body.close()
        self.assertEqual(0, limited.reserved)

    def test_disk_free_space_and_file_size_bounds(self):
        limited = self.make_gateway(max_file_bytes=2, max_spool_bytes=2)
        self.denied(lambda: self.run_request(gateway=limited), 413)
        with mock.patch.object(core.shutil, "disk_usage", return_value=type("Disk", (), {"free": 0})()):
            self.denied(lambda: self.run_request(), 507)

    def test_over_30gb_supported_without_allocating_or_copying_test_data(self):
        size = 35 * 1024**3
        with open(self.file, "r+b") as stream:
            stream.truncate(size)
        self.assertLess(os.stat(self.file).st_blocks * 512, 1024**2)
        called = False
        def cancel():
            nonlocal called
            # First pre-open check passes; abort when snapshot copy begins.
            prior, called = called, True
            return prior
        # The synthetic container deliberately has only 256MiB tmpfs. Model a production
        # disk's sufficient capacity, then cancel before copying even the first block.
        with mock.patch.object(core.shutil, "disk_usage", return_value=type("Disk", (), {"free": 1024**4})()):
            self.denied(lambda: self.run_request(cancelled=cancel), 408, "request-cancelled")
        self.assertEqual(0, self.gateway.reserved)

    def test_cancel_and_deadline_after_expensive_work_release_resources(self):
        self.denied(lambda: self.run_request(cancelled=lambda: True), 408)
        original = os.read
        def reading(fd, size):
            data = original(fd, size)
            self.gateway.clock = lambda: time.time() + 1000
            return data
        with mock.patch.object(core.os, "read", side_effect=reading):
            self.denied(lambda: self.run_request(), 408, "deadline-exceeded")
        self.assertEqual(0, self.gateway.reserved)

    def test_abandoned_snapshot_expiry_releases_disk_and_slot(self):
        gateway = self.make_gateway(snapshot_ttl=1, concurrency=1)
        reply = self.run_request(self.request("content"), gateway=gateway)
        deadline = time.monotonic() + 3
        while gateway.reserved and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(reply.body.closed)
        self.assertEqual(0, gateway.reserved)
        self.run_request(gateway=gateway)

    def test_config_rejects_weak_keys_and_nonprivate_spool(self):
        with self.assertRaises(ValueError):
            Gateway(self.gateway_id, [self.root], {"key": b"short"}, self.replay, self.spool)
        os.chmod(self.spool, 0o755)
        self.denied(lambda: self.make_gateway(), 503)

    def test_unicode_private_use_filename_is_opaque_but_format_names_denied(self):
        for name in ("private-\ue000.bin", "format-\u200b.bin"):
            with open(os.path.join(self.source, name), "wb") as stream:
                stream.write(b"test")
        entries = json.loads(self.run_request(self.request("list", "")).body)["entries"]
        self.assertIn("private-\ue000.bin", [entry["name"] for entry in entries])
        self.assertNotIn("format-\u200b.bin", [entry["name"] for entry in entries])
        self.run_request(self.request(path="private-\ue000.bin"))
        self.denied(lambda: self.run_request(self.request(path="format-\u200b.bin")), 400)

    def test_json_utf8_and_size_bounds_are_enforced(self):
        for body in (b"\xff", b"x" * 16385, b'{"schemaVersion":NaN}', b"[]"):
            self.denied(lambda body=body: self.gateway.execute(*self.signed(body=body)), 400)

    def test_http_fixed_post_round_trip_and_static_errors(self):
        server = ReadServer(("127.0.0.1", 0), self.gateway)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            headers, body = self.signed()
            connection.request("POST", "/v1/read", body=body, headers=headers)
            reply = connection.getresponse()
            self.assertEqual(200, reply.status)
            self.assertEqual(hashlib.sha256(self.data).hexdigest(), json.loads(reply.read())["sha256"])
            connection.close()
            for method, path, extra in (("GET", "/v1/read", {}), ("POST", "/v1/read?other=1", {}),
                                        ("POST", "/v1/read", {"Transfer-Encoding": "chunked"})):
                connection = http.client.HTTPConnection(*server.server_address, timeout=5)
                headers, body = self.signed()
                connection.request(method, path, body=body, headers={**headers, **extra})
                response = connection.getresponse()
                self.assertIn(response.status, (400, 404, 405))
                result = response.read().decode()
                self.assertNotIn(self.source, result)
                self.assertNotIn(headers["X-Ops-Read-Signature"], result)
                connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_http_content_snapshot_range(self):
        server = ReadServer(("127.0.0.1", 0), self.gateway)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(*server.server_address, timeout=5)
            headers, body = self.signed(self.request("content", range={"start": 1, "end": 5}))
            connection.request("POST", "/v1/read", body=body, headers=headers)
            response = connection.getresponse()
            self.assertEqual(206, response.status)
            self.assertEqual("5", response.getheader("Content-Length"))
            self.assertEqual(self.data[1:6], response.read())
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
