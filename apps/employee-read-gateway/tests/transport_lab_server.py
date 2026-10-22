"""Explicit local test fixture; never part of the production service entrypoint."""
import dataclasses
import json
import os
import tempfile

from employee_read_gateway.core import Gateway, ReplayStore, enroll
from employee_read_gateway.http_adapter import ReadServer

home = tempfile.mkdtemp(prefix="synthetic-transport-", dir="/tmp")
source, spool, state = [os.path.join(home, name) for name in ("source", "spool", "state")]
for directory in (source, spool, state):
    os.mkdir(directory, 0o700)
data = bytes((i * 31 + 17) % 251 for i in range(2 * 1024 * 1024))
with open(os.path.join(source, "map.bin"), "xb") as stream:
    stream.write(data)
os.chmod(os.path.join(source, "map.bin"), 0o600)
root = enroll(source, os.environ["SYNTHETIC_ROOT_ID"], 1)
gateway = Gateway(os.environ["SYNTHETIC_GATEWAY_ID"], [root],
                  {"synthetic-local-key": bytes.fromhex(os.environ["SYNTHETIC_KEY_HEX"])},
                  ReplayStore(os.path.join(state, "nonces.sqlite3")), spool,
                  max_file_bytes=4 * 1024 * 1024, max_spool_bytes=16 * 1024 * 1024, minimum_free_bytes=0)
print(json.dumps({"kind": "synthetic-employee-gateway-ready", "root": dataclasses.asdict(root)}), flush=True)
ReadServer(("0.0.0.0", 8080), gateway).serve_forever()
