"""queue-renderer and the shared NAS link: today's config keeps the bearer; the successor drops it. Synthetic values only."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
ALL = ROOT / "compose.truenas.all.yaml"
BASE = ROOT / "compose.truenas.yaml"
SUCCESSOR = ROOT / "compose.queue-renderer.nas-link.yaml"
VALUES = {
    "MEDIA_JOBS_HOST_PATH": "/synthetic/jobs",
    "WORKERS_APP_DATA_HOST_PATH": "/synthetic/workers-app-data",
    "THUMBNAIL_INGEST_SECRET": "synthetic-renderer-token",
    "LTDSTHUMB_INGEST_URL": "https://ops.example.test/api/internal/thumbnail-ingest/v1",
    "LTDSTHUMB_BROKER_ACCESS_CLIENT_ID": "synthetic-access-id",
    "LTDSTHUMB_BROKER_ACCESS_CLIENT_SECRET": "synthetic-access-secret",
    "LTDSTHUMB_R2_ACCOUNT_ID": "synthetic-account",
    "LTDSTHUMB_R2_BUCKET_NAME": "synthetic-bucket",
    "LTDSTHUMB_R2_ACCESS_KEY_ID": "synthetic-object-read-id",
    "LTDSTHUMB_R2_SECRET_ACCESS_KEY": "synthetic-object-read-secret",
    "LOGS_BIND_ADDRESS": "192.0.2.10",
}
LINK = {"NAS_LINK_CLIENT_ID": "synthetic-link.access", "NAS_LINK_CLIENT_SECRET": "synthetic-link-secret-0000000000000000"}


def render(files, values, link=False):
    names = set(re.findall(r"\$\{([A-Z0-9_]+)", "".join(file.read_text() for file in (ALL, BASE, SUCCESSOR))))
    env = {key: value for key, value in os.environ.items() if key not in names and key != "COMPOSE_PROJECT_NAME"}
    with tempfile.TemporaryDirectory(prefix="renderer-link-test-") as temp:
        if link:
            link_file = Path(temp) / "nas-link.env"
            link_file.write_text("".join(f"{key}={value}\n" for key, value in LINK.items()))
            values = values | {"NAS_LINK_ENV_FILE": str(link_file)}
        env_file = Path(temp) / "synthetic.env"
        env_file.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        command = ["docker", "compose", "--env-file", str(env_file)]
        for file in files:
            command.extend(["-f", str(file)])
        command.extend(["config", "--format", "json"])
        return subprocess.run(command, env=env, cwd=temp, capture_output=True, text=True, timeout=30)


class RendererNasLinkTests(unittest.TestCase):
    def test_current_stack_keeps_the_bearer_until_its_retirement(self):
        result = render([ALL], VALUES)
        self.assertEqual(result.returncode, 0, result.stderr)
        queue = json.loads(result.stdout)["services"]["queue-renderer"]["environment"]
        self.assertEqual(queue["LTDSTHUMB_API_TOKEN"], "synthetic-renderer-token", "the bearer is kept explicitly")
        for file in (ALL, BASE):
            self.assertRegex(file.read_text(), r"LTDSTHUMB_API_TOKEN: \$\{THUMBNAIL_INGEST_SECRET:-\}")

    def test_successor_uses_only_the_shared_link_and_drops_the_bearer(self):
        result = render([ALL, SUCCESSOR], VALUES, link=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)["services"]
        queue = services["queue-renderer"]["environment"]
        self.assertNotIn("LTDSTHUMB_API_TOKEN", queue)
        self.assertEqual({key: queue[key] for key in LINK}, LINK)
        self.assertEqual(queue["CF_ACCESS_CLIENT_ID"], "", "no older pair, so the worker resolves the link pair")
        current = json.loads(render([ALL], VALUES, link=True).stdout)["services"]
        for name in services:
            if name != "queue-renderer":
                self.assertEqual(services[name], current[name], f"{name} unchanged by the successor")

    def test_retired_mode_needs_no_old_value(self):
        # Beau's live shape (proxy-generator + queue-renderer) with the successor and NO THUMBNAIL_INGEST_SECRET at all.
        base_values = {k: VALUES[k] for k in ("MEDIA_JOBS_HOST_PATH", "WORKERS_APP_DATA_HOST_PATH")}
        result = render([BASE, SUCCESSOR], base_values, link=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        queue = json.loads(result.stdout)["services"]["queue-renderer"]["environment"]
        self.assertNotIn("LTDSTHUMB_API_TOKEN", queue)
        self.assertEqual({key: queue[key] for key in LINK}, LINK)
        # The four-service stack still needs the value for the BROKER's own ingest credential, not for the renderer.
        all_values = {k: v for k, v in VALUES.items() if k != "THUMBNAIL_INGEST_SECRET"}
        failed = render([ALL, SUCCESSOR], all_values, link=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("THUMBNAIL_INGEST_SECRET", failed.stderr)

    def test_successor_requires_the_shared_file(self):
        self.assertNotEqual(render([ALL, SUCCESSOR], VALUES).returncode, 0)


if __name__ == "__main__":
    unittest.main()
