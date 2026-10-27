import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const fail = code => { throw new Error(`native_staff_sync_preparation_${code}`); };
const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));

function strings(values, label) {
  if (!Array.isArray(values) || values.length > 10_000 || values.some(value => typeof value !== 'string'
    || value !== value.trim().toLowerCase() || value.length < 3 || value.length > 254 || !/^[^\s@]+@[^\s@]+$/u.test(value))) fail(`${label}_invalid`);
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) fail(`${label}_duplicate`);
  return sorted;
}

function same(left, right) { return canonical(left) === canonical(right); }

export function gitEvidenceEnvironment() {
  if(Object.keys(process.env).some(key=>/^GIT_/iu.test(key)&&key.toUpperCase()!=='GIT_PAGER'))fail('git_environment_override');
  const env={};
  for(const key of ['PATH','SystemRoot','WINDIR','PATHEXT','COMSPEC','TEMP','TMP'])
    if(process.env[key])env[key]=process.env[key];
  env.GIT_CONFIG_NOSYSTEM='1';
  env.GIT_TERMINAL_PROMPT='0';
  env.GIT_PAGER='cat';
  return env;
}

// Deliberately closed source inventory: these are the Ops Sync entrypoint,
// native reconciler, and the code paths that define cohort selection and PA
// ingress effects. Read committed Git objects, not a caller-supplied list of
// hashes or dirty working-tree bytes.
const SYNC_SOURCE_PATHS = Object.freeze([
  'apps/ops-sync/src/access-group.ts',
  'apps/ops-sync/src/index.ts',
  'apps/ops-sync/src/native-staff-access.ts',
  'apps/ops-sync/src/projection.ts',
  'apps/ops-sync/src/schema.ts',
  'apps/ops-sync/src/security.ts',
  'apps/ops-sync/src/types.ts',
  'apps/ops-sync/test/connector-ingress.test.ts',
  'apps/ops-sync/test/native-staff-access.test.ts',
  'apps/operations/src/worker/project-alpha-connectors.ts',
  'apps/operations/src/worker/project-alpha-source.ts',
  'apps/operations/src/worker/staff-login-bindings.ts',
]);

/** Derive source evidence from the exact candidate commit's Git objects. */
export function deriveNativeStaffSyncSourceEvidence({ repositoryRoot, sourceCommit, moduleSha256 }) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim() || !COMMIT.test(sourceCommit ?? '')
    || !HASH.test(moduleSha256 ?? '')) fail('source_evidence_input_invalid');
  let sourceTreeSha256;
  const env=gitEvidenceEnvironment();
  try { sourceTreeSha256=sha(execFileSync('git',['-C',repositoryRoot,'archive','--format=tar',sourceCommit],{maxBuffer:64*1024*1024,env})); }
  catch { fail('source_commit_unavailable'); }
  if(!HASH.test(sourceTreeSha256))fail('source_commit_unavailable');
  const files = SYNC_SOURCE_PATHS.map(path => {
    let bytes;
    try { bytes = execFileSync('git', ['-C', repositoryRoot, 'show', `${sourceCommit}:${path}`], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024,env }); }
    catch { fail('source_commit_file_missing'); }
    return { path, sha256: sha(bytes) };
  });
  const manifest = { schemaVersion:1, sourceCommit, sourceTreeSha256, moduleSha256, files };
  return Object.freeze({ ...manifest, sourceEvidenceSha256:sha(canonical(manifest)) });
}

/**
 * Qualify a dormant Sync-only preparation receipt. Inputs must come from
 * separately reviewed, read-only provider observations; this pure function
 * neither contacts Cloudflare nor deploys or changes group membership.
 * Secret values are forbidden: binding metadata may contain only binding name,
 * type, and pinned resource identifiers.
 */
