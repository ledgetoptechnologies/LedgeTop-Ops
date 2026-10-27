import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_NATIVE_STAFF_CUTOVER_DISTRIBUTION_SHA256 } from './native-staff-cutover-distribution-pin-value.mjs';

const fail = code => { throw new Error(`native_staff_cutover_distribution_${code}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Closed runtime inventory. Migrations and cutover source are additionally
// byte-compared with the separately pinned source commit by the config check.
export const NATIVE_STAFF_CUTOVER_DISTRIBUTION_FILES = Object.freeze([
  'scripts/native-staff-cutover-approved-executor.mjs',
  'scripts/native-staff-cutover-approved-executor-config.mjs',
  'scripts/native-staff-cutover-owner-approval-cli.mjs',
  'scripts/native-staff-cutover-owner-approval.mjs',
  'scripts/native-staff-cutover-distribution-pin.mjs',
  'scripts/native-staff-cutover-v1.mjs',
  'scripts/native-staff-sync-preparation.mjs',
  'scripts/native-staff-bootstrap-owner-approval.mjs',
  'scripts/native-staff-bootstrap-approved-executor.mjs',
  'scripts/native-staff-bootstrap-approved-executor-config.mjs',
  'scripts/native-staff-bootstrap-d1.mjs',
  'scripts/native-staff-bootstrap-owner-approval-distribution-pin.mjs',
  'scripts/native-staff-bootstrap-owner-approval-distribution-pin-value.mjs',
  'scripts/native-staff-bootstrap-owner-approval-distribution-manifest.json',
  'apps/operations/node_modules/wrangler/wrangler-dist/cli.js',
]);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}

export function assertPinnedNativeStaffCutoverDistribution({ read = readFileSync, stat = lstatSync, root = ROOT } = {}) {
  const pin = PINNED_NATIVE_STAFF_CUTOVER_DISTRIBUTION_SHA256;
  if (!/^[0-9a-f]{64}$/u.test(pin) || pin === '0'.repeat(64)) fail('pin_unprovisioned');
  const manifestPath = path.join(root, 'scripts', 'native-staff-cutover-distribution-manifest.json');
  let bytes, manifest;
  try {
    const info = stat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024) fail('manifest_invalid');
    bytes = read(manifestPath);
    if (sha(bytes) !== pin) fail('manifest_pin_mismatch');
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_staff_cutover_distribution_')) throw error;
    fail('manifest_invalid');
  }
  if (!exact(manifest, ['schemaVersion','kind','files']) || manifest.schemaVersion !== 1
    || manifest.kind !== 'operations-native-staff-cutover-runtime-manifest-v1' || !Array.isArray(manifest.files)
    || manifest.files.length !== NATIVE_STAFF_CUTOVER_DISTRIBUTION_FILES.length) fail('manifest_invalid');
  const expected = [...NATIVE_STAFF_CUTOVER_DISTRIBUTION_FILES].sort();
  const files = manifest.files;
  if (files.some((entry, index) => !exact(entry, ['path','sha256']) || entry.path !== expected[index]
    || !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? ''))) fail('manifest_invalid');
  for (const entry of files) {
    const target = path.resolve(root, entry.path);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) fail('manifest_path_invalid');
    const maxBytes = entry.path === 'apps/operations/node_modules/wrangler/wrangler-dist/cli.js'
      ? 20 * 1024 * 1024 : 16 * 1024 * 1024;
    try {
      const info = stat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes
        || sha(read(target)) !== entry.sha256) fail('runtime_file_pin_mismatch');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('native_staff_cutover_distribution_')) throw error;
      fail('runtime_file_unavailable');
    }
  }
  return true;
}
