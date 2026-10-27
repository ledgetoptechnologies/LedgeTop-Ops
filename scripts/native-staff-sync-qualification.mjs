import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveNativeStaffSyncSourceEvidence, gitEvidenceEnvironment } from './native-staff-sync-preparation.mjs';

const fail=code=>{throw new Error(`native_staff_sync_qualification_${code}`);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const basename=value=>path.basename(value).toLowerCase();
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const APP=path.join(ROOT,'apps','ops-sync');
const QUALIFICATION_TESTS=Object.freeze([
  'test/native-staff-access.test.ts',
  'test/connector-ingress.test.ts',
  'test/native-staff-preparation-entrypoint.test.ts',
]);
const REQUIRED_CASES=Object.freeze([
  'keeps the default-off and pre-migration cron inert without credentials or PA authority',
  'keeps the default-off native Access cron independent of PA connector state',
  'acknowledges a signed primary employee event without provisioning staff or invoking Cloudflare Access',
  'scheduled handler treats the absent 0225 control schema as a no-op',
  'scheduled handler treats an explicit disabled control as a no-op without provider credentials',
  'fetch handler rejects absent Access identity before doing any staff or provider work',
]);
const SOURCE_PATHS=Object.freeze([
  'apps/ops-sync/src/access-group.ts','apps/ops-sync/src/index.ts','apps/ops-sync/src/native-staff-access.ts',
  'apps/ops-sync/src/projection.ts','apps/ops-sync/src/schema.ts','apps/ops-sync/src/security.ts','apps/ops-sync/src/types.ts',
  'apps/operations/src/worker/project-alpha-connectors.ts','apps/operations/src/worker/project-alpha-source.ts',
  'apps/operations/src/worker/staff-login-bindings.ts',...QUALIFICATION_TESTS.map(value=>`apps/ops-sync/${value}`),
  'scripts/native-staff-sync-preparation.mjs','scripts/native-staff-sync-preparation.d.mts',
  'scripts/native-staff-sync-preparation.test.mjs','scripts/native-staff-sync-qualification.mjs',
  'scripts/native-staff-sync-qualification.d.mts',
]);
const git=(args,root=ROOT)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:gitEvidenceEnvironment()}).trim();

function checkCandidateCheckout(sourceCommit) {
  if(git(['rev-parse','HEAD'])!==sourceCommit)fail('candidate_not_checked_out');
  const status=git(['status','--porcelain','--',...SOURCE_PATHS]);
  if(status)fail('candidate_sources_or_tests_dirty');
  return sha(execFileSync('git',['-C',ROOT,'archive','--format=tar',sourceCommit],{maxBuffer:64*1024*1024,env:gitEvidenceEnvironment()}));
}

function runProcess(command,args,cwd,env) {
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,
    timeout:600_000,killSignal:'SIGTERM'});
  if(result.error||result.status!==0)fail('qualification_command_failed');
  return result.stdout??'';
}

function validateTestReport(report) {
  if(report?.success!==true||report.numFailedTestSuites!==0||report.numFailedTests!==0||report.numPendingTests!==0
    ||report.numPassedTests<REQUIRED_CASES.length||!Array.isArray(report.testResults)||report.testResults.length!==QUALIFICATION_TESTS.length)
    fail('behavior_tests_failed_or_incomplete');
  const files=report.testResults.map(row=>basename(row.name)).sort();
  if(files.join('\0')!==QUALIFICATION_TESTS.map(value=>basename(value)).sort().join('\0')
    ||report.testResults.some(row=>row.status!=='passed'||!Array.isArray(row.assertionResults)))fail('behavior_test_inventory_mismatch');
  const tests=new Set(report.testResults.flatMap(row=>row.assertionResults.filter(item=>item.status==='passed').map(item=>item.title)));
  if(REQUIRED_CASES.some(name=>!tests.has(name)))fail('behavior_case_missing');
  return { suiteCount:report.numPassedTestSuites, testCount:report.numPassedTests,
    testReportSha256:sha(JSON.stringify(report)), testFiles:files };
}

/**
 * Execute the exact candidate D1/Miniflare behavior suites and the existing
 * Wrangler dry-run build. Returns no qualification if the build bytes do not
 * match the independently reviewed expected candidate module hash supplied by
 * the caller. This does not observe or authenticate an uploaded Worker version.
 * This runs local commands only; it has no deploy, account, database, or network
 * operation. The returned evidence is a local review receipt, not a signature.
 */
