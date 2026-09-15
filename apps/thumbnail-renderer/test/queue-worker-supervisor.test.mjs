import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const supervisor = await readFile(new URL(
  "../truenas/thumbnail-generation/thumbnail-worker-supervisor.sh",
  import.meta.url,
), "utf8");
const compose = await readFile(new URL("../compose.truenas.yaml", import.meta.url), "utf8");
const queueCompose = await readFile(new URL("../compose.truenas.queue-renderer.yaml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const publishWorkflow = await readFile(new URL("../../../.github/workflows/publish-thumbnail-renderer.yml", import.meta.url), "utf8");

test("queue renderer uses a bounded isolated worker pool on RAM scratch", () => {
  assert.match(supervisor, /LTDSTHUMB_WORKER_CONCURRENCY:=4/);
  assert.match(supervisor, /LTDSTHUMB_WORKER_CONCURRENCY >= 1/);
  assert.match(supervisor, /LTDSTHUMB_WORKER_CONCURRENCY <= 8/);
  assert.match(supervisor, /stat -f -c '%T'/);
  assert.match(supervisor, /slot_dir="\$LTDSTHUMB_SCRATCH_DIR\/slot-\$slot"/);
  assert.match(supervisor, /LTDSTHUMB_WORKER_SLOT="\$slot"/);
  assert.match(supervisor, /wait -n/);
});

test("published queue-worker image owns every required decoder", () => {
  assert.match(dockerfile, /FROM common AS queue-worker/);
  for (const dependency of ["curl", "ffmpeg", "libvips-tools", "poppler-utils", "python3", "webp"]) {
    assert.match(dockerfile, new RegExp(`\\b${dependency.replace("-", "\\-")}\\b`));
  }
  assert.match(dockerfile, /thumbnail-worker-supervisor\.sh/);
});

test("TrueNAS service has no source mount and uses bounded tmpfs", () => {
  const service = compose.slice(compose.indexOf("  queue-renderer:"), compose.indexOf("\nnetworks:"));
  assert.match(service, /LTDSTHUMB_QUEUE_WORKER_IMAGE/);
  assert.match(service, /LTDSTHUMB_WORKER_CONCURRENCY/);
  assert.match(service, /\/scratch:rw,nosuid,nodev,noexec,size=/);
  assert.doesNotMatch(service, /volumes:/);
  assert.doesNotMatch(service, /R2_ACCESS_KEY|R2_SECRET/);
});

test("standalone queue renderer is pinned and hardened", () => {
  const service = queueCompose.slice(queueCompose.indexOf("  queue-renderer:"));
  assert.match(service, /image: ghcr\.io\/ledgetoptechnologies\/ltds-thumbnail-queue-worker@sha256:REPLACE_WITH_PUBLISHED_DIGEST/);
  assert.doesNotMatch(service, /:latest\b/);
  assert.match(service, /user: "568:568"/);
  assert.match(service, /init: true/);
  assert.match(service, /read_only: true/);
  assert.match(service, /cap_drop: \[ALL\]/);
  assert.match(service, /security_opt: \[no-new-privileges:true\]/);
  assert.match(service, /pids_limit: 256/);
});

test("standalone queue renderer bounds concurrency and RAM scratch without source or R2 mounts", () => {
  assert.match(queueCompose, /LTDSTHUMB_WORKER_CONCURRENCY: "4"/);
  assert.match(queueCompose, /mem_limit: 5g/);
  assert.match(queueCompose, /cpus: "4\.0"/);
  assert.match(queueCompose, /\/scratch:rw,nosuid,nodev,noexec,size=4g,mode=0700,uid=568,gid=568/);
  assert.match(queueCompose, /\/cache:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=568,gid=568/);
  assert.match(queueCompose, /\/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777/);
  assert.doesNotMatch(queueCompose, /\bvolumes:\s*$/m);
  assert.doesNotMatch(queueCompose, /JOBS_HOST_PATH|ARTIFACTS_HOST_PATH|WORK_HOST_PATH|STATE_HOST_PATH|\/data\/jobs/);
  assert.doesNotMatch(queueCompose, /R2_ACCESS_KEY|R2_SECRET|LTDSTHUMB_R2_/);
  assert.doesNotMatch(queueCompose, /apt-get/);
});

test("publish is blocked on source checks and proves the exact published all-media digest", () => {
  assert.equal((publishWorkflow.match(/actions\/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f/g) || []).length, 2);
  assert.equal((publishWorkflow.match(/node-version: 24/g) || []).length, 2);
  assert.match(publishWorkflow, /verify:\s*[\s\S]*npm --prefix apps\/thumbnail-renderer run check/);
  assert.match(publishWorkflow, /verify:\s*[\s\S]*npm --prefix apps\/thumbnail-renderer test/);
  assert.match(publishWorkflow, /publish:\s*\n\s+if:[^\n]+\n\s+needs: verify/);
  const readback = publishWorkflow.indexOf("Verify immutable commit tag digest");
  const smoke = publishWorkflow.indexOf("Prove the exact published all-media queue image");
  const receipt = publishWorkflow.indexOf("Write the immutable deployment receipt");
  assert.ok(readback > publishWorkflow.indexOf("Build and publish the linux/amd64 image"));
  assert.ok(smoke > readback);
  assert.ok(receipt > smoke);
  assert.match(publishWorkflow, /docker buildx imagetools inspect "\$\{TAG\}"/);
  assert.match(publishWorkflow, /"\$\{resolved_digest\}" != "\$\{EXPECTED_DIGEST\}"/);
  assert.match(publishWorkflow, /LTDSTHUMB_SMOKE_IMAGE: \$\{\{ steps\.names\.outputs\.image \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}/);
});
