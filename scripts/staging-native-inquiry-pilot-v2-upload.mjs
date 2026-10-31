/**
 * One-shot, injected uploader for the configuration-only native inquiry pilot.
 * Importing this module performs no provider or credential operations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compileStagingNativeInquiryPilotV2PlanFromFiles, hashStagingNativeInquiryPilotV2PlanFile,
  stagingNativeInquiryPilotV2PlanConstants } from './staging-native-inquiry-pilot-v2-plan.mjs';
import { canonical, need } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';

const { current: CURRENT, gates: GATES, sourceCommits: SOURCES } = stagingNativeInquiryPilotV2PlanConstants;
const CONTRACT = 'staging-native-inquiry-pilot-config-only-v2';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const HASH32 = /^[a-f0-9]{32}$/u;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROOF = 'C:/Projects/Ledge Top Operations/release-records/unification-20261024/record-v7-assets-proof-20261031.json';
const PROOF_SHA256 = '0d4c66619a4393594008be2261c865a4b631ad0204de4d5f3e5b21d579b18d84';
const BLAKE3_PACKAGE = 'C:/Projects/Ledge Top Operations/ops-recipient-inquiries-20261030/apps/operations/node_modules/blake3-wasm';
const BLAKE3_PACKAGE_SHA256 = 'f36864b59bcb76e6a97b7f236ad3ca78749af8374453ae1bcca048815b8c6e9e';
const BLAKE3_ENTRY_SHA256 = '0b267defb78ea5ca7886b59769140a440cbfa6f005241466440728e284a1d969';
const MAX_FILES = 1024, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_AGE_MS = 30 * 60_000;
const MIME = Object.freeze({ '.avif':'image/avif','.css':'text/css','.gif':'image/gif','.html':'text/html',
  '.ico':'image/vnd.microsoft.icon','.jpeg':'image/jpeg','.jpg':'image/jpeg','.js':'application/javascript',
  '.json':'application/json','.map':'application/json','.mjs':'application/javascript','.pdf':'application/pdf',
  '.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain','.wasm':'application/wasm',
  '.webmanifest':'application/manifest+json','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.xml':'application/xml' });
const clone = value => structuredClone(value);
const equal = (a, b) => canonical(a) === canonical(b);
const fail = (ok, message) => need(ok, `Native inquiry pilot uploader: ${message}`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ownKeys = (value, keys) => !!value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function readPinnedJson(file, limit = 64 * 1024 * 1024) {
  fail(file && path.isAbsolute(file.path) && SHA.test(file.sha256 ?? ''), 'file pin is malformed');
  outsideRepository(file.path);
  const st = fs.lstatSync(file.path);
  fail(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= limit
    && fs.realpathSync(file.path) === path.resolve(file.path),
    'pinned file is not a bounded single-link regular file');
  const fd = fs.openSync(file.path, 'r');
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    fail(before.dev === st.dev && before.ino === st.ino && before.size === st.size && bytes.length === st.size
      && after.dev === before.dev && after.ino === before.ino && after.nlink === 1 && after.size === before.size
      && after.mtimeMs === before.mtimeMs && sha256(bytes) === file.sha256,
    'pinned file bytes or identity changed');
    return { value: JSON.parse(bytes.toString('utf8')), bytes };
  } finally { fs.closeSync(fd); }
}

function outsideRepository(target) {
  const relative = path.relative(ROOT, target);
  fail(isOutsideStagingNativeInquiryPilotV2Repository(target),
    'evidence and asset bytes must remain outside the source worktree');
}

export function isOutsideStagingNativeInquiryPilotV2Repository(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const relative = path.relative(ROOT, target);
  return relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

export function validateStagingNativeInquiryPilotV2ManifestPaths(paths) {
  fail(Array.isArray(paths) && paths.length > 0 && paths.every((value, index) => typeof value === 'string'
    && (!index || paths[index - 1].localeCompare(value) < 0)),
  'manifest asset paths must be uniquely locale-sorted');
  return true;
}

function blake3() {
  const req = createRequire(import.meta.url), packageJson = path.join(BLAKE3_PACKAGE, 'package.json');
  fail(sha256(fs.readFileSync(packageJson)) === BLAKE3_PACKAGE_SHA256, 'pinned BLAKE3 package changed');
  const entry = req.resolve(BLAKE3_PACKAGE);
  fail(sha256(fs.readFileSync(entry)) === BLAKE3_ENTRY_SHA256, 'pinned BLAKE3 entrypoint changed');
  const digest = req(BLAKE3_PACKAGE).hash;
  fail(typeof digest === 'function' && digest(Buffer.from('QQ==txt', 'utf8')).toString('hex')
    === '42f8fed80a10e56fb584724a8ea0e156e928a529e86ab234a8d5b79057256bab', 'pinned BLAKE3 startup vector failed');
  return bytes => digest(bytes).toString('hex');
}

function verifyMaterialization(plan, evidence, hashBlake3, now) {
  fail(ownKeys(evidence, ['manifestFile','filesRoot']) && path.isAbsolute(evidence.filesRoot),
    'exact pinned materialization manifest and absolute root are required');
  outsideRepository(evidence.filesRoot);
  const rootStat = fs.lstatSync(evidence.filesRoot);
  fail(rootStat.isDirectory() && !rootStat.isSymbolicLink()
    && fs.realpathSync(evidence.filesRoot) === path.resolve(evidence.filesRoot),
  'materialization root must be a real nonsymlink directory');
  const manifest = readPinnedJson(evidence.manifestFile, 16 * 1024 * 1024).value;
  fail(ownKeys(manifest, ['schemaVersion','purpose','environment','accountId','workerName','sourceVersionId','observedAt','scope','assetsConfig','files','excludedFiles'])
    && manifest.schemaVersion === 1 && manifest.purpose === 'staging-retained-assets-materialization-v1'
    && manifest.environment === 'staging' && manifest.accountId === STAGING_ACCOUNT_ID
    && manifest.workerName === plan.workerName && manifest.sourceVersionId === plan.baselineVersionId
    && Number.isFinite(Date.parse(manifest.observedAt)) && Date.parse(manifest.observedAt) <= now
    && now - Date.parse(manifest.observedAt) <= MAX_AGE_MS
    && equal(manifest.assetsConfig, plan.assetUploadRecipe.assetsConfig)
    && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES
    && Array.isArray(manifest.excludedFiles), 'materialization manifest is for another target or malformed');
  const files = new Map(), uploads = new Map(), assetPaths = manifest.files.map(row => row?.path); let total = 0;
  validateStagingNativeInquiryPilotV2ManifestPaths(assetPaths);
  for (const row of manifest.files) {
    fail(ownKeys(row, ['path','size','sha256']) && typeof row.path === 'string' && row.path.startsWith('/')
      && !/[\\%?#\u0000-\u001f\u007f]/u.test(row.path)
      && row.path.slice(1).split('/').every(segment => segment && segment !== '.' && segment !== '..')
      && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= MAX_FILE_BYTES
      && SHA.test(row.sha256 ?? ''), 'manifest entries must be sorted, unique and byte-pinned');
    total += row.size; fail(total <= MAX_TOTAL_BYTES, 'manifest exceeds bounded materialization size');
    const target = path.join(evidence.filesRoot, row.path.slice(1).replaceAll('/', path.sep));
    const stat = fs.lstatSync(target);
    fail(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === row.size,
      'materialized file is linked or differs in size');
    const fd = fs.openSync(target, 'r'); let bytes;
    try {
      const before = fs.fstatSync(fd); bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
      fail(before.dev === stat.dev && before.ino === stat.ino && before.size === row.size && bytes.length === row.size
        && after.dev === before.dev && after.ino === before.ino && after.size === before.size
        && after.mtimeMs === before.mtimeMs && sha256(bytes) === row.sha256,
      'materialized file bytes changed or do not match manifest');
    } finally { fs.closeSync(fd); }
    const extension = path.posix.extname(row.path).toLowerCase(), contentType = MIME[extension];
    fail(contentType, 'unknown asset extension is refused');
    const encoded = bytes.toString('base64'), fullHash = hashBlake3(Buffer.from(`${encoded}${extension.slice(1)}`, 'utf8'));
    fail(SHA.test(fullHash), 'BLAKE3 provider hash malformed');
    const contentHash = fullHash.slice(0, 32), prior = uploads.get(contentHash);
    fail(!prior || (prior.sha256 === row.sha256 && prior.size === row.size && prior.contentType === contentType),
      'provider hash collision maps to different local bytes');
    if (!prior) uploads.set(contentHash, { hash: contentHash, path: row.path, size: row.size, sha256: row.sha256, contentType, bytes });
    files.set(row.path, { path: row.path, size: row.size, sha256: row.sha256, providerHash: contentHash, contentType, bytes });
  }
  const diskPaths = new Set();
  let scanned = 0;
  function walk(directory, prefix = '') {
    fail(prefix.split('/').length <= 18, 'materialization directory tree exceeds depth bound');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      fail(++scanned <= MAX_FILES * 2, 'materialization directory tree exceeds entry bound');
      const full = path.join(directory, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const st = fs.lstatSync(full);
      fail(!st.isSymbolicLink(), 'materialization tree contains a symbolic link');
      if (entry.isDirectory()) walk(full, rel);
      else { fail(entry.isFile(), 'materialization tree contains a non-file entry'); diskPaths.add('/' + rel.replaceAll('\\', '/')); }
    }
  }
  walk(evidence.filesRoot);
  fail(diskPaths.size === files.size && [...diskPaths].every(file => files.has(file)),
    'materialization tree contains omitted or unmanifested files');
  return { manifest: Object.fromEntries([...files.values()].map(row => [row.path, { hash: row.providerHash, size: row.size }])),
    files, uploads, manifestSHA256: evidence.manifestFile.sha256, count: files.size, totalBytes: total };
}

function verifyCoverage(evidenceFile, plan, materialized, now) {
  const evidence = readPinnedJson(evidenceFile, 16 * 1024 * 1024).value;
  fail(ownKeys(evidence, ['schemaVersion','purpose','environment','accountId','application','workerName','baselineVersionId','observedAt','window','sourceReceipts','releases'])
    && evidence.schemaVersion === 1 && evidence.purpose === 'staging-served-release-coverage-v1'
    && evidence.environment === 'staging' && evidence.accountId === STAGING_ACCOUNT_ID
    && evidence.application === plan.application && evidence.workerName === plan.workerName
    && evidence.baselineVersionId === plan.baselineVersionId, 'served-release coverage target differs');
  const observed = Date.parse(evidence.observedAt), from = Date.parse(evidence.window?.from), to = Date.parse(evidence.window?.to);
  fail(Number.isFinite(observed) && observed <= now && now - observed <= MAX_AGE_MS && to === observed
    && from <= to - 48 * 60 * 60_000, 'fresh complete 48-hour served-release window is required');
  fail(Array.isArray(evidence.sourceReceipts) && evidence.sourceReceipts.length >= 4 && evidence.sourceReceipts.length <= 64,
    'coverage source receipts are incomplete');
  const kinds = evidence.sourceReceipts.map(row => row?.kind);
  fail(['deployment-history','current-materialization','served-path-byte-closures'].every(kind => kinds.includes(kind))
    && kinds.includes('asset-upload-lineage') && kinds.every(kind => ['deployment-history','current-materialization',
      'served-path-byte-closures','asset-upload-lineage'].includes(kind))
    && new Set(evidence.sourceReceipts.map(row => row.path)).size === kinds.length,
  'coverage receipt kinds are incomplete or duplicated');
  for (const receipt of evidence.sourceReceipts) {
    fail(ownKeys(receipt, ['kind','path','sha256']) && path.isAbsolute(receipt.path) && SHA.test(receipt.sha256 ?? ''),
      'coverage source receipt malformed');
    readPinnedJson(receipt, 64 * 1024 * 1024);
  }
  const materializationReceipt = evidence.sourceReceipts.find(row => row.kind === 'current-materialization');
  fail(materializationReceipt.sha256 === materialized.manifestSHA256, 'coverage does not bind exact new materialization manifest');
  fail(Array.isArray(evidence.releases) && evidence.releases.length > 0 && evidence.releases.length <= 256,
    'bounded deployment history is required');
  const local = materialized.files, union = new Map(), seenVersions = new Set(), seenDeployments = new Set();
  let previousTo, index = 0;
  while (index < evidence.releases.length) {
    const first = evidence.releases[index], start = Date.parse(first.from), end = Date.parse(first.to), group = [];
    fail(ownKeys(first, ['deploymentId','from','to','percentage','versionId','assetLineageEvidenceSHA256','closureEvidenceSHA256','servedAssetClosure'])
      && UUID.test(first.deploymentId ?? ''), 'coverage history row malformed');
    while (index < evidence.releases.length && evidence.releases[index].deploymentId === first.deploymentId) {
      const row = evidence.releases[index++];
      fail(ownKeys(row, ['deploymentId','from','to','percentage','versionId','assetLineageEvidenceSHA256','closureEvidenceSHA256','servedAssetClosure'])
        && row.from === first.from && row.to === first.to && UUID.test(row.versionId ?? '')
        && Number.isFinite(row.percentage) && row.percentage > 0 && row.percentage <= 100
        && Array.isArray(row.servedAssetClosure) && !group.some(item => item.versionId === row.versionId),
      'coverage deployment weights or release rows malformed');
      group.push(row);
    }
    fail(Number.isFinite(start) && Number.isFinite(end) && start < end && !seenDeployments.has(first.deploymentId)
      && (seenDeployments.size ? start === previousTo : start === from)
      && Math.abs(group.reduce((sum, row) => sum + row.percentage, 0) - 100) < 0.0001,
    'coverage history has gaps, overlaps or invalid weights');
    previousTo = end; seenDeployments.add(first.deploymentId);
    for (const row of group) {
      seenVersions.add(row.versionId);
      fail(evidence.sourceReceipts.some(item => item.kind === 'asset-upload-lineage' && item.sha256 === row.assetLineageEvidenceSHA256)
        && evidence.sourceReceipts.some(item => item.kind === 'served-path-byte-closures' && item.sha256 === row.closureEvidenceSHA256),
      'coverage release lacks matching lineage and byte-closure receipts');
      fail(Array.isArray(row.servedAssetClosure) && row.servedAssetClosure.length > 0 && row.servedAssetClosure.length <= MAX_FILES,
        'release byte closure is empty or oversized');
      const closurePaths = row.servedAssetClosure.map(file => file?.path);
      fail(new Set(closurePaths).size === closurePaths.length
        && equal(closurePaths, closurePaths.slice().sort((a, b) => a.localeCompare(b))),
      'served closure paths must be sorted and unique');
      for (const file of row.servedAssetClosure) {
        fail((ownKeys(file, ['path','size','sha256']) || ownKeys(file, ['path','size','sha256','retainedPath']))
          && Number.isSafeInteger(file.size) && file.size >= 0 && SHA.test(file.sha256 ?? '')
          && typeof file.path === 'string' && file.path.startsWith('/')
          && !/[\\%?#\u0000-\u001f\u007f]/u.test(file.path)
          && file.path.slice(1).split('/').every(segment => segment && segment !== '.' && segment !== '..'),
        'served closure file malformed');
        const targetPath = file.retainedPath ?? file.path, expected = { path: targetPath, size: file.size, sha256: file.sha256 };
        if (file.retainedPath) fail(file.path === '/index.html'
          && file.retainedPath === `/_ui/${plan.application}/${file.sha256.slice(0, 40)}/index.html`,
        'retained root URL alias is outside the exact approved hash path');
        else fail(equal(local.get(file.path) && { path: file.path, size: local.get(file.path).size,
          sha256: local.get(file.path).sha256 }, { path: file.path, size: file.size, sha256: file.sha256 }),
        'served path does not match its exact source bytes');
        fail(equal(local.get(targetPath) && { path: targetPath, size: local.get(targetPath).size, sha256: local.get(targetPath).sha256 }, expected),
          'new materialization does not contain every historically served byte path');
        const old = union.get(targetPath); fail(!old || equal(old, expected), 'history assigns conflicting bytes to one URL');
        union.set(targetPath, expected);
      }
    }
  }
  fail(previousTo === to && seenVersions.has(plan.baselineVersionId) && union.size > 0,
    'history must end at fresh observation and include current baseline version');
  return { observedAt: evidence.observedAt, releaseCount: evidence.releases.length, requiredAssetCount: union.size };
}

function checkPlan(plan, planFile) {
  const planKeys = ['schemaVersion','contract','purpose','application','step','accountId','workerName','sourceCommit','sourceProfiles',
    'baselineVersionId','currentActiveVersionId','currentLatestVersionId','controlsSHA256','baselineControlsSHA256','basePlanSHA256',
    'basePlanContract','basePlanSchemaVersion','databaseSchemaSHA256','mainModuleSHA256','sourceMapSHA256','controlsObservedAt',
    'baselineControlsObservedAt','installedCodeMatchesQualifiedBuild','installedRuntimeAndBindingsMatchBase','schemaMatchesBase',
    'preservedBindings','configurationDelta','expectedResolvedBindings','clientPilotContext','held','offlineOnly','deploymentEnabled',
    'executionAllowed','holdReasons','versionCreateTemplate','assetUploadRecipe','futureExecutionPrerequisites',
    'noIdentityOrCapabilityGrant','noMigrationConfig','noFileOrFinancePermission','noNotificationCreation','noOpsSyncUpdate'];
  fail(ownKeys(plan, planKeys) && plan.schemaVersion === 2 && plan.contract === CONTRACT && plan.purpose === 'staging-native-inquiry-pilot-configuration-only-v2'
    && ['client', 'operations'].includes(plan.application) && plan.accountId === STAGING_ACCOUNT_ID
    && plan.workerName === CURRENT[plan.application].workerName && plan.sourceCommit === SOURCES[plan.application]
    && equal(plan.sourceProfiles, SOURCES) && plan.baselineVersionId === CURRENT[plan.application].activeVersionId
    && plan.currentActiveVersionId === plan.baselineVersionId && plan.currentLatestVersionId === plan.baselineVersionId
    && plan.step === (plan.application === 'client' ? 1 : 2)
    && plan.basePlanContract === (plan.application === 'operations' ? 'staging-backend-only-owner-review-profile-v5'
      : 'staging-backend-only-current-profile-v4')
    && plan.basePlanSchemaVersion === (plan.application === 'operations' ? 5 : 4)
    && SHA.test(plan.basePlanSHA256 ?? '')
    && plan.held === true && plan.offlineOnly === true && plan.deploymentEnabled === false && plan.executionAllowed === false
    && plan.noIdentityOrCapabilityGrant === true && plan.noMigrationConfig === true && plan.noOpsSyncUpdate === true
    && plan.noFileOrFinancePermission === true && plan.noNotificationCreation === true
    && Array.isArray(plan.holdReasons) && plan.holdReasons.length >= 4
    && Array.isArray(plan.futureExecutionPrerequisites) && plan.futureExecutionPrerequisites.length >= 4
    && (plan.application === 'client' ? plan.clientPilotContext === null
      : plan.clientPilotContext && SHA.test(plan.clientPilotContext.receiptSHA256 ?? '')
        && UUID.test(plan.clientPilotContext.candidateVersionId ?? '')
        && UUID.test(plan.clientPilotContext.deploymentId ?? '')
        && SHA.test(plan.clientPilotContext.planSHA256 ?? '')
        && SHA.test(plan.clientPilotContext.baselineControlsSHA256 ?? '')
        && SHA.test(plan.clientPilotContext.controlsSHA256 ?? '')),
  'plan is not an exact held v2 target');
  const expectedGates = GATES[plan.application];
  fail(Array.isArray(plan.configurationDelta) && equal(plan.configurationDelta,
    expectedGates.map(name => ({ name, type: 'plain_text', text: 'true' })))
    && Array.isArray(plan.versionCreateTemplate?.bindings), 'configuration delta differs from the two fixed gates');
  const additions = plan.versionCreateTemplate.bindings.filter(row => expectedGates.includes(row.name));
  fail(additions.length === expectedGates.length && expectedGates.every(name => {
    const rows = additions.filter(row => row.name === name);
    return rows.length === 1 && rows[0].type === 'plain_text' && rows[0].text === 'true'
      && !Object.hasOwn(rows[0], 'version_id');
  }) && plan.versionCreateTemplate.bindings.every(row => expectedGates.includes(row.name)
    || (row.type === 'inherit' && row.version_id === plan.baselineVersionId))
    && plan.versionCreateTemplate.account_id === STAGING_ACCOUNT_ID
    && plan.versionCreateTemplate.deploy === false && !Object.hasOwn(plan.versionCreateTemplate, 'assets')
    && !Object.hasOwn(plan.versionCreateTemplate, 'migrations'), 'version template exceeds exact held configuration delta');
  fail(plan.assetUploadRecipe?.protocol === 'workers-static-assets-upload-v1'
    && plan.assetUploadRecipe.completionJwtRequired === true && plan.assetUploadRecipe.completionJwtMemoryOnly === true
    && plan.assetUploadRecipe.completionJwtPersisted === false && plan.assetUploadRecipe.providerManifestBytesPersisted === false
    && plan.assetUploadRecipe.requiresReviewedRetainedReleaseCoverageEvidence === true
    && plan.assetUploadRecipe.uploadAssetSetAllowed === false,
  'retained asset/JWT protocol is not pinned');
  const moduleRows = plan.versionCreateTemplate.modules;
  fail(Array.isArray(moduleRows) && moduleRows.length === 2, 'exact main and source-map modules are required');
  const main = moduleRows.find(row => row.name === plan.versionCreateTemplate.main_module);
  const map = moduleRows.find(row => row.name === `${plan.versionCreateTemplate.main_module}.map`);
  fail(main && map && main.content_type !== 'application/source-map' && map.content_type === 'application/source-map'
    && Buffer.from(main.content_base64, 'base64').toString('base64') === main.content_base64
    && Buffer.from(map.content_base64, 'base64').toString('base64') === map.content_base64
    && sha256(Buffer.from(main.content_base64, 'base64')) === plan.mainModuleSHA256
    && sha256(Buffer.from(map.content_base64, 'base64')) === plan.sourceMapSHA256,
  'module payload differs from source-pinned compiler output');
  fail(plan.installedCodeMatchesQualifiedBuild === true && plan.installedRuntimeAndBindingsMatchBase === true
    && plan.schemaMatchesBase === true && Array.isArray(plan.preservedBindings)
    && plan.preservedBindings.length === plan.versionCreateTemplate.bindings.filter(row => row.type === 'inherit').length
    && Array.isArray(plan.expectedResolvedBindings)
    && plan.expectedResolvedBindings.length === plan.preservedBindings.length
    && plan.expectedResolvedBindings.every((row, index) => ownKeys(row, ['name','type','projectionSHA256'])
      && row.name === plan.preservedBindings[index] && SHA.test(row.projectionSHA256 ?? '')),
  'qualified current runtime/binding/schema preservation evidence is incomplete');
  fail(planFile && SHA.test(planFile.sha256 ?? '')
    && hashStagingNativeInquiryPilotV2PlanFile(plan) === planFile.sha256,
  'held plan file hash does not match canonical compiler serialization');
  return plan;
}

function stablePlan(plan) {
  return { schemaVersion: plan.schemaVersion, contract: plan.contract, application: plan.application,
    purpose: plan.purpose, step: plan.step, accountId: plan.accountId, workerName: plan.workerName, sourceCommit: plan.sourceCommit,
    sourceProfiles: plan.sourceProfiles, baselineVersionId: plan.baselineVersionId,
    currentActiveVersionId: plan.currentActiveVersionId, currentLatestVersionId: plan.currentLatestVersionId,
    basePlanSHA256: plan.basePlanSHA256, basePlanContract: plan.basePlanContract,
    basePlanSchemaVersion: plan.basePlanSchemaVersion,
    databaseSchemaSHA256: plan.databaseSchemaSHA256, mainModuleSHA256: plan.mainModuleSHA256,
    sourceMapSHA256: plan.sourceMapSHA256, installedCodeMatchesQualifiedBuild: plan.installedCodeMatchesQualifiedBuild,
    installedRuntimeAndBindingsMatchBase: plan.installedRuntimeAndBindingsMatchBase,
    schemaMatchesBase: plan.schemaMatchesBase, preservedBindings: plan.preservedBindings,
    expectedResolvedBindings: plan.expectedResolvedBindings, configurationDelta: plan.configurationDelta,
    clientPilotContext: plan.clientPilotContext, versionCreateTemplate: plan.versionCreateTemplate,
    assetUploadRecipe: plan.assetUploadRecipe, holdReasons: plan.holdReasons,
    futureExecutionPrerequisites: plan.futureExecutionPrerequisites, held: plan.held, offlineOnly: plan.offlineOnly,
    deploymentEnabled: plan.deploymentEnabled, executionAllowed: plan.executionAllowed,
    noIdentityOrCapabilityGrant: plan.noIdentityOrCapabilityGrant, noMigrationConfig: plan.noMigrationConfig,
    noFileOrFinancePermission: plan.noFileOrFinancePermission, noNotificationCreation: plan.noNotificationCreation,
    noOpsSyncUpdate: plan.noOpsSyncUpdate };
}

function checkedJournal(journal) {
  fail(journal && typeof journal.reserve === 'function' && typeof journal.complete === 'function', 'durable one-attempt journal is required');
  return journal;
}

export function projectStagingNativeInquiryPilotV2MaterializationEvidence(assetEvidence) {
  fail(ownKeys(assetEvidence, ['manifestFile','filesRoot','coverageEvidenceFile']),
    'manifest, materialization root and coverage evidence pins are required');
  return { manifestFile: assetEvidence.manifestFile, filesRoot: assetEvidence.filesRoot };
}

export function validateStagingNativeInquiryPilotV2UploadBuckets(buckets, uploads) {
  fail(Array.isArray(buckets) && buckets.length <= MAX_FILES && uploads instanceof Map,
    'upload-session bucket array or local upload index is malformed');
  const seen = new Set();
  for (const bucket of buckets) {
    fail(Array.isArray(bucket) && bucket.length > 0 && bucket.length <= MAX_FILES, 'asset bucket malformed');
    for (const hashValue of bucket) {
      fail(HASH32.test(hashValue ?? '') && uploads.has(hashValue) && !seen.has(hashValue),
        'asset hash is unknown, malformed or duplicated in upload-session response');
      seen.add(hashValue);
    }
  }
  // Cloudflare intentionally omits hashes already uploaded to the same Worker.
  // Empty buckets are valid and the session JWT is then the completion JWT.
  return { buckets: buckets.map(bucket => bucket.slice()), requestedUploadCount: seen.size };
}

function safeCreateParams(plan, completionJwt) {
  fail(typeof completionJwt === 'string' && completionJwt.length >= 16 && completionJwt.length <= 8192,
    'in-memory asset completion JWT is required');
  const params = clone(plan.versionCreateTemplate);
  params.bindings = [...params.bindings, { name: 'ASSETS', type: 'assets' }].sort((a, b) => a.name.localeCompare(b.name));
  params.assets = { config: clone(plan.assetUploadRecipe.assetsConfig), jwt: completionJwt };
  params.deploy = false;
  params.bindings_inherit = 'strict';
  fail(params.bindings.filter(row => row.name === 'ASSETS').length === 1
    && params.bindings.filter(row => row.name !== 'ASSETS').every(row => expectedGateOrInherit(row, plan)),
  'final candidate bindings are outside the reviewed plan');
  return params;
}

function expectedGateOrInherit(row, plan) {
  return GATES[plan.application].includes(row.name)
    ? row.type === 'plain_text' && row.text === 'true' && !Object.hasOwn(row, 'version_id')
    : row.type === 'inherit' && row.version_id === plan.baselineVersionId;
}

export function validateStagingNativeInquiryPilotV2CandidateReadback({ readback, candidateVersionId, plan, candidateParams } = {}) {
  checkPlan(plan, { sha256: hashStagingNativeInquiryPilotV2PlanFile(plan) });
  fail(candidateParams && candidateParams.account_id === STAGING_ACCOUNT_ID && candidateParams.deploy === false
    && candidateParams.bindings_inherit === 'strict' && candidateParams.assets
    && equal(candidateParams.assets.config, plan.assetUploadRecipe.assetsConfig)
    && typeof candidateParams.assets.jwt === 'string' && candidateParams.assets.jwt.length >= 16
    && candidateParams.assets.jwt.length <= 8192
    && equal(candidateParams.modules, plan.versionCreateTemplate.modules)
    && equal(candidateParams.bindings.filter(row => row.name !== 'ASSETS'), plan.versionCreateTemplate.bindings)
    && candidateParams.bindings.filter(row => row.name === 'ASSETS').length === 1
    && candidateParams.bindings.find(row => row.name === 'ASSETS')?.type === 'assets'
    && !Object.hasOwn(candidateParams, 'migrations'), 'candidate request differs from the held no-deploy plan');
  const deploymentRows = readback?.deployment;
  const exactDeploymentRows = Array.isArray(deploymentRows) && deploymentRows.length > 0
    && deploymentRows.every(row => ownKeys(row, ['versionId','percentage']));
  const baseline100 = exactDeploymentRows && deploymentRows.filter(row =>
    row.versionId === plan.baselineVersionId && row.percentage === 100).length === 1;
  const inactiveOnly = deploymentRows?.length === 1 && baseline100;
  const candidateZero = deploymentRows?.length === 2 && baseline100
    && new Set(deploymentRows.map(row => row.versionId)).size === 2
    && deploymentRows.filter(row => row.versionId === candidateVersionId && row.percentage === 0).length === 1;
  fail(UUID.test(candidateVersionId ?? '') && ownKeys(readback, ['latestVersionId','deployment','candidate'])
    && readback.latestVersionId === candidateVersionId && (inactiveOnly || candidateZero),
  'candidate readback must leave the baseline at 100% and candidate at zero traffic');
  const candidate = readback.candidate;
  fail(ownKeys(candidate, ['id','mainModule','modules','resolvedBindings','assetsConfig','compatibilityDate','compatibilityFlags','exports'])
    && candidate.id === candidateVersionId && candidate.mainModule === candidateParams.main_module
    && Array.isArray(candidate.modules) && Array.isArray(candidate.resolvedBindings), 'candidate source readback is malformed');
  const requested = candidateParams.modules.map(row => ({ name: row.name, bytes: Buffer.from(row.content_base64, 'base64').length,
    sha256: sha256(Buffer.from(row.content_base64, 'base64')), content_type: row.content_type }));
  const inherited = candidate.resolvedBindings.filter(row => !GATES[plan.application].includes(row.name) && row.name !== 'ASSETS');
  const actualProjection = inherited.map(row => {
    fail(row && typeof row === 'object' && typeof row.name === 'string' && typeof row.type === 'string',
      'resolved binding row lacks identity');
    return { name: row.name, type: row.type, projectionSHA256: sha256(Buffer.from(canonical(row))) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const gateProjection = candidate.resolvedBindings.filter(row => GATES[plan.application].includes(row.name));
  const assetBindings = candidate.resolvedBindings.filter(row => row.name === 'ASSETS');
  const expectedGateHash = sha256(Buffer.from(JSON.stringify('true')));
  const actualRuntime = candidate.modules.filter(row => row.content_type !== 'application/source-map');
  const actualMaps = candidate.modules.filter(row => row.content_type === 'application/source-map');
  const expectedRuntime = requested.filter(row => row.content_type !== 'application/source-map');
  const expectedMaps = requested.filter(row => row.content_type === 'application/source-map');
  fail(equal(actualRuntime, expectedRuntime) && actualMaps.length <= 1
    && (actualMaps.length === 0 || equal(actualMaps, expectedMaps))
    && candidate.resolvedBindings.every(row => row?.type !== 'inherit')
    && equal(actualProjection, plan.expectedResolvedBindings)
    && assetBindings.length === 1 && assetBindings[0].type === 'assets'
    && gateProjection.length === GATES[plan.application].length && GATES[plan.application].every(name => {
      const rows = gateProjection.filter(row => row.name === name);
      return rows.length === 1 && rows[0].type === 'plain_text' && rows[0].textSHA256 === expectedGateHash;
    })
    && equal(candidate.assetsConfig, candidateParams.assets.config)
    && candidate.compatibilityDate === candidateParams.compatibility_date
    && equal(candidate.compatibilityFlags, candidateParams.compatibility_flags)
    && equal(candidate.exports, candidateParams.exports), 'candidate bytes or runtime/readback fields differ from request');
  return true;
}

/** Create a v2 candidate. Every provider-facing operation is injected; no
 * adapter or credential loader is imported by this module. */
