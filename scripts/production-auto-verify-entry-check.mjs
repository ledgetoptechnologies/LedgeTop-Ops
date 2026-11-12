// Read-only, offline check: which temporary-verifier precondition would refuse a ledger's old-asset entries?
//   node scripts/production-auto-verify-entry-check.mjs <ledger.json> <ledgetop-clients|ledgetop-ops> [activeVersionId]
// <ledger.json> is the active version's __ops_release_ledger.json module, read by the operator (read-only). No
// network, provider, journal or GitHub access. Output is one JSON line of FIXED rule labels and counts only (no
// paths, hashes or bytes), safe for a public log. It mirrors production-auto-verify.mjs exactly and then runs the
// real createAssetVerifierSource on the same entries, so the result names the rule the release hit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_VERIFICATION_LIMITS, createAssetVerifierSource } from './production-auto-verify.mjs';

const ORIGINS = { 'ledgetop-ops': 'https://ops.ledgetop.app', 'ledgetop-clients': 'https://portal.ledgetop.app' };
const PATH = /^\/(?:assets\/[A-Za-z0-9_./-]+|_ui\/(?:operations|client)\/[a-f0-9]{40}\/(?:assets\/[A-Za-z0-9_./-]+|index\.html|release\.json)|_ui\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.(?:html|js|mjs|css|json|webmanifest|ico|png|svg|webp|txt))$/u;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** Fixed-label counts for each verifier rule over the given entries (no entry data is returned). */
export function verifierEntryFindings(entries, { workerName, versionId }) {
  const app = workerName === 'ledgetop-ops' ? 'operations' : 'client';
  const counts = { entries: entries.length, totalBytes: 0, maxFileBytes: 0, pathRefused: 0, pathTraversal: 0, duplicatePath: 0,
    sizeRefused: 0, hashRefused: 0, mimeRefused: 0, archiveIndexRefused: 0, releaseProofRefused: 0, otherAppUi: 0 };
  const seen = new Set();
  for (const e of entries) {
    counts.totalBytes += Number(e.size) || 0;
    counts.maxFileBytes = Math.max(counts.maxFileBytes, Number(e.size) || 0);
    if (typeof e.path !== 'string' || e.path.length > 1024 || !PATH.test(e.path)) counts.pathRefused++;
    else if (e.path.includes('..') || e.path.includes('//') || e.path.split('/').includes('.')) counts.pathTraversal++;
    if (seen.has(e.path)) counts.duplicatePath++; seen.add(e.path);
    if (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > ASSET_VERIFICATION_LIMITS.fileBytes) counts.sizeRefused++;
    if (!/^[a-f0-9]{64}$/u.test(e.sha256 ?? '')) counts.hashRefused++;
    if (typeof e.contentType !== 'string' || !MIME.test(e.contentType)) counts.mimeRefused++;
    const archive = /^\/_ui\/(operations|client)\/([a-f0-9]{40})\/index\.html$/u.exec(e.path ?? '');
    if (archive && (archive[1] !== app || archive[2] !== String(e.sha256).slice(0, 40) || e.contentType !== 'text/html')) counts.archiveIndexRefused++;
    const proof = /^\/_ui\/(operations|client)\/[a-f0-9]{40}\/release\.json$/u.exec(e.path ?? '');
    if (proof && (proof[1] !== app || e.contentType !== 'application/json')) counts.releaseProofRefused++;
    const ui = /^\/_ui\/(operations|client)\//u.exec(e.path ?? '');
    if (ui && ui[1] !== app) counts.otherAppUi++;
  }
  const rules = [];
  if (counts.entries === 0) rules.push('no_entries');
  if (counts.entries > ASSET_VERIFICATION_LIMITS.files) rules.push('file_count_over_limit');
  if (counts.totalBytes > ASSET_VERIFICATION_LIMITS.totalBytes) rules.push('total_bytes_over_limit');
  for (const key of ['pathRefused', 'pathTraversal', 'duplicatePath', 'sizeRefused', 'hashRefused', 'mimeRefused', 'archiveIndexRefused', 'releaseProofRefused'])
    if (counts[key]) rules.push(key);
  if (versionId !== undefined && !UUID.test(versionId)) rules.push('version_id_refused');
  let realSource = 'not_run';
  try {
    createAssetVerifierSource({ workerName, origin: ORIGINS[workerName], entries, nonceHash: 'a'.repeat(64),
      versionId: versionId ?? '00000000-0000-4000-8000-000000000000' });
    realSource = 'accepted';
  } catch (error) { realSource = error?.message === 'static_asset_verification_refused' ? 'refused' : 'error'; }
  return { limits: ASSET_VERIFICATION_LIMITS, counts, rules, realCreateAssetVerifierSource: realSource };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, workerName, versionId] = process.argv.slice(2);
  if (!file || !ORIGINS[workerName]) { console.error('usage: production-auto-verify-entry-check.mjs <ledger.json> <ledgetop-clients|ledgetop-ops> [activeVersionId]'); process.exit(2); }
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = (ledger.assets ?? []).map(row => ({ path: row.path, size: row.size, sha256: row.sha256, contentType: row.mime }));
  console.log(JSON.stringify(verifierEntryFindings(entries, { workerName, versionId })));
}
