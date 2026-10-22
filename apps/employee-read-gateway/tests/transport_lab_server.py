"""Explicit local test fixture; never part of the production service entrypoint."""
import dataclasses
import hashlib
import json
import os
import shutil
import tempfile

from employee_read_gateway.core import Gateway, ReplayStore, enroll
from employee_read_gateway.http_adapter import ReadServer

large = os.environ.get("SYNTHETIC_LARGE_FILE") == "1"
if os.environ.get("SYNTHETIC_LARGE_FILE") not in (None, "1"):
    raise ValueError("Explicit bounded large-file mode required")
length = 3 * 1024**3 + 17 if large else 2 * 1024**2
base = "/synthetic" if large else "/tmp"
volume_available_before = shutil.disk_usage(base).free
if large and volume_available_before < length * 3 + 512 * 1024**2:
    raise ValueError("Insufficient local volume space for source and two snapshots")
home = tempfile.mkdtemp(prefix="synthetic-transport-", dir=base)
source, spool, state = [os.path.join(home, name) for name in ("source", "spool", "state")]
for directory in (source, spool, state):
    os.mkdir(directory, 0o700)
digest = hashlib.sha256()
# The block length is a multiple of the 251-byte pattern period. Repetition
# therefore preserves the existing deterministic fixture bytes at every offset.
block = bytes((i * 31 + 17) % 251 for i in range(251)) * 4096
with open(os.path.join(source, "map.bin"), "xb") as stream:
    remaining = length
    while remaining:
        part = block[:min(remaining, len(block))]
        stream.write(part)
        digest.update(part)
        remaining -= len(part)
    stream.flush()
    os.fsync(stream.fileno())
os.chmod(os.path.join(source, "map.bin"), 0o600)
root = enroll(source, os.environ["SYNTHETIC_ROOT_ID"], 1)
gateway = Gateway(os.environ["SYNTHETIC_GATEWAY_ID"], [root],
                  {"synthetic-local-key": bytes.fromhex(os.environ["SYNTHETIC_KEY_HEX"])},
                  ReplayStore(os.path.join(state, "nonces.sqlite3")), spool,
                  max_file_bytes=length if large else 4 * 1024**2,
                  max_spool_bytes=length * 2 + 32 * 1024**2 if large else 16 * 1024**2,
                  minimum_free_bytes=256 * 1024**2 if large else 0)
print(json.dumps({"kind": "synthetic-employee-gateway-ready", "root": dataclasses.asdict(root),
                  "bytes": length, "sha256": digest.hexdigest(), "volumeAvailableBytesBefore": volume_available_before,
                  "sourceAllocatedBytes": os.stat(os.path.join(source, "map.bin")).st_blocks * 512,
                  "volumeAvailableBytes": shutil.disk_usage(base).free}), flush=True)
ReadServer(("0.0.0.0", 8080), gateway).serve_forever()
