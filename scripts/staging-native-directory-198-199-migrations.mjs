import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createNativeDirectoryMigrationWindow } from "./staging-native-directory-migration-window.mjs";
export { applicationTableNames, assertApplyReady, assertAttemptMarker, assertPreserved, normalizedSql, quoteSqlIdentifier, reviewedSchemaDefinitions } from "./staging-native-directory-migration-window.mjs";

export const SPEC = Object.freeze({
  application: "operations", preservationPolicy: "strict", from: 198, to: 199,
  database: "78b34173-b168-4e3d-9832-bb9d245cc6b8", databaseName: "ltds-ops-staging", binding: "OPS_DB",
  priorNamesSha256: "d88ba83a54c045e5eb416fb912324047d68160f9f198e6b56591f0f0909788f2",
  priorContentsSha256: "47369a1c36e64853cf8e82c874af734ff0c2745bef416cca9c3a01cae16f8409",
  suffix: Object.freeze([Object.freeze({name:"0199_native_directory_profile_binding_continuations.sql",
    sha256:"056007062980460404fe85093cb796b855b91c23351a323457e91d5b053a2006"})]),
});
const CI_JOBS = Object.freeze(["source-invariants","incoming-pickup-alpine","client","operations","ops-sync","thumbnail-renderer",
  "operations-browser-desktop-edge","operations-browser-mobile-edge","client-browser-desktop-edge","client-browser-mobile-edge"]);
export function assertNativeDirectory199SourceCi(run, headSha, now=Date.now()) {
  assert.match(headSha,/^[0-9a-f]{40}$/u,"exact source HEAD required");
  assert(run && run.workflowName==="CI" && run.headSha===headSha && run.status==="completed" && run.conclusion==="success",
    "completed successful CI for the exact source HEAD required");
  assert(["pull_request","push"].includes(run.event),"reviewed source CI event required");
  const updated=Date.parse(run.updatedAt);
  assert(Number.isFinite(updated)&&updated<=now&&now-updated<=30*60_000,"fresh source CI required");
  assert(Array.isArray(run.jobs)&&run.jobs.length===CI_JOBS.length,"all ten source CI jobs required");
  assert.deepEqual(run.jobs.map(job=>job.name).sort(),[...CI_JOBS].sort(),"exact source CI job set required");
  assert(run.jobs.every(job=>job.status==="completed"&&job.conclusion==="success"),"every source CI job must succeed");
}
function readCommand(command,args,base) {
  const result=spawnSync(command,args,{cwd:base,windowsHide:true,encoding:"utf8",timeout:30_000,maxBuffer:1_048_576,
    stdio:["ignore","pipe","pipe"]});
  assert(!result.error&&result.status===0,"source CI verification command unavailable");
  return result.stdout.trim();
}
/** Read-only live GitHub evidence; static local JSON is never an execution grant. */
export async function verifyNativeDirectory199SourceCi(base,dependencies={}) {
  const runId=process.env.STAGING_SOURCE_CI_RUN_ID;
  assert(typeof runId==="string"&&/^[1-9][0-9]{0,19}$/u.test(runId),"explicit source CI run ID required");
  const read=dependencies.readSourceCiCommand??readCommand;
  const headSha=read("git",["rev-parse","HEAD"],base);
  assert.equal(read("git",["status","--porcelain","--untracked-files=normal"],base),"","clean exact source checkout required");
  const run=JSON.parse(read("gh",["run","view",runId,"--repo","ledgetoptechnologies/LedgeTop-Ops","--json","headSha,workflowName,status,conclusion,event,updatedAt,jobs"],base));
  assertNativeDirectory199SourceCi(run,headSha);
  assert.equal(read("git",["rev-parse","HEAD"],base),headSha,"source HEAD changed during verification");
  assert.equal(read("git",["status","--porcelain","--untracked-files=normal"],base),"","source checkout changed during verification");
  return Object.freeze({headSha,runId});
}
const window=createNativeDirectoryMigrationWindow(SPEC,(base,dependencies)=>(dependencies.sourceCiGate??verifyNativeDirectory199SourceCi)(base,dependencies));
export const buildNativeDirectory198To199Plan=window.buildPlan;
export const materializeNativeDirectory198To199=window.materialize;
export const nativeDirectory198To199ReadOnlyQueries=window.readOnlyQueries;
export const runNativeDirectory198To199=window.run;
export const safeNativeDirectory198To199Failure=window.safeFailure;
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  runNativeDirectory198To199().then(value=>console.log(JSON.stringify(value))).catch(()=>{
    console.error(safeNativeDirectory198To199Failure());process.exitCode=1;
  });
