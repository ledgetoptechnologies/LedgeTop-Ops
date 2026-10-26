"""Prove that a fresh, writable app-data root needs no pre-created child folders.

Uses disposable, labelled Docker volumes, synthetic credentials, an empty Jobs
volume, and disabled container networking. Never mounts the operator's dataset.
"""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

from test_compose import ALL, OPTIONAL, VALUES, render


def run(arguments):
    return subprocess.run(arguments, capture_output=True, text=True, check=True, timeout=120).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proxy-image", default="proxy-generator:canary")
    args = parser.parse_args()
    services = render([ALL], VALUES | OPTIONAL)["services"]
    marker = uuid.uuid4().hex
    label = "codex.proxy-storage-test"
    volumes = []
    try:
        for suffix in ("data", "jobs"):
            name = f"proxy-storage-test-{marker}-{suffix}"
            run(["docker", "volume", "create", "--label", f"{label}={marker}", name])
            volumes.append(name)
        data, jobs = volumes
        run(["docker", "run", "--rm", "--network", "none", "--read-only",
            "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN",
            "--mount", f"type=volume,source={data},target=/app-data",
            "--entrypoint", "python3", args.proxy_image,
            "-c", "import os; os.chown('/app-data', 568, 568)"])

        def container(image, environment, command, source=False, tmpfs=()):
            options = ["docker", "run", "--rm", "--network", "none", "--read-only",
                "--user", "568:568", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--pids-limit", "128", "--mount", f"type=volume,source={data},target=/app-data",
                "--mount", f"type=volume,source={jobs},target=/data/jobs,readonly"]
            for key, value in environment.items():
                options += ["--env", f"{key}={value}"]
            for specification in tmpfs:
                options += ["--tmpfs", specification]
            if source:
                module_root = (Path(__file__).resolve().parent.parent / "thumbnail-renderer").as_posix()
                options += ["--mount", f"type=bind,source={module_root},target=/app,readonly"]
            return run(options + command[:2] + [image] + command[2:])

        container(args.proxy_image, services["proxy-generator"]["environment"],
            ["--entrypoint", "python3", "/app/proxy_generator.py", "--once"],
            tmpfs=services["proxy-generator"]["tmpfs"])
        decoder = services["decoder"]["environment"]
        container("node:24-bookworm-slim", decoder, ["--entrypoint", "node", "--input-type=module", "-e",
            "import {readDecoderConfig} from '/app/src/config.mjs';"
            "import {runWatcher} from '/app/src/watcher.mjs';"
            "await runWatcher(readDecoderConfig(), {signal:AbortSignal.abort()});"], source=True,
            tmpfs=services["decoder"]["tmpfs"])
        broker = services["broker"]["environment"] | {
            "THUMBNAIL_INGEST_SECRET": "synthetic-" + "s" * 40,
            "CF_ACCESS_CLIENT_ID": "synthetic-" + "i" * 20,
            "CF_ACCESS_CLIENT_SECRET": "synthetic-" + "s" * 40,
            "LTDSTHUMB_R2_ACCOUNT_ID": "0" * 32,
            "LTDSTHUMB_R2_ACCESS_KEY_ID": "synthetic-key-000000",
            "LTDSTHUMB_R2_SECRET_ACCESS_KEY": "synthetic-" + "s" * 40,
        }
        container("node:24-bookworm-slim", broker, ["--entrypoint", "node", "--input-type=module", "-e",
            "import {readBrokerConfig} from '/app/src/config.mjs';"
            "import {runBroker} from '/app/src/broker.mjs';"
            "await runBroker(readBrokerConfig(), {signal:AbortSignal.abort()});"], source=True,
            tmpfs=services["broker"]["tmpfs"])
        container(args.proxy_image, {}, ["--entrypoint", "python3", "-c",
            "from pathlib import Path; "
            "[(Path(p)/'mount-write-test').write_bytes(b'ok') for p in ('/scratch','/cache','/tmp')]; "
            "assert all((Path(p)/'mount-write-test').stat().st_uid==568 for p in ('/scratch','/cache','/tmp'))"],
            tmpfs=services["queue-renderer"]["tmpfs"])
        print(container(args.proxy_image, {}, ["--entrypoint", "python3", "-c",
            "from pathlib import Path; p=Path('/app-data'); "
            "expected={'proxy-state','thumbnail-artifacts','thumbnail-work','thumbnail-cache','thumbnail-state'}; "
            "assert {x.name for x in p.iterdir()}==expected; "
            "assert (p/'proxy-state/jobs.sqlite').is_file(); "
            "assert all((p/x).is_dir() for x in ('thumbnail-state/decoder','thumbnail-state/broker',"
            "'thumbnail-artifacts/prebuilt','thumbnail-artifacts/receipts','thumbnail-work/jobs')); "
            "assert all(x.stat().st_uid==568 and x.stat().st_gid==568 for x in p.rglob('*')); "
            "print('Fresh dataset startup passed: five folders created automatically as 568:568.')"]), end="")
    finally:
        for name in reversed(volumes):
            metadata = json.loads(run(["docker", "volume", "inspect", name]))[0]
            if metadata.get("Labels", {}).get(label) != marker:
                raise RuntimeError("Refusing to remove a volume without the exact test ownership label")
            run(["docker", "volume", "rm", name])


if __name__ == "__main__":
    main()
