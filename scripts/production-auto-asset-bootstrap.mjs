/**
 * One-time bridge for an active static-asset association whose passive release
 * ledger predates some still-served assets. A pin is admitted only when an
 * accepted active-release receipt and its exact packet manifest are source
 * controlled alongside this code. Missing rows receive a new upload hash only
 * after the current active version's bytes have been independently verified.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateAssetLedger } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const need = (ok, code) => { if (!ok) throw Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const KNOWN_MANUAL_STATIC_VERSIONS = Object.freeze({
  '0b1ab5a8-9db0-42ab-b718-8569fae2382e': 'ledgetop-ops',
  '1c606164-9a98-495a-87c9-3be251658d00': 'ledgetop-clients',
});
const DATA = Object.freeze({
  'ledgetop-ops': Object.freeze({
    activeVersionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e',
    packetManifestSHA256: 'fec34761336801fe672132c07b9d219f0325185de245a28e2713b1b7ebd9e0ae',
    acceptedReceiptSHA256: '31e730a6577fe9f6ababf2f42a16fd1fe34ddfe912ea60afeb39f27a32001dfb',
    terminalReceiptSHA256: 'eb668d58c8ffab56910b776397aa25d1f4fcd40d3fdf909c498f8cf835fa69e1',
    packetManifestFile: './data/production-auto-asset-bootstrap/operations-packet-manifest.json',
    acceptedReceiptFile: './data/production-auto-asset-bootstrap/operations-accepted-receipt.json',
    terminalReceiptFile: './data/production-auto-asset-bootstrap/operations-terminal-receipt.json',
  }),
  'ledgetop-clients': Object.freeze({
    activeVersionId: '1c606164-9a98-495a-87c9-3be251658d00',
    packetManifestSHA256: 'fa42dede3e1befc359f59907603942b0b60e96f04e42c71daf63ed707ca9cb05',
    acceptedReceiptSHA256: '300b43e3f152d299e75f351278f75bc122651bf1172c5634135538a9c2d2b0ca',
    packetManifestFile: './data/production-auto-asset-bootstrap/client-packet-manifest.json',
    acceptedReceiptFile: './data/production-auto-asset-bootstrap/client-accepted-receipt.json',
  }),
});

export function readPinnedAssetInventoryBootstrap({ workerName, activeVersionId } = {}) {
  const knownWorker = KNOWN_MANUAL_STATIC_VERSIONS[activeVersionId];
  if (!knownWorker) return null;
  need(workerName === knownWorker, 'asset_bootstrap_known_version_worker_mismatch');
  const data = DATA[workerName];
  need(data && data.activeVersionId === activeVersionId, 'asset_bootstrap_successful_receipt_required');
  const read = name => fs.readFileSync(fileURLToPath(new URL(name, import.meta.url)));
  return { pin: { schemaVersion: 1, workerName, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    activeVersionId, packetManifestSHA256: data.packetManifestSHA256,
    acceptedReceiptSHA256: data.acceptedReceiptSHA256,
    ...(data.terminalReceiptSHA256 ? { terminalReceiptSHA256: data.terminalReceiptSHA256 } : {}) },
  packetManifestBytes: read(data.packetManifestFile), acceptedReceiptBytes: read(data.acceptedReceiptFile),
  ...(data.terminalReceiptFile ? { terminalReceiptBytes: read(data.terminalReceiptFile) } : {}) };
}

function manifestAndReceipt({ pin, packetManifestBytes, acceptedReceiptBytes, terminalReceiptBytes }, activeVersionId, workerName, accountId) {
  need(pin && Object.getPrototypeOf(pin) === Object.prototype
    && pin.schemaVersion === 1 && pin.workerName === workerName && pin.accountId === accountId
    && UUID.test(pin.activeVersionId ?? '') && pin.activeVersionId === activeVersionId
    && SHA.test(pin.packetManifestSHA256 ?? '') && SHA.test(pin.acceptedReceiptSHA256 ?? '')
    && Buffer.isBuffer(packetManifestBytes) && digest(packetManifestBytes) === pin.packetManifestSHA256
    && Buffer.isBuffer(acceptedReceiptBytes) && digest(acceptedReceiptBytes) === pin.acceptedReceiptSHA256
    && (pin.terminalReceiptSHA256 === undefined
      ? terminalReceiptBytes === undefined
      : SHA.test(pin.terminalReceiptSHA256) && Buffer.isBuffer(terminalReceiptBytes)
        && digest(terminalReceiptBytes) === pin.terminalReceiptSHA256),
  'asset_bootstrap_pin_mismatch');
  let manifest, receipt, terminalReceipt;
  try {
    manifest = JSON.parse(packetManifestBytes.toString('utf8'));
    receipt = JSON.parse(acceptedReceiptBytes.toString('utf8'));
    if (terminalReceiptBytes) terminalReceipt = JSON.parse(terminalReceiptBytes.toString('utf8'));
  } catch { need(false, 'asset_bootstrap_evidence_invalid'); }
  const application = workerName === 'ledgetop-ops' ? 'operations' : 'client';
  const unionBytes = Array.isArray(manifest?.union?.files)
    ? manifest.union.files.reduce((sum, row) => sum + (Number.isSafeInteger(row?.size) ? row.size : 0), 0) : -1;
  const cutover = Date.parse(receipt?.cutoverAt ?? ''), pruningFloor = Date.parse(receipt?.earliestPermittedPruningAt ?? '');
  need(manifest?.schemaVersion === 1 && manifest?.purpose === 'offline retained frontend asset packet; not a deployment or active-namespace proof'
    && manifest.application === application && COMMIT.test(manifest.sourceCommit ?? '')
    && manifest.union && Array.isArray(manifest.union.files)
    && manifest.union.fileCount === manifest.union.files.length && manifest.union.totalBytes === unionBytes
    && manifest.replacement?.onlyPath === '/index.html' && manifest.replacement?.oldIndexExcludedFromUpload === true
    && receipt?.schemaVersion === 1 && receipt.status === 'accepted-after-separate-active-verification'
    && receipt.worker === workerName && receipt.sourceCommit === manifest.sourceCommit
    && receipt.candidateVersionId === activeVersionId && receipt.packetManifestSHA256 === pin.packetManifestSHA256
    && receipt.minimumRetentionHours >= 48 && receipt.automaticPruning === false
    && Number.isSafeInteger(receipt.files) && receipt.files === manifest.union.files.length
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes === unionBytes
    && Number.isFinite(cutover) && Number.isFinite(pruningFloor) && pruningFloor >= cutover + 48 * 60 * 60 * 1000
    && receipt.postActivationProof?.allBodySizeShaMimeChecksPassed === true
    && receipt.postActivationProof?.temporaryHelperRemoved === true
    && receipt.postActivationProof?.cleanup?.removed === true
    && receipt.postActivationProof?.cleanup?.absenceVerified === true
    && (workerName !== 'ledgetop-ops' || receipt.terminalReceiptSHA256 === pin.terminalReceiptSHA256
      && terminalReceipt?.status === 'existing-staged-candidate-recovered-and-verified'
      && terminalReceipt.candidateVersionId === activeVersionId
      && terminalReceipt.candidateActiveProof?.fileCount === receipt.files
      && terminalReceipt.candidateActiveProof?.totalBytes === receipt.bytes
      && terminalReceipt.candidateActiveProof?.packetManifestSHA256 === pin.packetManifestSHA256
      && terminalReceipt.candidateActiveProof?.byteMimeHashVerified === true
      && terminalReceipt.candidateActiveProof?.temporaryHelperRemoved === true
      && terminalReceipt.candidateActiveProof?.temporaryHelperAbsenceVerified === true
      && terminalReceipt.activationPosts === 1 && terminalReceipt.automaticPruning === false),
  'asset_bootstrap_receipt_unqualified');
  return { manifest, receipt };
}

function packetRows(manifest) {
  const files = manifest.union.files;
  need(files.length > 0 && files.length <= 20_000, 'asset_bootstrap_manifest_invalid');
  const seen = new Set(), rows = [];
  for (const file of files) {
    need(file && typeof file.path === 'string' && Number.isSafeInteger(file.size) && file.size >= 0
      && SHA.test(file.sha256 ?? '') && typeof file.mime === 'string'
      && ['retained-prior-active', 'retained-and-current-build-identical', 'new-candidate-asset', 'new-candidate-index'].includes(file.provenance)
      && !seen.has(file.path.toLowerCase()), 'asset_bootstrap_manifest_invalid');
    seen.add(file.path.toLowerCase());
    rows.push({ path: file.path, size: file.size, sha256: file.sha256, mime: file.mime, provenance: file.provenance });
  }
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  need(rows.some(row => row.path === '/index.html'), 'asset_bootstrap_manifest_invalid');
  return rows;
}

/** Validate the static evidence and calculate which paths need current-byte proof. */
export function prepareAssetInventoryBootstrap({ bootstrap, previous, activeVersionId, workerName, accountId }) {
  need(bootstrap && Object.getPrototypeOf(bootstrap) === Object.prototype, 'asset_bootstrap_missing');
  const { manifest } = manifestAndReceipt(bootstrap, activeVersionId, workerName, accountId);
  const ledger = validateAssetLedger(previous, { workerName, accountId });
  const rows = packetRows(manifest), known = new Map(ledger.assets.map(row => [row.path, row]));
  const packet = new Map(rows.map(row => [row.path, row]));
  for (const row of ledger.assets) {
    const match = packet.get(row.path);
    const sameBytes = match && match.size === row.size && match.sha256 === row.sha256 && match.mime === row.mime;
    // The current active index is deliberately replaceable and is excluded
    // from retained packet history. A stale ledger's index hash is not the
    // current active index's provider identity.
    need(sameBytes || row.path === '/index.html', 'asset_bootstrap_conflicts_with_ledger');
  }
  return { rows, missing: rows.filter(row => {
    const existing = known.get(row.path);
    return !existing || existing.size !== row.size || existing.sha256 !== row.sha256 || existing.mime !== row.mime;
  }) };
}