export function runNativeStaffSyncQualification({ sourceCommit, candidateModuleSha256 }) {
  if(!/^[a-f0-9]{40}$/u.test(sourceCommit??'')||!/^[a-f0-9]{64}$/u.test(candidateModuleSha256??''))
    fail('candidate_pin_invalid');
  checkCandidateCheckout(sourceCommit);
  const sourceEvidence=deriveNativeStaffSyncSourceEvidence({repositoryRoot:ROOT,sourceCommit,moduleSha256:candidateModuleSha256});
  const sourceTreeSha256=sourceEvidence.sourceTreeSha256;
  const runnerBytes=readFileSync(fileURLToPath(import.meta.url));
  const reviewedRunner=execFileSync('git',['-C',ROOT,'show',`${sourceCommit}:scripts/native-staff-sync-qualification.mjs`],
    {maxBuffer:2*1024*1024,env:gitEvidenceEnvironment()});
  if(!runnerBytes.equals(reviewedRunner))fail('qualification_runner_not_committed');
  const qualificationRunnerSha256=sha(reviewedRunner);
  const tempRoot=mkdtempSync(path.join(os.tmpdir(),'ltds-sync-qualification-'));
  const reportFile=path.join(tempRoot,'vitest-report.json');
  const tempFiles=path.join(tempRoot,'tmp'),isolatedHome=path.join(tempRoot,'home');
  mkdirSync(tempFiles);mkdirSync(isolatedHome);
  const env={};
  for(const key of ['PATH','SystemRoot','WINDIR','PATHEXT','COMSPEC'])if(process.env[key])env[key]=process.env[key];
  env.TEMP=tempFiles;env.TMP=tempFiles;env.TMPDIR=tempFiles;
  env.USERPROFILE=isolatedHome;env.HOME=isolatedHome;env.LOCALAPPDATA=isolatedHome;env.APPDATA=isolatedHome;
  env.WRANGLER_SEND_METRICS='false';env.WRANGLER_WRITE_LOGS='false';env.WRANGLER_HIDE_BANNER='true';
  env.WRANGLER_LOG_PATH=path.join(tempRoot,'wrangler-logs');
  try {
    const vitest=path.join(APP,'node_modules','vitest','vitest.mjs');
    runProcess(process.execPath,[vitest,'run','--config','vitest.config.ts','--reporter=json',`--outputFile=${reportFile}`,...QUALIFICATION_TESTS],APP,env);
    const report=JSON.parse(readFileSync(reportFile,'utf8'));
    const behavior=validateTestReport(report);
    runProcess(process.execPath,['scripts/build.mjs'],APP,env);
    const builtModule=readFileSync(path.join(APP,'dist','index.js'));
    const builtModuleSha256=sha(builtModule);
    if(builtModuleSha256!==candidateModuleSha256)fail('built_module_hash_mismatch');
    const body={schemaVersion:1,kind:'ops-sync-candidate-behavior-qualification-v1',sourceCommit,sourceTreeSha256,
      sourceEvidenceSha256:sourceEvidence.sourceEvidenceSha256,candidateModuleSha256,builtModuleSha256,
      qualificationRunnerSha256,
      vitestVersion:JSON.parse(readFileSync(path.join(APP,'node_modules','vitest','package.json'),'utf8')).version,
      wranglerVersion:JSON.parse(readFileSync(path.join(APP,'node_modules','wrangler','package.json'),'utf8')).version,
      ...behavior};
    const finalTreeSha256=checkCandidateCheckout(sourceCommit);
    const finalEvidence=deriveNativeStaffSyncSourceEvidence({repositoryRoot:ROOT,sourceCommit,moduleSha256:candidateModuleSha256});
    if(finalTreeSha256!==sourceTreeSha256||JSON.stringify(finalEvidence)!==JSON.stringify(sourceEvidence)
      ||!readFileSync(fileURLToPath(import.meta.url)).equals(reviewedRunner))fail('candidate_changed_during_qualification');
    return Object.freeze({...body,qualificationSha256:sha(JSON.stringify(body))});
  } finally {
    const tempPrefix=path.resolve(os.tmpdir())+path.sep;
    const safe=path.resolve(tempRoot);
    if(!safe.startsWith(tempPrefix)||path.dirname(safe)!==path.resolve(os.tmpdir()))fail('temp_path_invalid');
    rmSync(safe,{recursive:true,force:true});
  }
}

