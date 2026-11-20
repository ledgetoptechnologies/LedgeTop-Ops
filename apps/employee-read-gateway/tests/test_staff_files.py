"""Staff writes: Access service assertion, Ed25519 envelopes, and every write operation on a real Linux directory."""
import base64
import hashlib
import json
import os
import shutil
import tempfile
import time
import unittest
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, padding, rsa

from employee_read_gateway.core import enroll
from employee_read_gateway.errors import Denied
from employee_read_gateway.staff_files import linuxfs
from employee_read_gateway.staff_files.access import AccessKeys, verify_service_assertion
from employee_read_gateway.staff_files.names import writable_name
from employee_read_gateway.staff_files.service import Config, Limits, StaffFiles
from employee_read_gateway.staff_files.signing import parse_public_keys, verify_envelope

ISSUER = "https://example-team.cloudflareaccess.com"
AUDIENCE = "a" * 64
CLIENT_ID = "nas-link-client.access"
STAFF = "staff-1"
GRANT = "11111111-1111-4111-8111-111111111111"
ROOT_ID = "22222222-2222-4222-8222-222222222222"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def raw_public(key) -> str:
    return b64(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        numbers = self.rsa.public_key().public_numbers()
        self.jwks = {"keys": [{"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig",
                               "n": b64(numbers.n.to_bytes(256, "big")), "e": b64(numbers.e.to_bytes(3, "big"))}]}
        self.fetches = []
        self.clock = Clock()

        def fetch(url, timeout):
            self.fetches.append(url)
            return json.dumps(self.jwks).encode()

        self.keys = AccessKeys(ISSUER, fetch=fetch, clock=self.clock, cooldown=300)

    def token(self, header=None, **claims):
        now = int(self.clock())
        payload = {"iss": ISSUER, "aud": [AUDIENCE], "type": "app", "sub": "", "common_name": CLIENT_ID,
                   "iat": now - 5, "exp": now + 300}
        payload.update(claims)
        payload = {k: v for k, v in payload.items() if v is not ...}
        head = b64(json.dumps(header or {"alg": "RS256", "kid": "k1"}).encode())
        body = b64(json.dumps(payload).encode())
        signature = self.rsa.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
        return f"{head}.{body}.{b64(signature)}"

    def verify(self, token):
        return verify_service_assertion(token, issuer=ISSUER, audience=AUDIENCE, client_id=CLIENT_ID, keys=self.keys,
                                        clock=self.clock)

    def test_reviewed_service_shape_is_accepted(self):
        self.assertGreater(self.verify(self.token()), self.clock())
        self.assertEqual(self.fetches, [ISSUER + "/cdn-cgi/access/certs"])

    def test_other_shapes_are_refused(self):
        for claims in ({"sub": ...}, {"sub": "person"}, {"email": "x@example.test"}, {"type": "org"},
                       {"common_name": "other"}, {"aud": ["b" * 64]}, {"iss": "https://other.cloudflareaccess.com"},
                       {"exp": int(self.clock()) - 1}, {"nbf": int(self.clock()) + 60}):
            with self.subTest(claims=claims), self.assertRaises(Denied) as caught:
                self.verify(self.token(**claims))
            self.assertEqual(caught.exception.status, 404)
        for header in ({"alg": "HS256", "kid": "k1"}, {"alg": "none", "kid": "k1"}, {"alg": "RS256"}):
            with self.subTest(header=header), self.assertRaises(Denied):
                self.verify(self.token(header=header))

    def test_unknown_kid_refreshes_once_per_cooldown_and_stale_keys_fail_closed(self):
        self.verify(self.token())
        with self.assertRaises(Denied):
            self.verify(self.token(header={"alg": "RS256", "kid": "k2"}))
        with self.assertRaises(Denied):
            self.verify(self.token(header={"alg": "RS256", "kid": "k2"}))
        self.assertEqual(len(self.fetches), 1)  # second unknown kid inside the cooldown: no fetch
        self.jwks = {"keys": []}
        self.clock.now += 8 * 86400
        with self.assertRaises(Denied):
            self.verify(self.token())


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.write, self.read, self.next = (ed25519.Ed25519PrivateKey.generate() for _ in range(3))
        self.keys = parse_public_keys(f"files-write:w1:{raw_public(self.write)},files-read:r1:{raw_public(self.read)}")
        self.clock = Clock()

    def signed(self, key, **fields):
        envelope = {"scope": "files-write", "keyId": "w1", "issuedAt": int(self.clock()), "expiresAt": int(self.clock()) + 20}
        envelope.update(fields)
        raw = json.dumps(envelope).encode()
        return b64(raw), b64(key.sign(b"ltfiles-v2\n" + raw))

    def test_scope_key_time_and_tamper(self):
        self.assertEqual(verify_envelope(*self.signed(self.write), "files-write", self.keys, self.clock)["keyId"], "w1")
        refused = [self.signed(self.read, keyId="r1"),                    # read key cannot authorize a write
                   self.signed(self.read),                                # wrong key under the write id
                   self.signed(self.write, keyId="nope"),
                   self.signed(self.write, expiresAt=int(self.clock()) + 31),
                   self.signed(self.write, issuedAt=int(self.clock()) - 60, expiresAt=int(self.clock()) - 40)]
        envelope, signature = self.signed(self.write)
        refused.append((b64(json.dumps({"scope": "files-write", "keyId": "w1", "issuedAt": 1, "expiresAt": 2}).encode()), signature))
        for envelope_header, signature_header in refused:
            with self.assertRaises(Denied) as caught:
                verify_envelope(envelope_header, signature_header, "files-write", self.keys, self.clock)
            self.assertEqual(caught.exception.status, 401)

    def test_rotation_overlap_and_retirement(self):
        both = parse_public_keys(f"files-write:w1:{raw_public(self.write)},files-write:w2:{raw_public(self.next)}")
        verify_envelope(*self.signed(self.write), "files-write", both, self.clock)
        verify_envelope(*self.signed(self.next, keyId="w2"), "files-write", both, self.clock)
        retired = parse_public_keys(f"files-write:w2:{raw_public(self.next)}")
        with self.assertRaises(Denied):
            verify_envelope(*self.signed(self.write), "files-write", retired, self.clock)
        with self.assertRaises(ValueError):
            parse_public_keys(",".join(f"files-write:w{i}:{raw_public(self.write)}" for i in range(3)))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.root = os.path.join(self.base, "root")
        self.internal = os.path.join(self.base, ".ltfiles")
        os.mkdir(self.root, 0o750)
        os.mkdir(self.internal, 0o700)
        os.mkdir(os.path.join(self.root, "jobs"))
        pin = enroll(self.root, ROOT_ID, 1)
        self.clock = Clock()
        self.limits = Limits(chunk_size=8, max_file_bytes=64, grant_quota_bytes=100, global_quota_bytes=200,
                             free_margin_bytes=0, sessions_per_staff=2, sessions_total=3)
        self.config = Config(ROOT_ID, 1, pin.fingerprint, self.root, self.internal, AUDIENCE, CLIENT_ID, self.limits)
        self.files = StaffFiles(self.config, self.clock)

    def tearDown(self):
        self.files.close()
        shutil.rmtree(self.base)

    def restart(self):
        self.files.close()
        self.files = StaffFiles(self.config, self.clock)
        return self.files

    def id_of(self, relative):
        parent, name = os.path.split(os.path.join(self.root, relative))
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            return linuxfs.statx(fd, name).object_id
        finally:
            os.close(fd)

    def root_id(self, relative=""):
        fd = os.open(os.path.join(self.root, relative), os.O_RDONLY | os.O_DIRECTORY)
        try:
            return linuxfs.statx(fd).object_id
        finally:
            os.close(fd)

    def run_op(self, operation, args, body=b"", **kwargs):
        return self.files.execute(self.envelope(operation, args, body, **kwargs), body)

    def envelope(self, operation, args, body=b"", operation_id=None, rights=("read", "write"), grant_path="jobs",
                 exclusive=True, generation=1):
        return {"schemaVersion": 2, "scope": "files-write", "keyId": "w1", "nonce": uuid.uuid4().hex,
                    "issuedAt": int(self.clock()), "expiresAt": int(self.clock()) + 20, "audience": AUDIENCE,
                    "servicePrincipal": CLIENT_ID, "method": "POST", "route": "/v2/op",
                    "operationId": operation_id or str(uuid.uuid4()),
                    "actor": {"staffId": STAFF, "accessSubject": "subject-1", "admissionVersion": 1},
                    "grant": {"grantId": GRANT, "grantGeneration": generation, "path": grant_path, "rights": list(rights)},
                    "root": {"rootId": ROOT_ID, "rootGeneration": 1, "rootFingerprint": self.config.root_fingerprint,
                             "exclusive": exclusive},
                "operation": operation, "args": args, "bodySha256": hashlib.sha256(body).hexdigest()}

    def mkdir(self, path, operation_id=None):
        parent = os.path.dirname(path)
        return self.run_op("mkdir", {"path": path, "parentId": self.root_id(parent)}, operation_id=operation_id)

    def upload(self, path, data, precondition=None, operation_id=None):
        operation_id = operation_id or str(uuid.uuid4())
        begin = self.run_op("upload.begin", {"path": path, "parentId": self.root_id(os.path.dirname(path)), "size": len(data),
                                             "sha256": hashlib.sha256(data).hexdigest(),
                                             "precondition": precondition or {"kind": "create"}}, operation_id=operation_id)
        if begin.status != 200:
            return begin
        for index in range(0, max(1, len(data)), 8):
            chunk = data[index:index + 8]
            self.run_op("upload.chunk", {"index": index // 8, "chunkSha256": hashlib.sha256(chunk).hexdigest(),
                                         "chunkSize": len(chunk)}, body=chunk, operation_id=operation_id)
        return self.run_op("upload.commit", {}, operation_id=operation_id)

    def test_mkdir_is_idempotent_and_changed_intent_conflicts(self):
        operation_id = str(uuid.uuid4())
        first = self.mkdir("jobs/A", operation_id)
        self.assertEqual(first.status, 200)
        self.assertEqual(self.mkdir("jobs/A", operation_id).body, first.body)
        with self.assertRaises(Denied) as caught:
            self.mkdir("jobs/B", operation_id)
        self.assertEqual(caught.exception.status, 409)

    def test_case_folded_sibling_and_windows_names(self):
        self.mkdir("jobs/Report")
        self.assertEqual(self.mkdir("jobs/REPORT").status, 409)
        for name in ("CON", "nul.txt", "a.", "a ", "a:b", "COM1.log"):
            with self.subTest(name=name), self.assertRaises(Denied):
                writable_name(name)

    def test_grant_scope_rights_and_shared_roots(self):
        for kwargs, status in (({"rights": ("read",)}, 403), ({"exclusive": False}, 403), ({"grant_path": "other"}, 403)):
            with self.subTest(kwargs=kwargs), self.assertRaises(Denied) as caught:
                self.run_op("mkdir", {"path": "jobs/X", "parentId": self.root_id("jobs")}, **kwargs)
            self.assertEqual(caught.exception.status, status)
        with self.assertRaises(Denied):  # the grant folder itself cannot be removed by its grantee
            self.run_op("delete", {"path": "jobs", "id": self.root_id("jobs"), "etag": None})

    def test_symlinks_and_hard_links_are_refused(self):
        os.symlink("/etc", os.path.join(self.root, "jobs", "link"))
        self.assertEqual(self.run_op("mkdir", {"path": "jobs/link/x", "parentId": "0" * 32}).status, 403)
        with open(os.path.join(self.root, "jobs", "f"), "wb") as stream:
            stream.write(b"x")
        os.link(os.path.join(self.root, "jobs", "f"), os.path.join(self.root, "jobs", "g"))
        result = self.run_op("delete", {"path": "jobs/f", "id": self.id_of("jobs/f"),
                                        "etag": hashlib.sha256(b"x").hexdigest()})
        self.assertEqual(result.status, 403)

    def test_chunked_upload_resume_and_commit(self):
        data = b"0123456789abcdefXYZ"
        result = self.upload("jobs/plan.txt", data)
        self.assertEqual(result.status, 200, result.body)
        with open(os.path.join(self.root, "jobs", "plan.txt"), "rb") as stream:
            self.assertEqual(stream.read(), data)
        self.assertEqual(result.body["result"]["etag"], hashlib.sha256(data).hexdigest())
        # Identical retry of the commit returns the stored disposition.
        self.assertEqual(self.run_op("upload.commit", {}, operation_id=result.body["operationId"]).body, result.body)

    def test_upload_checks(self):
        operation_id = str(uuid.uuid4())
        data = b"abcdefgh12"
        self.run_op("upload.begin", {"path": "jobs/x.bin", "parentId": self.root_id("jobs"), "size": len(data),
                                     "sha256": hashlib.sha256(b"different").hexdigest(), "precondition": {"kind": "create"}},
                    operation_id=operation_id)
        first = data[:8]
        args = {"index": 0, "chunkSha256": hashlib.sha256(first).hexdigest(), "chunkSize": 8}
        self.run_op("upload.chunk", args, body=first, operation_id=operation_id)
        self.assertEqual(self.run_op("upload.chunk", args, body=first, operation_id=operation_id).body["received"], [0])
        with self.assertRaises(Denied) as caught:
            other = b"ZZZZZZZZ"
            self.run_op("upload.chunk", {"index": 0, "chunkSha256": hashlib.sha256(other).hexdigest(), "chunkSize": 8},
                        body=other, operation_id=operation_id)
        self.assertEqual(caught.exception.status, 409)
        with self.assertRaises(Denied) as caught:
            self.run_op("upload.commit", {}, operation_id=operation_id)
        self.assertEqual(caught.exception.code, "upload-incomplete")
        with self.assertRaises(Denied) as caught:  # chunk under a new grant generation: refused
            self.run_op("upload.chunk", {"index": 1, "chunkSha256": hashlib.sha256(b"12").hexdigest(), "chunkSize": 2},
                        body=b"12", operation_id=operation_id, generation=2)
        self.assertEqual(caught.exception.status, 403)
        self.run_op("upload.chunk", {"index": 1, "chunkSha256": hashlib.sha256(b"12").hexdigest(), "chunkSize": 2},
                    body=b"12", operation_id=operation_id)
        self.assertEqual(self.run_op("upload.commit", {}, operation_id=operation_id).status, 422)

    def test_overwrite_is_disabled_in_v1(self):
        self.upload("jobs/doc.txt", b"version one")
        with self.assertRaises(Denied) as caught:
            self.upload("jobs/doc.txt", b"version two", {"kind": "replace", "id": self.id_of("jobs/doc.txt"),
                                                         "etag": hashlib.sha256(b"version one").hexdigest()})
        self.assertEqual((caught.exception.status, caught.exception.code), (400, "overwrite-unsupported"))
        self.assertEqual(self.upload("jobs/DOC.txt", b"version two").status, 409)  # create-only, case-folded

    def test_expired_replay_entry_is_rejected(self):
        with self.assertRaises(Denied) as caught:
            self.files.replay.claim("w1", "a" * 32, int(self.clock()), int(self.clock()))
        self.assertEqual(caught.exception.status, 401)

    def test_commit_whose_hash_outlives_the_signature_publishes_nothing_and_a_fresh_retry_reuses_the_hash(self):
        data = b"0123456789abcdef"
        operation_id = str(uuid.uuid4())
        self.run_op("upload.begin", {"path": "jobs/big.bin", "parentId": self.root_id("jobs"), "size": len(data),
                                     "sha256": hashlib.sha256(data).hexdigest(), "precondition": {"kind": "create"}},
                    operation_id=operation_id)
        for index in (0, 1):
            chunk = data[index * 8:(index + 1) * 8]
            self.run_op("upload.chunk", {"index": index, "chunkSha256": hashlib.sha256(chunk).hexdigest(), "chunkSize": 8},
                        body=chunk, operation_id=operation_id)
        clock, real = self.clock, self.files.hash_slots

        class SlowHash:
            def __enter__(self):
                clock.now += 60  # hashing takes longer than the 30-second authorization
            def __exit__(self, *exc):
                return False

        self.files.hash_slots = SlowHash()
        with self.assertRaises(Denied) as caught:
            self.run_op("upload.commit", {}, operation_id=operation_id)
        self.assertEqual(caught.exception.code, "expired")
        self.assertFalse(os.path.exists(os.path.join(self.root, "jobs", "big.bin")))
        self.assertEqual(self.run_op("upload.status", {}, operation_id=operation_id).body["state"], "open")

        class NoHash:
            def __enter__(self):
                raise AssertionError("the verified hash should be reused")
            def __exit__(self, *exc):
                return False

        self.files.hash_slots = NoHash()
        committed = self.run_op("upload.commit", {}, operation_id=operation_id)
        self.files.hash_slots = real
        self.assertEqual(committed.status, 200, committed.body)
        with open(os.path.join(self.root, "jobs", "big.bin"), "rb") as stream:
            self.assertEqual(stream.read(), data)

    def staged(self, path, data):
        operation_id = str(uuid.uuid4())
        self.run_op("upload.begin", {"path": path, "parentId": self.root_id(os.path.dirname(path)), "size": len(data),
                                     "sha256": hashlib.sha256(data).hexdigest(), "precondition": {"kind": "create"}},
                    operation_id=operation_id)
        for index in range(0, len(data), 8):
            chunk = data[index:index + 8]
            self.run_op("upload.chunk", {"index": index // 8, "chunkSha256": hashlib.sha256(chunk).hexdigest(),
                                         "chunkSize": len(chunk)}, body=chunk, operation_id=operation_id)
        return operation_id

    def test_another_intent_turning_unknown_during_the_hash_blocks_the_commit(self):
        operation_id = self.staged("jobs/held.bin", b"held bytes")
        files, real = self.files, self.files.hash_slots

        class OtherGoesUnknown:
            def __enter__(self):
                with files.store.transaction() as db:
                    db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,'unknown',?,NULL,NULL,0,0)",
                               (str(uuid.uuid4()), "move", "d", STAFF, GRANT, 1, "jobs",
                                json.dumps({"source": "jobs/a", "destination": "jobs/b", "id": "0" * 32})))
            def __exit__(self, *exc):
                return False

        self.files.hash_slots = OtherGoesUnknown()
        with self.assertRaises(Denied) as caught:
            self.run_op("upload.commit", {}, operation_id=operation_id)
        self.files.hash_slots = real
        self.assertEqual(caught.exception.status, 423)
        self.assertFalse(os.path.exists(os.path.join(self.root, "jobs", "held.bin")))

    def test_expiry_between_the_durable_intent_and_the_syscall_is_a_known_no_change(self):
        clock, store = self.clock, self.files.store
        real_audit = store.audit

        def audit_then_lapse(db, operation_id, kind, staff_id, phase, detail):
            real_audit(db, operation_id, kind, staff_id, phase, detail)
            if phase == "intent":
                clock.now += 60  # the authorization lapses after the intent is durable, before the syscall

        store.audit = audit_then_lapse
        try:
            mkdir_id = str(uuid.uuid4())
            with self.assertRaises(Denied) as caught:
                self.mkdir("jobs/late", mkdir_id)
            self.assertEqual(caught.exception.code, "expired")
            self.assertFalse(os.path.exists(os.path.join(self.root, "jobs", "late")))
            with store.transaction() as db:
                self.assertIsNone(store.operation(db, mkdir_id))  # withdrawn: a fresh retry may proceed
            upload_id = self.staged("jobs/late.bin", b"late bytes")
            with self.assertRaises(Denied) as caught:
                self.run_op("upload.commit", {}, operation_id=upload_id)
            self.assertEqual(caught.exception.code, "expired")
            self.assertFalse(os.path.exists(os.path.join(self.root, "jobs", "late.bin")))
        finally:
            store.audit = real_audit
        self.assertEqual(self.run_op("upload.status", {}, operation_id=upload_id).body["state"], "open")
        self.assertEqual(self.mkdir("jobs/late", mkdir_id).status, 200)
        self.assertEqual(self.run_op("upload.commit", {}, operation_id=upload_id).status, 200)
        self.assertTrue(self.files.ready())

    def test_crash_between_reservation_and_staging_file_then_identical_retry_succeeds(self):
        data = b"retry me"
        operation_id = str(uuid.uuid4())
        args = {"path": "jobs/retry.bin", "parentId": self.root_id("jobs"), "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "precondition": {"kind": "create"}}
        real = self.files._ensure_part

        def crash(upload_id):
            # the crash lands after the staging file exists but before its inode was recorded
            os.close(os.open(os.path.join(self.internal, "uploads", upload_id + ".part"), os.O_WRONLY | os.O_CREAT, 0o600))
            raise RuntimeError("crash")

        self.files._ensure_part = crash
        with self.assertRaises(RuntimeError):
            self.run_op("upload.begin", args, operation_id=operation_id)
        self.restart()  # startup adopts the empty staging file attributable to the reservation
        self.assertEqual(self.run_op("upload.begin", args, operation_id=operation_id).body["state"], "open")
        self.run_op("upload.chunk", {"index": 0, "chunkSha256": hashlib.sha256(data).hexdigest(), "chunkSize": len(data)},
                    body=data, operation_id=operation_id)
        self.assertEqual(self.run_op("upload.commit", {}, operation_id=operation_id).status, 200)
        # Without a restart, an identical retry also finishes the interrupted creation.
        second = str(uuid.uuid4())
        self.files._ensure_part = lambda upload_id: (_ for _ in ()).throw(RuntimeError("crash"))
        with self.assertRaises(RuntimeError):
            self.run_op("upload.begin", dict(args, path="jobs/retry2.bin"), operation_id=second)
        del self.files._ensure_part
        self.assertEqual(self.run_op("upload.begin", dict(args, path="jobs/retry2.bin"), operation_id=second).status, 200)
        self.assertTrue(os.path.exists(os.path.join(self.internal, "uploads", second + ".part")))
        self.assertIs(real.__func__, StaffFiles._ensure_part)

    def test_delete_expiring_after_holder_allocation_leaves_source_and_no_holder(self):
        self.upload("jobs/keep.txt", b"keep me")
        trash = os.path.join(self.internal, "trash")
        clock, real_final = self.clock, self.files.final

        def final(envelope):
            if os.listdir(trash):  # the holder exists: lapse right before the source-to-trash rename
                clock.now += 60
            real_final(envelope)

        self.files.final = final
        operation_id = str(uuid.uuid4())
        with self.assertRaises(Denied) as caught:
            self.run_op("delete", {"path": "jobs/keep.txt", "id": self.id_of("jobs/keep.txt"),
                                   "etag": hashlib.sha256(b"keep me").hexdigest()}, operation_id=operation_id)
        self.assertEqual(caught.exception.code, "expired")
        self.assertTrue(os.path.exists(os.path.join(self.root, "jobs", "keep.txt")))
        self.assertEqual(os.listdir(trash), [])
        with self.files.store.transaction() as db:
            self.assertIsNone(self.files.store.operation(db, operation_id))
        del self.files.final

    def test_interrupted_prepare_does_not_leave_the_upload_stuck(self):
        operation_id = str(uuid.uuid4())
        self.run_op("upload.begin", {"path": "jobs/x.bin", "parentId": self.root_id("jobs"), "size": 1,
                                     "sha256": hashlib.sha256(b"x").hexdigest(), "precondition": {"kind": "create"}},
                    operation_id=operation_id)
        self.run_op("upload.chunk", {"index": 0, "chunkSha256": hashlib.sha256(b"x").hexdigest(), "chunkSize": 1},
                    body=b"x", operation_id=operation_id)
        os.unlink(os.path.join(self.internal, "uploads", operation_id + ".part"))
        with self.assertRaises(OSError):
            self.run_op("upload.commit", {}, operation_id=operation_id)
        self.assertEqual(self.files.committing, set())
        self.assertEqual(self.run_op("upload.status", {}, operation_id=operation_id).body["state"], "open")

    def test_single_writer_per_root(self):
        with self.assertRaises(Denied) as caught:
            StaffFiles(self.config, self.clock)
        self.assertEqual(caught.exception.code, "root-owned-by-another-instance")
        self.restart()  # once released, a new owner starts normally

    def test_mutations_are_serialized_root_wide(self):
        import threading
        self.mkdir("jobs/A")
        results = []
        with self.files.write_lock:
            worker = threading.Thread(target=lambda: results.append(self.mkdir("jobs/A/deep")))
            worker.start()
            worker.join(0.3)
            self.assertTrue(worker.is_alive())  # a descendant change waits for the root-wide lock
        worker.join(5)
        self.assertEqual(results[0].status, 200)

    def test_folder_handles_are_bound_to_the_checked_identity(self):
        envelope = self.envelope("mkdir", {"path": "jobs/new", "parentId": self.root_id("jobs")})
        plan = self.files.plan_mkdir(envelope, envelope["args"])
        intent = plan["check"]()
        os.rename(os.path.join(self.root, "jobs"), os.path.join(self.root, "jobs-old"))
        os.mkdir(os.path.join(self.root, "jobs"))  # same path, different folder
        with self.assertRaises(Exception) as caught:
            plan["apply"](intent)
        self.assertEqual(getattr(caught.exception, "code", None), "parent-changed")
        self.assertFalse(os.path.exists(os.path.join(self.root, "jobs", "new")))

    def test_status_needs_the_current_generation_and_scope(self):
        self.mkdir("jobs/A")
        done = self.mkdir("jobs/B")
        target = done.body["operationId"]
        self.assertEqual(self.run_op("op.status", {"targetOperationId": target}).status, 200)
        self.assertEqual(self.run_op("op.status", {"targetOperationId": target}, generation=2).status, 404)
        self.assertEqual(self.run_op("op.status", {"targetOperationId": target}, grant_path="jobs/A").status, 404)

    def test_quota_and_session_limits(self):
        with self.assertRaises(Denied) as caught:
            self.run_op("upload.begin", {"path": "jobs/big", "parentId": self.root_id("jobs"), "size": 65,
                                         "sha256": "0" * 64, "precondition": {"kind": "create"}})
        self.assertEqual(caught.exception.status, 413)
        begin = lambda name, size: self.run_op(  # noqa: E731
            "upload.begin", {"path": f"jobs/{name}", "parentId": self.root_id("jobs"), "size": size,
                             "sha256": "0" * 64, "precondition": {"kind": "create"}})
        begin("a", 60)
        with self.assertRaises(Denied) as caught:  # 60 + 60 exceeds the 100-byte grant reservation
            begin("b", 60)
        self.assertEqual(caught.exception.status, 507)
        begin("b", 10)
        with self.assertRaises(Denied) as caught:  # third open upload for the same person
            begin("c", 1)
        self.assertEqual(caught.exception.status, 429)

    def test_move_rename_and_own_subtree(self):
        self.mkdir("jobs/A")
        self.mkdir("jobs/B")
        moved = self.run_op("move", {"source": "jobs/A", "sourceId": self.id_of("jobs/A"), "sourceEtag": None,
                                     "destination": "jobs/B/A2", "destinationParentId": self.root_id("jobs/B")})
        self.assertEqual(moved.status, 200, moved.body)
        self.assertTrue(os.path.isdir(os.path.join(self.root, "jobs", "B", "A2")))
        recase = self.run_op("move", {"source": "jobs/B", "sourceId": self.id_of("jobs/B"), "sourceEtag": None,
                                      "destination": "jobs/b", "destinationParentId": self.root_id("jobs")})
        self.assertEqual(recase.status, 200, recase.body)
        with self.assertRaises(Denied):
            self.run_op("move", {"source": "jobs/b", "sourceId": self.id_of("jobs/b"), "sourceEtag": None,
                                 "destination": "jobs/b/A2/x", "destinationParentId": self.root_id("jobs/b/A2")})

    def test_delete_to_trash_and_restore(self):
        self.upload("jobs/keep.txt", b"keep me")
        deleted = self.run_op("delete", {"path": "jobs/keep.txt", "id": self.id_of("jobs/keep.txt"),
                                         "etag": hashlib.sha256(b"keep me").hexdigest()})
        self.assertEqual(deleted.status, 200, deleted.body)
        self.assertFalse(os.path.exists(os.path.join(self.root, "jobs", "keep.txt")))
        restored = self.run_op("trash.restore", {"trashId": deleted.body["result"]["trashId"]})
        self.assertEqual(restored.status, 200, restored.body)
        with open(os.path.join(self.root, "jobs", "keep.txt"), "rb") as stream:
            self.assertEqual(stream.read(), b"keep me")

    def test_restart_reconciliation_and_operator_hold(self):
        self.mkdir("jobs/A")
        object_id = self.id_of("jobs/A")
        operation_id = str(uuid.uuid4())
        intent = {"source": "jobs/A", "destination": "jobs/Z", "id": object_id}
        with self.files.store.transaction() as db:
            db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,'intent',?,NULL,NULL,0,0)",
                       (operation_id, "move", "d", STAFF, GRANT, 1, "jobs", json.dumps(intent)))
        os.rename(os.path.join(self.root, "jobs", "A"), os.path.join(self.root, "jobs", "Z"))  # applied before the crash
        self.assertEqual(self.restart().reconcile(), {})  # nothing pending after the decision
        with self.files.store.transaction() as db:
            self.assertEqual(self.files.store.operation(db, operation_id)["state"], "applied")
        lost = str(uuid.uuid4())
        with self.files.store.transaction() as db:
            db.execute("INSERT INTO operations VALUES(?,?,?,?,?,?,?,'intent',?,NULL,NULL,0,0)",
                       (lost, "move", "d", STAFF, GRANT, 1, "jobs",
                        json.dumps({"source": "jobs/gone", "destination": "jobs/also-gone", "id": object_id})))
        restarted = self.restart()
        with restarted.store.transaction() as db:
            self.assertEqual(restarted.store.operation(db, lost)["state"], "unknown")
        self.assertFalse(restarted.ready())
        with self.assertRaises(Denied) as caught:
            self.mkdir("jobs/new")
        self.assertEqual(caught.exception.status, 423)
        with self.assertRaises(ValueError):  # an operator cannot declare it applied without evidence
            restarted.resolve_hold(lost, "applied", "staging-qa")
        restarted.resolve_hold(lost, "rejected", "staging-qa")
        self.assertTrue(restarted.ready())
        self.assertEqual(self.mkdir("jobs/new").status, 200)

    def test_internal_storage_must_be_a_private_sibling(self):
        self.files.close()
        os.chmod(self.internal, 0o755)
        with self.assertRaises(Denied):
            StaffFiles(self.config, self.clock)


