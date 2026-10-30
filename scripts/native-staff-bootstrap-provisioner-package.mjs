import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 } from './native-staff-bootstrap-provisioner-pin-value.mjs';

export const NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_MANIFEST =
  'scripts/native-staff-bootstrap-provisioner-package-manifest.json';
export const NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES = Object.freeze([
  'scripts/native-staff-bootstrap-provisioner.mjs',
  'scripts/native-staff-bootstrap-provisioner-core.mjs',
  'scripts/native-staff-bootstrap-provisioner-package.mjs',
  'scripts/native-staff-bootstrap-provisioner-windows-adapter.mjs',
  'scripts/native-staff-bootstrap-provisioner-windows.ps1',
  'scripts/native-staff-bootstrap-owner-approval.mjs',
  'scripts/native-staff-bootstrap-sign-dpapi.ps1',
  'scripts/native-staff-bootstrap-d1.mjs',
  'scripts/native-staff-bootstrap-owner-approval-distribution-pin.mjs',
  'scripts/native-staff-bootstrap-owner-approval-distribution-pin-value.mjs',
]);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fail = code => { throw new Error(`native_staff_bootstrap_provisioner_package_${code}`); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exactObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));

export function assertPinnedNativeStaffBootstrapProvisionerPackage({ root = ROOT,
  expectedSha256 = PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256,
  read = readFileSync, stat = lstatSync } = {}) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 ?? '') || expectedSha256 === '0'.repeat(64))
    fail('pin_not_provisioned');
  const manifestPath = path.join(root, NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_MANIFEST);
  let manifestBytes, manifest;
  try {
    const info = stat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024) fail('manifest_invalid');
    manifestBytes = read(manifestPath);
    if (sha(manifestBytes) !== expectedSha256) fail('manifest_pin_mismatch');
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_staff_bootstrap_provisioner_package_')) throw error;
    fail('manifest_invalid');
  }
  if (!exactObject(manifest, ['schemaVersion', 'kind', 'files']) || manifest.schemaVersion !== 1
    || manifest.kind !== 'operations-native-staff-bootstrap-provisioner-package-v1'
    || !Array.isArray(manifest.files) || manifest.files.length !== NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES.length)
    fail('manifest_invalid');
  const expected = [...NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES].sort();
  if (manifest.files.some((entry, index) => !exactObject(entry, ['path', 'sha256'])
    || entry.path !== expected[index] || !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? ''))) fail('manifest_invalid');
  for (const entry of manifest.files) {
    const target = path.resolve(root, entry.path), relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('path_invalid');
    try {
      const info = stat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024 * 1024
        || sha(read(target)) !== entry.sha256) fail('file_mismatch');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('native_staff_bootstrap_provisioner_package_')) throw error;
      fail('file_unavailable');
    }
  }
  return true;
}
