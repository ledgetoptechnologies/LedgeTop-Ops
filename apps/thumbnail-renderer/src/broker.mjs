import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { asRendererError, RendererError } from "./errors.mjs";
import { validateWebpFile } from "./webp.mjs";
import { writeHealth } from "./state.mjs";

const PROFILE = "ltds-thumbnail-320x240-webp-v1";
const delay = (ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
const hexHash = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value, encoding) => createHmac("sha256", key).update(value).digest(encoding);
const cleanEtag = (value) => (value || "").replace(/^"|"$/g, "");
export function safeLog(level, event, fields = {}) { process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`); }
export function installSignalController() { const controller = new AbortController(); const stop = () => controller.abort(); process.once("SIGTERM", stop); process.once("SIGINT", stop); return controller; }

function canonicalUri(bucket, sourceKey) {
  return `/${[bucket, ...sourceKey.split("/")].map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
}

function checksumSha256Hex(headers) {
  const value = headers.get("x-amz-checksum-sha256") || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value ? bytes.toString("hex") : null;
}

export function signedHead(config, sourceKey, now = new Date()) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const uri = canonicalUri(config.bucket, sourceKey);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payload = hexHash("");
  const headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `HEAD\n${uri}\n\n${headers}\n${signedHeaders}\n${payload}`;
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hexHash(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  return {
    url: new URL(`https://${host}${uri}`),
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payload,
      "x-amz-date": amzDate,
    },
  };
}

