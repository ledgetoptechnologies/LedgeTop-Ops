import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL("./", import.meta.url));
const worker = fileURLToPath(new URL("../truenas/thumbnail-generation/thumbnail-queue-worker.sh", import.meta.url));
const server = fileURLToPath(new URL("./video-worker-smoke-server.py", import.meta.url));
const runner = fileURLToPath(new URL("./video-worker-smoke-runner.sh", import.meta.url));
const image = process.env.LTDSTHUMB_SMOKE_IMAGE ||
  "jrottenberg/ffmpeg@sha256:50171be54480baa9371be135493b034a9e08d2ff54eb873ce99963f12a24a187";

for (const scenario of [
  { name: "long", duration: "8", seek: "5s" },
  { name: "short", duration: "4", seek: "2.000000s" },
]) {
  const args = [
    "run", "--rm", `--name=ltds-video-worker-${scenario.name}-smoke`,
    "--tmpfs", "/scratch:rw,size=1g,mode=0700",
    "--add-host", "incoming.ledgetopdroneservices.com:127.0.0.1",
    "--add-host", "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com:127.0.0.1",
    "-e", `SMOKE_DURATION=${scenario.duration}`,
    "-e", `SMOKE_EXPECTED_SEEK=${scenario.seek}`,
    "-v", `${worker}:/scripts/thumbnail-queue-worker.sh:ro`,
    "-v", `${server}:/scripts/mock.py:ro`,
    "-v", `${runner}:/scripts/smoke.sh:ro`,
    "--entrypoint", "/bin/bash", image, "/scripts/smoke.sh",
  ];
  const result = spawnSync("docker", args, { cwd: testDir, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
