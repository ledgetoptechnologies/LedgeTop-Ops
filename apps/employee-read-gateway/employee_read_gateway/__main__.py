"""Explicit enrollment and file-configured service startup; never discover roots or keys."""
import argparse
import dataclasses
import json
import os
import stat

from .core import Gateway, ReplayStore, Root, enroll, private_directory
from .http_adapter import ReadServer


def private_file(path):
    private_directory(os.path.dirname(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() \
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 65536:
            raise ValueError("Private regular configuration file required")
        return stream.read(65537)


def main():
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    enrollment = subcommands.add_parser("enroll")
    enrollment.add_argument("--root-path", required=True)
    enrollment.add_argument("--root-id", required=True)
    enrollment.add_argument("--generation", type=int, required=True)
    serving = subcommands.add_parser("serve")
    serving.add_argument("--config", required=True)
    args = parser.parse_args()
    if args.command == "enroll":
        print(json.dumps(dataclasses.asdict(enroll(args.root_path, args.root_id, args.generation))))
        return
    settings = json.loads(private_file(args.config))
    key = private_file(settings["keyFile"])
    if not 32 <= len(key) <= 128:
        raise ValueError("Dedicated binary signing key must be 32..128 bytes")
    state = settings["stateDirectory"]
    private_directory(state)
    gateway = Gateway(settings["gatewayId"], [Root(**item) for item in settings["roots"]],
                      {settings["keyId"]: key}, ReplayStore(os.path.join(state, "replay.sqlite3"), settings.get("nonceCapacity", 10000)),
                      settings["spoolDirectory"], **settings.get("limits", {}))
    ReadServer((settings.get("listenHost", "127.0.0.1"), settings.get("listenPort", 8080)), gateway).serve_forever()


if __name__ == "__main__":
    main()
