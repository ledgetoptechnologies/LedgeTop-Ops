import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { renderThumbnail } from "./render.mjs";
import { asRendererError, RendererError } from "./errors.mjs";
import { sha256File } from "./files.mjs";
import { writeHealth } from "./state.mjs";

const PROFILE = "ltds-thumbnail-320x240-webp-v1";
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const RESERVED = new Set([".previews", "_ltds", "dump"]);

export function safeLog(level, event, fields = {}) { process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`); }
export function installSignalController() { const controller = new AbortController(); const stop = () => controller.abort(); process.once("SIGTERM", stop); process.once("SIGINT", stop); return controller; }
const delay = (ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

function identity(details) { return `${details.dev}:${details.ino}:${details.size}:${details.mtimeNs}:${details.ctimeNs}`; }
function mountIdentity(details) { return `${details.dev}:${details.ino}`; }
function mediaKind(filePath) { const extension = path.extname(filePath).toLowerCase(); return IMAGE_EXTENSIONS.has(extension) ? "image" : extension === ".pdf" ? "pdf" : null; }
function canonicalRelative(relative) { const parts = relative.split(path.sep); return parts.length > 0 && parts.every((part) => part && part !== "." && part !== ".." && !RESERVED.has(part.toLowerCase()) && !part.startsWith(".")); }
function sourceHash(sourceKey) { return createHash("sha256").update(sourceKey).digest("hex"); }
async function hashFile(filePath) { const hash = createHash("sha256"); for await (const chunk of createReadStream(filePath)) hash.update(chunk); return hash.digest("hex"); }
function validSourceKey(value) {
  return typeof value === "string" && value.startsWith("Jobs/") && value.length <= 850 && !value.includes("\\") && !/[\0-\x1f\x7f]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && !RESERVED.has(part.toLowerCase()));
}

async function atomicJson(filePath, value) {
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(`${filePath}.tmp`, filePath);
}

function validCachedKey(receipt, key) {
  if (!validSourceKey(receipt?.sourceKey) || typeof key !== "string") return false;
  const prefix = `_ltds/derivatives/thumbnails/v1/prebuilt/${receipt.sourceKey}/`;
  return key.startsWith(prefix) && /^[a-f0-9]{64}\.(?:webp|json)$/.test(key.slice(prefix.length));
}

function cachedPath(config, key) {
  const prefix = "_ltds/derivatives/thumbnails/v1/prebuilt/";
  const relative = key.slice(prefix.length);
  const result = path.join(config.artifactsDir, "prebuilt", ...relative.split("/"));
  const root = path.resolve(config.artifactsDir, "prebuilt");
  if (!result.startsWith(`${root}${path.sep}`)) throw new RendererError("invalid_local_manifest", false);
  return result;
}

async function readReceipt(config, id) {
  try {
    return JSON.parse(await readFile(path.join(config.artifactsDir, "receipts", `${id}.json`), "utf8"));
  } catch { /* absent or invalid is regenerated */ }
  return null;
}

function renderFailurePath(config, id) {
  return config.stateDir ? path.join(config.stateDir, "render-failures", `${id}.json`) : null;
}

async function readRenderFailure(config, id) {
  const filePath = renderFailurePath(config, id);
  if (!filePath) return null;
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function clearRenderFailure(config, id) {
  const filePath = renderFailurePath(config, id);
  if (filePath) await rm(filePath, { force: true });
}

async function recordRenderFailure(config, id, localIdentity, error, previous, now) {
  const filePath = renderFailurePath(config, id);
  if (!filePath) return { quarantined: !error.retryable, nextAttemptAt: now };
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const priorAttempts = previous?.localIdentity === localIdentity ? Number(previous.attempts || 0) : 0;
  const attempts = error.retryable ? priorAttempts + 1 : config.renderMaxAttempts;
  const quarantined = !error.retryable || attempts >= config.renderMaxAttempts;
  const backoff = quarantined ? 0 : Math.min(config.renderRetryMaxMs, config.renderRetryBaseMs * 2 ** Math.min(attempts - 1, 8));
  const record = {
    schemaVersion: 1, localIdentity, attempts, quarantined, errorCode: error.code,
    nextAttemptAt: quarantined ? 0 : now + backoff, updatedAt: new Date(now).toISOString(),
  };
  await atomicJson(filePath, record);
  return record;
}

export async function processSource(config, filePath, dependencies = {}) {
  const render = dependencies.renderThumbnail || renderThumbnail;
  const now = typeof dependencies.now === "function" ? dependencies.now() : Date.now();
  const relative = path.relative(config.jobsRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !canonicalRelative(relative)) return "skipped";
  const kind = mediaKind(filePath);
  if (!kind) return "skipped";
  const before = await stat(filePath, { bigint: true });
  if (!before.isFile() || before.size <= 0n || before.size > BigInt(kind === "image" ? config.imageMaxBytes : config.pdfMaxBytes)) return "unsupported";
  const sourceKey = `${config.r2RootPrefix}/${relative.split(path.sep).join("/")}`;
  if (!validSourceKey(sourceKey)) return "skipped";
  const longestDerivedKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${sourceKey}/${"0".repeat(64)}.webp`;
  if (Buffer.byteLength(longestDerivedKey, "utf8") > 1024) return "skipped";
  const id = sourceHash(sourceKey);
  const localIdentity = identity(before);
  const renderFailure = await readRenderFailure(config, id);
  if (renderFailure?.localIdentity === localIdentity) {
    if (renderFailure.quarantined) return "quarantined";
    if (Number(renderFailure.nextAttemptAt || 0) > now) return "deferred";
  } else if (renderFailure) await clearRenderFailure(config, id);
  const previous = await readReceipt(config, id);
  if (previous?.localIdentity === localIdentity && previous.profile === PROFILE) {
    await clearRenderFailure(config, id);
    return "current";
  }

  const workspace = path.join(config.workDir, `job-${randomUUID()}`);
  const staged = path.join(config.artifactsDir, `.stage-${randomUUID()}`);
  await Promise.all([mkdir(workspace, { recursive: true, mode: 0o700 }), mkdir(staged, { recursive: true, mode: 0o700 })]);
  try {
    const renderedPath = path.join(workspace, "thumbnail.webp");
    const thumbnailPath = path.join(staged, "thumbnail.webp");
    const rendered = await render({ mediaKind: kind, sourcePath: filePath, outputPath: renderedPath, workspace, maxPixels: config.imageMaxPixels, timeoutMs: config.renderTimeoutMs });
    if (rendered.width !== 320 || rendered.height !== 240 || rendered.outputBytes > 128 * 1024) throw new RendererError("invalid_output", false);
    await copyFile(renderedPath, thumbnailPath);
    const sourceSha256 = await hashFile(filePath);
    const after = await stat(filePath, { bigint: true });
    if (identity(after) !== localIdentity) throw new RendererError("source_changed", true);
    const fingerprint = sourceSha256;
    const relativeBase = path.posix.join(...sourceKey.split("/"), fingerprint);
    const prebuiltKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${relativeBase}.webp`;
    const manifestKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${relativeBase}.json`;
    const thumbnailSha256 = await sha256File(renderedPath);
    const retireKeys = previous?.sourceKey === sourceKey && previous.prebuiltKey !== prebuiltKey
      ? [previous.prebuiltKey, previous.manifestKey].filter((value) => typeof value === "string") : [];
    const manifest = {
      schemaVersion: "ltds-thumbnail-local/v1", sourceKey, sourceSize: Number(before.size),
      sourceMime: kind === "pdf" ? "application/pdf" : "application/octet-stream",
      sourceSha256, localIdentity, renderedAt: new Date().toISOString(),
      rendererVersion: config.rendererVersion,
      profile: PROFILE, fingerprint, prebuiltKey, manifestKey,
      thumbnail: { file: `${relativeBase}.webp`, mime: "image/webp", width: 320, height: 240, bytes: rendered.outputBytes, sha256: thumbnailSha256 },
      retireKeys,
    };
    const destinationBase = path.join(config.artifactsDir, "prebuilt", ...sourceKey.split("/"), fingerprint);
    await mkdir(path.dirname(destinationBase), { recursive: true, mode: 0o700 });
    await copyFile(thumbnailPath, `${destinationBase}.webp.tmp`);
    await rename(`${destinationBase}.webp.tmp`, `${destinationBase}.webp`);
    await mkdir(path.join(config.artifactsDir, "receipts"), { recursive: true, mode: 0o700 });
    const receiptPath = path.join(config.artifactsDir, "receipts", `${id}.json`);
    await writeFile(`${receiptPath}.tmp`, `${JSON.stringify({ ...manifest, brokerState: "awaiting_sync" })}\n`, { mode: 0o600 });
    await rename(`${receiptPath}.tmp`, receiptPath);
    await clearRenderFailure(config, id);
    return "queued";
  } catch (error) {
    const safe = asRendererError(error);
    const failure = await recordRenderFailure(config, id, localIdentity, safe, renderFailure, now);
    return failure.quarantined ? "quarantined" : "deferred";
  } finally {
    await Promise.all([rm(workspace, { recursive: true, force: true }), rm(staged, { recursive: true, force: true })]);
  }
}

