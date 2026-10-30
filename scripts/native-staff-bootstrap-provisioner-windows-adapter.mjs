import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fail = code => { throw new Error(`native_staff_bootstrap_provisioner_${code}`); };

function powershellRequest(operation, request, { spawn = spawnSync, env = process.env } = {}) {
  if (process.platform !== 'win32') fail('windows_required');
  const script = fileURLToPath(new URL('./native-staff-bootstrap-provisioner-windows.ps1', import.meta.url));
  const childEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PSHOME', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'TEMP', 'TMP'].filter(key => typeof env[key] === 'string' && env[key].length > 0)
    .map(key => [key, env[key]]));
  const result = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    input: JSON.stringify({ operation, ...request }), encoding: 'utf8', windowsHide: true,
    timeout: 30_000, maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    const code = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    if (/^native_staff_bootstrap_provisioner_[a-z0-9_]+$/u.test(code)) fail(code.slice('native_staff_bootstrap_provisioner_'.length));
    fail('windows_helper_failed');
  }
  try { return JSON.parse(result.stdout); } catch { fail('windows_helper_failed'); }
}

export function createNativeStaffBootstrapProvisionerWindowsAdapter(options = {}) {
  const call = (operation, request = {}) => powershellRequest(operation, request, options);
  return Object.freeze({
    preflight: paths => call('preflight', { paths }),
    begin: intent => call('begin', { intent }),
    installConfigNoReplace: (destination, bytes, configSha256) => call('install-config', {
      destination, configBase64: bytes.toString('base64'), configSha256,
    }),
    createReceiptDirectory: receiptDirectory => call('create-receipt-directory', { receiptDirectory }),
    advanceJournal: phase => call('advance-journal', { phase }),
    publishInitialRegistryNoReplace: (temporary, destination) => call('publish-initial-registry', { temporary, destination }),
    verifyPublishedRegistry: destination => call('verify-registry', { destination }),
    finish: result => call('finish', { result }),
    failClosed: () => undefined,
    reconcileReadOnly: ({ localAppData, receiptDirectory }) => call('reconcile-read-only', { localAppData, receiptDirectory }),
  });
}
