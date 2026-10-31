/**
 * One-shot, injected adapter for creating an inactive staging backend candidate.
 * The v3 offline plan remains held. This adapter does not enable/deploy the
 * candidate and refuses any plan or evidence that is not freshly revalidated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonical, need } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID } from './staging-requirements.mjs';
import {
  compileStagingBackendReleasePlan,
  validateStagingBackendReleasePlan,
  STAGING_BACKEND_RELEASE_TARGETS,
} from './staging-backend-release-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/u;
const HASH32 = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SOURCE_COMMIT = 'c2ce0b6feaa3f410dd6284bd5ce5763818958ec8';
const V7_RUNTIME_PROOF_SHA256 = '0d4c66619a4393594008be2261c865a4b631ad0204de4d5f3e5b21d579b18d84';
const COVERAGE_PURPOSE = 'staging-served-release-coverage-v1';
const REQUIRED_COVERAGE_SOURCES = Object.freeze([
  'deployment-history', 'current-materialization', 'served-path-byte-closures',
]);
const MATERIALIZATION_ONLY_PATHS = new Set(['/.assetsignore']);
const MAX_FILES = 1_024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_COVERAGE_AGE_MS = 30 * 60_000;
const ASSET_UPLOAD_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${STAGING_ACCOUNT_ID}/workers/assets/upload?base64=true`;
const MIME_BY_EXTENSION = Object.freeze({
  '.avif': 'image/avif', '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html',
  '.ico': 'image/vnd.microsoft.icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'application/javascript',
  '.json': 'application/json', '.map': 'application/json', '.mjs': 'application/javascript', '.pdf': 'application/pdf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.xml': 'application/xml',
});

const clone = value => structuredClone(value);
const equal = (a, b) => canonical(a) === canonical(b);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ownKeysAre = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && equal(Object.keys(value).sort(), [...keys].sort());
const isoMs = value => {
  const n = Date.parse(value);
  need(Number.isFinite(n), 'Coverage timestamps must be valid ISO dates');
  return n;
};

function outsideRepository(file) {
  const relative = path.relative(ROOT, file);
  need(relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)),
    'Evidence and materialization files must remain outside the source worktree');
}

function readPinnedJson(pin, label, expectedSha = undefined, maxBytes = 16 * 1024 * 1024) {
  need(ownKeysAre(pin, ['path', 'sha256']) && path.isAbsolute(pin.path) && SHA.test(pin.sha256 ?? '')
    && (expectedSha === undefined || pin.sha256 === expectedSha), `${label} path and immutable SHA-256 pin required`);
  outsideRepository(pin.path);
  let handle;
  try {
    const stat = fs.lstatSync(pin.path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes,
      `${label} must be a bounded single-link file`);
    handle = fs.openSync(pin.path, 'r');
    const before = fs.fstatSync(handle);
    need(before.isFile() && before.nlink === 1 && before.size === stat.size
      && before.dev === stat.dev && before.ino === stat.ino, `${label} changed while opening`);
    const bytes = fs.readFileSync(handle), after = fs.fstatSync(handle);
    need(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      && after.ino === before.ino && after.dev === before.dev && sha256(bytes) === pin.sha256,
    `${label} changed or does not match its immutable byte pin`);
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is missing, malformed or changed; candidate held`);
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}

function verifySourceReceipt(row) {
  need(ownKeysAre(row, ['kind','path','sha256']) && path.isAbsolute(row.path) && SHA.test(row.sha256 ?? ''),
    'Coverage source receipts must pin exact files');
  outsideRepository(row.path);
  let handle;
  try {
    const stat = fs.lstatSync(row.path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 64 * 1024 * 1024,
      'Coverage source receipt must be a bounded single-link file');
    handle = fs.openSync(row.path, 'r');
    const before = fs.fstatSync(handle);
    need(before.isFile() && before.nlink === 1 && before.size === stat.size && before.dev === stat.dev && before.ino === stat.ino,
      'Coverage source receipt changed while opening');
    const bytes = fs.readFileSync(handle), after = fs.fstatSync(handle);
    need(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      && after.dev === before.dev && after.ino === before.ino && sha256(bytes) === row.sha256,
    'Coverage source receipt bytes differ from the exact source pin');
    return bytes;
  } catch { throw new Error('A served-release coverage source receipt is missing or changed'); }
  finally { if (handle !== undefined) fs.closeSync(handle); }
}

function checkedHeldPlan(planOptions, heldPlan) {
  need(heldPlan?.schemaVersion === 3 && heldPlan.contract === 'staging-backend-only-v3'
    && heldPlan.sourceCommit === SOURCE_COMMIT && heldPlan.held === true
    && heldPlan.offlineOnly === true && heldPlan.executionAllowed === false && heldPlan.deploymentEnabled === false
    && heldPlan.assetsUploadRequired === true && heldPlan.assetJwtIncluded === false
    && heldPlan.liveNamespaceVerified === false && heldPlan.assetReconstitution?.namespaceReconstituted === false
    && heldPlan.assetReconstitution?.namespaceInherited === false
    && heldPlan.assetUploadRecipe?.uploadAssetSetAllowed === false,
  'Only the exact held v3 source plan is accepted; release flags cannot be promoted');
  validateStagingBackendReleasePlan(planOptions, heldPlan);
  const app = heldPlan.application, target = STAGING_BACKEND_RELEASE_TARGETS[app];
  need(target && ['operations', 'client'].includes(app) && heldPlan.accountId === STAGING_ACCOUNT_ID
    && heldPlan.selectedWorker === target.workerName && UUID.test(heldPlan.selectedActiveVersionId ?? '')
    && UUID.test(heldPlan.selectedLatestVersionId ?? ''), 'Plan does not name a fixed staging Worker');
  const template = heldPlan.versionCreateTemplate;
  need(template?.account_id === STAGING_ACCOUNT_ID && template.deploy === false
    && Array.isArray(template.modules) && template.modules.length === 2
    && template.modules[0].name === template.main_module
    && template.modules[1].name === `${template.main_module}.map`
    && !Object.hasOwn(template, 'assets') && Array.isArray(template.bindings)
    && !template.bindings.some(row => row.name === 'ASSETS'),
  'Held version template must contain the exact source pair and non-asset bindings only');
  const inheritRows = template.bindings.filter(row => row.type === 'inherit');
  const serviceRows = template.bindings.filter(row => row.type === 'service');
  need(inheritRows.length === template.bindings.length - serviceRows.length
    && inheritRows.every(row => row.version_id === heldPlan.selectedActiveVersionId)
    && serviceRows.length === (app === 'client' ? 1 : 0)
    && (app !== 'client' || equal(serviceRows, [
      { name: 'OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES', type: 'service', service: 'ledgetop-ops-staging',
        entrypoint: 'OperationsNativePrincipalInquiryIngress' },
    ])),
  'Existing non-service bindings must inherit from the reviewed active version');
  return heldPlan;
}

function verifyRuntimeProof(proofFile) {
  const proof = readPinnedJson(proofFile, 'Root v7 runtime proof', V7_RUNTIME_PROOF_SHA256, 64 * 1024);
  const required = ['at','sourceSha256','probeId','workerName','versions','deploymentId','liveC100ReadbackVerified','httpChecks',
    'assetSetReconstituted','assetNamespaceInherited','nonAssetsExplicitAInheritanceVerified','completionJwtKeptInMemoryOnly',
    'ownedWorkerApiAndPublic404','realApplicationUploaded','realApplicationExecutionAllowed',
    'requiresCompleteRetainedRealAssetManifest','phaseFiles'];
  need(ownKeysAre(proof, required) && proof.sourceSha256 === '83e263fe0cb595adcac54b9bcbcb2022c881872cf9e1ba23be9706a667b3f4dc'
    && proof.liveC100ReadbackVerified === true && proof.httpChecks === 5 && proof.assetSetReconstituted === true
    && proof.assetNamespaceInherited === false && proof.nonAssetsExplicitAInheritanceVerified === true
    && proof.completionJwtKeptInMemoryOnly === true && proof.ownedWorkerApiAndPublic404 === true
    && proof.realApplicationUploaded === false && proof.realApplicationExecutionAllowed === false
    && proof.requiresCompleteRetainedRealAssetManifest === true && Array.isArray(proof.phaseFiles),
  'The exact Root v7 synthetic asset reconstitution runtime proof is required');
  return V7_RUNTIME_PROOF_SHA256;
}

function checkedCoverageEvidence(coverageFile, plan, nowMs) {
  const evidence = readPinnedJson(coverageFile, 'Served-release coverage evidence', undefined, 16 * 1024 * 1024);
  const keys = ['schemaVersion','purpose','environment','accountId','application','workerName','baselineVersionId',
    'observedAt','window','sourceReceipts','releases'];
  need(ownKeysAre(evidence, keys) && evidence.schemaVersion === 1 && evidence.purpose === COVERAGE_PURPOSE
    && evidence.environment === 'staging' && evidence.accountId === STAGING_ACCOUNT_ID
    && evidence.application === plan.application && evidence.workerName === plan.selectedWorker
    && evidence.baselineVersionId === plan.selectedActiveVersionId,
  'Served-release coverage evidence must pin this exact staging baseline');
  const observedAt = isoMs(evidence.observedAt), from = isoMs(evidence.window?.from), to = isoMs(evidence.window?.to);
  need(ownKeysAre(evidence.window, ['from','to']) && observedAt <= nowMs && nowMs - observedAt <= MAX_COVERAGE_AGE_MS
    && to === observedAt && from <= to - 48 * 60 * 60_000,
  'Served-release evidence must be fresh and cover at least the preceding 48 hours');
  need(Array.isArray(evidence.sourceReceipts) && evidence.sourceReceipts.length >= REQUIRED_COVERAGE_SOURCES.length + 1
    && evidence.sourceReceipts.length <= 64,
    'Served-release evidence must pin history, one or more asset-lineage sources, current materialization and byte closures');
  for (const receipt of evidence.sourceReceipts) verifySourceReceipt(receipt);
  const sourceKinds = evidence.sourceReceipts.map(row => row.kind);
  const uniqueKinds = new Set(sourceKinds);
  need(REQUIRED_COVERAGE_SOURCES.every(kind => uniqueKinds.has(kind))
    && sourceKinds.every(kind => [...REQUIRED_COVERAGE_SOURCES, 'asset-upload-lineage'].includes(kind))
    && sourceKinds.filter(kind => kind === 'asset-upload-lineage').length > 0
    && new Set(evidence.sourceReceipts.map(row => row.path)).size === evidence.sourceReceipts.length,
  'Required served-release evidence sources must be complete, pinned and nonduplicated');
  const materializationReceipt = evidence.sourceReceipts.find(row => row.kind === 'current-materialization');
  need(materializationReceipt.sha256 === plan.assetReconstitution.manifestSHA256,
    'Current materialization receipt must pin the exact held-plan asset manifest');
  need(Array.isArray(evidence.releases) && evidence.releases.length > 0 && evidence.releases.length <= 256,
    'Served-release evidence must include its bounded deployment history');
  const union = new Map(), seenDeployments = new Set(), seenVersions = new Set();
  const local = new Map(plan.assetReconstitution.files.map(row => [row.path, row]));
  let previousTo;
  let index = 0;
  while (index < evidence.releases.length) {
    const first = evidence.releases[index];
    need(ownKeysAre(first, ['deploymentId','from','to','percentage','versionId','assetLineageEvidenceSHA256','closureEvidenceSHA256','servedAssetClosure'])
      && UUID.test(first.deploymentId ?? ''), 'Coverage rows must pin exact deployment and version fields');
    const start = isoMs(first.from), end = isoMs(first.to), group = [];
    while (index < evidence.releases.length && evidence.releases[index].deploymentId === first.deploymentId) {
      const version = evidence.releases[index++];
      need(ownKeysAre(version, ['deploymentId','from','to','percentage','versionId','assetLineageEvidenceSHA256','closureEvidenceSHA256','servedAssetClosure'])
        && version.from === first.from && version.to === first.to
        && UUID.test(version.versionId ?? '') && Number.isFinite(version.percentage)
        && version.percentage > 0 && version.percentage <= 100
        && SHA.test(version.assetLineageEvidenceSHA256 ?? '') && SHA.test(version.closureEvidenceSHA256 ?? '')
        && Array.isArray(version.servedAssetClosure)
        && !group.some(prior => prior.versionId === version.versionId),
      'Deployment version weights or lineage pins are invalid; zero-weight rows must be omitted');
      group.push(version);
    }
    need(start < end && !seenDeployments.has(first.deploymentId)
      && (seenDeployments.size === 0 ? start === from : start === previousTo)
      && Math.abs(group.reduce((sum, version) => sum + version.percentage, 0) - 100) < 0.0001,
    'Covered deployment intervals must be ordered, gap-free, unique and total 100%');
    previousTo = end;
    seenDeployments.add(first.deploymentId);
    for (const version of group) {
      seenVersions.add(version.versionId);
      const assetLineages = evidence.sourceReceipts.filter(source => source.kind === 'asset-upload-lineage');
      const closures = evidence.sourceReceipts.filter(source => source.kind === 'served-path-byte-closures');
      need(assetLineages.some(source => version.assetLineageEvidenceSHA256 === source.sha256)
        && closures.some(source => version.closureEvidenceSHA256 === source.sha256),
        'Version asset lineage and byte closure must bind to the verified source receipts');
      need(Array.isArray(version.servedAssetClosure) && version.servedAssetClosure.length > 0
        && version.servedAssetClosure.length <= MAX_FILES, 'Every nonzero deployment version needs its served asset byte closure');
      const closure = version.servedAssetClosure.map(file => {
        need((ownKeysAre(file, ['path','size','sha256']) || ownKeysAre(file, ['path','size','sha256','retainedPath']))
          && Number.isSafeInteger(file.size) && file.size >= 0 && SHA.test(file.sha256 ?? '')
          && typeof file.path === 'string' && file.path.startsWith('/')
          && !/[\\%?#\u0000-\u001f\u007f]/u.test(file.path)
          && file.path.slice(1).split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..'),
        'Served asset closure entries require exact paths, sizes and SHA-256 bytes');
        const row = { path: file.path, size: file.size, sha256: file.sha256 };
        if (Object.hasOwn(file, 'retainedPath')) {
          const expectedPath = `/_ui/${plan.application}/${file.sha256.slice(0, 40)}/index.html`;
          need(file.path === '/index.html' && file.retainedPath === expectedPath,
            'Only a verified root index may use the exact hash-addressed retained root path');
          row.retainedPath = file.retainedPath;
        }
        return row;
      });
      need(new Set(closure.map(file => file.path)).size === closure.length
        && equal(closure, closure.slice().sort((a, b) => a.path.localeCompare(b.path))),
      'Served asset closures must have unique sorted source paths');
      for (const file of closure) {
        const targetPath = file.retainedPath ?? file.path;
        const targetFile = { path: targetPath, size: file.size, sha256: file.sha256 };
        const sourceFile = { path: file.path, size: file.size, sha256: file.sha256 };
        need((file.retainedPath ? file.path === '/index.html' : equal(local.get(file.path), sourceFile))
          && equal(local.get(targetPath), targetFile),
        'Materialized candidate bytes must prove each served path or its specifically reviewed root archive URL');
        const prior = union.get(targetPath);
        need(!prior || equal(prior, targetFile), 'A retained URL has conflicting historical byte content and cannot be preserved in one namespace');
        union.set(targetPath, targetFile);
      }
    }
  }
  need(previousTo === to && seenVersions.has(plan.selectedActiveVersionId),
    'Deployment history must end at its fresh observation and include the current baseline version');
  need(union.size > 0 && [...union.values()].every(file => equal(local.get(file.path), file)),
    'Materialized candidate bytes do not contain every path and exact byte hash from the served-release history');
  return { fileSHA256: coverageFile.sha256, observedAt: evidence.observedAt, window: clone(evidence.window),
    releaseCount: evidence.releases.length, requiredAssetCount: union.size, requiredAssets: [...union.values()] };
}

/** Pure offline validation of the typed retention evidence against a held plan.
 * It performs no provider reads or writes and returns no asset paths or bytes. */
