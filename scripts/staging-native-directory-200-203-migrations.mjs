import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createNativeDirectoryMigrationWindow } from "./staging-native-directory-migration-window.mjs";
export { applicationTableNames, assertApplyReady, assertAttemptMarker, assertPreserved, normalizedSql, quoteSqlIdentifier,
  reviewedNativeDirectorySchemaDefinitions, reviewedSchemaDefinitions } from "./staging-native-directory-migration-window.mjs";

export const SPEC = Object.freeze({
  application: "operations", preservationPolicy: "strict", from: 200, to: 203,
  database: "78b34173-b168-4e3d-9832-bb9d245cc6b8", databaseName: "ltds-ops-staging", binding: "OPS_DB",
  priorNamesSha256: "33b6dbc6d8270cc82b7af0c315c5d874a5e8369ad0884185a60085218e75601f",
  priorContentsSha256: "8544d12cba6a51f3ab909c85d02e5fb8b48c54f054f1ca30d426ea17be924138",
  suffix: Object.freeze([
    Object.freeze({ name: "0201_native_directory_lifecycle.sql", sha256: "7bdd6d02c5ab97ba705e9a6d32238917ffb9a0757f3aa49d4eb8dcf7795e2878" }),
    Object.freeze({ name: "0202_reviewed_import_enrollment.sql", sha256: "77388f0dfa96e3715ef9754dd2dc92a7b1ec18139be0b8bf4590b79a3a77cedf" }),
    Object.freeze({ name: "0203_effective_native_directory_enrollment_consumers.sql", sha256: "3e331b0de53c0e4ca0b22395b879ef0e799f66872c2f49afd4ef7f7a58be0008" }),
  ]),
});
// This tool trusts the local operator and repository checkout. Private ACLs,
// hashes and an exclusive shared attempt marker prevent accidental disclosure,
// drift and retry; they are not append-only storage against a local administrator.
// Before apply, independently restore/verify the exact private SQL export.
// Export command success and a nonempty file alone do not prove restorability.
export const SOURCE_CI_JOBS = Object.freeze(["source-invariants", "incoming-pickup-alpine", "client", "operations", "ops-sync", "thumbnail-renderer",
  "operations-browser-desktop-edge", "operations-browser-mobile-edge", "client-browser-desktop-edge", "client-browser-mobile-edge"]);

export function assertNativeDirectory203SourceCi(run, expectedHeadSha, now = Date.now()) {
  assert.match(expectedHeadSha, /^[0-9a-f]{40}$/u, "exact reviewed source SHA required");
  assert(run && run.workflowName === "CI" && run.headSha === expectedHeadSha && run.status === "completed" && run.conclusion === "success",
    "completed successful CI for the exact reviewed source SHA required");
  assert(["pull_request", "push"].includes(run.event), "reviewed source CI event required");
  const updated = Date.parse(run.updatedAt);
  assert(Number.isFinite(updated) && updated <= now && now - updated <= 30 * 60_000, "fresh source CI required");
  assert(Array.isArray(run.jobs) && run.jobs.length === SOURCE_CI_JOBS.length, "all ten source CI jobs required");
  assert.deepEqual(run.jobs.map(job => job.name).sort(), [...SOURCE_CI_JOBS].sort(), "exact source CI job set required");
  assert(run.jobs.every(job => job.status === "completed" && job.conclusion === "success"), "every source CI job must succeed");
}
function readCommand(command, args, base) {
  const result = spawnSync(command, args, { cwd: base, windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"] });
  assert(!result.error && result.status === 0, "source CI verification command unavailable");
  return result.stdout.trim();
}
/** Read-only git/GitHub attestation. Requires gh's existing authentication; it never reads provider credentials. */
export async function verifyNativeDirectory203SourceCi(base, dependencies = {}) {
  const runId = process.env.STAGING_SOURCE_CI_RUN_ID;
  const expectedHeadSha = process.env.STAGING_SOURCE_COMMIT_SHA;
  assert(typeof runId === "string" && /^[1-9][0-9]{0,19}$/u.test(runId), "explicit source CI run ID required");
  assert(typeof expectedHeadSha === "string" && /^[0-9a-f]{40}$/u.test(expectedHeadSha), "explicit final reviewed source SHA required");
  const read = dependencies.readSourceCiCommand ?? readCommand;
  const headSha = read("git", ["rev-parse", "HEAD"], base);
  assert.equal(headSha, expectedHeadSha, "checkout must be the exact final reviewed source SHA");
  assert.equal(read("git", ["status", "--porcelain", "--untracked-files=normal"], base), "", "clean exact source checkout required");
  const run = JSON.parse(read("gh", ["run", "view", runId, "--repo", "ledgetoptechnologies/LedgeTop-Ops", "--json",
    "headSha,workflowName,status,conclusion,event,updatedAt,jobs"], base));
  assertNativeDirectory203SourceCi(run, expectedHeadSha);
  assert.equal(read("git", ["rev-parse", "HEAD"], base), expectedHeadSha, "source HEAD changed during verification");
  assert.equal(read("git", ["status", "--porcelain", "--untracked-files=normal"], base), "", "source checkout changed during verification");
  return Object.freeze({ headSha: expectedHeadSha, runId });
}

const window = createNativeDirectoryMigrationWindow(SPEC,
  (base, dependencies) => (dependencies.sourceCiGate ?? verifyNativeDirectory203SourceCi)(base, dependencies));
export const buildNativeDirectory200To203Plan = window.buildPlan;
export const assertNativeDirectory200To203PrivateArtifact = window.assertPrivate;
export const materializeNativeDirectory200To203 = window.materialize;
export const nativeDirectory200To203ReadOnlyQueries = window.readOnlyQueries;
export const runNativeDirectory200To203 = window.run;
export const safeNativeDirectory200To203Failure = window.safeFailure;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeDirectory200To203().then(value => console.log(JSON.stringify(value))).catch(() => {
    console.error(safeNativeDirectory200To203Failure()); process.exitCode = 1;
  });
