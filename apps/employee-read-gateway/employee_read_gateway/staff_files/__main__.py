"""Staff Files container entrypoint.

  serve          run the HTTP service (settings from the environment; the shared nas-link.env plus the root pin)
  enroll         print the root pin for /data/root (an operator copies it into Ops and the compose block)
  resolve-hold   settle an operation reconciliation could not decide (applied|rejected), recorded in the audit trail

Fixed layout: the dataset is mounted at /data; /data/root is served; /data/.ltfiles (uploads, trash, state) is its
sibling on the same filesystem. Nothing else is read or written.
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
    from .service import Config
    return Config(root_id=os.environ.get("FILES_ROOT_ID", ""), root_generation=int(os.environ.get("FILES_ROOT_GENERATION", "0")),
                  root_fingerprint=os.environ.get("FILES_ROOT_FINGERPRINT", ""), root_path=ROOT_PATH,
                  internal_path=INTERNAL_PATH, audience=os.environ.get("NAS_LINK_AUDIENCE", ""),
                  client_id=os.environ.get("NAS_LINK_CLIENT_ID", ""))


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
    StaffFilesServer(("0.0.0.0", 8080), files, keys, AccessKeys(issuer), issuer).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
