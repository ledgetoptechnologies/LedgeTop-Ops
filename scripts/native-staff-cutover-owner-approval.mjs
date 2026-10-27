import { constants, createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, protectedSign, verifyCloudflareAccessJwt } from './native-staff-bootstrap-owner-approval.mjs';
import { compileNativeStaffCutoverV1 } from './native-staff-cutover-v1.mjs';

export const NATIVE_STAFF_CUTOVER_OWNER_APPROVAL_KIND = 'operations-native-staff-cutover-owner-approval-v1';
export const NATIVE_STAFF_CUTOVER_APPROVAL_STATE_KIND = 'operations-native-staff-cutover-approval-state-v1';
export const NATIVE_STAFF_CUTOVER_CONSENT_PREFIX = 'APPROVE NATIVE STAFF CUTOVER';
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const MAX_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const OWNER_CLAIMS = new WeakSet();
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stop = code => { throw new Error(`native_staff_cutover_owner_${code}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const deepClone = value => JSON.parse(canonicalJson(value));

function sourceEvidence(config, { cwd = REPOSITORY_ROOT, run = undefined,
  read = readFileSync } = {}) {
  const exec = run ?? execFileSync;
  const source = config?.source;
  if (!source || !/^[0-9a-f]{40}$/u.test(source.commit ?? '')) stop('source_pin_invalid');
  const git = args => {
    try { return exec('git', ['-C', cwd, ...args], { encoding: args[0] === 'show' ? 'buffer' : 'utf8', stdio: ['ignore','pipe','ignore'] }); }
    catch { stop('source_unavailable'); }
  };
  git(['cat-file','-e',`${source.commit}^{commit}`]);
  const names = String(git(['ls-tree','-r','--name-only',source.commit,'--','apps/operations/migrations']))
    .split(/\r?\n/u).filter(name => /^apps\/operations\/migrations\/\d{4}_.+\.sql$/u.test(name))
    .map(name => name.slice('apps/operations/migrations/'.length)).sort();
  if (names.length !== 230 || names.some((name,index) => !name.startsWith(`${String(index+1).padStart(4,'0')}_`))
    || sha(names.join('\n')) !== source.migrationNamesSha256) stop('migration_names_mismatch');
  const modulePaths = ['scripts/native-staff-cutover-v1.mjs','scripts/native-staff-sync-preparation.mjs',
    'scripts/native-staff-bootstrap-d1.mjs'];
  const pinnedPaths = [...modulePaths, ...names.map(name => `apps/operations/migrations/${name}`)];
  try {
    exec('git', ['-C', cwd, 'diff', '--quiet', source.commit, '--', ...pinnedPaths],
      { encoding: 'utf8', stdio: ['ignore','ignore','ignore'] });
  } catch (error) {
    if (error?.status === 1) stop('source_worktree_mismatch');
    stop('source_unavailable');
  }
  const hashes = {};
  for (const relative of modulePaths) {
    const local = path.join(cwd,relative);
    let current;
    try { current = read(local); }
    catch { stop('source_file_unavailable'); }
    hashes[relative] = sha(current);
  }
  if (hashes['scripts/native-staff-cutover-v1.mjs'] !== source.cutoverModuleSha256
    || hashes['scripts/native-staff-sync-preparation.mjs'] !== source.syncPreparationModuleSha256
    || hashes['scripts/native-staff-bootstrap-d1.mjs'] !== source.installerModuleSha256) stop('module_pin_mismatch');
  const contentHash = sha(names.map(name => {
    let current;
    try { current = read(path.join(cwd,'apps','operations','migrations',name)); }
    catch { stop('migration_unavailable'); }
    return `${name}\0${sha(current)}`;
  }).join('\n'));
  if (contentHash !== source.migrationContentsSha256) stop('migration_contents_mismatch');
  return Object.freeze({ commit: source.commit, migrationNamesSha256: sha(names.join('\n')),
    migrationContentsSha256: contentHash, ...hashes });
}

/** Require a committed 0230 source tree, including all migration and runtime bytes. */
export function assertPinnedNativeStaffCutoverSource(config, options = {}) {
  sourceEvidence(config, options);
  return true;
}

export function compileNativeStaffCutoverApprovalContext(artifact, config) {
  const keys = ['schemaVersion','kind','approvalId','commandId','reviewedSnapshot','controlPlaneStaffIds','operator','syncPreparationReceipt'];
  if (!exact(artifact,keys) || artifact.schemaVersion !== 1 || artifact.kind !== 'operations-native-staff-cutover-candidate-v1'
    || !UUID.test(artifact.approvalId ?? '') || !UUID.test(artifact.commandId ?? '')
    || !Array.isArray(artifact.controlPlaneStaffIds) || !exact(artifact.operator,['staffId','accessSubject'])
    || artifact.operator.staffId !== config.access.owner.staffId || artifact.operator.accessSubject !== config.access.owner.accessSubject)
    stop('candidate_invalid');
  const compiled = compileNativeStaffCutoverV1({ reviewedSnapshot: artifact.reviewedSnapshot,
    controlPlaneStaffIds: artifact.controlPlaneStaffIds, operator: artifact.operator,
    syncPreparationReceipt: artifact.syncPreparationReceipt });
  const context = { schemaVersion:1, kind:'operations-native-staff-cutover-approval-context-v1',
    commandId:artifact.commandId, approvalId:artifact.approvalId, sourceSnapshotSha256:compiled.reviewedSnapshot.snapshotSha256,
    planSha256:compiled.planSha256, bindingSha256:compiled.bindingSha256, cohortSha256:compiled.plan.cohortSha256,
    controlPlaneStaffIds:compiled.controlPlaneStaffIds, operatorStaffId:artifact.operator.staffId,
    operatorSubject:artifact.operator.accessSubject, syncPreparationReceipt:compiled.syncPreparationReceipt };
  const approvalContext={schemaVersion:1,kind:'operations-native-staff-cutover-owner-approval-context-v1',
    target:config.target,source:config.source,cutoverApprovalContext:context};
  const contextSha256=sha(canonicalJson(approvalContext));
  return Object.freeze({ artifact:deepClone(artifact), compiled, context, approvalContext,
    contextSha256, cutoverContextSha256:sha(canonicalJson(context)),
    consentText:`${NATIVE_STAFF_CUTOVER_CONSENT_PREFIX} ${contextSha256}` });
}

function buildTrustEnvelope({ config, context, contextSha256, cutoverContextSha256, ownerClaims, now, authorizationChallenge }) {
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(Math.min(ownerClaims.expiresAt * 1000, now + MAX_TTL_MS)).toISOString();
  if (!HASH.test(authorizationChallenge ?? '') || Date.parse(expiresAt) <= now) stop('owner_session_expired');
  return { schemaVersion:1, kind:'operations-native-staff-cutover-trust-envelope-v1',
    action:'enable-native-staff-reconciliation', ownerSessionId:randomUUID(), authorizationChallenge,
    approvalId:context.approvalId, commandId:context.commandId,
    approvedOperatorStaffId:config.access.owner.staffId, approvedOperatorAccessSubject:config.access.owner.accessSubject,
    issuedByStaffId:config.access.owner.staffId, issuedByAccessSubject:config.access.owner.accessSubject,
    authorizedAt:issuedAt, expiresAt, reviewedSnapshotSha256:context.sourceSnapshotSha256,
    canonicalPlanSha256:context.planSha256, bindingEvidenceSha256:context.bindingSha256,
    cutoverApprovalContextSha256:cutoverContextSha256, ownerApprovalContextSha256:contextSha256,
    consentText:`${NATIVE_STAFF_CUTOVER_CONSENT_PREFIX} ${contextSha256}` };
}

/** Verify a real Access JWT and its current Access-protected session response. */
export async function verifyCurrentNativeStaffCutoverOwnerSession(config, token, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') stop('session_fetch_unavailable');
  const claims = await verifyCloudflareAccessJwt(token, config.access, { now, fetchImpl });
  if (claims.subject !== config.access.owner.accessSubject) stop('owner_subject_mismatch');
  let response;
  try { response = await fetchImpl(new URL('/api/session',config.access.origin), { method:'GET', redirect:'manual',
    cache:'no-store', signal:AbortSignal.timeout(15_000), headers:{ accept:'application/json','Cf-Access-Token':token } }); }
  catch { stop('session_unavailable'); }
  if (!response || response.redirected || response.status !== 200
    || response.status >= 300 && response.status < 400
    || !/application\/json(?:\s*;|$)/iu.test(response.headers?.get?.('content-type') ?? '')) stop('session_rejected');
  const length=response.headers.get('content-length');
  if(length&&(!/^\d+$/u.test(length)||Number(length)>256*1024))stop('session_too_large');
  let text;
  try {
    if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
        if(size>256*1024){await reader.cancel().catch(()=>{});stop('session_too_large');}chunks.push(Buffer.from(value));}}
      finally{try{reader.releaseLock();}catch{}}
      text=Buffer.concat(chunks,size).toString('utf8');
    }else{text=await response.text();if(Buffer.byteLength(text,'utf8')>256*1024)stop('session_too_large');}
  }catch(error){if(error instanceof Error&&error.message.startsWith('native_staff_cutover_owner_'))throw error;stop('session_invalid');}
  let body;try{body=JSON.parse(text);}catch{stop('session_invalid');}
  if (body?.user?.id !== config.access.owner.staffId || claims.expiresAt * 1000 <= now) stop('session_owner_mismatch');
  const proof = Object.freeze({ claims, staffId:body.user.id });
  OWNER_CLAIMS.add(proof);
  return proof;
}

export function nativeStaffCutoverConsentText(artifact, config) {
  return compileNativeStaffCutoverApprovalContext(artifact,config).consentText;
}

/** Construct an exact cutover-purpose receipt only from a verified live owner session. */
export function buildNativeStaffCutoverOwnerApprovalReceipt({ config, artifact, ownerSession, typedConsent,
  now = Date.now(), authorizationChallenge = sha(randomBytes(32)) } = {}) {
  if (!ownerSession || !OWNER_CLAIMS.has(ownerSession)) stop('verified_owner_session_required');
  const prepared = compileNativeStaffCutoverApprovalContext(artifact,config), claims = ownerSession.claims;
  if (typedConsent !== prepared.consentText || claims.issuer !== config.access.issuer
    || claims.audience !== config.access.audience || claims.subject !== config.access.owner.accessSubject
    || !HASH.test(claims.assertionSha256 ?? '') || claims.expiresAt * 1000 <= now
    || !Number.isSafeInteger(claims.issuedAt) || claims.issuedAt > Math.floor(now/1000)) stop('owner_consent_invalid');
  const trustEnvelope = buildTrustEnvelope({ config, context:prepared.context, contextSha256:prepared.contextSha256,
    cutoverContextSha256:prepared.cutoverContextSha256, ownerClaims:claims, now, authorizationChallenge });
  const payload = { schemaVersion:1, kind:NATIVE_STAFF_CUTOVER_OWNER_APPROVAL_KIND,
    target:config.target, source:config.source,
    ownerAccess:{ issuer:claims.issuer, audience:claims.audience, staffId:config.access.owner.staffId,
      accessSubject:claims.subject, assertionSha256:claims.assertionSha256, verifiedAt:trustEnvelope.authorizedAt,
      expiresAt:trustEnvelope.expiresAt },
    approvalContext:prepared.approvalContext, approvalContextSha256:prepared.contextSha256,
    cutoverApprovalContextSha256:prepared.cutoverContextSha256,
    canonicalPlanSha256:prepared.context.planSha256, reviewedSnapshotSha256:prepared.context.sourceSnapshotSha256,
    bindingEvidenceSha256:prepared.context.bindingSha256, ownerConsentText:prepared.consentText, trustEnvelope };
  const payloadJson = canonicalJson(payload), signature = protectedSign(payloadJson,config);
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) stop('signature_invalid');
  return Object.freeze({ schemaVersion:1, kind:NATIVE_STAFF_CUTOVER_OWNER_APPROVAL_KIND,
    algorithm:'RSA-PSS-SHA256', keyId:config.signer.keyId, payload, signature });
}

export function verifyNativeStaffCutoverOwnerApprovalReceipt(receipt, { config, expectedArtifact, now = Date.now() } = {}) {
  const receiptKeys=['schemaVersion','kind','algorithm','keyId','payload','signature'];
  if (!exact(receipt,receiptKeys) || receipt.schemaVersion !== 1 || receipt.kind !== NATIVE_STAFF_CUTOVER_OWNER_APPROVAL_KIND
    || receipt.algorithm !== 'RSA-PSS-SHA256' || receipt.keyId !== config?.signer?.keyId
    || typeof receipt.signature !== 'string' || receipt.signature.length > 4096) stop('receipt_invalid');
  const payload=receipt.payload;
  const payloadKeys=['schemaVersion','kind','target','source','ownerAccess','approvalContext','approvalContextSha256',
    'cutoverApprovalContextSha256','canonicalPlanSha256','reviewedSnapshotSha256','bindingEvidenceSha256','ownerConsentText','trustEnvelope'];
  const ownerContext=payload?.approvalContext, context=ownerContext?.cutoverApprovalContext;
  if (!exact(payload,payloadKeys) || payload.schemaVersion !== 1 || payload.kind !== NATIVE_STAFF_CUTOVER_OWNER_APPROVAL_KIND
    || canonicalJson(payload.target)!==canonicalJson(config.target) || canonicalJson(payload.source)!==canonicalJson(config.source)
    || !exact(ownerContext,['schemaVersion','kind','target','source','cutoverApprovalContext'])
    || ownerContext.schemaVersion!==1||ownerContext.kind!=='operations-native-staff-cutover-owner-approval-context-v1'
    || canonicalJson(ownerContext.target)!==canonicalJson(payload.target)||canonicalJson(ownerContext.source)!==canonicalJson(payload.source)
    || canonicalJson(payload.target)!==canonicalJson(config.target)||canonicalJson(payload.source)!==canonicalJson(config.source)
    || !exact(context,['schemaVersion','kind','commandId','approvalId','sourceSnapshotSha256','planSha256','bindingSha256',
      'cohortSha256','controlPlaneStaffIds','operatorStaffId','operatorSubject','syncPreparationReceipt'])
    || context.schemaVersion!==1||context.kind!=='operations-native-staff-cutover-approval-context-v1'
    || !UUID.test(context.commandId??'')||!UUID.test(context.approvalId??'')
    || ![context.sourceSnapshotSha256,context.planSha256,context.bindingSha256,context.cohortSha256].every(value=>HASH.test(value??''))
    || !Array.isArray(context.controlPlaneStaffIds)||!context.controlPlaneStaffIds.length
    || context.controlPlaneStaffIds.length>1024||context.controlPlaneStaffIds.some(id=>!ID.test(id))
    || canonicalJson(context.controlPlaneStaffIds)!==canonicalJson([...context.controlPlaneStaffIds].sort())
    || new Set(context.controlPlaneStaffIds).size!==context.controlPlaneStaffIds.length
    || context.operatorStaffId!==config.access.owner.staffId||typeof context.operatorSubject!=='string'
    || context.operatorSubject!==config.access.owner.accessSubject
    || !HASH.test(payload.approvalContextSha256 ?? '') || sha(canonicalJson(ownerContext))!==payload.approvalContextSha256
    || !HASH.test(payload.cutoverApprovalContextSha256??'')||sha(canonicalJson(context))!==payload.cutoverApprovalContextSha256
    || payload.canonicalPlanSha256!==context.planSha256
    || payload.reviewedSnapshotSha256!==context.sourceSnapshotSha256
    || payload.bindingEvidenceSha256!==context.bindingSha256
    || payload.ownerConsentText!==`${NATIVE_STAFF_CUTOVER_CONSENT_PREFIX} ${payload.approvalContextSha256}`) stop('receipt_binding_invalid');
  const owner=payload.ownerAccess, env=payload.trustEnvelope;
  if (!exact(owner,['issuer','audience','staffId','accessSubject','assertionSha256','verifiedAt','expiresAt'])
    || owner.issuer!==config.access.issuer || owner.audience!==config.access.audience
    || owner.staffId!==config.access.owner.staffId || owner.accessSubject!==config.access.owner.accessSubject
    || !HASH.test(owner.assertionSha256 ?? '') || !exact(env,['schemaVersion','kind','action','ownerSessionId','authorizationChallenge',
      'approvalId','commandId','approvedOperatorStaffId','approvedOperatorAccessSubject','issuedByStaffId','issuedByAccessSubject',
      'authorizedAt','expiresAt','reviewedSnapshotSha256','canonicalPlanSha256','bindingEvidenceSha256',
      'cutoverApprovalContextSha256','ownerApprovalContextSha256','consentText'])
    || env.schemaVersion!==1 || env.kind!=='operations-native-staff-cutover-trust-envelope-v1'
    || env.action!=='enable-native-staff-reconciliation' || !UUID.test(env.ownerSessionId ?? '') || !HASH.test(env.authorizationChallenge ?? '')
    || env.approvalId!==context.approvalId || env.commandId!==context.commandId
    || env.approvedOperatorStaffId!==config.access.owner.staffId || env.approvedOperatorAccessSubject!==config.access.owner.accessSubject
    || env.issuedByStaffId!==config.access.owner.staffId || env.issuedByAccessSubject!==config.access.owner.accessSubject
    || env.reviewedSnapshotSha256!==payload.reviewedSnapshotSha256 || env.canonicalPlanSha256!==payload.canonicalPlanSha256
    || env.bindingEvidenceSha256!==payload.bindingEvidenceSha256 || env.cutoverApprovalContextSha256!==payload.cutoverApprovalContextSha256
    || env.ownerApprovalContextSha256!==payload.approvalContextSha256
    || env.consentText!==payload.ownerConsentText || owner.verifiedAt!==env.authorizedAt || owner.expiresAt!==env.expiresAt
    || !Number.isFinite(Date.parse(env.authorizedAt)) || !Number.isFinite(Date.parse(env.expiresAt))
    || new Date(Date.parse(env.authorizedAt)).toISOString()!==env.authorizedAt
    || new Date(Date.parse(env.expiresAt)).toISOString()!==env.expiresAt || Date.parse(env.authorizedAt)>now
    || Date.parse(env.expiresAt)<=now || Date.parse(env.expiresAt)-Date.parse(env.authorizedAt)>MAX_TTL_MS) stop('receipt_binding_invalid');
  if (expectedArtifact) {
    const expected=compileNativeStaffCutoverApprovalContext(expectedArtifact,config);
    if (canonicalJson(expected.approvalContext)!==canonicalJson(payload.approvalContext)) stop('receipt_artifact_mismatch');
  }
  let key, signature;
  try { key=createPublicKey(config.signer.publicKeyPem); signature=Buffer.from(receipt.signature,'base64'); } catch { stop('receipt_signature_invalid'); }
  if (!verifySignature('sha256',Buffer.from(canonicalJson(payload)),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},signature))
    stop('receipt_signature_invalid');
  return Object.freeze({ approvalId:context.approvalId, commandId:context.commandId,
    contextSha256:payload.approvalContextSha256, cutoverContextSha256:payload.cutoverApprovalContextSha256,
    planSha256:payload.canonicalPlanSha256,
    snapshotSha256:payload.reviewedSnapshotSha256, trustEnvelope:env });
}

function registryPaths(config) {
  const dir=config?.receiptDirectory;
  if (typeof dir!=='string' || !path.isAbsolute(dir)) stop('registry_unavailable');
  const stat=lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) stop('registry_unavailable');
  return { state:path.join(dir,'cutover-approval-state.json'), lock:path.join(dir,'cutover-approval-state.lock') };
}
function verifySignedObject(envelope, config, kind, keys) {
  if (!exact(envelope,['schemaVersion','kind','keyId','payload','signature']) || envelope.schemaVersion!==1 || envelope.kind!==kind
    || envelope.keyId!==config.signer.keyId || typeof envelope.signature!=='string' || envelope.signature.length>4096
    || !exact(envelope.payload,keys)) stop('registry_invalid');
  let key; try { key=createPublicKey(config.signer.publicKeyPem); } catch { stop('registry_key_invalid'); }
  if (!verifySignature('sha256',Buffer.from(canonicalJson(envelope.payload)),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},
    Buffer.from(envelope.signature,'base64'))) stop('registry_signature_invalid');
  return envelope.payload;
}
export function readNativeStaffCutoverApprovalRegistry(config) {
  const {state}=registryPaths(config); let envelope,text;
  try { const stat=lstatSync(state); if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2*1024*1024)stop('registry_invalid'); text=readFileSync(state,'utf8'); envelope=JSON.parse(text); }
  catch(error){if(error instanceof Error&&error.message.startsWith('native_staff_cutover_owner_'))throw error;stop('registry_unavailable');}
  const payload=verifySignedObject(envelope,config,NATIVE_STAFF_CUTOVER_APPROVAL_STATE_KIND,
    ['schemaVersion','sequence','previousStateSha256','entries']);
  if(payload.schemaVersion!==1||!Number.isSafeInteger(payload.sequence)||payload.sequence<0
    ||!(payload.previousStateSha256===null||HASH.test(payload.previousStateSha256))||!Array.isArray(payload.entries)||payload.entries.length>10_000)
    stop('registry_invalid');
  const seen=new Set();
  for(const entry of payload.entries){if(!exact(entry,['approvalId','commandId','receiptSha256','contextSha256','state','updatedAt'])
    ||!UUID.test(entry.approvalId??'')||!UUID.test(entry.commandId??'')||!HASH.test(entry.receiptSha256??'')
    ||!HASH.test(entry.contextSha256??'')||!['issued','revoked','dispatching','consumed','uncertain'].includes(entry.state)
    ||!Number.isFinite(Date.parse(entry.updatedAt??''))||new Date(Date.parse(entry.updatedAt)).toISOString()!==entry.updatedAt
    ||seen.has(entry.approvalId)||seen.has(`command:${entry.commandId}`))stop('registry_invalid');seen.add(entry.approvalId);seen.add(`command:${entry.commandId}`);}
  return Object.freeze({envelope,stateSha256:sha(text)});
}
function acquireLock(config){const {lock}=registryPaths(config);let fd;
  try{fd=openSync(lock,'wx',0o600);writeFileSync(fd,randomUUID());fsyncSync(fd);}catch{if(fd!==undefined)closeSync(fd);stop('registry_locked');}
  let released=false;return()=>{if(released)return;released=true;closeSync(fd);try{unlinkSync(lock);}catch{stop('registry_lock_release_failed');}};}
function signedState(config,payload){const signature=protectedSign(canonicalJson(payload),config);
  if(typeof signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature))stop('registry_sign_failed');
  return {schemaVersion:1,kind:NATIVE_STAFF_CUTOVER_APPROVAL_STATE_KIND,keyId:config.signer.keyId,payload,signature};}
function persistState(config,payload){const {state}=registryPaths(config),envelope=signedState(config,payload),tmp=`${state}.${randomUUID()}.tmp`;
  let fd;try{fd=openSync(tmp,'wx',0o600);writeFileSync(fd,`${canonicalJson(envelope)}\n`,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,state);}
  catch{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}stop('registry_write_failed');}
  return readNativeStaffCutoverApprovalRegistry(config);}
const nextState=(current,entries)=>({schemaVersion:1,sequence:current.envelope.payload.sequence+1,
  previousStateSha256:current.stateSha256,entries:entries.slice().sort((a,b)=>a.approvalId.localeCompare(b.approvalId))});

/** Explicit provisioning-only hook; production issuance refuses a missing state file. */
export function initializeNativeStaffCutoverApprovalRegistry(config){
  const release=acquireLock(config);try{const {state}=registryPaths(config);try{lstatSync(state);stop('registry_already_initialized');}
    catch(error){if(error instanceof Error&&error.message.startsWith('native_staff_cutover_owner_'))throw error;if(error?.code!=='ENOENT')stop('registry_unavailable');}
    return persistState(config,{schemaVersion:1,sequence:0,previousStateSha256:null,entries:[]});}finally{release();}}
export function issueNativeStaffCutoverApproval(config,receipt){
  const identity=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config}),receiptSha256=sha(canonicalJson(receipt));const release=acquireLock(config);try{
    const current=readNativeStaffCutoverApprovalRegistry(config);
    if(current.envelope.payload.entries.some(entry=>entry.approvalId===identity.approvalId||entry.commandId===identity.commandId))stop('approval_replay');
    const entry={approvalId:identity.approvalId,commandId:identity.commandId,receiptSha256,
      contextSha256:identity.contextSha256,state:'issued',updatedAt:new Date().toISOString()};
    const next=persistState(config,nextState(current,[...current.envelope.payload.entries,entry]));
    return Object.freeze({approvalId:identity.approvalId,commandId:identity.commandId,receiptSha256,
      contextSha256:identity.contextSha256,stateSha256:next.stateSha256});}finally{release();}}
export function revokeNativeStaffCutoverApproval(config,receipt,expectedStateSha256){
  if(!HASH.test(expectedStateSha256??''))stop('registry_hash_required');const identity=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config});
  const release=acquireLock(config);try{const current=readNativeStaffCutoverApprovalRegistry(config);if(current.stateSha256!==expectedStateSha256)stop('registry_changed_after_consent');
    const index=current.envelope.payload.entries.findIndex(row=>row.approvalId===identity.approvalId&&row.receiptSha256===sha(canonicalJson(receipt))&&row.state==='issued');
    if(index<0)stop('approval_not_revocable');const entries=current.envelope.payload.entries.slice();entries[index]={...entries[index],state:'revoked',updatedAt:new Date().toISOString()};
    return persistState(config,nextState(current,entries));}finally{release();}}
export function acquireNativeStaffCutoverApprovalLease(config,receipt){
  const identity=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config}),release=acquireLock(config);let finished=false;
  try{const current=readNativeStaffCutoverApprovalRegistry(config),index=current.envelope.payload.entries.findIndex(row=>row.approvalId===identity.approvalId);
    if(index<0||current.envelope.payload.entries[index].commandId!==identity.commandId
      ||current.envelope.payload.entries[index].receiptSha256!==sha(canonicalJson(receipt))
      ||current.envelope.payload.entries[index].contextSha256!==identity.contextSha256||current.envelope.payload.entries[index].state!=='issued')stop('approval_not_issuable');
    const entries=current.envelope.payload.entries.slice();entries[index]={...entries[index],state:'dispatching',updatedAt:new Date().toISOString()};
    const dispatching=persistState(config,nextState(current,entries));let released=false;
    const releaseOnce=()=>{if(!released){released=true;release();}};
    return Object.freeze({stateSha256:dispatching.stateSha256,finish(outcome){if(finished||!['consumed','uncertain'].includes(outcome))stop('registry_finish_invalid');
      const latest=readNativeStaffCutoverApprovalRegistry(config),at=latest.envelope.payload.entries.findIndex(row=>row.approvalId===identity.approvalId);
      if(at<0||latest.envelope.payload.entries[at].state!=='dispatching'||latest.envelope.payload.entries[at].receiptSha256!==sha(canonicalJson(receipt)))stop('registry_state_changed');
      const final=latest.envelope.payload.entries.slice();final[at]={...final[at],state:outcome,updatedAt:new Date().toISOString()};
      persistState(config,nextState(latest,final));finished=true;releaseOnce();}});
  }catch(error){release();throw error;}}

export function writeNativeStaffCutoverReceiptFile(config,receipt){
  const identity=verifyNativeStaffCutoverOwnerApprovalReceipt(receipt,{config}),{state}=registryPaths(config);
  const file=path.join(path.dirname(state),`native-staff-cutover-owner-approval-${identity.approvalId}.json`);
  const bytes=`${canonicalJson(receipt)}\n`;if(Buffer.byteLength(bytes)>MAX_RECEIPT_BYTES)stop('receipt_too_large');
  let fd;try{fd=openSync(file,'wx',0o600);writeFileSync(fd,bytes,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;}
  catch{if(fd!==undefined)closeSync(fd);stop('receipt_publish_failed');}
  return file;
}

export async function readCurrentCutoverOwnerSession(config,{getAccessToken=()=>runPinnedCloudflaredToken(config),fetchImpl=globalThis.fetch,now=Date.now()}={}){
  const token=await getAccessToken();return verifyCurrentNativeStaffCutoverOwnerSession(config,token,{fetchImpl,now});}
