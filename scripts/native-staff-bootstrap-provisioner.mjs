import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeStaffBootstrapProvisioner } from './native-staff-bootstrap-provisioner-core.mjs';
import { PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 } from './native-staff-bootstrap-provisioner-pin-value.mjs';

const fail = code => { throw new Error(`native_staff_bootstrap_provisioner_${code}`); };

function main(argv) {
  // This gate precedes argv handling, candidate access, filesystem adapters,
  // source checks, and protected signing.
  if (PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 === '0'.repeat(64))
    fail('package_pin_not_provisioned');
  const result = runNativeStaffBootstrapProvisioner(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof Error && /^native_staff_bootstrap_provisioner_[a-z0-9_]+$/u.test(error.message)
      ? error.message : 'native_staff_bootstrap_provisioner_unavailable';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