class HttpTests(unittest.TestCase):
    """The order of checks over a real socket: NAS link assertion, then the Files signature, then the body."""

    def setUp(self):
        import threading
        from employee_read_gateway.staff_files.server import StaffFilesServer
        self.service = ServiceTests("test_mkdir_is_idempotent_and_changed_intent_conflicts")
        self.service.setUp()
        self.access = AccessTests("test_reviewed_service_shape_is_accepted")
        self.access.setUp()
        self.write = ed25519.Ed25519PrivateKey.generate()
        keys = parse_public_keys(f"files-write:w1:{raw_public(self.write)}")
        self.access.clock.now = self.service.clock.now = time.time()
        self.server = StaffFilesServer(("127.0.0.1", 0), self.service.files, keys, self.access.keys, ISSUER)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.service.tearDown()

    def post(self, headers, body=b""):
        import http.client
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=10)
        connection.request("POST", "/v2/op", body=body, headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def envelope(self, **overrides):
        now = int(time.time())
        envelope = {"schemaVersion": 2, "scope": "files-write", "keyId": "w1", "nonce": uuid.uuid4().hex,
                    "issuedAt": now, "expiresAt": now + 20, "audience": AUDIENCE, "servicePrincipal": CLIENT_ID,
                    "method": "POST", "route": "/v2/op", "operationId": str(uuid.uuid4()),
                    "actor": {"staffId": STAFF, "accessSubject": "subject-1", "admissionVersion": 1},
                    "grant": {"grantId": GRANT, "grantGeneration": 1, "path": "jobs", "rights": ["read", "write"]},
                    "root": {"rootId": ROOT_ID, "rootGeneration": 1,
                             "rootFingerprint": self.service.config.root_fingerprint, "exclusive": True},
                    "operation": "mkdir", "args": {"path": "jobs/H", "parentId": self.service.root_id("jobs")},
                    "bodySha256": hashlib.sha256(b"").hexdigest()}
        envelope.update(overrides)
        raw = json.dumps(envelope).encode()
        return {"X-Ltfiles-Envelope": b64(raw), "X-Ltfiles-Signature": b64(self.write.sign(b"ltfiles-v2\n" + raw))}

    def test_link_then_signature_then_operation(self):
        signed = self.envelope()
        self.assertEqual(self.post(signed)[0], 404)  # no NAS link assertion: opaque 404
        link = {"Cf-Access-Jwt-Assertion": self.access.token()}
        self.assertEqual(self.post({**link, "X-Ltfiles-Envelope": signed["X-Ltfiles-Envelope"],
                                    "X-Ltfiles-Signature": b64(b"\0" * 64)})[0], 401)
        status, body = self.post({**link, **signed})
        self.assertEqual((status, body["state"]), (200, "applied"))
        self.assertEqual(self.post({**link, **signed})[1]["error"], "replayed-request")  # same nonce again

    def test_a_body_that_arrives_after_the_signature_expired_is_refused(self):
        import socket
        now = int(time.time())
        data = b"slow!"
        operation_id = str(uuid.uuid4())
        service = self.service
        service.clock.now = time.time()
        service.run_op("upload.begin", {"path": "jobs/slow.bin", "parentId": service.root_id("jobs"), "size": len(data),
                                        "sha256": hashlib.sha256(data).hexdigest(), "precondition": {"kind": "create"}},
                       operation_id=operation_id)
        service.clock.now = None
        service.files.clock = time.time
        headers = self.envelope(operationId=operation_id, operation="upload.chunk", issuedAt=now, expiresAt=now + 2,
                                args={"index": 0, "chunkSha256": hashlib.sha256(data).hexdigest(), "chunkSize": len(data)},
                                bodySha256=hashlib.sha256(data).hexdigest())
        headers["Cf-Access-Jwt-Assertion"] = self.access.token()
        head = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
        with socket.create_connection(("127.0.0.1", self.server.server_address[1]), timeout=10) as connection:
            connection.sendall(f"POST /v2/op HTTP/1.0\r\nContent-Length: {len(data)}\r\n{head}\r\n".encode())
            time.sleep(3.2)  # the body arrives after expiresAt
            connection.sendall(data)
            reply = connection.makefile("rb").read()
        self.assertIn(b" 401 ", reply.split(b"\r\n", 1)[0])
        self.assertIn(b'"expired"', reply)


if __name__ == "__main__":
    unittest.main()