export function validateStagingBackendAssetCoverageEvidence({ coverageEvidenceFile, heldPlan, now = () => Date.now() } = {}) {
  need(heldPlan?.schemaVersion === 3 && heldPlan.contract === 'staging-backend-only-v3'
    && heldPlan.held === true && heldPlan.executionAllowed === false
    && ['operations','client'].includes(heldPlan.application)
    && typeof now === 'function', 'A held v3 staging backend plan and clock are required');
  const checked = checkedCoverageEvidence(coverageEvidenceFile, heldPlan, now());
  return { evidenceSHA256: checked.fileSHA256, observedAt: checked.observedAt,
    window: checked.window, releaseCount: checked.releaseCount, requiredAssetCount: checked.requiredAssetCount };
}

function assetExtension(assetPath) { return path.posix.extname(assetPath).toLowerCase(); }

function verifyAssetFiles(plan, hashBlake3) {
  need(typeof hashBlake3 === 'function', 'A trusted pinned BLAKE3 implementation is required');
  const vector = hashBlake3(Buffer.from('QQ==txt', 'utf8'));
  need(typeof vector === 'string' && /^[a-f0-9]{64}$/u.test(vector)
    && vector === '42f8fed80a10e56fb584724a8ea0e156e928a529e86ab234a8d5b79057256bab',
  'BLAKE3 implementation failed the known v7-compatible startup vector');
  const root = plan.assetReconstitution.filesRoot;
  need(path.isAbsolute(root), 'Retained asset materialization path must be absolute'); outsideRepository(root);
  const verified = new Map(), uploads = new Map();
  let total = 0;
  for (const descriptor of plan.assetReconstitution.files) {
    const relative = descriptor.path.slice(1).replaceAll('/', path.sep);
    const filePath = path.join(root, relative), stat = fs.lstatSync(filePath);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === descriptor.size
      && stat.size <= MAX_FILE_BYTES, 'A staged asset is linked, oversized or changed');
    total += stat.size; need(total <= MAX_TOTAL_BYTES && verified.size < MAX_FILES, 'Staged assets exceed bounded limits');
    const descriptorFd = fs.openSync(filePath, 'r');
    let bytes;
    try {
      const before = fs.fstatSync(descriptorFd);
      need(before.isFile() && before.nlink === 1 && before.dev === stat.dev && before.ino === stat.ino
        && before.size === descriptor.size && before.size <= MAX_FILE_BYTES,
      'Staged asset changed while opening');
      bytes = fs.readFileSync(descriptorFd);
      const after = fs.fstatSync(descriptorFd), current = fs.lstatSync(filePath);
      need(bytes.length === descriptor.size && sha256(bytes) === descriptor.sha256 && after.size === before.size
        && after.mtimeMs === before.mtimeMs && after.dev === before.dev && after.ino === before.ino
        && current.dev === before.dev && current.ino === before.ino && current.nlink === 1,
      'Staged asset bytes no longer match the reviewed local materialization');
    } finally { fs.closeSync(descriptorFd); }
    const extension = assetExtension(descriptor.path), contentType = MIME_BY_EXTENSION[extension];
    need(contentType, 'Staged asset has an unsupported MIME extension; retain the release hold');
    const encoded = bytes.toString('base64'), hashInput = Buffer.from(`${encoded}${extension.replace(/^\./u, '')}`, 'utf8');
    const fullHash = hashBlake3(hashInput);
    need(typeof fullHash === 'string' && /^[a-f0-9]{64}$/u.test(fullHash), 'BLAKE3 asset manifest hash is malformed');
    const contentHash = fullHash.slice(0, 32);
    const old = uploads.get(contentHash);
    need(!old || (old.sha256 === descriptor.sha256 && old.size === descriptor.size && old.contentType === contentType),
      'Duplicate provider asset hash maps to conflicting local bytes');
    if (!old) uploads.set(contentHash, { hash: contentHash, path: descriptor.path, size: descriptor.size,
      sha256: descriptor.sha256, contentType, bytes });
    verified.set(descriptor.path, { path: descriptor.path, size: descriptor.size, sha256: descriptor.sha256,
      providerHash: contentHash, contentType, bytes });
  }
  const actualFiles = new Set([...verified.keys(), ...plan.assetReconstitution.localOnlyFiles.map(file => file.path)]);
  need(actualFiles.size === plan.assetReconstitution.files.length + plan.assetReconstitution.localOnlyFiles.length,
    'The local asset inventory contains duplicate paths');
  const manifest = Object.fromEntries([...verified.values()].map(file => [file.path,
    { hash: file.providerHash, size: file.size }]));
  return { manifest, uploads, files: verified };
}

