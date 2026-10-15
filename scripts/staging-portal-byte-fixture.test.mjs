import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { applyPortalByteFixture, compilePortalByteFixture, main, preparePortalByteFixture, resumePortalByteFixture, STAGING_PORTAL_BYTE_HASHES, validatePortalByteFixtureConfig, verifyPortalByteFixture } from "./staging-portal-byte-fixture.mjs";

const id = "10000000-0000-4000-8000-000000000001";
const config = { name: "staging-portal-byte-fixture", account_id: "846c924bf17bf4f3dd15c97a4c5d1d51", compatibility_date: "2026-10-08", r2_buckets: [{ binding: "DATA_BUCKET", bucket_name: "client-data-staging", remote: true }] };
const body = value => ({ ...value, async arrayBuffer() { return Buffer.from(value.bytes); } });

test("actual CLI entrypoint rejects an invalid mode without opening a binding", () => {
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "staging-portal-byte-fixture.mjs"), "invalid"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /staging-portal-byte-fixture: unknown mode/);
  assert.equal(result.stdout, "");
});
function bucket(initial = new Map(), behavior = {}) {
  return { store: initial, heads: [], gets: [], puts: [], async head(key) { this.heads.push(key); const v = this.store.get(key); return v ? { key, etag: `etag-${v.customMetadata.role}`, version: `version-${v.customMetadata.role}`, uploaded: new Date("2026-10-08T12:00:00.000Z"), size: Buffer.byteLength(v.bytes), customMetadata: v.customMetadata, httpMetadata: { contentType: "text/plain; charset=utf-8" } } : null; }, async get(key) { this.gets.push(key); const v = this.store.get(key); return v ? body({ key, ...v }) : null; }, async put(key, bytes, options) { this.puts.push({ key, bytes, options }); if (this.store.has(key)) return null; const value = { bytes: String(bytes), customMetadata: options.customMetadata }; this.store.set(key, value); if (behavior.throwAfterWrite) throw Error("lost response"); return { key }; } };
}
function deps(b, extra = {}) { let saved = false; return { randomUUID: () => id, withBucket: async (_config, cb) => cb(b), createEvidence: () => ({ evidenceDir: "private" }), writeEvidence: () => { saved = true; return "private/provision.json"; }, get saved() { return saved; }, ...extra }; }

test("compiler emits four bounded exact-scope objects and stable hashes", () => {
  const manifest = compilePortalByteFixture(id);
  assert.equal(manifest.objects.length, 4);
  assert.equal(manifest.selectedPrefix, "staging/portal-acceptance/37fa87e6-f283-4a29-a2d7-f33629fbd0b7/shared/");
  assert.deepEqual(Object.fromEntries(manifest.objects.map(v => [v.role, v.sha256])), STAGING_PORTAL_BYTE_HASHES);
  assert.match(manifest.objects[0].key, new RegExp(`/37fa87e6-f283-4a29-a2d7-f33629fbd0b7/shared/${id}/`));
  assert.match(manifest.objects[2].key, new RegExp(`/37fa87e6-f283-4a29-a2d7-f33629fbd0b7/private/${id}/`));
  assert.doesNotMatch(manifest.objects[3].key, /37fa87e6-f283-4a29-a2d7-f33629fbd0b7/);
  assert.ok(manifest.objects.filter(v => v.role.startsWith("selected-")).every(v => v.key.startsWith(manifest.selectedPrefix)));
  assert.ok(manifest.objects.filter(v => !v.role.startsWith("selected-")).every(v => !v.key.startsWith(manifest.selectedPrefix)));
  assert.ok(manifest.objects.every(v => v.size <= 1024));
});

test("config is exact, staging-only, and one remote R2 binding", () => {
  assert.equal(validatePortalByteFixtureConfig(config).bucketName, "client-data-staging");
  for (const wrong of [{ ...config, account_id: "wrong" }, { ...config, r2_buckets: [...config.r2_buckets, config.r2_buckets[0]] }, { ...config, d1_databases: [] }]) assert.throws(() => validatePortalByteFixtureConfig(wrong));
});

test("prepare is readonly and uses only four exact HEADs", async () => {
  const b = bucket(), result = await preparePortalByteFixture("config", deps(b));
  assert.equal(result.mutationsPerformed, false); assert.equal(b.heads.length, 4); assert.equal(b.gets.length, 0); assert.equal(b.puts.length, 0);
});

test("apply saves manifest before conditional creates and exact readback", async () => {
  const b = bucket(); let saved = false;
  const d = deps(b, { writeEvidence: () => { saved = true; return "private/provision.json"; } });
  const original = b.put.bind(b); b.put = async (...args) => { assert.equal(saved, true); return original(...args); };
  const result = await applyPortalByteFixture("config", d);
  assert.equal(result.mode, "applied"); assert.equal(b.puts.length, 4); assert.ok(b.puts.every(v => v.options.onlyIf.etagDoesNotMatch === "*")); assert.equal(b.gets.length, 4);
});

