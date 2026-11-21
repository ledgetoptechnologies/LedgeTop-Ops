"""Staff Files container entrypoint.

  serve          run the HTTP service (settings from the environment; the shared nas-link.env plus the root pin)
  enroll         print the root pin for /data/root (an operator copies it into Ops and the compose block)
  resolve-hold   settle an operation reconciliation could not decide (applied|rejected), recorded in the audit trail

Fixed layout: the dataset is mounted at /data; /data/root is served; /data/.ltfiles (uploads, trash, spool, state) is its
sibling on the same filesystem. Nothing else is read or written.

Writes are enabled only by a verified FILES_ROOT_INVENTORY bound to FILES_HOST, FILES_DATASET (the host path mounted at
/data) and FILES_GATEWAY_ID (inventory.py). Reads (/v1/read) need a files-read public key.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys

from ..core import enroll

ROOT_PATH, INTERNAL_PATH = "/data/root", "/data/.ltfiles"


def _config():
    from .inventory import check_inventory
    from .service import Config
    root_id, generation = os.environ.get("FILES_ROOT_ID", ""), int(os.environ.get("FILES_ROOT_GENERATION", "0"))
    fingerprint = os.environ.get("FILES_ROOT_FINGERPRINT", "")
    writes, reason = check_inventory(os.environ.get("FILES_ROOT_INVENTORY"), host=os.environ.get("FILES_HOST", ""),
                                     dataset=os.environ.get("FILES_DATASET", ""), gateway_id=os.environ.get("FILES_GATEWAY_ID", ""),
                                     root_id=root_id, root_generation=generation, root_fingerprint=fingerprint)
    print(json.dumps({"event": "inventory", "writes": writes, "reason": reason}), flush=True)  # no paths or values
    return Config(root_id=root_id, root_generation=generation, root_fingerprint=fingerprint, root_path=ROOT_PATH,
                  internal_path=INTERNAL_PATH, audience=os.environ.get("NAS_LINK_AUDIENCE", ""),
                  client_id=os.environ.get("NAS_LINK_CLIENT_ID", ""), writes_enabled=writes)


def _reader(files, read_keys):
    """The v1 read gateway over the same pinned root, or None without a files-read key."""
    if not read_keys:
        return None
    from ..core import ReplayStore, Root
    from .read import Ed25519ReadGateway
    pin = enroll(ROOT_PATH, files.config.root_id, files.config.root_generation)
    if pin.fingerprint != files.config.root_fingerprint:
        raise ValueError("root pin changed")
    os.close(files._private_child(files.internal_fd, "spool"))
    return Ed25519ReadGateway(os.environ.get("FILES_GATEWAY_ID", ""), [Root(**dataclasses.asdict(pin))], read_keys,
                              ReplayStore(os.path.join(INTERNAL_PATH, "state", "read-nonces.sqlite3")), os.path.join(INTERNAL_PATH, "spool"))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m employee_read_gateway.staff_files")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve")
    enrolling = commands.add_parser("enroll")
    enrolling.add_argument("--root-id", required=True)
    enrolling.add_argument("--generation", type=int, required=True)
    holding = commands.add_parser("resolve-hold")
    holding.add_argument("--operation-id", required=True)
    holding.add_argument("--as", dest="decision", choices=("applied", "rejected"), required=True)
    holding.add_argument("--operator", required=True)
    args = parser.parse_args(argv)
    if args.command == "enroll":
        print(json.dumps(dataclasses.asdict(enroll(ROOT_PATH, args.root_id, args.generation))))
        return 0
    from .access import DEFAULT_ISSUER, AccessKeys, canonical_issuer
    from .server import StaffFilesServer
    from .service import StaffFiles
    from .signing import parse_public_keys
    files = StaffFiles(_config())
    if args.command == "resolve-hold":
        files.resolve_hold(args.operation_id, args.decision, args.operator)
        return 0
    issuer = canonical_issuer(os.environ.get("ACCESS_ISSUER") or DEFAULT_ISSUER)
    keys = parse_public_keys(os.environ.get("OPS_FILES_SIGNING_PUBLIC_KEYS"))
    StaffFilesServer(("0.0.0.0", 8080), files, keys, AccessKeys(issuer), issuer, reader=_reader(files, keys["files-read"])).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