/** Read-only byte validation for an already compiled held plan. This can
 * verify a prepared local manifest without constructing the SDK adapter. */
export function validateStagingBackendAssetMaterialization({ heldPlan, hashBlake3 } = {}) {
  need(heldPlan?.schemaVersion === 3 && heldPlan.contract === 'staging-backend-only-v3'
    && heldPlan.sourceCommit === SOURCE_COMMIT && heldPlan.held === true
    && heldPlan.executionAllowed === false && heldPlan.deploymentEnabled === false
    && heldPlan.assetsUploadRequired === true && heldPlan.assetJwtIncluded === false
    && heldPlan.accountId === STAGING_ACCOUNT_ID
    && ['operations','client'].includes(heldPlan.application),
  'Only a held, exact source-pinned v3 staging plan can be locally byte-validated');
  const verified = verifyAssetFiles(heldPlan, hashBlake3);
  const totalBytes = [...verified.files.values()].reduce((sum, file) => sum + file.size, 0);
  return { application: heldPlan.application, fileCount: verified.files.size, uniqueUploadCount: verified.uploads.size,
    duplicateContentPathCount: verified.files.size - verified.uploads.size, totalBytes };
}

function checkedJournal(journal) {
  need(journal && typeof journal.reserve === 'function' && typeof journal.complete === 'function',
    'A durable one-attempt journal adapter is required');
  return journal;
}