test("collision never overwrites", async () => {
  const manifest = compilePortalByteFixture(id), item = manifest.objects[0], existing = new Map([[item.key, { bytes: "foreign", customMetadata: {} }]]), b = bucket(existing);
  await assert.rejects(applyPortalByteFixture("config", deps(b)), /collision/); assert.equal(b.puts.length, 0); assert.equal(existing.get(item.key).bytes, "foreign");
});

test("partial response retry accepts only exact owned bytes and metadata", async () => {
  const b = bucket(new Map(), { throwAfterWrite: true }), result = await applyPortalByteFixture("config", deps(b));
  assert.ok(result.outcomes.every(v => v.outcome === "created-response-lost"));
  const retry = bucket(b.store), again = await applyPortalByteFixture("config", deps(retry));
  assert.ok(again.outcomes.every(v => v.outcome === "already-owned")); assert.equal(retry.puts.length, 0);
});

test("resume uses the exact saved manifest after a partial stop without rewriting evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-byte-")), dir = path.join(root, ".backups", "staging-native-authority", id), file = path.join(dir, "provision.json"), manifest = compilePortalByteFixture(id), b = bucket();
  let calls = 0, writes = 0; const original = b.put.bind(b); b.put = async (...args) => { calls += 1; if (calls === 2) throw Error("stopped"); return original(...args); };
  try {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(resumePortalByteFixture("config", file, deps(b, { root, writeEvidence: () => { writes += 1; } })), /outcome unknown/);
    assert.equal(b.store.size, 1);
    b.put = original;
    const result = await main(["resume", "--config", "config", "--manifest", file], deps(b, { root, writeEvidence: () => { writes += 1; } }));
    assert.equal(result.mode, "resumed"); assert.equal(b.store.size, 4); assert.equal(writes, 0); assert.equal(result.outcomes[0].outcome, "already-owned");
    const before = b.puts.length, verified = await main(["verify", "--config", "config", "--manifest", file], deps(b, { root }));
    assert.equal(verified.mode, "verified-readonly"); assert.equal(verified.mutationsPerformed, false); assert.equal(verified.objects.length, 4); assert.equal(b.puts.length, before);
    assert.deepEqual(Object.keys(verified.objects[0]), ["role", "key", "etag", "version", "size", "uploaded", "contentType", "sha256"]);
    const missing = bucket(new Map(b.store)); missing.store.delete(manifest.objects[1].key);
    await assert.rejects(verifyPortalByteFixture("config", file, deps(missing, { root })), /missing object/);
    const collided = bucket(new Map(b.store)); collided.store.set(manifest.objects[1].key, { ...collided.store.get(manifest.objects[1].key), bytes: "foreign" });
    await assert.rejects(verifyPortalByteFixture("config", file, deps(collided, { root })), /collision/);
    const foreign = path.join(root, "provision.json"); fs.writeFileSync(foreign, JSON.stringify(manifest));
    await assert.rejects(main(["resume", "--config", "config", "--manifest", foreign], deps(b, { root })), /path rejected/);
    const tampered = structuredClone(manifest); tampered.objects[0].bytes = "changed"; fs.writeFileSync(file, JSON.stringify(tampered));
    await assert.rejects(main(["resume", "--config", "config", "--manifest", file], deps(b, { root })), /manifest changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real binding wrapper detects config drift and unexpected env and always disposes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-byte-config-")), file = path.join(dir, "wrangler.json"), b = bucket();
  try {
    fs.writeFileSync(file, JSON.stringify(config)); let disposed = 0;
    await preparePortalByteFixture(file, { randomUUID: () => id, getPlatformProxy: async options => { assert.deepEqual(options, { configPath: path.resolve(file), envFiles: [], persist: false, remoteBindings: true }); return { env: { DATA_BUCKET: b }, dispose: async () => { disposed += 1; } }; } });
    assert.equal(disposed, 1);
    fs.writeFileSync(file, JSON.stringify(config)); disposed = 0;
    await assert.rejects(preparePortalByteFixture(file, { randomUUID: () => id, getPlatformProxy: async () => ({ env: { DATA_BUCKET: b, EXTRA: {} }, dispose: async () => { disposed += 1; } }) }), /unexpected binding set/);
    assert.equal(disposed, 1);
    fs.writeFileSync(file, JSON.stringify(config)); disposed = 0;
    await assert.rejects(preparePortalByteFixture(file, { randomUUID: () => id, getPlatformProxy: async () => { fs.writeFileSync(file, `${JSON.stringify(config)} `); return { env: { DATA_BUCKET: b }, dispose: async () => { disposed += 1; } }; } }), /config changed/);
    assert.equal(disposed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
