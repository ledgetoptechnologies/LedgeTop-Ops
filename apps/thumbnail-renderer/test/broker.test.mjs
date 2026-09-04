import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { brokerOnce, publishJob, signedHead } from "../src/broker.mjs";

function validWebp() {
  const payload = Buffer.alloc(10); payload[3] = 0x9d; payload[4] = 0x01; payload[5] = 0x2a; payload.writeUInt16LE(320, 6); payload.writeUInt16LE(240, 8);
  const chunk = Buffer.concat([Buffer.from("VP8 "), Buffer.from([10, 0, 0, 0]), payload]);
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from([4 + chunk.length, 0, 0, 0]), Buffer.from("WEBP"), chunk]);
}

const baseConfig = {
  accountId: "a".repeat(32), bucket: "client-data", accessKeyId: "A".repeat(32), secretAccessKey: "z".repeat(48),
  requestTimeoutMs: 1000, settleMs: 0, ingestUrl: new URL("https://ops.example.test/api/internal/thumbnail-ingest/v1"),
  ingestSecret: "s".repeat(48), accessClientId: "access-client-id", accessClientSecret: "c".repeat(48),
};

test("signs a HEAD for only the exact encoded key", () => {
  const result = signedHead(baseConfig, "Jobs/Clients/Test/photo one.jpg", new Date("2026-08-08T12:00:00Z"));
  assert.equal(result.url.pathname, "/client-data/Jobs/Clients/Test/photo%20one.jpg");
  assert.match(result.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  assert.equal("x-amz-checksum-mode" in result.headers, false);
  assert.match(result.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ltds-broker-test-"));
  const fingerprint = "a".repeat(64);
  const relativeBase = `Jobs/Clients/Test/photo.jpg/${fingerprint}`;
  const prebuiltKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${relativeBase}.webp`;
  const manifestKey = `_ltds/derivatives/thumbnails/v1/prebuilt/${relativeBase}.json`;
  const localBase = path.join(root, "prebuilt", ...relativeBase.split("/"));
  const receiptPath = path.join(root, "receipts", `${"b".repeat(64)}.json`);
  const retiredBase = path.join(root, "prebuilt", "Jobs", "Clients", "Test", "photo.jpg", "c".repeat(64));
  await Promise.all([mkdir(path.dirname(localBase), { recursive: true }), mkdir(path.dirname(receiptPath), { recursive: true })]);
  const thumbnail = validWebp();
  await writeFile(`${localBase}.webp`, thumbnail);
  const receipt = {
    schemaVersion: "ltds-thumbnail-local/v1", sourceKey: "Jobs/Clients/Test/photo.jpg", sourceSize: 123,
    sourceMime: "application/octet-stream", sourceSha256: fingerprint, fingerprint, localIdentity: "1:2:123:4:5",
    renderedAt: "2026-08-08T12:00:00.000Z", rendererVersion: "truenas-0.1.0",
    profile: "ltds-thumbnail-320x240-webp-v1", prebuiltKey, manifestKey,
    thumbnail: { file: `${relativeBase}.webp`, mime: "image/webp", width: 320, height: 240, bytes: thumbnail.length, sha256: (await import("node:crypto")).createHash("sha256").update(thumbnail).digest("hex") },
    brokerState: "awaiting_sync",
    retireKeys: [
      `_ltds/derivatives/thumbnails/v1/prebuilt/Jobs/Clients/Test/photo.jpg/${"c".repeat(64)}.webp`,
      `_ltds/derivatives/thumbnails/v1/prebuilt/Jobs/Clients/Test/photo.jpg/${"c".repeat(64)}.json`,
    ],
  };
  await writeFile(`${retiredBase}.webp`, "old");
  await writeFile(`${retiredBase}.json`, "old");
  await writeFile(receiptPath, JSON.stringify(receipt));
  return { root, config: { ...baseConfig, artifactsDir: root }, receiptPath, receipt, localManifest: `${localBase}.json`, retiredBase };
}

function head(url) {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith(".webp")) return new Response(null, { status: 200, headers: { "content-length": String(validWebp().length), etag: '"thumb-etag"', "last-modified": "Sat, 08 Aug 2026 12:02:00 GMT", "content-type": "image/webp" } });
  if (pathname.endsWith(".json")) return new Response(null, { status: 200, headers: { "content-length": "700", etag: '"manifest-etag"', "last-modified": new Date(Date.now() + 60_000).toUTCString(), "content-type": "application/json" } });
  return new Response(null, { status: 200, headers: { "content-length": "123", etag: '"source-etag"', "last-modified": "Sat, 08 Aug 2026 12:01:00 GMT", "content-type": "image/jpeg", "x-amz-checksum-sha256": Buffer.from("a".repeat(64), "hex").toString("base64") } });
}

test("finalizes an exact-Etag manifest, then registers stable synced objects without base64", async () => {
  const item = await fixture();
  const requests = [];
  const firstFetch = async (url, init) => { requests.push({ url: String(url), init }); return head(url); };
  try {
    assert.equal((await publishJob(item.config, item.receiptPath, { fetchImpl: firstFetch })).state, "awaiting_manifest_sync");
    const finalized = JSON.parse(await readFile(item.localManifest, "utf8"));
    assert.deepEqual({ schemaVersion: finalized.schemaVersion, provider: finalized.provider, sourceEtag: finalized.sourceEtag, sourceFingerprint: finalized.sourceFingerprint, thumbnailEtag: finalized.thumbnail.etag }, {
      schemaVersion: 1, provider: "ltds-truenas", sourceEtag: "source-etag", sourceFingerprint: { algorithm: "sha256", value: "a".repeat(64) }, thumbnailEtag: "thumb-etag",
    });
    const finalSize = Buffer.byteLength(await readFile(item.localManifest, "utf8"));
    let registeredBody;
    const secondFetch = async (url, init) => {
      if (init.method === "POST") { requests.push({ url: String(url), init }); registeredBody = JSON.parse(init.body); return new Response(JSON.stringify({ status: "ready" }), { status: 200 }); }
      const response = head(url);
      if (new URL(url).pathname.endsWith(".json")) response.headers.set("content-length", String(finalSize));
      return response;
    };
    assert.equal((await publishJob(item.config, item.receiptPath, { fetchImpl: secondFetch })).state, "ready");
    assert.deepEqual(registeredBody, { schemaVersion: 1, provider: "ltds-truenas", manifestKey: item.receipt.manifestKey, manifestEtag: "manifest-etag", thumbnailKey: item.receipt.prebuiltKey, thumbnailEtag: "thumb-etag" });
    const registerRequest = requests.find(({ init }) => init.method === "POST");
    assert.equal(registerRequest.init.headers.authorization, `Bearer ${baseConfig.ingestSecret}`);
    assert.equal(registerRequest.init.headers["cf-access-client-id"], baseConfig.accessClientId);
    assert.equal(registerRequest.init.headers["cf-access-client-secret"], baseConfig.accessClientSecret);
    await assert.rejects(readFile(`${item.retiredBase}.webp`), { code: "ENOENT" });
    await assert.rejects(readFile(`${item.retiredBase}.json`), { code: "ENOENT" });
    assert.equal("thumbnailBase64" in registeredBody, false);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("does not finalize against an R2 source older than the local render", async () => {
  const item = await fixture();
  const fetchImpl = async () => new Response(null, { status: 200, headers: { "content-length": "123", etag: '"old"', "last-modified": "Sat, 08 Aug 2026 11:00:00 GMT" } });
  try { await assert.rejects(publishJob(item.config, item.receiptPath, { fetchImpl }), { code: "source_pending", retryable: true }); }
  finally { await rm(item.root, { recursive: true, force: true }); }
});

test("fails closed when R2 cannot prove the remote bytes match the local source digest", async () => {
  const item = await fixture();
  const response = (digest) => new Response(null, { status: 200, headers: {
    "content-length": "123", etag: '"source-etag"', "last-modified": "Sat, 08 Aug 2026 12:01:00 GMT",
    "content-type": "image/jpeg", ...(digest ? { "x-amz-checksum-sha256": digest } : {}),
  } });
  try {
    await assert.rejects(publishJob(item.config, item.receiptPath, { fetchImpl: async () => response(null) }), { code: "source_digest_unverified", retryable: false });
    await assert.rejects(publishJob(item.config, item.receiptPath, { fetchImpl: async () => response(Buffer.from("b".repeat(64), "hex").toString("base64")) }), { code: "source_digest_unverified", retryable: false });
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test("quarantines a malformed receipt and still processes a valid later receipt", async () => {
  const item = await fixture();
  const valid = await readFile(item.receiptPath);
  const malformed = path.join(item.root, "receipts", `${"0".repeat(64)}.json`);
  await rm(item.receiptPath);
  await writeFile(malformed, "not-json");
  await writeFile(item.receiptPath, valid);
  try {
    const outcomes = [];
    // Directory iteration order is platform-specific. A valid receipt may be
    // finalized and retired before the malformed sibling is encountered.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcomes.push(await brokerOnce(item.config, { fetchImpl: async (url) => head(url) }));
      try { await readFile(malformed); }
      catch (error) { if (error?.code === "ENOENT") break; throw error; }
    }
    assert.ok(outcomes.includes("awaiting_manifest_sync"));
    await assert.rejects(readFile(malformed), { code: "ENOENT" });
    assert.equal(await readFile(`${malformed}.invalid`, "utf8"), "not-json");
  } finally { await rm(item.root, { recursive: true, force: true }); }
});