async function* sourceFiles(root) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (entry.isSymbolicLink() || RESERVED.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (entry.isFile()) yield full;
  }
}

async function reconcileMissing(config, seen, rootId, now = Date.now()) {
  if (!config.stateDir || !Number.isFinite(config.pruneGraceMs)) return 0;
  const statePath = path.join(config.stateDir, "prune-state.json");
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  let previous = null;
  try { previous = JSON.parse(await readFile(statePath, "utf8")); } catch { /* first complete scan */ }
  if (!previous) {
    await atomicJson(statePath, { schemaVersion: 1, rootIdentity: rootId, missing: {} });
    return 0;
  }
  if (previous.rootIdentity !== rootId) throw new RendererError("source_mount_changed", false);
  const missing = {};
  let pruned = 0;
  const receiptsDir = path.join(config.artifactsDir, "receipts");
  await mkdir(receiptsDir, { recursive: true, mode: 0o700 });
  const directory = await opendir(receiptsDir);
  for await (const entry of directory) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const id = entry.name.slice(0, -5);
    const seenIdentity = seen.get(id);
    const receiptPath = path.join(receiptsDir, entry.name);
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch { continue; }
    if (sourceHash(String(receipt.sourceKey || "")) !== id || (seenIdentity && seenIdentity === receipt.localIdentity)) continue;
    const prior = previous.missing?.[id];
    const record = { firstSeen: Number.isFinite(prior?.firstSeen) ? prior.firstSeen : now, completeScans: Math.min(1_000_000, Number(prior?.completeScans || 0) + 1) };
    if (record.completeScans < 2 || now - record.firstSeen < config.pruneGraceMs) { missing[id] = record; continue; }
    const keys = [receipt.prebuiltKey, receipt.manifestKey, ...(Array.isArray(receipt.retireKeys) ? receipt.retireKeys : [])];
    if (keys.length > 22 || !keys.every((key) => validCachedKey(receipt, key))) { missing[id] = record; continue; }
    const pruningPath = `${receiptPath}.pruning`;
    try { await rename(receiptPath, pruningPath); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    for (const key of new Set(keys)) await rm(cachedPath(config, key), { force: true });
    await rm(pruningPath, { force: true });
    pruned += 1;
  }
  await atomicJson(statePath, { schemaVersion: 1, rootIdentity: rootId, missing });
  return pruned;
}