function safeVersionCreateTemplate(plan, completionJwt) {
  need(typeof completionJwt === 'string' && completionJwt.length >= 16 && completionJwt.length <= 8_192,
    'An in-memory asset completion JWT is required');
  const params = clone(plan.versionCreateTemplate);
  params.bindings = [...params.bindings, { name: 'ASSETS', type: 'assets' }].sort((a, b) => a.name.localeCompare(b.name));
  params.assets = { config: clone(plan.assetUploadRecipe.assetsConfig), jwt: completionJwt };
  params.deploy = false;
  params.bindings_inherit = 'strict';
  const nonAssetBindings = params.bindings.filter(row => row.name !== 'ASSETS');
  need(params.bindings.filter(row => row.name === 'ASSETS').length === 1
    && params.bindings.find(row => row.name === 'ASSETS')?.type === 'assets'
    && equal(nonAssetBindings, plan.versionCreateTemplate.bindings)
    && nonAssetBindings.filter(row => row.type === 'inherit').every(row => row.version_id === plan.selectedActiveVersionId)
    && params.deploy === false && params.assets.config && params.assets.jwt === completionJwt,
  'Final candidate must use exact uploaded assets and only the plan-pinned inheritance and service bindings');
  return params;
}

function checkReadback(readback, candidateVersionId, plan, candidateParams) {
  const keys = ['latestVersionId','deployment','candidate'];
  need(ownKeysAre(readback, keys) && Array.isArray(readback.deployment) && readback.deployment.length === 1
    && ownKeysAre(readback.deployment[0], ['versionId','percentage'])
    && readback.deployment[0].versionId === plan.selectedActiveVersionId && readback.deployment[0].percentage === 100
    && readback.latestVersionId === candidateVersionId,
  'Fresh candidate readback did not preserve the baseline 100% deployment and identify the candidate as latest');
  const candidate = readback.candidate;
  need(ownKeysAre(candidate, ['id','mainModule','modules','resolvedBindings','assetsConfig','compatibilityDate','compatibilityFlags','exports'])
    && candidate.id === candidateVersionId && candidate.mainModule === candidateParams.main_module
    && Array.isArray(candidate.modules) && candidate.modules.length === candidateParams.modules.length
    && Array.isArray(candidate.resolvedBindings),
  'Candidate readback does not match its source and pinned metadata');
  const expectedModules = candidateParams.modules.map((module, index) => {
    const pin = index === 0 ? plan.artifact.main : plan.artifact.sourceMap;
    return { name: module.name, bytes: pin.size, sha256: pin.sha256 };
  });
  const actualModules = candidate.modules.map(row => {
    need(ownKeysAre(row, ['name','bytes','sha256']) && Number.isSafeInteger(row.bytes) && SHA.test(row.sha256 ?? ''),
      'Candidate module readback requires exact name, size and hash fields');
    return row;
  });
  const expectedResolvedBindings = [
    ...plan.expectedUnchangedResources.bindings.filter(row => row.name !== 'ASSETS'),
    ...candidateParams.bindings.filter(row => row.type === 'service'),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const actualResolvedBindings = candidate.resolvedBindings;
  need(actualResolvedBindings.every(row => row && typeof row === 'object' && row.type !== 'inherit')
    && new Set(actualResolvedBindings.map(row => row?.name)).size === actualResolvedBindings.length
    && equal(actualModules, expectedModules)
    && equal(actualResolvedBindings, expectedResolvedBindings)
    && equal(candidate.assetsConfig, candidateParams.assets.config)
    && candidate.compatibilityDate === candidateParams.compatibility_date
    && equal(candidate.compatibilityFlags, candidateParams.compatibility_flags)
    && equal(candidate.exports, candidateParams.exports),
  'Candidate readback differs from its reviewed source, bindings, assets or runtime metadata');
  return true;
}

/** Validate the adapter's hash-only, resolved binding projection against the
 * pinned active capsule. `resolvedBindings` must contain installed value rows,
 * not the request's `{type:'inherit'}` instructions or raw secret values. */
export function validateStagingBackendAssetCandidateReadback({ readback, candidateVersionId, heldPlan, candidateParams } = {}) {
  need(heldPlan?.schemaVersion === 3 && heldPlan.contract === 'staging-backend-only-v3'
    && heldPlan.held === true && heldPlan.executionAllowed === false
    && UUID.test(candidateVersionId ?? '') && candidateParams && typeof candidateParams === 'object',
  'A held v3 plan, candidate ID and exact request are required for readback validation');
  return checkReadback(readback, candidateVersionId, heldPlan, candidateParams);
}

/** Create a single held staging candidate. All mutations are one-shot and
 * journaled before submission; a failed/uncertain step is never retried. */
export function createStagingBackendAssetCandidateUploader({ sdk, uploadBucket, readFreshControls,
  readCandidateState, journal, hashBlake3, now = () => Date.now() } = {}) {
  need(sdk && typeof sdk.createAssetUploadSession === 'function' && typeof sdk.createVersion === 'function'
    && typeof uploadBucket === 'function' && typeof readFreshControls === 'function'
    && typeof readCandidateState === 'function' && typeof now === 'function',
  'A fixed SDK adapter, bucket transport, readback readers and clock are required');
  const oneAttemptJournal = checkedJournal(journal);

  return async function createCandidate({ planOptions, heldPlan, runtimeProofFile, coverageEvidenceFile } = {}) {
    checkedHeldPlan(planOptions, heldPlan);
    verifyRuntimeProof(runtimeProofFile);
    let lastObservedAt = isoMs(heldPlan.controlsCapture.observedAt);
    let token;
    const planKey = `${heldPlan.application}/${heldPlan.selectedWorker}/${heldPlan.selectedActiveVersionId}/${SOURCE_COMMIT}`;

    async function recheckBaseline(step) {
      let controlFile;
      try { controlFile = await readFreshControls(heldPlan.application, heldPlan.selectedWorker); }
      catch { throw new Error(`Fresh staging controls unavailable before ${step}; candidate held`); }
      const fresh = compileStagingBackendReleasePlan({ ...planOptions, controlsFile: controlFile, now });
      const freshAt = isoMs(fresh.controlsCapture.observedAt);
      need(freshAt >= lastObservedAt && now() - freshAt <= 30 * 60_000,
        `Fresh staging controls moved backwards or became stale before ${step}`);
      const projection = plan => ({ application: plan.application, accountId: plan.accountId,
        selectedWorker: plan.selectedWorker, selectedActiveVersionId: plan.selectedActiveVersionId,
        selectedLatestVersionId: plan.selectedLatestVersionId, selectedControlPins: plan.selectedControlPins,
        observations: plan.observations, databaseSchemaSHA256: plan.databaseSchemaSHA256 });
      need(equal(projection(fresh), projection(heldPlan)),
        `Active/latest or worker controls drifted from the reviewed baseline before ${step}`);
      lastObservedAt = freshAt;
      checkedCoverageEvidence(coverageEvidenceFile, heldPlan, now());
      return fresh;
    }

    async function mutation(step, requestHash, action) {
      const key = `${planKey}/${step}`;
      let reserved = false;
      try { reserved = (await oneAttemptJournal.reserve(key, { step, workerName: heldPlan.selectedWorker,
        accountId: STAGING_ACCOUNT_ID, requestSHA256: requestHash })) === true; } catch {
        throw new Error(`One-attempt journal refused ${step}; no request submitted`);
      }
      need(reserved, `One-attempt journal already consumed ${step}; refusing replay`);
      let response;
      try { response = await action(); }
      catch {
        try { await oneAttemptJournal.complete(key, { outcome: 'uncertain', requestSHA256: requestHash }); } catch { /* remain held */ }
        throw new Error(`Staging ${step} outcome is uncertain; no retry is permitted`);
      }
      try { await oneAttemptJournal.complete(key, { outcome: 'response-received', requestSHA256: requestHash }); }
      catch { throw new Error(`Staging ${step} response could not be durably journaled; no retry is permitted`); }
      return response;
    }

    try {
      const files = verifyAssetFiles(heldPlan, hashBlake3);
      let current = await recheckBaseline('asset-upload-session');
      const sessionRequest = { account_id: STAGING_ACCOUNT_ID, manifest: files.manifest };
      const session = await mutation('asset-upload-session', sha256(Buffer.from(canonical(sessionRequest))),
        () => sdk.createAssetUploadSession(heldPlan.selectedWorker, sessionRequest, { maxRetries: 0 }));
      need(session && Array.isArray(session.buckets) && typeof session.jwt === 'string'
        && session.jwt.length >= 16 && session.jwt.length <= 8_192,
      'Asset upload session returned malformed buckets or JWT; candidate held');
      token = session.jwt;
      const seenHashes = new Set();
      for (const bucket of session.buckets) {
        need(Array.isArray(bucket) && bucket.length > 0 && bucket.length <= MAX_FILES,
          'Asset upload session contains an invalid bucket');
        for (const contentHash of bucket) {
          need(HASH32.test(contentHash ?? '') && files.uploads.has(contentHash) && !seenHashes.has(contentHash),
            'Asset upload session contains an unknown or duplicate asset hash');
          seenHashes.add(contentHash);
        }
      }
      let completionJwt;
      if (session.buckets.length === 0) {
        completionJwt = token;
      } else {
        for (let index = 0; index < session.buckets.length; index++) {
          current = await recheckBaseline(`asset-upload-bucket-${index}`);
          const rows = session.buckets[index].map(contentHash => {
            const row = files.uploads.get(contentHash);
            return { hash: row.hash, size: row.size, contentType: row.contentType, base64: row.bytes.toString('base64') };
          });
          const summary = rows.map(({ hash: contentHash, size, contentType }) => ({ hash: contentHash, size, contentType }));
          const bodyHash = sha256(Buffer.from(canonical(summary)));
          const response = await mutation(`asset-upload-bucket-${index}`, bodyHash, () => uploadBucket({
            endpoint: ASSET_UPLOAD_ENDPOINT, workerName: heldPlan.selectedWorker, accountId: STAGING_ACCOUNT_ID,
            uploadJwt: token, files: rows, maxRetries: 0, timeoutMs: 25_000,
          }));
          const final = index === session.buckets.length - 1;
          need(response && response.status === (final ? 201 : 200)
            && (final ? typeof response.completionJwt === 'string' && response.completionJwt.length >= 16
              && response.completionJwt.length <= 8_192 : response.completionJwt === undefined),
          'Asset upload bucket response did not meet the one-response status/JWT contract');
          if (final) completionJwt = response.completionJwt;
        }
        need(completionJwt, 'Asset bucket uploads ended without the final completion JWT');
        token = completionJwt;
      }

      current = await recheckBaseline('version-create');
      const versionRequest = safeVersionCreateTemplate(current, token);
      const nonSecretRequest = clone(versionRequest); delete nonSecretRequest.assets.jwt;
      const versionRequestHash = sha256(Buffer.from(canonical(nonSecretRequest)));
      const created = await mutation('version-create', versionRequestHash,
        () => sdk.createVersion(current.selectedWorker, versionRequest, { maxRetries: 0 }));
      const candidateVersionId = created?.id;
      need(UUID.test(candidateVersionId ?? ''), 'Version-create response lacked a candidate ID; no retry is permitted');
      token = undefined;
      let readback;
      try { readback = await readCandidateState(current.selectedWorker, candidateVersionId); }
      catch { return { candidateVersionId, readbackVerified: false }; }
      let readbackVerified = false;
      try { readbackVerified = validateStagingBackendAssetCandidateReadback({ readback, candidateVersionId,
        heldPlan: current, candidateParams: versionRequest }); } catch { /* return the candidate ID with a false readback status */ }
      return { candidateVersionId, readbackVerified };
    } finally {
      token = undefined;
    }
  };
}