export function compileNativeStaffSyncPreparation({ active, candidate, control, cohortBefore, cohortAfter,
  alternateBindingsBefore, alternateBindingsAfter, groupBefore, groupAfter, pins, sourceEvidence, qualificationEvidence, repositoryRoot }) {
  if (!exact(active, ['accountId','workerName','environment','databaseId','runtimeVersion','settings','bindings','moduleSha256','sourceCommit'])
    || !exact(candidate, ['accountId','workerName','environment','databaseId','runtimeVersion','settings','bindings','moduleSha256','sourceCommit'])
    || !exact(sourceEvidence, ['schemaVersion','sourceCommit','sourceTreeSha256','moduleSha256','files','sourceEvidenceSha256'])
    || !exact(qualificationEvidence,['schemaVersion','kind','sourceCommit','sourceTreeSha256','sourceEvidenceSha256',
      'candidateModuleSha256','builtModuleSha256','vitestVersion','wranglerVersion','suiteCount','testCount','testReportSha256',
      'qualificationRunnerSha256','testFiles','qualificationSha256'])
    || !exact(control, ['tablePresent','enabled','generation','appliedGeneration','leaseId','leaseUntil','attemptGeneration'])
    || !exact(cohortBefore, ['cohortSha256','rows'])
    || !exact(cohortAfter, ['cohortSha256','rows'])
    || !exact(alternateBindingsBefore, ['issuer','activeBindings','pendingIntentCount'])
    || !exact(alternateBindingsAfter, ['issuer','activeBindings','pendingIntentCount'])
    || !exact(pins, ['accountId','workerName','environment','databaseId','runtimeVersion','activeModuleSha256','activeSourceCommit',
      'candidateModuleSha256','candidateSourceCommit','settingsSha256','bindingsSha256','staffAccessIssuer'])
    || !Array.isArray(groupBefore) || !Array.isArray(groupAfter)) fail('input_invalid');
  for (const worker of [active,candidate]) {
    if (typeof worker.accountId !== 'string' || !/^[a-f0-9]{32}$/u.test(worker.accountId)
      || typeof worker.workerName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(worker.workerName)
      || typeof worker.environment !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(worker.environment)
      || !/^[a-f0-9-]{36}$/u.test(worker.databaseId ?? '') || !HASH.test(worker.moduleSha256 ?? '')
      || !COMMIT.test(worker.sourceCommit ?? '') || typeof worker.runtimeVersion !== 'string' || !worker.runtimeVersion.trim()
      || !worker.settings || typeof worker.settings !== 'object' || Array.isArray(worker.settings)
      || !Array.isArray(worker.bindings)) fail('worker_identity_invalid');
    if (worker.bindings.some(binding => !exact(binding, ['name','type','resourceId'])
      || typeof binding.name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(binding.name)
      || typeof binding.type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(binding.type)
      || typeof binding.resourceId !== 'string' || !binding.resourceId.trim())) fail('binding_metadata_invalid');
  }
  if (active.accountId !== candidate.accountId || active.workerName !== candidate.workerName
    || active.environment !== candidate.environment || active.databaseId !== candidate.databaseId
    || active.runtimeVersion !== candidate.runtimeVersion || !same(active.settings,candidate.settings)
    || !same([...active.bindings].sort((a,b)=>a.name.localeCompare(b.name)),
      [...candidate.bindings].sort((a,b)=>a.name.localeCompare(b.name)))) fail('deployment_surface_changed');
  const bindingsSha256=sha(canonical([...active.bindings].sort((a,b)=>a.name.localeCompare(b.name))));
  const settingsSha256=sha(canonical(active.settings));
  if (pins.accountId !== active.accountId || pins.workerName !== active.workerName || pins.environment !== active.environment
    || pins.databaseId !== active.databaseId || pins.runtimeVersion !== active.runtimeVersion
    || pins.activeModuleSha256 !== active.moduleSha256 || pins.activeSourceCommit !== active.sourceCommit
    || pins.candidateModuleSha256 !== candidate.moduleSha256 || pins.candidateSourceCommit !== candidate.sourceCommit
    || pins.bindingsSha256 !== bindingsSha256 || pins.settingsSha256 !== settingsSha256
    || typeof pins.staffAccessIssuer !== 'string' || !/^https:\/\/[a-z0-9.-]+\.cloudflareaccess\.com$/u.test(pins.staffAccessIssuer)
    || !HASH.test(pins.activeModuleSha256 ?? '') || !HASH.test(pins.candidateModuleSha256 ?? '')
    || !COMMIT.test(pins.activeSourceCommit ?? '') || !COMMIT.test(pins.candidateSourceCommit ?? '')
    || !HASH.test(pins.bindingsSha256 ?? '') || !HASH.test(pins.settingsSha256 ?? '')) fail('reviewed_pins_mismatch');
  const derivedSourceEvidence=deriveNativeStaffSyncSourceEvidence({
    repositoryRoot, sourceCommit:candidate.sourceCommit, moduleSha256:candidate.moduleSha256,
  });
  if (sourceEvidence.schemaVersion !== 1 || sourceEvidence.sourceCommit !== candidate.sourceCommit
    || sourceEvidence.moduleSha256 !== candidate.moduleSha256 || !same(sourceEvidence,derivedSourceEvidence))
    fail('source_evidence_mismatch');
  const {qualificationSha256,...qualificationBody}=qualificationEvidence;
  if(qualificationEvidence.schemaVersion!==1||qualificationEvidence.kind!=='ops-sync-candidate-behavior-qualification-v1'
    ||qualificationEvidence.sourceCommit!==candidate.sourceCommit
    ||qualificationEvidence.sourceTreeSha256!==derivedSourceEvidence.sourceTreeSha256
    ||qualificationEvidence.sourceEvidenceSha256!==derivedSourceEvidence.sourceEvidenceSha256
    ||qualificationEvidence.candidateModuleSha256!==candidate.moduleSha256
    ||qualificationEvidence.builtModuleSha256!==candidate.moduleSha256
    ||typeof qualificationEvidence.vitestVersion!=='string'||typeof qualificationEvidence.wranglerVersion!=='string'
    ||!HASH.test(qualificationEvidence.qualificationRunnerSha256??'')
    ||qualificationEvidence.suiteCount!==3||!Number.isSafeInteger(qualificationEvidence.testCount)||qualificationEvidence.testCount<6
    ||!HASH.test(qualificationEvidence.testReportSha256??'')
    ||!same(qualificationEvidence.testFiles,['connector-ingress.test.ts','native-staff-access.test.ts','native-staff-preparation-entrypoint.test.ts'])
    ||!HASH.test(qualificationSha256??'')||sha(JSON.stringify(qualificationBody))!==qualificationSha256)
    fail('behavior_qualification_invalid');
  if (control.tablePresent !== false && control.tablePresent !== true) fail('control_state_invalid');
  if (control.tablePresent && (control.enabled !== 0 || control.generation !== 0 || control.appliedGeneration !== 0
    || control.leaseId !== null || control.leaseUntil !== null || control.attemptGeneration !== null)) fail('control_not_dormant');
  if (!control.tablePresent && [control.enabled,control.generation,control.appliedGeneration,control.leaseId,
    control.leaseUntil,control.attemptGeneration].some(value => value !== null)) fail('control_absence_invalid');
  const validateCohort = value => {
    if (!HASH.test(value.cohortSha256 ?? '') || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 1024)
      fail('cohort_evidence_invalid');
    const rows=value.rows;
    if (rows.some(row=>!exact(row,['staffId','email','accessSubject','displayName','active','admissionVersion','profileVersion'])
      ||typeof row.staffId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(row.staffId)
      ||typeof row.email!=='string'||row.email!==row.email.trim().toLowerCase()||!/^[^\s@]+@[^\s@]+$/u.test(row.email)
      ||typeof row.accessSubject!=='string'||!row.accessSubject.trim()||row.accessSubject.length>191||/\p{C}/u.test(row.accessSubject)
      ||typeof row.displayName!=='string'||!row.displayName.trim()||row.displayName.length>160
      ||typeof row.active!=='boolean'||!Number.isSafeInteger(row.admissionVersion)||row.admissionVersion<1
      ||!Number.isSafeInteger(row.profileVersion)||row.profileVersion<1)) fail('cohort_evidence_invalid');
    const sorted=[...rows].sort((a,b)=>a.staffId.localeCompare(b.staffId));
    if(!same(rows,sorted)||new Set(rows.map(row=>row.staffId)).size!==rows.length
      ||new Set(rows.map(row=>row.email)).size!==rows.length||new Set(rows.map(row=>row.accessSubject)).size!==rows.length
      ||sha(canonical(rows))!==value.cohortSha256)fail('cohort_evidence_invalid');
    return {cohortSha256:value.cohortSha256,rows,activeStaffEmails:strings(rows.filter(row=>row.active).map(row=>row.email),'cohort')};
  };
  const beforeCohort=validateCohort(cohortBefore),afterCohort=validateCohort(cohortAfter);
  if(!same(beforeCohort,afterCohort))fail('cohort_changed_during_preparation');
  const staffEmails=beforeCohort.activeStaffEmails;
  const cohortByStaff = new Map();
  // Cohort email lists alone cannot prove a second login belongs to a staff
  // identity. The read-only D1 evidence must supply every authority link below.
  // Pending intents are counted for before/after stability but never admitted.
  const validateAliases = evidence => {
    if (typeof evidence.issuer !== 'string' || evidence.issuer !== pins.staffAccessIssuer
      || !/^https:\/\/[a-z0-9.-]+\.cloudflareaccess\.com$/u.test(evidence.issuer)
      || !Array.isArray(evidence.activeBindings) || evidence.activeBindings.length > 1000
      || !Number.isSafeInteger(evidence.pendingIntentCount) || evidence.pendingIntentCount < 0) fail('alternate_binding_evidence_invalid');
    const aliases = evidence.activeBindings.map(row => {
      if (!exact(row, ['bindingId','staffId','loginEmail','accessSubject','issuer','bindingVersion','status','intentId',
        'intentStatus','intentBindingId','intentGeneration','canonicalEmail','canonicalSubject','staffStatus','admissionActive',
        'admissionSubject','profileEmail','generation','ownerGlobal','ownerAdminDeny'])
        || typeof row.bindingId !== 'string' || !/^[0-9a-f-]{36}$/u.test(row.bindingId)
        || typeof row.staffId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(row.staffId)
        || typeof row.loginEmail !== 'string' || row.loginEmail !== row.loginEmail.trim().toLowerCase()
        || !/^[^\s@]+@[^\s@]+$/u.test(row.loginEmail) || row.loginEmail.length > 254
        || typeof row.accessSubject !== 'string' || !row.accessSubject.trim() || row.accessSubject.length > 191 || /\p{C}/u.test(row.accessSubject)
        || row.issuer !== evidence.issuer || row.bindingVersion !== 1 || row.status !== 'active'
        || typeof row.intentId !== 'string' || row.intentId !== row.intentBindingId
        || row.intentStatus !== 'claimed' || !Number.isSafeInteger(row.intentGeneration) || row.intentGeneration < 0
        || !Number.isSafeInteger(row.generation) || row.generation < row.intentGeneration + 1
        || row.staffStatus !== 'active' || row.admissionActive !== 1
        || typeof row.canonicalEmail !== 'string' || row.canonicalEmail !== row.canonicalEmail.trim().toLowerCase()
        || row.profileEmail !== row.canonicalEmail || typeof row.canonicalSubject !== 'string'
        || row.admissionSubject !== row.canonicalSubject || !row.ownerGlobal || row.ownerAdminDeny) fail('alternate_binding_not_currently_authorized');
      const primary = cohortByStaff.get(row.staffId);
      if (!primary || primary.email !== row.canonicalEmail || primary.accessSubject !== row.canonicalSubject || !primary.active
        || row.loginEmail === row.canonicalEmail) fail('alternate_binding_identity_mismatch');
      return { bindingId:row.bindingId,staffId:row.staffId,loginEmail:row.loginEmail,accessSubject:row.accessSubject,
        issuer:row.issuer,bindingVersion:row.bindingVersion,intentId:row.intentId,intentGeneration:row.intentGeneration,generation:row.generation };
    }).sort((a,b)=>a.bindingId.localeCompare(b.bindingId));
    if (new Set(aliases.map(row=>row.bindingId)).size !== aliases.length
      || new Set(aliases.map(row=>`${row.issuer}\0${row.loginEmail}`)).size !== aliases.length
      || new Set(aliases.map(row=>`${row.issuer}\0${row.accessSubject}`)).size !== aliases.length) fail('alternate_binding_ambiguous');
    return { issuer:evidence.issuer, activeBindings:aliases, pendingIntentCount:evidence.pendingIntentCount };
  };
  for (const row of beforeCohort.rows) cohortByStaff.set(row.staffId,row);
  const aliasesBefore=validateAliases(alternateBindingsBefore), aliasesAfter=validateAliases(alternateBindingsAfter);
  if (!same(aliasesBefore,aliasesAfter)) fail('alternate_bindings_changed_during_preparation');
  const before = strings(groupBefore, 'group_before');
  const after = strings(groupAfter, 'group_after');
  if (!same(before, after)) fail('group_changed_during_preparation');
  const desiredGroup = strings([...staffEmails, ...aliasesBefore.activeBindings.map(row=>row.loginEmail)], 'desired_group');
  const receipt = { schemaVersion:1, kind:'operations-native-staff-sync-dormant-preparation-v1',
    accountId:active.accountId, workerName:active.workerName, environment:active.environment, databaseId:active.databaseId,
    activeRuntimeVersion:active.runtimeVersion, candidateRuntimeVersion:candidate.runtimeVersion,
    activeSettingsSha256:settingsSha256, candidateSettingsSha256:sha(canonical(candidate.settings)),
    bindingsSha256,
    activeModuleSha256:active.moduleSha256, candidateModuleSha256:candidate.moduleSha256,
    activeSourceCommit:active.sourceCommit, candidateSourceCommit:candidate.sourceCommit,
    candidateSourceTreeSha256:derivedSourceEvidence.sourceTreeSha256,sourceEvidenceSha256:derivedSourceEvidence.sourceEvidenceSha256,
    behaviorQualificationSha256:qualificationEvidence.qualificationSha256,testReportSha256:qualificationEvidence.testReportSha256,
    builtModuleSha256:qualificationEvidence.builtModuleSha256,qualificationRunnerSha256:qualificationEvidence.qualificationRunnerSha256,
    controlState:control.tablePresent ? 'disabled' : 'missing', cohortSha256:beforeCohort.cohortSha256,
    activeStaffCount:staffEmails.length, activeAlternateBindingCount:aliasesBefore.activeBindings.length,
    alternateBindingEvidenceSha256:sha(canonical(aliasesBefore)),
    currentGroupCount:before.length, currentGroupSha256:sha(canonical(before)),
    desiredGroupCount:desiredGroup.length, desiredGroupSha256:sha(canonical(desiredGroup)) };
  return Object.freeze({ ...receipt, receiptSha256:sha(canonical(receipt)) });
}
