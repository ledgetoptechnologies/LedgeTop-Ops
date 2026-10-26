"""Render deployment templates with synthetic values; never start containers."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
BASE = ROOT / "compose.truenas.yaml"
PREBUILT = ROOT / "compose.truenas.prebuilt.yaml"
ALL = ROOT / "compose.truenas.all.yaml"
THUMBNAIL = ROOT.parent / "thumbnail-renderer" / "compose.truenas.yaml"
STANDALONE = ROOT.parent / "thumbnail-renderer" / "compose.truenas.queue-renderer.yaml"
VALUES = {
    "MEDIA_JOBS_HOST_PATH": "/synthetic/jobs",
    "LTDSPROXY_STATE_HOST_PATH": "/synthetic/proxy-state",
    "THUMBNAIL_INGEST_SECRET": "synthetic-renderer-token",
}
OPTIONAL = {
    "LTDSTHUMB_ARTIFACTS_HOST_PATH": "/synthetic/artifacts",
    "LTDSTHUMB_WORK_HOST_PATH": "/synthetic/work",
    "LTDSTHUMB_CACHE_HOST_PATH": "/synthetic/cache",
    "LTDSTHUMB_STATE_HOST_PATH": "/synthetic/thumbnail-state",
    "LTDSTHUMB_INGEST_URL": "https://ops.example.test/api/internal/thumbnail-ingest/v1",
    "LTDSTHUMB_BROKER_ACCESS_CLIENT_ID": "synthetic-access-id",
    "LTDSTHUMB_BROKER_ACCESS_CLIENT_SECRET": "synthetic-access-secret",
    "LTDSTHUMB_R2_ACCOUNT_ID": "synthetic-account",
    "LTDSTHUMB_R2_BUCKET_NAME": "synthetic-bucket",
    "LTDSTHUMB_R2_ACCESS_KEY_ID": "synthetic-object-read-id",
    "LTDSTHUMB_R2_SECRET_ACCESS_KEY": "synthetic-object-read-secret",
}


def render(files, values, expect_success=True):
    # Do not inherit operator substitution values or .env contents.
    names = set(re.findall(r"\$\{([A-Z0-9_]+)", "".join(file.read_text() for file in (BASE, PREBUILT, ALL, THUMBNAIL, STANDALONE))))
    env = {key: value for key, value in os.environ.items() if key not in names}
    with tempfile.TemporaryDirectory(prefix="ltds-compose-test-") as temp:
        env_file = Path(temp) / "synthetic.env"
        env_file.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
        command = ["docker", "compose", "--env-file", str(env_file)]
        for file in files:
            command.extend(["-f", str(file)])
        command.extend(["config", "--format", "json"])
        result = subprocess.run(command, env=env, cwd=temp, capture_output=True, text=True, timeout=30)
    if expect_success:
        if result.returncode:
            raise AssertionError(f"Synthetic Compose rendering failed: {result.stderr}")
        return json.loads(result.stdout)
    if result.returncode == 0:
        raise AssertionError("Compose accepted a missing required deployment value")
    return result


class MediaComposeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = render([BASE], VALUES)["services"]
        cls.full = render([BASE, PREBUILT], VALUES | OPTIONAL)["services"]
        cls.all = render([ALL], VALUES | OPTIONAL)["services"]

    def test_default_requires_no_prebuilt_configuration(self):
        self.assertEqual(set(self.base), {"proxy-generator", "queue-renderer"})
        self.assertEqual(set(self.full), {"proxy-generator", "queue-renderer", "decoder", "broker"})
        for name in self.base:
            self.assertEqual(self.base[name], self.full[name])
        self.assertEqual(self.base["proxy-generator"]["environment"]["MAX_CONCURRENT"], "6")
        self.assertEqual(self.base["proxy-generator"]["environment"]["PROXY_MAX_HEIGHT"], "720")
        self.assertEqual(self.base["proxy-generator"]["environment"]["FORCE_PROXY_REGENERATION_VERSION"], "6")
        self.assertEqual(self.base["queue-renderer"]["environment"]["LTDSTHUMB_WORKER_CONCURRENCY"], "4")

    def test_independent_hardened_services(self):
        for name, service in self.full.items():
            with self.subTest(service=name):
                self.assertTrue(service["read_only"])
                self.assertEqual(service["user"], "568:568")
                self.assertIn("ALL", service["cap_drop"])
                self.assertIn("no-new-privileges:true", service["security_opt"])
                self.assertFalse(service.get("ports"))
                self.assertFalse(service.get("depends_on"))
                self.assertFalse(service.get("privileged", False))
                self.assertGreater(float(service["cpus"]), 0)
                self.assertRegex(str(service["mem_limit"]), r"^[1-9][0-9]*(?:[bkmgBKMG])?$")
                self.assertRegex(service["image"], r"^ghcr\.io/ledgetoptechnologies/ltds-[a-z-]+:latest$")
                self.assertEqual(service["pull_policy"], "always")
                for volume in service.get("volumes", []):
                    # Some Compose versions omit explicit false values when
                    # serializing normalized configuration. Also inspect the
                    # source below so omission cannot hide a removed safeguard.
                    self.assertFalse(volume.get("bind", {}).get("create_host_path", False))

        for source in (BASE, PREBUILT, ALL):
            text = source.read_text()
            self.assertEqual(len(re.findall(r"(?m)^\s*- type: bind\s*$", text)),
                len(re.findall(r"(?m)^\s*create_host_path: false\s*$", text)))

    def test_media_and_credential_boundaries(self):
        proxy = self.full["proxy-generator"]
        decoder = self.full["decoder"]
        broker = self.full["broker"]
        queue = self.full["queue-renderer"]
        for service in (proxy, decoder):
            self.assertEqual(service["network_mode"], "none")
            self.assertFalse(any(re.search(r"TOKEN|SECRET|ACCESS_KEY|API_BASE", key) for key in service["environment"]))
        proxy_mounts = {volume["target"]: volume for volume in proxy["volumes"]}
        decoder_mounts = {volume["target"]: volume for volume in decoder["volumes"]}
        self.assertFalse(proxy_mounts["/data/jobs"].get("read_only", False))
        self.assertEqual(proxy_mounts["/data/jobs"]["source"], "/synthetic/jobs")
        self.assertEqual(proxy_mounts["/state"]["source"], "/synthetic/proxy-state")
        self.assertTrue(decoder_mounts["/data/jobs"]["read_only"])
        self.assertEqual(decoder_mounts["/data/jobs"]["source"], "/synthetic/jobs")
        self.assertNotIn("/data/jobs", {volume["target"] for volume in broker["volumes"]})
        self.assertFalse(queue.get("volumes"))
        self.assertEqual(queue["environment"]["CF_ACCESS_CLIENT_ID"], "")
        self.assertEqual(broker["environment"]["CF_ACCESS_CLIENT_ID"], "synthetic-access-id")
        self.assertFalse(any("R2_" in key for key in queue["environment"]))
        self.assertTrue(any(mount.startswith("/scratch:") for mount in queue["tmpfs"]))

    def test_required_values_fail_closed(self):
        for missing in ("MEDIA_JOBS_HOST_PATH", "LTDSPROXY_STATE_HOST_PATH", "THUMBNAIL_INGEST_SECRET"):
            with self.subTest(missing=missing):
                render([BASE], {key: value for key, value in VALUES.items() if key != missing}, expect_success=False)
        render([BASE, PREBUILT], VALUES, expect_success=False)

    def test_custom_user_owns_queue_tmpfs(self):
        custom = render([BASE], VALUES | {"PUID": "1234", "PGID": "5678"})["services"]
        for service in custom.values():
            self.assertEqual(service["user"], "1234:5678")
        for mount in custom["queue-renderer"]["tmpfs"]:
            if mount.startswith(("/scratch:", "/cache:")):
                self.assertIn("uid=1234,gid=5678", mount)

    def test_single_document_matches_full_stack_and_pins_user(self):
        self.assertEqual(self.all, self.full)
        fixed_user = render([ALL], VALUES | OPTIONAL | {"PUID": "1234", "PGID": "5678"})["services"]
        for service in fixed_user.values():
            self.assertEqual(service["user"], "568:568")
        for mount in fixed_user["queue-renderer"]["tmpfs"]:
            if mount.startswith(("/scratch:", "/cache:")):
                self.assertIn("uid=568,gid=568", mount)
        render([ALL], VALUES, expect_success=False)

    def test_smaller_proxy_profile_override(self):
        smaller = render([ALL], VALUES | OPTIONAL | {"LTDSPROXY_MAX_HEIGHT": "540"})["services"]
        self.assertEqual(smaller["proxy-generator"]["environment"]["PROXY_MAX_HEIGHT"], "540")

    def test_latest_images_and_queue_profile_in_every_deployment(self):
        expected = {
            "proxy-generator": "ghcr.io/ledgetoptechnologies/ltds-proxy-generator:latest",
            "queue-renderer": "ghcr.io/ledgetoptechnologies/ltds-thumbnail-queue-worker:latest",
            "decoder": "ghcr.io/ledgetoptechnologies/ltds-thumbnail-decoder:latest",
            "broker": "ghcr.io/ledgetoptechnologies/ltds-thumbnail-broker:latest",
        }
        thumbnail_values = VALUES | OPTIONAL | {
            "LTDSTHUMB_JOBS_HOST_PATH": "/synthetic/jobs",
            "CF_ACCESS_CLIENT_ID": "synthetic-access-id",
            "CF_ACCESS_CLIENT_SECRET": "synthetic-access-secret",
        }
        deployments = [self.base, self.full, self.all,
            render([THUMBNAIL], thumbnail_values)["services"],
            render([STANDALONE], {})["services"]]
        for services in deployments:
            for name, service in services.items():
                with self.subTest(service=name):
                    self.assertEqual(service["image"], expected[name])
                    self.assertEqual(service["pull_policy"], "always")
        for services in (self.base, self.all):
            queue = services["queue-renderer"]
            self.assertEqual(queue["container_name"], "ltds-thumbnail-gen")
            self.assertEqual(float(queue["cpus"]), 8.0)
            self.assertEqual(int(queue["mem_limit"]), 10 * 1024**3)
            self.assertEqual(queue["pids_limit"], 256)
            self.assertEqual(queue["logging"]["options"]["max-file"], "3")


if __name__ == "__main__":
    unittest.main()
