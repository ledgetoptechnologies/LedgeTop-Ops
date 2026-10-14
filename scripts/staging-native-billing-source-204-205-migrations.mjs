import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeDirectoryMigrationWindow } from "./staging-native-directory-migration-window.mjs";
import { OPERATIONS_SOURCE_CHAIN_204 } from "./staging-operations-source-v204.mjs";
import { OPERATIONS_SOURCE_CHAIN_205 } from "./staging-operations-source-v205.mjs";
import { verifyNativeDirectory203SourceCi } from "./staging-native-directory-200-203-migrations.mjs";

export { SOURCE_CI_JOBS, assertNativeDirectory203SourceCi as assertNativeBilling205SourceCi }
  from "./staging-native-directory-200-203-migrations.mjs";
export const SPEC = Object.freeze({
  application: "operations", preservationPolicy: "strict", from: 204, to: 205,
  database: "78b34173-b168-4e3d-9832-bb9d245cc6b8", databaseName: "ltds-ops-staging", binding: "OPS_DB",
  priorNamesSha256: OPERATIONS_SOURCE_CHAIN_204.namesSha256,
  priorContentsSha256: OPERATIONS_SOURCE_CHAIN_204.contentsSha256,
  suffix: Object.freeze(Object.entries(OPERATIONS_SOURCE_CHAIN_205.appendedMigrations)
    .map(([name, sha256]) => Object.freeze({ name, sha256 }))),
});
export const PROFILE = Object.freeze({ sourceChain: OPERATIONS_SOURCE_CHAIN_205,
  generatedArtifacts: "ignored-native-billing-205" });
// No ALTER/replacement exception: all prior rows and schema must remain exact,
// new objects must equal reviewed definitions and new tables must be empty.
const window = createNativeDirectoryMigrationWindow(SPEC,
  (base, dependencies) => (dependencies.sourceCiGate ?? verifyNativeDirectory203SourceCi)(base, dependencies), null, PROFILE);
export const buildNativeBilling204To205Plan = window.buildPlan;
export const materializeNativeBilling204To205 = window.materialize;
export const nativeBilling204To205ReadOnlyQueries = window.readOnlyQueries;
export const runNativeBilling204To205 = window.run;
export const safeNativeBilling204To205Failure = window.safeFailure;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeBilling204To205().then(value => console.log(JSON.stringify(value))).catch(() => {
    console.error(safeNativeBilling204To205Failure()); process.exitCode = 1;
  });