export function createStagingNativeInquiryPilotV2Uploader({ sdk, uploadBucket, readFreshControls,
  readCandidateState, journal, now = () => Date.now() } = {}) {
  fail(sdk && typeof sdk.createAssetUploadSession === 'function' && typeof sdk.createVersion === 'function'
    && typeof uploadBucket === 'function' && typeof readFreshControls === 'function'
    && typeof readCandidateState === 'function' && typeof now === 'function',
  'injected SDK, transport, readback and clock are required');
  const oneAttemptJournal = checkedJournal(journal);
  return async function createCandidate({ planFile, inputFiles, assetEvidence } = {}) {
    const held = checkPlan(readPinnedJson(planFile).value, planFile);
    fail(inputFiles && inputFiles.application === held.application, 'pinned compiler inputs are required');
    projectStagingNativeInquiryPilotV2MaterializationEvidence(assetEvidence);
    const compileOptions = { application: held.application, baselineControlsFile: inputFiles.baselineControlsFile,
      currentControlsFile: inputFiles.currentControlsFile, clientPilotReceiptFile: inputFiles.clientPilotReceiptFile,
      clientPilotReceiptSHA256: inputFiles.clientPilotReceiptSHA256 };
    const first = compileStagingNativeInquiryPilotV2PlanFromFiles(compileOptions);
    checkPlan(first, { sha256: hashStagingNativeInquiryPilotV2PlanFile(first) });
    fail(equal(stablePlan(first), stablePlan(held)), 'fresh compiler output differs from held plan');
    const proof = readPinnedJson({ path: PROOF, sha256: PROOF_SHA256 }, 64 * 1024).value;
    const proofKeys = ['at','sourceSha256','probeId','workerName','versions','deploymentId','liveC100ReadbackVerified','httpChecks',
      'assetSetReconstituted','assetNamespaceInherited','nonAssetsExplicitAInheritanceVerified','completionJwtKeptInMemoryOnly',
      'ownedWorkerApiAndPublic404','realApplicationUploaded','realApplicationExecutionAllowed',
      'requiresCompleteRetainedRealAssetManifest','phaseFiles'];
    fail(ownKeys(proof, proofKeys) && proof.sourceSha256 === '83e263fe0cb595adcac54b9bcbcb2022c881872cf9e1ba23be9706a667b3f4dc'
      && proof.liveC100ReadbackVerified === true && proof.httpChecks === 5 && proof.assetSetReconstituted === true
      && proof.assetNamespaceInherited === false && proof.nonAssetsExplicitAInheritanceVerified === true
      && proof.completionJwtKeptInMemoryOnly === true && proof.ownedWorkerApiAndPublic404 === true
      && proof.realApplicationUploaded === false && proof.realApplicationExecutionAllowed === false
      && proof.requiresCompleteRetainedRealAssetManifest === true && Array.isArray(proof.phaseFiles),
    'exact pinned runtime asset-upload proof is incomplete');
    const verified = verifyMaterialization(held, projectStagingNativeInquiryPilotV2MaterializationEvidence(assetEvidence), blake3(), now());
    verifyCoverage(assetEvidence.coverageEvidenceFile, held, verified, now());
    let lastObserved = Date.parse(held.controlsObservedAt);
    let completionJwt;
    const planKey = `v2/${held.application}/${held.workerName}/${held.baselineVersionId}/${held.sourceCommit}`;
    async function recheck(step) {
      const controlFile = await readFreshControls(held.application, held.workerName);
      const freshOptions = { ...compileOptions, currentControlsFile: controlFile };
      if (held.application === 'client') freshOptions.baselineControlsFile = controlFile;
      const fresh = compileStagingNativeInquiryPilotV2PlanFromFiles(freshOptions);
      checkPlan(fresh, { sha256: hashStagingNativeInquiryPilotV2PlanFile(fresh) });
      fail(equal(stablePlan(fresh), stablePlan(held)) && Date.parse(fresh.controlsObservedAt) >= lastObserved
        && now() - Date.parse(fresh.controlsObservedAt) <= 30 * 60_000,
      `fresh compiler controls drifted before ${step}`);
      lastObserved = Date.parse(fresh.controlsObservedAt);
      verifyCoverage(assetEvidence.coverageEvidenceFile, held, verified, now());
      return fresh;
    }
    async function mutate(step, requestHash, run) {
      const key = `${planKey}/${step}`;
      let reserved = false;
      try { reserved = await oneAttemptJournal.reserve(key, { step, workerName: held.workerName,
        accountId: STAGING_ACCOUNT_ID, requestSHA256: requestHash }); } catch { /* fail closed */ }
      fail(reserved === true, `one-attempt journal refuses ${step}; no request submitted`);
      let response;
      try { response = await run(); }
      catch { try { await oneAttemptJournal.complete(key, { outcome: 'uncertain', requestSHA256: requestHash }); } catch { /* remain held */ }
        throw new Error(`${step} outcome uncertain; retry is forbidden`); }
      try { await oneAttemptJournal.complete(key, { outcome: 'response-received', requestSHA256: requestHash }); }
      catch { throw new Error(`${step} response not durably recorded; retry is forbidden`); }
      return response;
    }
    try {
      const current = await recheck('asset-upload-session');
      const sessionRequest = { account_id: STAGING_ACCOUNT_ID, manifest: verified.manifest };
      const sessionHash = sha256(Buffer.from(canonical(sessionRequest)));
      const session = await mutate('asset-upload-session', sessionHash,
        () => sdk.createAssetUploadSession(held.workerName, sessionRequest, { maxRetries: 0 }));
      fail(session && Array.isArray(session.buckets) && typeof session.jwt === 'string'
        && session.jwt.length >= 16 && session.jwt.length <= 8192, 'asset upload session response malformed');
      const checkedBuckets = validateStagingNativeInquiryPilotV2UploadBuckets(session.buckets, verified.uploads);
      completionJwt = session.jwt;
      for (let index = 0; index < checkedBuckets.buckets.length; index++) {
        const bucket = checkedBuckets.buckets[index];
        const rows = bucket.map(assetHash => {
          const row = verified.uploads.get(assetHash);
          return { hash: row.hash, size: row.size, contentType: row.contentType, base64: row.bytes.toString('base64') };
        });
        await recheck(`asset-upload-bucket-${index}`);
        const summary = rows.map(({ hash: assetHash, size, contentType }) => ({ hash: assetHash, size, contentType }));
        const requestHash = sha256(Buffer.from(canonical(summary)));
        const response = await mutate(`asset-upload-bucket-${index}`, requestHash, () => uploadBucket({
          endpoint: `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}/workers/assets/upload?base64=true`, workerName: held.workerName,
          accountId: STAGING_ACCOUNT_ID, uploadJwt: completionJwt, files: rows, maxRetries: 0, timeoutMs: 25_000 }));
        const final = index === session.buckets.length - 1;
        fail(response && (final ? response.status === 201 && typeof response.completionJwt === 'string'
          && response.completionJwt.length >= 16 && response.completionJwt.length <= 8192
          : [200, 202].includes(response.status) && response.completionJwt === undefined),
        'bucket acknowledgement status/JWT contract failed');
        if (final) completionJwt = response.completionJwt;
      }
      const latest = await recheck('version-create');
      const params = safeCreateParams(latest, completionJwt);
      const withoutJwt = clone(params); delete withoutJwt.assets.jwt;
      const requestHash = sha256(Buffer.from(canonical(withoutJwt)));
      const created = await mutate('version-create', requestHash,
        () => sdk.createVersion(held.workerName, params, { maxRetries: 0 }));
      const candidateVersionId = created?.id; completionJwt = undefined;
      fail(UUID.test(candidateVersionId ?? ''), 'version-create did not return candidate ID');
      let readback;
      try { readback = await readCandidateState(held.workerName, candidateVersionId); }
      catch { return { candidateVersionId, readbackVerified: false }; }
      let readbackVerified = false;
      try { readbackVerified = validateStagingNativeInquiryPilotV2CandidateReadback({ readback,
        candidateVersionId, plan: latest, candidateParams: params }); } catch { /* candidate remains held */ }
      return { candidateVersionId, readbackVerified };
    } finally { completionJwt = undefined; }
  };
}