export async function scanOnce(config, dependencies = {}) {
  const beforeRoot = await stat(config.jobsRoot, { bigint: true });
  if (!beforeRoot.isDirectory()) throw new RendererError("source_mount_unhealthy", true);
  const rootId = mountIdentity(beforeRoot);
  const seen = new Map();
  const counts = { scanned: 0, queued: 0, current: 0, unsupported: 0, deferred: 0, quarantined: 0, failed: 0, pruned: 0 };
  for await (const filePath of sourceFiles(config.jobsRoot)) {
    counts.scanned += 1;
    const relative = path.relative(config.jobsRoot, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && canonicalRelative(relative)) {
      try {
        const details = await stat(filePath, { bigint: true });
        if (details.isFile()) seen.set(sourceHash(`${config.r2RootPrefix}/${relative.split(path.sep).join("/")}`), identity(details));
      } catch { /* a concurrently changed source is retried next scan */ }
    }
    try { const outcome = await processSource(config, filePath, dependencies); if (outcome in counts) counts[outcome] += 1; }
    catch (error) { counts.failed += 1; safeLog("warn", "source_failed", { code: asRendererError(error).code }); }
  }
  const afterRoot = await stat(config.jobsRoot, { bigint: true });
  if (!afterRoot.isDirectory() || mountIdentity(afterRoot) !== rootId) throw new RendererError("source_mount_unhealthy", true);
  counts.pruned = await reconcileMissing(config, seen, rootId);
  return counts;
}

export async function runWatcher(config, { signal } = {}) {
  await Promise.all([mkdir(config.workDir, { recursive: true, mode: 0o700 }), mkdir(config.cacheDir, { recursive: true, mode: 0o700 }), mkdir(config.stateDir, { recursive: true, mode: 0o700 }), mkdir(path.join(config.artifactsDir, "prebuilt"), { recursive: true, mode: 0o700 }), mkdir(path.join(config.artifactsDir, "receipts"), { recursive: true, mode: 0o700 })]);
  safeLog("info", "decoder_started", { concurrency: 1, networkRequired: false });
  let state = "starting";
  const heartbeat = setInterval(() => writeHealth(config.stateDir, state).catch(() => {}), 30_000);
  heartbeat.unref?.();
  try {
    while (!signal?.aborted) {
      state = "processing";
      await writeHealth(config.stateDir, state);
      const counts = await scanOnce(config);
      safeLog("info", "scan_finished", counts);
      state = "idle";
      await writeHealth(config.stateDir, state);
      await delay(config.scanIntervalMs, signal);
    }
  } finally { clearInterval(heartbeat); }
}
