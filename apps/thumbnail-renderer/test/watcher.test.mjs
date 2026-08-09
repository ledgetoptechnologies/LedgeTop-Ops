import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { processSource, scanOnce } from "../src/watcher.mjs";
import { RendererError } from "../src/errors.mjs";

test("queues one local still without credentials or a source copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltds-decoder-test-"));
  const jobsRoot = path.join(root, "Jobs");
  const source = path.join(jobsRoot, "Clients", "Synthetic", "photo.jpg");
  const config = { jobsRoot, r2RootPrefix: "Jobs", artifactsDir: path.join(root, "artifacts"), workDir: path.join(root, "work"), imageMaxBytes: 1000, pdfMaxBytes: 1000, imageMaxPixels: 110_000_000, renderTimeoutMs: 1000, rendererVersion: "truenas-0.1.0" };
  await (await import("node:fs/promises")).mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "synthetic-image");
  try {
    const outcome = await processSource(config, source, { renderThumbnail: async ({ outputPath }) => { await writeFile(outputPath, "small-webp"); return { width: 320, height: 240, outputBytes: 10 }; } });
    assert.equal(outcome, "queued");
    const receipts = path.join(config.artifactsDir, "receipts");
    const [id] = await (await import("node:fs/promises")).readdir(receipts);
    const manifest = JSON.parse(await readFile(path.join(receipts, id), "utf8"));
    assert.equal(manifest.sourceKey, "Jobs/Clients/Synthetic/photo.jpg");
    assert.equal(manifest.sourceSize, 15);
    assert.equal(manifest.profile, "ltds-thumbnail-320x240-webp-v1");
    assert.match(manifest.prebuiltKey, /^_ltds\/derivatives\/thumbnails\/v1\/prebuilt\/Jobs\/.+\/[a-f0-9]{64}\.webp$/);
    assert.match(manifest.manifestKey, /\.json$/);
    assert.equal("sourceEtag" in manifest, false);
    assert.equal("agentSecret" in manifest, false);
    const localManifest = path.join(config.artifactsDir, "prebuilt", ...manifest.manifestKey.replace("_ltds/derivatives/thumbnails/v1/prebuilt/", "").split("/"));
    await assert.rejects(readFile(localManifest), { code: "ENOENT" });
    const firstKeys = [manifest.prebuiltKey, manifest.manifestKey];
    await writeFile(source, "synthetic-image-replaced");
    assert.equal(await processSource(config, source, { renderThumbnail: async ({ outputPath }) => { await writeFile(outputPath, "new-small-webp"); return { width: 320, height: 240, outputBytes: 14 }; } }), "queued");
    const replacement = JSON.parse(await readFile(path.join(receipts, id), "utf8"));
    assert.notEqual(replacement.prebuiltKey, manifest.prebuiltKey);
    assert.deepEqual(replacement.retireKeys, firstKeys);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prunes an exact missing-source cache entry only after two complete scans and grace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltds-decoder-prune-"));
  const jobsRoot = path.join(root, "Jobs");
  const artifactsDir = path.join(root, "artifacts");
  const stateDir = path.join(root, "state");
  const sourceKey = "Jobs/Clients/Synthetic/gone.jpg";
  const id = createHash("sha256").update(sourceKey).digest("hex");
  const fingerprint = "d".repeat(64);
  const relativeBase = `${sourceKey}/${fingerprint}`;
  const prebuiltKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${relativeBase}.webp`;
  const manifestKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${relativeBase}.json`;
  const localBase = path.join(artifactsDir, "prebuilt", ...relativeBase.split("/"));
  const receiptPath = path.join(artifactsDir, "receipts", `${id}.json`);
  await Promise.all([mkdir(jobsRoot, { recursive: true }), mkdir(path.dirname(localBase), { recursive: true }), mkdir(path.dirname(receiptPath), { recursive: true })]);
  await Promise.all([writeFile(`${localBase}.webp`, "old"), writeFile(`${localBase}.json`, "old"), writeFile(receiptPath, JSON.stringify({ sourceKey, localIdentity: "old", prebuiltKey, manifestKey, retireKeys: [] }))]);
  const config = { jobsRoot, r2RootPrefix: "Jobs", artifactsDir, stateDir, pruneGraceMs: 0 };
  try {
    await scanOnce(config);
    await scanOnce(config);
    assert.equal((await readFile(receiptPath, "utf8")).length > 0, true);
    const result = await scanOnce(config);
    assert.equal(result.pruned, 1);
    await assert.rejects(readFile(receiptPath), { code: "ENOENT" });
    await assert.rejects(readFile(`${localBase}.webp`), { code: "ENOENT" });
    await assert.rejects(readFile(`${localBase}.json`), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skips video and reserved paths without decoding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltds-decoder-test-"));
  const config = { jobsRoot: root, r2RootPrefix: "Jobs" };
  const video = path.join(root, "clip.mp4");
  await writeFile(video, "video");
  try { assert.equal(await processSource(config, video, { renderThumbnail: async () => assert.fail("must not decode") }), "skipped"); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("bounds render retries by source identity, quarantines failures, and continues later files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltds-decoder-failures-"));
  const jobsRoot = path.join(root, "Jobs");
  const bad = path.join(jobsRoot, "Clients", "Synthetic", "a-bad.pdf");
  const good = path.join(jobsRoot, "Clients", "Synthetic", "b-good.jpg");
  const config = {
    jobsRoot, r2RootPrefix: "Jobs", artifactsDir: path.join(root, "artifacts"), workDir: path.join(root, "work"),
    stateDir: path.join(root, "state"), pruneGraceMs: 86_400_000, imageMaxBytes: 1000, pdfMaxBytes: 1000,
    imageMaxPixels: 110_000_000, renderTimeoutMs: 1000, renderMaxAttempts: 3,
    renderRetryBaseMs: 1000, renderRetryMaxMs: 4000, rendererVersion: "truenas-0.1.0",
  };
  await mkdir(path.dirname(bad), { recursive: true });
  await Promise.all([writeFile(bad, "bad-pdf"), writeFile(good, "good-image")]);
  let badAttempts = 0;
  let allowBad = false;
  const renderThumbnail = async ({ sourcePath, outputPath }) => {
    if (sourcePath === bad && !allowBad) { badAttempts += 1; throw new RendererError("render_timeout", true); }
    await writeFile(outputPath, "small-webp");
    return { width: 320, height: 240, outputBytes: 10 };
  };
  try {
    assert.deepEqual(await scanOnce(config, { renderThumbnail, now: () => 0 }), { scanned: 2, queued: 1, current: 0, unsupported: 0, deferred: 1, quarantined: 0, failed: 0, pruned: 0 });
    assert.equal(badAttempts, 1);
    assert.deepEqual(await scanOnce(config, { renderThumbnail, now: () => 500 }), { scanned: 2, queued: 0, current: 1, unsupported: 0, deferred: 1, quarantined: 0, failed: 0, pruned: 0 });
    assert.equal(badAttempts, 1);
    await scanOnce(config, { renderThumbnail, now: () => 1000 });
    assert.equal(badAttempts, 2);
    const quarantined = await scanOnce(config, { renderThumbnail, now: () => 3000 });
    assert.equal(quarantined.quarantined, 1);
    assert.equal(badAttempts, 3);
    await scanOnce(config, { renderThumbnail, now: () => 4000 });
    assert.equal(badAttempts, 3);

    allowBad = true;
    await writeFile(bad, "replacement-pdf");
    const replacement = await scanOnce(config, { renderThumbnail, now: () => 4001 });
    assert.equal(replacement.queued, 1);
    const failures = path.join(config.stateDir, "render-failures");
    assert.deepEqual(await (await import("node:fs/promises")).readdir(failures), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("quarantines invalid post-render output without blocking a later source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltds-decoder-invalid-output-"));
  const jobsRoot = path.join(root, "Jobs");
  const invalid = path.join(jobsRoot, "Clients", "Synthetic", "a-invalid.jpg");
  const valid = path.join(jobsRoot, "Clients", "Synthetic", "b-valid.jpg");
  const config = {
    jobsRoot, r2RootPrefix: "Jobs", artifactsDir: path.join(root, "artifacts"), workDir: path.join(root, "work"),
    stateDir: path.join(root, "state"), pruneGraceMs: 86_400_000, imageMaxBytes: 1000, pdfMaxBytes: 1000,
    imageMaxPixels: 110_000_000, renderTimeoutMs: 1000, renderMaxAttempts: 3,
    renderRetryBaseMs: 1000, renderRetryMaxMs: 4000, rendererVersion: "truenas-0.1.0",
  };
  await mkdir(path.dirname(invalid), { recursive: true });
  await Promise.all([writeFile(invalid, "invalid-image"), writeFile(valid, "valid-image")]);
  let invalidAttempts = 0;
  const renderThumbnail = async ({ sourcePath, outputPath }) => {
    await writeFile(outputPath, "small-webp");
    if (sourcePath === invalid) { invalidAttempts += 1; return { width: 319, height: 240, outputBytes: 10 }; }
    return { width: 320, height: 240, outputBytes: 10 };
  };
  try {
    const first = await scanOnce(config, { renderThumbnail, now: () => 0 });
    assert.equal(first.quarantined, 1);
    assert.equal(first.queued, 1);
    assert.equal(invalidAttempts, 1);
    const second = await scanOnce(config, { renderThumbnail, now: () => 1000 });
    assert.equal(second.quarantined, 1);
    assert.equal(second.current, 1);
    assert.equal(invalidAttempts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
