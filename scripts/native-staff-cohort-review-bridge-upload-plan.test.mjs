import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RETAINED_RUNTIME_PINS } from "./native-staff-cohort-review-bridge-build.mjs";
import {
  createNativeStaffCohortReviewBridgeUploadPlan,
  inspectNativeStaffCohortReviewBridgeCandidatePackage,
} from "./native-staff-cohort-review-bridge-upload-plan.mjs";

const OPS = JSON.parse(readFileSync(new URL("./native-staff-cohort-review-bridge-installed-profile.json", import.meta.url), "utf8")).operations;
const PINNED = "0b1ab5a8-9db0-42ab-b718-8569fae2382e";
const CANDIDATE_DIR = process.env.COHORT_BRIDGE_CANDIDATE_DIR;
const clone = value => structuredClone(value);

function metadataFixture() {
  const bindings = [
    ...clone(OPS.bindings),
    ...OPS.plainNames.map(name => ({ name, type: "plain_text", text: `fixture-${name}` })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const identity = { id: PINNED, versions: [{ version_id: PINNED, percentage: 100 }] };
  return {
    operations: {
      latest: PINNED,
      deployment: identity,
      version: { id: PINNED, resources: { script: clone(OPS.script), script_runtime: clone(OPS.runtime), bindings: clone(bindings) } },
      modern: {
        id: PINNED,
        main_module: "index.js",
        compatibility_date: OPS.runtime.compatibility_date,
        compatibility_flags: clone(OPS.runtime.compatibility_flags),
        exports: clone(OPS.runtime.exports),
        usage_model: OPS.runtime.usage_model,
        containers: clone(OPS.runtime.containers),
        migration_tag: OPS.runtime.migration_tag,
        bindings: bindings.map(({ name, type }) => ({ name, type })),
        assets: { config: clone(OPS.metadata.assets.config), jwt: "test-only-opaque-placeholder" },
        modules: [],
      },
      settings: { ...clone(OPS.settings), annotations: {}, bindings: bindings.map(({ name, type }) => ({ name, type })) },
      schedules: { schedules: OPS.crons.map(cron => ({ cron })) },
    },
  };
}

async function copyCandidate(t, mutate) {
  assert.ok(CANDIDATE_DIR, "COHORT_BRIDGE_CANDIDATE_DIR is required for the offline package artifact case");
  const parent = await mkdtemp(path.join(os.tmpdir(), "cohort-bridge-plan-"));
  const directory = path.join(parent, "candidate");
  await mkdir(directory);
  for (const name of ["wrapper.js", "index.js", "__ops_c880_retention_ledger.json", "__ops_release_ledger.json", "bridge-build-receipt.json"])
    await copyFile(path.join(CANDIDATE_DIR, name), path.join(directory, name));
  if (mutate) await mutate(directory);
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return directory;
}

test("planner rejects active/latest/deployment and installed metadata drift before candidate reads", async () => {
  const mutations = [
    [snapshot => { snapshot.operations.latest = "11111111-1111-4111-8111-111111111111"; }, /active, latest, and modern version/],
    [snapshot => { snapshot.operations.modern.id = "11111111-1111-4111-8111-111111111111"; }, /active, latest, and modern version/],
    [snapshot => { snapshot.operations.deployment.versions.push({ version_id: "11111111-1111-4111-8111-111111111111", percentage: 0 }); }, /exactly one active version/],
    [snapshot => { snapshot.operations.deployment.versions[0].percentage = 99; }, /exactly one active version/],
    [snapshot => { snapshot.operations.version.resources.script_runtime.exports.Added = { type: "worker" }; }, /runtime metadata differs/],
    [snapshot => { snapshot.operations.version.resources.script.handlers = ["fetch", "newHandler"]; }, /script handlers differ/],
    [snapshot => { snapshot.operations.version.resources.bindings[0].type = "changed"; }, /binding metadata differs/],
    [snapshot => { snapshot.operations.settings.observability.logs.persist = false; }, /Worker settings differ/],
    [snapshot => { snapshot.operations.modern.main_module = "index.js.old"; }, /Modern version metadata differs/],
    [snapshot => { snapshot.operations.modern.exports = { ...clone(OPS.runtime.exports), Added: { type: "worker" } }; }, /Modern version metadata differs/],
    [snapshot => { snapshot.operations.modern.bindings[0].type = "changed"; }, /Modern version and active-version binding/],
    [snapshot => { snapshot.operations.modern.assets.config = { changed: true }; }, /Baseline asset configuration differs/],
  ];
  for (const [mutate, expected] of mutations) {
    const baselineSnapshot = metadataFixture();
    mutate(baselineSnapshot);
    await assert.rejects(createNativeStaffCohortReviewBridgeUploadPlan({ baselineSnapshot, candidateDir: "C:\\missing\\candidate" }), expected);
  }
});

test("planner rejects scalar setting drift using the fixed installed-profile value hashes", async () => {
  await assert.rejects(
    createNativeStaffCohortReviewBridgeUploadPlan({ baselineSnapshot: metadataFixture(), candidateDir: "C:\\missing\\candidate" }),
    /plain binding value hash differs from the installed profile/,
  );
});

test("candidate package pins and content types validate without a provider or live baseline", { skip: !CANDIDATE_DIR }, async t => {
  const candidateDir = await copyCandidate(t);
  const candidate = await inspectNativeStaffCohortReviewBridgeCandidatePackage(candidateDir);
  assert.deepEqual(candidate.modules.map(({ name, contentType }) => [name, contentType]), [
    ["wrapper.js", "application/javascript+module"],
    ["index.js", "application/javascript+module"],
    ["__ops_c880_retention_ledger.json", "text/plain"],
    ["__ops_release_ledger.json", "text/plain"],
  ]);
  assert.equal(candidate.receipt.wrapper.sha256, "0b747e80c503eb0600df5fa37d8f1d31a9d6f2f6c96c869768dd741e49fc2daa");
  assert.deepEqual(candidate.modules.filter(row => row.name !== "wrapper.js" && row.name !== "index.js").map(row => row.sha256), [
    RETAINED_RUNTIME_PINS["__ops_c880_retention_ledger.json"],
    RETAINED_RUNTIME_PINS["__ops_release_ledger.json"],
  ]);
});

test("candidate receipt, wrapper, and retained-module tampering fail closed", { skip: !CANDIDATE_DIR }, async t => {
  const receiptTampered = await copyCandidate(t, async directory => {
    const receiptPath = path.join(directory, "bridge-build-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.candidateMainModule = "index.js";
    await writeFile(receiptPath, JSON.stringify(receipt));
  });
  await assert.rejects(inspectNativeStaffCohortReviewBridgeCandidatePackage(receiptTampered), /independently reviewed receipt pin/);

  for (const [filename, change, expected] of [
    ["wrapper.js", async bytes => Buffer.concat([bytes, Buffer.from("\n// changed\n")]), /size differs from its pin/],
    ["index.js", async () => Buffer.from("tampered"), /size differs from its pin/],
    ["__ops_release_ledger.json", async bytes => { const copy = Buffer.from(bytes); copy[0] ^= 1; return copy; }, /retained module bytes differ from pin/],
  ]) {
    const tampered = await copyCandidate(t, async directory => {
      const file = path.join(directory, filename);
      await writeFile(file, await change(await readFile(file)));
    });
    await assert.rejects(inspectNativeStaffCohortReviewBridgeCandidatePackage(tampered), expected);
  }
});
