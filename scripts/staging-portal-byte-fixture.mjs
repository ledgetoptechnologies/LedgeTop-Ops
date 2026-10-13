import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { createPrivateEvidenceDirectory, writePrivateEvidence } from "./staging-native-authority-packet-rehearsal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = "846c924bf17bf4f3dd15c97a4c5d1d51";
const BUCKET = "client-data-staging";
const BINDING = "DATA_BUCKET";
const WORKER = "staging-portal-byte-fixture";
const DATE = "2026-10-08";
const TARGET = "37fa87e6-f283-4a29-a2d7-f33629fbd0b7";
const SELECTED_PREFIX = `staging/portal-acceptance/${TARGET}/shared/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT = Object.freeze({
  "selected-direct": "LTDS staging selected shared fixture\n",
  "selected-nested": "LTDS staging nested shared fixture\n",
  "sibling-private": "LTDS staging unselected private fixture\n",
  "cross-customer": "LTDS staging cross-customer fixture\n",
});
const fail = message => { throw new Error(`staging-portal-byte-fixture: ${message}`); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || !same(Object.keys(value).sort(), [...keys].sort())) fail(`${label} shape`);
};

export const STAGING_PORTAL_BYTE_TARGET = Object.freeze({ accountId: ACCOUNT, bucketName: BUCKET, binding: BINDING, targetId: TARGET, selectedPrefix: SELECTED_PREFIX });
export const STAGING_PORTAL_BYTE_HASHES = Object.freeze(Object.fromEntries(Object.entries(CONTENT).map(([role, bytes]) => [role, hash(bytes)])));

export function validatePortalByteFixtureConfig(value) {
  exact(value, ["name", "account_id", "compatibility_date", "r2_buckets"], "config");
  if (value.name !== WORKER || value.account_id !== ACCOUNT || value.compatibility_date !== DATE) fail("exact staging worker config required");
  if (!Array.isArray(value.r2_buckets) || value.r2_buckets.length !== 1) fail("exactly one R2 binding required");
  const bucket = value.r2_buckets[0];
  exact(bucket, ["binding", "bucket_name", "remote"], "R2 binding");
  if (bucket.binding !== BINDING || bucket.bucket_name !== BUCKET || bucket.remote !== true) fail("exact remote staging R2 binding required");
  return STAGING_PORTAL_BYTE_TARGET;
}

function readConfig(configPath, d = {}) {
  if (typeof configPath !== "string" || !configPath.length || configPath !== configPath.trim()) fail("config path required");
  const resolved = path.resolve(configPath), lstat = d.lstat ?? fs.lstatSync, read = d.readFile ?? fs.readFileSync;
  let stat, bytes;
  try { stat = lstat(resolved); } catch { fail("config must be an existing regular file"); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("config must be a non-symlink regular file");
  try { bytes = read(resolved, "utf8"); } catch { fail("config could not be read"); }
  let config;
  try { config = JSON.parse(bytes); } catch { fail("config must be valid JSON"); }
  return Object.freeze({ configPath: resolved, config, configHash: hash(bytes), target: validatePortalByteFixtureConfig(config) });
}

function loadProxy() {
  return createRequire(path.join(ROOT, "apps", "client", "package.json"))("wrangler").getPlatformProxy;
}

async function withBucket(configPath, callback, d = {}) {
  const read = d.readConfig ?? readConfig, before = read(configPath, d), getPlatformProxy = d.getPlatformProxy ?? loadProxy();
  const platform = await getPlatformProxy({ configPath: before.configPath, envFiles: [], persist: false, remoteBindings: true });
  if (!platform || typeof platform.dispose !== "function") fail("invalid platform proxy");
  try {
    const after = read(before.configPath, d);
    if (!same(before, after)) fail("config changed while opening binding");
    if (!platform.env || !same(Object.keys(platform.env), [BINDING])) fail("platform exposed an unexpected binding set");
    const bucket = platform.env[BINDING];
    if (!bucket || typeof bucket.head !== "function" || typeof bucket.get !== "function" || typeof bucket.put !== "function") fail("DATA_BUCKET is not an R2 binding");
    return await callback(bucket, before.target);
  } finally { await platform.dispose(); }
}

export function compilePortalByteFixture(runId) {
  if (!UUID.test(runId)) fail("fresh UUID required");
  const base = `staging/portal-acceptance/${TARGET}`;
  const keys = {
    "selected-direct": `${base}/shared/${runId}/selected.txt`,
    "selected-nested": `${base}/shared/${runId}/nested/selected.txt`,
    "sibling-private": `${base}/private/${runId}/sibling.txt`,
    "cross-customer": `staging/portal-acceptance/cross-customer-${runId}/shared/cross.txt`,
  };
  const objects = Object.entries(keys).map(([role, key]) => {
    const bytes = CONTENT[role], size = Buffer.byteLength(bytes);
    if (size > 1024) fail("fixture exceeds byte bound");
    return Object.freeze({ role, key, bytes, size, sha256: hash(bytes), customMetadata: Object.freeze({ fixture: "staging-portal-byte-v1", runId, role, sha256: hash(bytes) }) });
  });
  const selected = objects.filter(item => item.role.startsWith("selected-")), excluded = objects.filter(item => !item.role.startsWith("selected-"));
  if (selected.length !== 2 || selected.some(item => !item.key.startsWith(SELECTED_PREFIX)) || excluded.some(item => item.key.startsWith(SELECTED_PREFIX))) fail("fixture scope invariant");
  return Object.freeze({ schemaVersion: 1, stagingOnly: true, accountId: ACCOUNT, bucketName: BUCKET, targetId: TARGET, selectedPrefix: SELECTED_PREFIX, runId, objects });
}

async function observeExact(bucket, item, required = false) {
  const head = await bucket.head(item.key);
  if (!head) { if (required) fail(`missing object at ${item.role}`); return null; }
  if (head.key !== item.key || head.size !== item.size || !same(head.customMetadata, item.customMetadata)) fail(`collision at ${item.role}`);
  if (typeof head.etag !== "string" || !head.etag.length || typeof head.version !== "string" || !head.version.length
    || !(head.uploaded instanceof Date) || !Number.isFinite(head.uploaded.getTime())
    || head.httpMetadata?.contentType !== "text/plain; charset=utf-8") fail(`metadata collision at ${item.role}`);
  const object = await bucket.get(item.key);
  if (!object || typeof object.arrayBuffer !== "function") fail(`missing readback body at ${item.role}`);
  const bytes = Buffer.from(await object.arrayBuffer());
  if (bytes.length !== item.size || hash(bytes) !== item.sha256 || !bytes.equals(Buffer.from(item.bytes))) fail(`byte collision at ${item.role}`);
  return Object.freeze({ role: item.role, key: item.key, etag: head.etag, version: head.version, size: head.size,
    uploaded: head.uploaded.toISOString(),
    contentType: head.httpMetadata?.contentType ?? null, sha256: item.sha256 });
}

async function exactRead(bucket, item) { return Boolean(await observeExact(bucket, item)); }

async function createOne(bucket, item) {
  if (await exactRead(bucket, item)) return "already-owned";
  let result;
  try {
    result = await bucket.put(item.key, item.bytes, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "text/plain; charset=utf-8" }, customMetadata: item.customMetadata, sha256: item.sha256 });
  } catch (error) {
    if (await exactRead(bucket, item)) return "created-response-lost";
    throw new Error(`staging-portal-byte-fixture: write outcome unknown at ${item.role}`, { cause: error });
  }
  if (result === null) {
    if (await exactRead(bucket, item)) return "already-owned";
    fail(`conditional collision at ${item.role}`);
  }
  if (!await exactRead(bucket, item)) fail(`missing write readback at ${item.role}`);
  return "created";
}

function ops(d = {}) {
  return { root: d.root ?? ROOT, uuid: d.randomUUID ?? crypto.randomUUID, withBucket: d.withBucket ?? withBucket,
    createEvidence: d.createEvidence ?? createPrivateEvidenceDirectory, writeEvidence: d.writeEvidence ?? writePrivateEvidence };
}

function readManifest(root, filename, d = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof filename !== "string") fail("private manifest path required");
  const resolved = path.resolve(filename), relative = path.relative(path.join(root, ".backups", "staging-native-authority"), resolved);
  if (path.basename(resolved) !== "provision.json" || path.isAbsolute(relative) || relative.startsWith("..")
    || path.dirname(relative) === "." || path.basename(path.dirname(relative)) !== path.dirname(relative) || !UUID.test(path.dirname(relative))) fail("private manifest path rejected");
  const lstat = d.lstat ?? fs.lstatSync, read = d.readFile ?? fs.readFileSync;
  for (const entry of [root, path.join(root, ".backups"), path.join(root, ".backups", "staging-native-authority"), path.dirname(resolved), resolved]) {
    let stat; try { stat = lstat(entry); } catch { fail("private manifest path missing"); }
    const file = entry === resolved;
    if (stat.isSymbolicLink() || (file ? !stat.isFile() : !stat.isDirectory())) fail("private manifest must be non-symlink bounded path");
    if (file && stat.size > 65536) fail("private manifest exceeds size bound");
  }
  let value; try { value = JSON.parse(read(resolved, "utf8")); } catch { fail("private manifest invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || !UUID.test(value.runId)
    || value.runId !== path.basename(path.dirname(resolved))) fail("private manifest identity mismatch");
  const compiled = compilePortalByteFixture(value.runId);
  if (!same(value, compiled)) fail("private manifest changed");
  return Object.freeze({ manifest: compiled, manifestPath: resolved });
}

export async function preparePortalByteFixture(configPath, d = {}) {
  const o = ops(d), manifest = compilePortalByteFixture(o.uuid());
  return o.withBucket(configPath, async bucket => {
    const occupied = [];
    for (const item of manifest.objects) if (await bucket.head(item.key)) occupied.push(item.role);
    if (occupied.length) fail(`fresh UUID collision: ${occupied.join(",")}`);
    return { mode: "prepared-readonly", mutationsPerformed: false, manifest };
  }, d);
}

export async function applyPortalByteFixture(configPath, d = {}) {
  const o = ops(d), manifest = compilePortalByteFixture(o.uuid());
  return o.withBucket(configPath, async bucket => {
    const evidence = o.createEvidence(o.root, manifest.runId), manifestPath = o.writeEvidence(o.root, evidence.evidenceDir, "provision.json", manifest);
    if (!manifestPath) fail("private manifest save failed");
    const outcomes = [];
    for (const item of manifest.objects) outcomes.push({ role: item.role, outcome: await createOne(bucket, item) });
    return { mode: "applied", mutationsPerformed: true, manifestPath, hashes: STAGING_PORTAL_BYTE_HASHES, outcomes };
  }, d);
}

export async function resumePortalByteFixture(configPath, manifestFile, d = {}) {
  const o = ops(d), { manifest, manifestPath } = readManifest(o.root, manifestFile, d);
  return o.withBucket(configPath, async bucket => {
    const outcomes = [];
    for (const item of manifest.objects) outcomes.push({ role: item.role, outcome: await createOne(bucket, item) });
    return { mode: "resumed", mutationsPerformed: true, manifestPath, hashes: STAGING_PORTAL_BYTE_HASHES, outcomes };
  }, d);
}

export async function verifyPortalByteFixture(configPath, manifestFile, d = {}) {
  const o = ops(d), { manifest, manifestPath } = readManifest(o.root, manifestFile, d);
  return o.withBucket(configPath, async bucket => {
    const objects = [];
    for (const item of manifest.objects) objects.push(await observeExact(bucket, item, true));
    return { mode: "verified-readonly", mutationsPerformed: false, manifestPath, selectedPrefix: manifest.selectedPrefix, objects };
  }, d);
}

export async function main(argv = process.argv.slice(2), d = {}) {
  const values = argv[0] === "--config" ? ["prepare", ...argv] : argv, [mode, configFlag, configPath, manifestFlag, manifestPath] = values;
  if ((mode === "prepare" || mode === "apply") && (values.length !== 3 || configFlag !== "--config" || !configPath)) fail("usage: [prepare|apply] --config <path>");
  if ((mode === "resume" || mode === "verify") && (values.length !== 5 || configFlag !== "--config" || !configPath || manifestFlag !== "--manifest" || !manifestPath)) fail("usage: resume|verify --config <path> --manifest <private-provision.json>");
  if (mode === "prepare") return preparePortalByteFixture(configPath, d);
  if (mode === "apply") return applyPortalByteFixture(configPath, d);
  if (mode === "resume") return resumePortalByteFixture(configPath, manifestPath, d);
  if (mode === "verify") return verifyPortalByteFixture(configPath, manifestPath, d);
  fail("unknown mode");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result)), error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
