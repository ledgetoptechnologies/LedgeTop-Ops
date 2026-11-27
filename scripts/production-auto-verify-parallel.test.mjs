import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectVerifiedAssets, executeAssetVerification } from "./production-auto-verify.mjs";

const bytes = Buffer.from("asset");
const entries = Array.from({ length: 5 }, (_, i) => ({
  path: "/assets/fixture-" + i + ".js",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  contentType: "application/javascript",
}));
const response = (method, body = bytes) => new Response(method === "HEAD" ? null : body, {
  headers: { "Content-Type": entries[0].contentType, "Content-Length": String(bytes.length) },
});
const refused = { message: "static_asset_verification_refused" };

test("three bounded lanes keep per-asset HEAD before GET and return in manifest order", async () => {
  let active = 0, peak = 0;
  const calls = [];
  const fetchAsset = async ({ path }, { method }) => {
    calls.push([path, method]);
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return response(method);
  };
  const assets = await collectVerifiedAssets({ entries, fetchAsset, concurrency: 3 });
  assert.equal(peak, 3);
  assert.deepEqual([...assets.keys()], entries.map(entry => entry.path));
  for (const { path } of entries) {
    assert.deepEqual(calls.filter(([key]) => key === path).map(([,method]) => method), ["HEAD", "GET"]);
    assert.deepEqual(assets.get(path), bytes);
  }
  peak = 0;
  await collectVerifiedAssets({ entries, fetchAsset });
  assert.equal(peak, 1);
});

test("integrity failure cancels the other readers and cleans the helper exactly once", async () => {
  const started = [], cancelled = [], cleanup = [];
  let failIntegrity;
  const failWhenReady = new Promise(resolve => { failIntegrity = resolve; });
  const fetchAsset = async ({ path }, { method }) => {
    started.push([path, method]);
    if (method === "HEAD") return response(method);
    if (path === entries[0].path) {
      await failWhenReady;
      return response(method, Buffer.from("wrong"));
    }
    const stream = new ReadableStream({ pull() {
      if (streamStarted.add(path).size === 2) failIntegrity();
    }, cancel() { cancelled.push(path); } });
    return response(method, stream);
  };
  const streamStarted = new Set();
  await assert.rejects(executeAssetVerification({ entries, fetchAsset, concurrency: 3, timeoutMs: 1000,
    create: () => cleanup.push("create"), remove: () => cleanup.push("remove"),
    readAbsent: () => { cleanup.push("absent"); return true; },
  }), refused);
  assert.deepEqual(cancelled.sort(), entries.slice(1, 3).map(({path}) => path));
  assert.deepEqual(cleanup, ["create", "remove", "absent"]);
  assert.equal(started.length, 6);
});

test("caller abort stops every lane and invalid concurrency fails before create", async () => {
  const controller = new AbortController();
  const calls = [];
  const fetchAsset = (_entry, { signal, method }) => {
    assert.equal(method, "HEAD");
    calls.push(signal);
    if (calls.length === 3) controller.abort();
    return new Promise(() => {});
  };
  await assert.rejects(collectVerifiedAssets({ entries, fetchAsset, signal: controller.signal, concurrency: 3 }), refused);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(signal => signal.aborted));
  await assert.rejects(executeAssetVerification({ entries, fetchAsset, concurrency: 4,
    create: assert.fail, remove: assert.fail, readAbsent: assert.fail }), refused);
});
