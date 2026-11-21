"""Slice 2c: v1 reads signed with the files-read Ed25519 key, and the root inventory gate for writes."""
import base64
import hashlib
import json
import os
import tempfile
import time
import unittest
import uuid

from cryptography.hazmat.primitives.asymmetric import ed25519

from employee_read_gateway.core import ReplayStore, enroll
from employee_read_gateway.errors import Denied
from employee_read_gateway.staff_files.inventory import check_inventory, config_sha256
from employee_read_gateway.staff_files.read import Ed25519ReadGateway


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class ReadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ltfiles-read-")
        home = self.temporary.name
        self.source, spool, state = [os.path.join(home, name) for name in ("source", "spool", "state")]
        for directory in (self.source, spool, state):
            os.mkdir(directory, 0o700)
        with open(os.path.join(self.source, "map.bin"), "wb") as stream:
            stream.write(b"synthetic")
        self.gateway_id, self.root_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.root = enroll(self.source, self.root_id, 1)
        self.read_key, self.write_key = ed25519.Ed25519PrivateKey.generate(), ed25519.Ed25519PrivateKey.generate()
        self.gateway = Ed25519ReadGateway(self.gateway_id, [self.root], {"read-1": self.read_key.public_key()},
                                          ReplayStore(os.path.join(state, "nonces.sqlite3")), spool, minimum_free_bytes=0)

    def tearDown(self):
        self.gateway.close()
        self.temporary.cleanup()

    def body(self, **changes):
        now = int(time.time())
        value = dict(schemaVersion=1, gatewayId=self.gateway_id, rootId=self.root_id, rootGeneration=1, rootFingerprint=self.root.fingerprint,
                     staffId="synthetic-staff-1", accessSubject="synthetic-subject", admissionVersion=1, profileVersion=1,
                     grantId=str(uuid.uuid4()), grantGeneration=1, operation="list", path="", expectedSha256=None, range=None,
                     cursor=None, snapshotId=None, expiresAt=now + 25, deadlineAt=now + 120)
        value.update(changes)
        return json.dumps(value, separators=(",", ":")).encode()

    def headers(self, body, key=None, key_id="read-1", domain="ltfiles-v1read", **extra):
        timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
        message = "\n".join([domain, self.gateway_id, key_id, timestamp, nonce, "POST", "/v1/read", hashlib.sha256(body).hexdigest()]).encode()
        signature = (key or self.read_key).sign(message)
        return {"Content-Type": "application/json", "X-Ltfiles-Read-Key-Id": key_id, "X-Ltfiles-Read-Time": timestamp,
                "X-Ltfiles-Read-Nonce": nonce, "X-Ltfiles-Read-Signature": b64(signature), **extra}

    def test_files_read_signature_serves_the_v1_protocol(self):
        body = self.body()
        reply = self.gateway.execute(self.headers(body), body)
        self.assertEqual(reply.status, 200)
        self.assertEqual(json.loads(reply.body)["entries"], [{"name": "map.bin", "kind": "file"}])

    def test_only_the_files_read_scheme_is_accepted(self):
        body = self.body()
        cases = {
            "write key": self.headers(body, key=self.write_key),
            "unknown key id": self.headers(body, key_id="write-1"),
            "wrong domain": self.headers(body, domain="ltfiles-v2"),
            "body mismatch": self.headers(self.body(path="other")),
            "HMAC headers alongside": self.headers(body, **{"X-Ops-Read-Key-Id": "read-1", "X-Ops-Read-Signature": "0" * 64}),
        }
        for name, headers in cases.items():
            with self.subTest(name=name), self.assertRaises(Denied) as caught:
                self.gateway.execute(headers, body)
            self.assertEqual(caught.exception.status, 401)
        hmac_only = {"Content-Type": "application/json", "X-Ops-Read-Key-Id": "read-1", "X-Ops-Read-Time": str(int(time.time())),
                     "X-Ops-Read-Nonce": uuid.uuid4().hex, "X-Ops-Read-Signature": "0" * 64}
        with self.assertRaises(Denied):
            self.gateway.execute(hmac_only, body)

    def test_a_signed_read_is_single_use(self):
        body = self.body()
        headers = self.headers(body)
        self.gateway.execute(headers, body)
        with self.assertRaises(Denied) as caught:
            self.gateway.execute(headers, body)
        self.assertEqual(caught.exception.code, "replayed-request")


class InventoryTests(unittest.TestCase):
    HOST, DATASET, GATEWAY, ROOT, FP = "nas-staging", "/mnt/pool/files-test", str(uuid.uuid4()), str(uuid.uuid4()), "f" * 64

    def inventory(self, **changes):
        value = {"host": self.HOST, "dataset": self.DATASET, "gatewayId": self.GATEWAY,
                 "configSha256": config_sha256(self.HOST, self.DATASET, self.GATEWAY, self.ROOT, 1, self.FP),
                 "otherRoots": [], "smbShares": ["/mnt/pool/shared"], "cloudSyncSources": ["/mnt/pool/delivered"], "managedRoots": [],
                 "verifiedBy": "qa-receipt-20261121"}
        value.update(changes)
        return json.dumps({k: v for k, v in value.items() if v is not ...})

    def check(self, text):
        return check_inventory(text, host=self.HOST, dataset=self.DATASET, gateway_id=self.GATEWAY, root_id=self.ROOT,
                               root_generation=1, root_fingerprint=self.FP)

    def test_a_complete_bound_inventory_enables_writes(self):
        self.assertEqual(self.check(self.inventory()), (True, "ok"))
        self.assertEqual(self.check(self.inventory(smbShares=[], cloudSyncSources=[])), (True, "ok"))  # explicit empty lists

    def test_missing_partial_unbound_or_unverified_inventories_disable_writes(self):
        cases = {
            "missing": None, "empty": "", "not json": "{", "omitted list": self.inventory(managedRoots=...),
            "null list": self.inventory(smbShares=None), "other host": self.inventory(host="other"),
            "other dataset": self.inventory(dataset="/mnt/pool/other"), "other gateway": self.inventory(gatewayId=str(uuid.uuid4())),
            "stale config": self.inventory(configSha256="0" * 64), "unverified": self.inventory(verifiedBy=""),
            "extra key": json.dumps({**json.loads(self.inventory()), "note": 1}),
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                self.assertFalse(self.check(text)[0])

    def test_overlap_and_alias_disable_writes(self):
        other = lambda path, root=None: [{"gatewayId": str(uuid.uuid4()), "rootId": root or str(uuid.uuid4()), "hostPath": path}]  # noqa: E731
        cases = {
            "share is an ancestor": self.inventory(smbShares=["/mnt/pool"]),
            "share is a descendant": self.inventory(smbShares=["/mnt/pool/files-test/sub"]),
            "share is the dataset": self.inventory(smbShares=["/mnt/pool/files-test"]),
            "cloud sync over it": self.inventory(cloudSyncSources=["/mnt"]),
            "managed root inside": self.inventory(managedRoots=["/mnt/pool/files-test/x"]),
            "other root overlaps": self.inventory(otherRoots=other("/mnt/pool/files-test/inner")),
            "same root id elsewhere": self.inventory(otherRoots=other("/mnt/pool/elsewhere", self.ROOT)),
            "relative path": self.inventory(smbShares=["mnt/pool"]),
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                self.assertFalse(self.check(text)[0])
        self.assertTrue(self.check(self.inventory(smbShares=["/mnt/pool/files-test2"]))[0])  # a sibling prefix is not overlap


if __name__ == "__main__":
    unittest.main()
