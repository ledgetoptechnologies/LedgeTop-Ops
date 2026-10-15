import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROFILE, INITIAL_READ_SCOPES, STAGING_ORIGINS,
  buildTwoSourceStagingConnectionPlan as plan,
  buildTwoSourceStagingConnectionSecret as secret } from "./staging-ops-two-source-connection-profile-v1.mjs";

// Synthetic identities for tests only; never rendered as deployment defaults.
const uuid = n => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
function fixture() {
  return { profile: PROFILE, version: 1, sources: Object.fromEntries(Object.entries(STAGING_ORIGINS).map(([stage, baseUrl], index) => [stage, {
    sourceId: index === 0 ? "project-alpha:staging" : "project-alpha:test-2", enabled: true, baseUrl,
    sourceInstanceId: uuid(index * 3 + 1), applicationId: uuid(index * 3 + 2), historyEpoch: uuid(index * 3 + 3),
    scopes: [...INITIAL_READ_SCOPES],
  }])) };
}
function credentials(metadata) {
  return Object.fromEntries(Object.values(metadata.sources).map((source, index) => [source.sourceId, { apiKey: `private-test-token-${index}` }]));
}

test("versioned template cannot accidentally deploy fabricated identities", () => {
  const example = JSON.parse(fs.readFileSync(new URL("./staging-ops-two-source-connection-profile-v1.example.json", import.meta.url), "utf8"));
  assert.throws(() => plan(example), /invalid or incomplete/);
  for (const changed of [{ ...fixture(), version: 2 }, { ...fixture(), profile: "production" }]) {
    assert.throws(() => plan(changed), /invalid or incomplete/);
  }
});

test("read plan preserves compatibility pin and isolates actual operator identities without mutation", () => {
  const metadata = fixture();
  const before = structuredClone(metadata);
  metadata.sources.stageTwo.scopes.reverse();
  const result = plan(metadata);
  assert.equal(result.sources[0].baseUrl, STAGING_ORIGINS.stageOne);
  assert.equal(result.sources[1].baseUrl, STAGING_ORIGINS.stageTwo);
  assert.equal(result.liveAcceptanceRequired, true);
  assert.deepEqual(result.sources[1].scopes, INITIAL_READ_SCOPES);
  metadata.sources.stageTwo.scopes.reverse();
  assert.deepEqual(metadata, before);
  assert.ok(Object.isFrozen(result.sources[0]));
  assert.equal(JSON.stringify(result).includes("apiKey"), false);
});

test("credential bridge emits only exact runtime v1 envelope and never changes public plan", () => {
  const metadata = fixture(), privateValues = credentials(metadata);
  const publicBefore = JSON.stringify(plan(metadata));
  const envelope = JSON.parse(secret(metadata, privateValues));
  assert.deepEqual(Object.keys(envelope).sort(), ["instances", "version"]);
  assert.equal(envelope.version, 1);
  for (const source of Object.values(metadata.sources)) {
    const { scopes, ...identity } = source;
    assert.deepEqual(envelope.instances[source.sourceId], { ...identity, apiKey: privateValues[source.sourceId].apiKey });
  }
  assert.equal(JSON.stringify(plan(metadata)), publicBefore);
});

test("either disabled, malformed or absent sibling blocks the entire plan and secret", () => {
  for (const stage of Object.keys(STAGING_ORIGINS)) {
    for (const mutate of [s => { s.enabled = false; }, s => { delete s.enabled; }, s => { s.enabled = "true"; },
      s => { s.sourceInstanceId = null; }, s => { s.applicationId = "operator-must-supply"; },
      s => { s.historyEpoch = uuid(0).replace("4000", "1000"); }, s => { s.sourceId = "alias"; },
      s => { s.extra = "private-test-token"; }, s => { s.apiKey = "private-test-token"; }]) {
      const metadata = fixture(); mutate(metadata.sources[stage]);
      assert.throws(() => plan(metadata), /invalid or incomplete/);
      assert.throws(() => secret(metadata, credentials(metadata)), /invalid or incomplete/);
    }
    const metadata = fixture(); delete metadata.sources[stage];
    assert.throws(() => plan(metadata), /invalid or incomplete/);
  }
});

test("distinct installations require distinct aliases and source-instance identities", () => {
  for (const field of ["sourceId", "sourceInstanceId"]) {
    const metadata = fixture(); metadata.sources.stageTwo[field] = metadata.sources.stageOne[field];
    assert.throws(() => plan(metadata), /invalid or incomplete/);
  }
  const metadata = fixture();
  metadata.sources.stageOne.sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  metadata.sources.stageTwo.sourceInstanceId = metadata.sources.stageOne.sourceInstanceId.toUpperCase();
  assert.throws(() => plan(metadata), /invalid or incomplete/);
});

