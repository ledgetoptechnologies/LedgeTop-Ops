import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256 } from './native-staff-bootstrap-owner-approval-distribution-pin-value.mjs';

// The separate pin-value module is intentionally excluded from the manifest it verifies.
export { PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256 };
export const OWNER_APPROVAL_DISTRIBUTION_MANIFEST = 'scripts/native-staff-bootstrap-owner-approval-distribution-manifest.json';
const EXPECTED_RUNTIME_FILES = Object.freeze([
  'scripts/native-staff-bootstrap-owner-approval.mjs',
  'scripts/native-staff-bootstrap-sign-dpapi.ps1',
  'scripts/native-staff-bootstrap-approved-executor.mjs',
  'scripts/native-staff-bootstrap-approved-executor-config.mjs',
  'scripts/native-staff-bootstrap-d1.mjs',
  'scripts/native-staff-bootstrap-owner-approval-distribution-pin.mjs',
  'apps/operations/node_modules/wrangler/wrangler-dist/cli.js',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`native_staff_bootstrap_owner_${code}`); };

export function assertPinnedIssuerDistribution({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  expectedSha256 = PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256, read = readFileSync, stat = lstatSync,
  manifestPath = path.join(root, OWNER_APPROVAL_DISTRIBUTION_MANIFEST) } = {}) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? '') || expectedSha256 === '0'.repeat(64))
    fail('issuer_distribution_pin_not_provisioned');
  let manifestBytes, info;
  try { info = stat(manifestPath); manifestBytes = read(manifestPath); } catch { fail('issuer_distribution_unavailable'); }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || sha256(manifestBytes) !== expectedSha256)
    fail('issuer_distribution_pin_mismatch');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('issuer_distribution_manifest_invalid'); }
  if (!manifest || Object.keys(manifest).sort().join('\0') !== ['files', 'kind', 'schemaVersion'].sort().join('\0')
    || manifest.schemaVersion !== 1 || manifest.kind !== 'operations-native-staff-bootstrap-issuer-distribution-v1'
    || !Array.isArray(manifest.files))
    fail('issuer_distribution_manifest_invalid');
  const hashes = new Map();
  for (const file of manifest.files) {
    if (!file || Object.keys(file).sort().join('\0') !== ['path', 'sha256'].sort().join('\0')
      || typeof file.path !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256) || hashes.has(file.path))
      fail('issuer_distribution_manifest_invalid');
    hashes.set(file.path, file.sha256);
  }
  let migrationNames;
  try { migrationNames = readdirSync(path.join(root, 'apps', 'operations', 'migrations')).filter(name => name.endsWith('.sql')
    && /^\d{4}_/u.test(name) && Number(name.slice(0, 4)) <= 225).sort(); }
  catch { fail('issuer_distribution_unavailable'); }
  if (migrationNames.length !== 225 || migrationNames.at(-1) !== '0225_native_staff_lifecycle_bridge.sql')
    fail('issuer_distribution_manifest_invalid');
  const expectedFiles = [...EXPECTED_RUNTIME_FILES, ...migrationNames.map(name => `apps/operations/migrations/${name}`)];
  if (expectedFiles.some(file => !hashes.has(file)) || hashes.size !== expectedFiles.length)
    fail('issuer_distribution_manifest_invalid');
  for (const relative of expectedFiles) {
    const target = path.resolve(root, relative);
    if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target)))
      fail('issuer_distribution_manifest_invalid');
    let targetInfo, bytes;
    try { targetInfo = stat(target); bytes = read(target); } catch { fail('issuer_distribution_unavailable'); }
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || sha256(bytes) !== hashes.get(relative))
      fail('issuer_distribution_file_mismatch');
  }
  return true;
}
