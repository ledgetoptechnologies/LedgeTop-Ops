import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeDirectoryMigrationWindow } from "./staging-native-directory-migration-window.mjs";
export { applicationTableNames, assertApplyReady, assertAttemptMarker, assertPreserved, normalizedSql, quoteSqlIdentifier, reviewedSchemaDefinitions } from "./staging-native-directory-migration-window.mjs";
export const SPEC = Object.freeze({
  application: "operations",
  preservationPolicy: "strict",
  from: 196,
  to: 198,
  database: "78b34173-b168-4e3d-9832-bb9d245cc6b8",
  databaseName: "ltds-ops-staging",
  binding: "OPS_DB",
  priorNamesSha256: "c8f55f7a543d1e51d69abce753c2ce54a4640c35fd93c2769c8e971bb8162106",
  priorContentsSha256: "5dd50102b800eb3b49c9c5f41adb6f1ce44005425118b718ecc544e7f0b49c03",
  suffix: Object.freeze([
    Object.freeze({ name: "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql", sha256: "9cf2194a57cf7888c768d492c78cacf842e3f6c6814d3f395e6fa8f4d0a31a76" }),
    Object.freeze({ name: "0198_native_directory_active_binding_revision_refresh.sql", sha256: "a51026608eb70a0645540cfe12bad51feb7a97f924e0b2c3b83837a3ae2fa7c3" }),
  ]),
});

const window = createNativeDirectoryMigrationWindow(SPEC);
export const assertNativeDirectoryExactLedger = window.assertExactLedger;
export const buildNativeDirectory196To198Plan = window.buildPlan;
export const materializeNativeDirectory196To198 = window.materialize;
export const nativeDirectory196To198ReadOnlyQueries = window.readOnlyQueries;
export const runNativeDirectory196To198 = window.run;
export const safeNativeDirectory196To198Failure = window.safeFailure;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeDirectory196To198().then(value => console.log(JSON.stringify(value))).catch(() => {
    console.error(safeNativeDirectory196To198Failure());
    process.exitCode = 1;
  });