async function request(fetchImpl, url, init, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try { return await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" }); }
  catch { throw new RendererError("transfer_failed", true); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function headSource(config, sourceKey, { fetchImpl = fetch, signal } = {}) {
  const signed = signedHead(config, sourceKey);
  const response = await request(fetchImpl, signed.url, { method: "HEAD", headers: signed.headers }, config.requestTimeoutMs, signal);
  if (response.status === 404) throw new RendererError("source_pending", true);
  if (response.status === 401 || response.status === 403) throw new RendererError("r2_auth_rejected", false);
  if (!response.ok) throw new RendererError("transfer_failed", true);
  const size = Number(response.headers.get("content-length"));
  const etag = cleanEtag(response.headers.get("etag"));
  const lastModified = Date.parse(response.headers.get("last-modified") || "");
  if (!Number.isSafeInteger(size) || size <= 0 || !etag || !Number.isFinite(lastModified)) throw new RendererError("invalid_r2_head", true);
  return { size, etag, contentType: (response.headers.get("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase(), lastModified, checksumSha256: checksumSha256Hex(response.headers) };
}

function validManifest(value) {
  return value?.schemaVersion === "ltds-thumbnail-local/v1" && typeof value.sourceKey === "string" && value.sourceKey.startsWith("Jobs/") && !value.sourceKey.split("/").some((part) => !part || [".", "..", "dump", "_ltds", ".previews"].includes(part.toLowerCase())) &&
    Number.isSafeInteger(value.sourceSize) && value.sourceSize > 0 && typeof value.sourceSha256 === "string" && /^[a-f0-9]{64}$/.test(value.sourceSha256) &&
    typeof value.localIdentity === "string" && value.localIdentity.length <= 256 && Number.isFinite(Date.parse(value.renderedAt)) &&
    /^[A-Za-z0-9._-]{1,80}$/.test(value.rendererVersion) && value.profile === PROFILE && value.fingerprint === value.sourceSha256 &&
    typeof value.prebuiltKey === "string" && typeof value.manifestKey === "string" && value.thumbnail?.mime === "image/webp" &&
    value.thumbnail.width === 320 && value.thumbnail.height === 240 && Number.isSafeInteger(value.thumbnail.bytes) && value.thumbnail.bytes > 0 && value.thumbnail.bytes <= 128 * 1024 &&
    typeof value.thumbnail.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.thumbnail.sha256);
}

function localPrebuiltPath(config, key) {
  const prefix = "_ltds/derivatives/thumbnails/v1/prebuilt/";
  if (!key.startsWith(prefix)) throw new RendererError("invalid_local_manifest", false);
  const relative = key.slice(prefix.length);
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new RendererError("invalid_local_manifest", false);
  const result = path.join(config.artifactsDir, "prebuilt", ...relative.split("/"));
  if (!result.startsWith(`${path.resolve(config.artifactsDir, "prebuilt")}${path.sep}`)) throw new RendererError("invalid_local_manifest", false);
  return result;
}

function validRetireKey(receipt, key) {
  if (typeof key !== "string" || key === receipt.prebuiltKey || key === receipt.manifestKey) return false;
  const prefix = `_ltds/derivatives/thumbnails/v1/prebuilt/${receipt.sourceKey}/`;
  return key.startsWith(prefix) && /^[a-f0-9]{64}\.(?:webp|json)$/.test(key.slice(prefix.length));
}

async function retireRegistered(config, receiptPath, receipt) {
  if (!Array.isArray(receipt.retireKeys) || receipt.retireKeys.length === 0) return false;
  if (receipt.retireKeys.length > 20 || !receipt.retireKeys.every((key) => validRetireKey(receipt, key))) {
    throw new RendererError("invalid_retirement", false);
  }
  for (const key of new Set(receipt.retireKeys)) await rm(localPrebuiltPath(config, key), { force: true });
  await atomicJson(receiptPath, { ...receipt, retireKeys: [], retiredAt: new Date().toISOString() });
  return true;
}

async function stableSource(config, manifest, options) {
  const first = await headSource(config, manifest.sourceKey, options);
  if (first.size !== manifest.sourceSize || first.lastModified < Date.parse(manifest.renderedAt)) throw new RendererError("source_pending", true);
  await delay(config.settleMs, options.signal);
  const second = await headSource(config, manifest.sourceKey, options);
  if (second.etag !== first.etag || second.size !== first.size || second.lastModified !== first.lastModified) throw new RendererError("source_pending", true);
  if (!second.checksumSha256 || second.checksumSha256 !== manifest.sourceSha256) {
    throw new RendererError("source_digest_unverified", false);
  }
  return second;
}

async function atomicJson(filePath, value) {
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(`${filePath}.tmp`, filePath);
}

export async function publishJob(config, receiptPath, { fetchImpl = fetch, signal } = {}) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const manifest = receipt;
  if (!validManifest(manifest)) throw new RendererError("invalid_local_manifest", false);
  const localThumbnail = localPrebuiltPath(config, manifest.prebuiltKey);
  const localManifest = localPrebuiltPath(config, manifest.manifestKey);
  const thumbnail = await validateWebpFile(localThumbnail);
  if (thumbnail.outputBytes !== manifest.thumbnail.bytes || hexHash(thumbnail.bytes) !== manifest.thumbnail.sha256) throw new RendererError("invalid_local_manifest", false);
  const source = await stableSource(config, manifest, { fetchImpl, signal });
  const remoteThumbnail = await headSource(config, manifest.prebuiltKey, { fetchImpl, signal });
  if (remoteThumbnail.size !== thumbnail.outputBytes || remoteThumbnail.contentType !== "image/webp") throw new RendererError("prebuilt_pending", true);

  if (receipt.brokerState !== "awaiting_register" || receipt.sourceEtag !== source.etag || receipt.thumbnailEtag !== remoteThumbnail.etag) {
    const finalManifest = {
      schemaVersion: 1, provider: "ltds-truenas", sourceKey: manifest.sourceKey,
      sourceEtag: source.etag, sourceSize: source.size, sourceMime: source.contentType,
      sourceFingerprint: { algorithm: "sha256", value: manifest.fingerprint }, rendererVersion: manifest.rendererVersion,
      profile: PROFILE, createdAt: new Date().toISOString(),
      thumbnail: { key: manifest.prebuiltKey, etag: remoteThumbnail.etag, mime: "image/webp", width: 320, height: 240, bytes: thumbnail.outputBytes, sha256: manifest.thumbnail.sha256 },
    };
    await atomicJson(localManifest, finalManifest);
    await atomicJson(receiptPath, { ...receipt, brokerState: "awaiting_register", sourceEtag: source.etag, sourceMime: source.contentType, thumbnailEtag: remoteThumbnail.etag, finalizedAt: finalManifest.createdAt, attempts: 0, nextAttemptAt: 0 });
    return { manifest: { ...receipt, sourceEtag: source.etag, thumbnailEtag: remoteThumbnail.etag }, state: "awaiting_manifest_sync" };
  }

  const localManifestStat = await stat(localManifest);
  const remoteManifest = await headSource(config, manifest.manifestKey, { fetchImpl, signal });
  if (remoteManifest.size !== localManifestStat.size || remoteManifest.contentType !== "application/json" || remoteManifest.lastModified < Date.parse(receipt.finalizedAt || "")) throw new RendererError("manifest_pending", true);
  const currentThumbnail = await headSource(config, manifest.prebuiltKey, { fetchImpl, signal });
  if (currentThumbnail.etag !== receipt.thumbnailEtag || currentThumbnail.size !== thumbnail.outputBytes) throw new RendererError("prebuilt_pending", true);
  const body = JSON.stringify({ schemaVersion: 1, provider: "ltds-truenas", manifestKey: manifest.manifestKey, manifestEtag: remoteManifest.etag, thumbnailKey: manifest.prebuiltKey, thumbnailEtag: currentThumbnail.etag });
  if (Buffer.byteLength(body) > 8 * 1024) throw new RendererError("invalid_output", false);
  const response = await request(fetchImpl, config.ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.ingestSecret}`,
      "cf-access-client-id": config.accessClientId,
      "cf-access-client-secret": config.accessClientSecret,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  }, config.requestTimeoutMs, signal);
  if (response.ok) {
    const registered = { ...receipt, brokerState: "registered", manifestEtag: remoteManifest.etag, registeredAt: new Date().toISOString(), attempts: 0, nextAttemptAt: 0 };
    await atomicJson(receiptPath, registered);
    await retireRegistered(config, receiptPath, registered);
    return { manifest, state: "ready" };
  }
  if (response.status === 401 || response.status === 403) throw new RendererError("ingest_auth_rejected", false);
  if (response.status === 409 || response.status === 429 || response.status >= 500) throw new RendererError("ingest_retry", true);
  if ([400, 413, 415, 421].includes(response.status)) throw new RendererError("ingest_rejected", false);
  throw new RendererError("ingest_rejected", false);
}

export async function brokerOnce(config, dependencies = {}) {
  const receipts = path.join(config.artifactsDir, "receipts");
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const directory = await opendir(receipts);
  for await (const entry of directory) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const receiptPath = path.join(receipts, entry.name);
    let retry;
    try {
      const details = await stat(receiptPath);
      if (!details.isFile() || details.size <= 0 || details.size > 64 * 1024) throw new Error("invalid receipt size");
      retry = JSON.parse(await readFile(receiptPath, "utf8"));
      if (!retry || typeof retry !== "object" || Array.isArray(retry)) throw new Error("invalid receipt");
    } catch {
      try { await rename(receiptPath, `${receiptPath}.invalid`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      safeLog("warn", "broker_receipt_quarantined", { code: "invalid_local_manifest" });
      continue;
    }
    if (retry.brokerState === "registered") {
      if (await retireRegistered(config, receiptPath, retry)) return "retired";
      continue;
    }
    if (retry.brokerState === "failed") continue;
    if (Number(retry.nextAttemptAt || 0) > Date.now()) continue;
    try {
      const result = await publishJob(config, receiptPath, dependencies);
      return result.state;
    } catch (error) {
      const safe = asRendererError(error);
      if (!safe.retryable || retry.attempts >= 19) {
        await atomicJson(receiptPath, { ...retry, brokerState: "failed", errorCode: safe.code, failedAt: new Date().toISOString() });
        if (["r2_auth_rejected", "ingest_auth_rejected"].includes(safe.code)) throw safe;
        return "failed";
      }
      const attempts = Number(retry.attempts || 0) + 1;
      const backoff = Math.min(900_000, 5_000 * 2 ** Math.min(attempts, 8));
      await atomicJson(receiptPath, { ...retry, attempts, nextAttemptAt: Date.now() + backoff, errorCode: safe.code });
      return "retry";
    }
  }
  return "idle";
}

export async function runBroker(config, { signal } = {}) {
  await Promise.all([mkdir(path.join(config.artifactsDir, "receipts"), { recursive: true, mode: 0o700 }), mkdir(config.stateDir, { recursive: true, mode: 0o700 })]);
  safeLog("info", "broker_started", { concurrency: 1 });
  while (!signal?.aborted) {
    await writeHealth(config.stateDir, "processing");
    try { safeLog("info", "broker_cycle", { outcome: await brokerOnce(config, { signal }) }); }
    catch (error) { const safe = asRendererError(error); safeLog("error", "broker_failed", { code: safe.code }); if (!safe.retryable) throw safe; }
    await writeHealth(config.stateDir, "idle");
    await delay(config.pollIntervalMs, signal);
  }
}