/** Build the verifier request, replacing a stale passive /index.html row with its packet row. */
export function assetBootstrapVerificationEntries(previous, prepared) {
  const rows = new Map(previous.assets.map(row => [row.path, row]));
  for (const row of prepared.missing) rows.set(row.path, row);
  return [...rows.values()].map(row => ({ path: row.path, size: row.size, sha256: row.sha256, contentType: row.mime }));
}

/** Add only byte-proven packet rows; known opaque provider hashes remain verbatim. */
export function completeAssetInventoryBootstrap({ bootstrap, previous, verifiedAssets, activeVersionId, workerName, accountId }) {
  const { rows } = prepareAssetInventoryBootstrap({ bootstrap, previous, activeVersionId, workerName, accountId });
  need(verifiedAssets instanceof Map, 'asset_bootstrap_bytes_missing');
  const prior = validateAssetLedger(previous, { workerName, accountId });
  const known = new Map(prior.assets.map(row => [row.path, row]));
  need(verifiedAssets.size === rows.length && rows.every(row => {
    const bytes = verifiedAssets.get(row.path);
    return Buffer.isBuffer(bytes) && bytes.length === row.size && digest(bytes) === row.sha256;
  }), 'asset_bootstrap_active_bytes_mismatch');
  const assets = rows.map(row => {
    const existing = known.get(row.path);
    if (existing && existing.size === row.size && existing.sha256 === row.sha256 && existing.mime === row.mime) return existing;
    const bytes = verifiedAssets.get(row.path);
    // This is a fresh upload identifier for a byte-verified row, not a claim
    // about the provider hash used by the currently active association.
    return { path: row.path, size: row.size, sha256: row.sha256, mime: row.mime, providerHash: digest(bytes).slice(0, 32) };
  });
  return validateAssetLedger({ ...prior, assets }, { workerName, accountId });
}