test("PA-local application and epoch identities may coincide across independent installations", () => {
  const metadata = fixture();
  metadata.sources.stageTwo.applicationId = metadata.sources.stageOne.applicationId;
  metadata.sources.stageTwo.historyEpoch = metadata.sources.stageOne.historyEpoch;
  const result = plan(metadata);
  assert.equal(result.sources[0].applicationId, result.sources[1].applicationId);
  assert.equal(result.sources[0].historyEpoch, result.sources[1].historyEpoch);
  assert.notEqual(result.sources[0].sourceInstanceId, result.sources[1].sourceInstanceId);
  assert.equal(Object.keys(JSON.parse(secret(metadata, credentials(metadata))).instances).length, 2);
});

test("runtime within-tuple identity invariant is preserved before secret generation", () => {
  for (const stage of Object.keys(STAGING_ORIGINS)) {
    for (const [left, right] of [["sourceInstanceId", "applicationId"], ["applicationId", "historyEpoch"], ["sourceInstanceId", "historyEpoch"]]) {
      const metadata = fixture();
      metadata.sources[stage][left] = metadata.sources[stage][right];
      assert.throws(() => plan(metadata), /invalid or incomplete/);
      assert.throws(() => secret(metadata, credentials(metadata)), /invalid or incomplete/);
    }
  }
});

test("Stage One existing enrollment alias cannot be rewritten", () => {
  const metadata = fixture();
  metadata.sources.stageOne.sourceId = "project-alpha:stage-one";
  assert.throws(() => plan(metadata), /invalid or incomplete/);
});

test("no hostname rewrite, production, paths, auth, or Access metadata can pass", () => {
  for (const baseUrl of ["https://pa-stage-one.ledgetoptechnologies.com", "https://pa.ledgetoptechnologies.com",
    `${STAGING_ORIGINS.stageOne}/`, `${STAGING_ORIGINS.stageOne}?`, `${STAGING_ORIGINS.stageOne}/api`, "http://localhost:1628"]) {
    const metadata = fixture(); metadata.sources.stageOne.baseUrl = baseUrl;
    assert.throws(() => plan(metadata), /invalid or incomplete/);
  }
  const metadata = fixture(); metadata.sources.stageTwo.accessClientSecret = "secret";
  assert.throws(() => plan(metadata), /invalid or incomplete/);
});

test("initial scope contract rejects missing, duplicate and write grants", () => {
  for (const scopes of [[], INITIAL_READ_SCOPES.slice(1), [...INITIAL_READ_SCOPES, "projects.write"],
    [INITIAL_READ_SCOPES[0], INITIAL_READ_SCOPES[0], INITIAL_READ_SCOPES[2]],
    [INITIAL_READ_SCOPES[0], INITIAL_READ_SCOPES[1], "projects.write"]]) {
    const metadata = fixture(); metadata.sources.stageTwo.scopes = scopes;
    assert.throws(() => plan(metadata), /invalid or incomplete/);
  }
});

test("secret bridge requires precisely both keys and rejects header injection without echoing secrets", () => {
  for (const key of ["", "private-test-token\r\nAuthorization:bad", "space token", "x".repeat(8193), "é"]) {
    const metadata = fixture(), values = credentials(metadata);
    values[metadata.sources.stageTwo.sourceId].apiKey = key;
    assert.throws(() => secret(metadata, values), error => error.message === "Two-source staging connection profile is invalid or incomplete");
  }
  const metadata = fixture();
  for (const values of [{}, { ...credentials(metadata), extra: { apiKey: "private" } }]) {
    assert.throws(() => secret(metadata, values), /invalid or incomplete/);
  }
  const accessor = fixture();
  Object.defineProperty(accessor.sources.stageTwo, "applicationId", { enumerable: true, get() { throw new Error("private-token"); } });
  assert.throws(() => plan(accessor), error => !error.message.includes("private-token"));
});

test("check CLI has no writes and redacts accidental credentials and parse errors", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "two-source-profile-"));
  try {
    const input = path.join(directory, "metadata.json");
    const script = fileURLToPath(new URL("./staging-ops-two-source-connection-profile-v1.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [script, "--check", "--values", input], { encoding: "utf8", cwd: directory });
    fs.writeFileSync(input, JSON.stringify(fixture()));
    assert.equal(run().status, 0);
    assert.deepEqual(fs.readdirSync(directory), ["metadata.json"]);
    for (const text of ['{"apiKey":"private-test-token"', JSON.stringify({ ...fixture(), apiKey: "private-test-token" }),
      JSON.stringify(fixture()).replace('"enabled":true', '"enabled":false,"enabled":true'),
      JSON.stringify(fixture()).replace('"enabled":true', '"enabled":false,"\\u0065nabled":true')]) {
      fs.writeFileSync(input, text);
      const result = run(); assert.equal(result.status, 1);
      assert.equal((result.stdout + result.stderr).includes("private-test-token"), false);
    }
  } finally { fs.rmSync(directory, { recursive: true }); }
});
