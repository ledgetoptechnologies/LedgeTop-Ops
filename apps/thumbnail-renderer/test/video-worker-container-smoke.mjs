import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL("./", import.meta.url));
const server = fileURLToPath(new URL("./video-worker-smoke-server.py", import.meta.url));
const runner = fileURLToPath(new URL("./video-worker-smoke-runner.sh", import.meta.url));
const appDir = fileURLToPath(new URL("../", import.meta.url));
const image = process.env.LTDSTHUMB_SMOKE_IMAGE || "ltds-thumbnail-queue-worker:smoke";
if (!process.env.LTDSTHUMB_SMOKE_IMAGE) {
  const build = spawnSync("docker", ["build", "--target", "queue-worker", "-t", image, "."], {
    cwd: appDir, encoding: "utf8", stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
}

for (const scenario of [
  { name: "jpeg", kind: "image", duration: "0", seek: "", sourceFile: "source.jpg", imageFormat: "jpg" },
  { name: "png", kind: "image", duration: "0", seek: "", sourceFile: "source.png", imageFormat: "png", sourceKey: "Jobs/Synthetic/smoke.png", contentType: "image/png" },
  { name: "pdf", kind: "pdf", duration: "0", seek: "" },
  { name: "long-video", kind: "video", duration: "8", seek: "5s" },
  { name: "authenticated-proxy-video", kind: "video", duration: "8", seek: "5s", includePresigned: "0" },
  { name: "short-video", kind: "video", duration: "4", seek: "2.000000s" },
  {
    name: "tail-video", kind: "video", duration: "8", seek: "5s", faststart: "0",
    requireTailRange: "1", padBeforeMoovBytes: "268435456", requirePartialTransfer: "1",
  },
  { name: "disguised-video", kind: "video", duration: "8", seek: "5s", sourceKey: "Jobs/Synthetic/disguised.jpg", contentType: "video/mp4" },
]) {
  const args = [
    "run", "--rm", `--name=ltds-video-worker-${scenario.name}-smoke`,
    "--tmpfs", "/scratch:rw,size=1g,mode=0700,uid=568,gid=568",
    "--add-host", "incoming.ledgetopdroneservices.com:127.0.0.1",
    "--add-host", "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com:127.0.0.1",
    "-e", `SMOKE_KIND=${scenario.kind}`,
    "-e", `SMOKE_DURATION=${scenario.duration}`,
    "-e", `SMOKE_EXPECTED_SEEK=${scenario.seek}`,
    "-e", `SMOKE_SOURCE_KEY=${scenario.sourceKey || ""}`,
    "-e", `SMOKE_CONTENT_TYPE=${scenario.contentType || ""}`,
    "-e", `SMOKE_SOURCE_FILE=${scenario.sourceFile || ""}`,
    "-e", `SMOKE_IMAGE_FORMAT=${scenario.imageFormat || "jpg"}`,
    "-e", `SMOKE_FASTSTART=${scenario.faststart || "1"}`,
    "-e", `SMOKE_REQUIRE_TAIL_RANGE=${scenario.requireTailRange || "0"}`,
    "-e", `SMOKE_PAD_BEFORE_MOOV_BYTES=${scenario.padBeforeMoovBytes || "0"}`,
    "-e", `SMOKE_REQUIRE_PARTIAL_TRANSFER=${scenario.requirePartialTransfer || "0"}`,
    "-e", `SMOKE_INCLUDE_PRESIGNED=${scenario.includePresigned || "1"}`,
    "-v", `${server}:/scripts/mock.py:ro`,
    "-v", `${runner}:/scripts/smoke.sh:ro`,
    "--entrypoint", "/bin/bash", image, "-c",
    "sed 's/\\r$//' /scripts/smoke.sh > /scratch/smoke.sh && bash /scratch/smoke.sh",
  ];
  const result = spawnSync("docker", args, { cwd: testDir, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
