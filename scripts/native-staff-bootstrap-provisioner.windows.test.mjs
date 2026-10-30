import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signBytes, constants as cryptoConstants, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES } from './native-staff-bootstrap-provisioner-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const failCode = code => new RegExp(`native_staff_bootstrap_provisioner_${code}`, 'u');
const quotePowerShellLiteral = value => value.replaceAll("'", "''");

function safeRemoveOwnedTestDirectory(tempRoot, target) {
  const resolvedRoot = path.resolve(tempRoot);
  const resolvedTarget = path.resolve(target);
  const resolvedTempBase = path.resolve(os.tmpdir());
  const rootNamePattern = /^native-staff-bootstrap-provisioner-windows-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (path.dirname(resolvedRoot) !== resolvedTempBase || !rootNamePattern.test(path.basename(resolvedRoot))) {
    throw new Error('native_staff_bootstrap_provisioner_test_cleanup_root_invalid');
  }
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (resolvedTarget !== resolvedRoot && (!relativeTarget || relativeTarget === '..'
      || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget))) {
    throw new Error('native_staff_bootstrap_provisioner_test_cleanup_target_invalid');
  }
  for (const directory of [resolvedRoot, resolvedTarget]) {
    if (!existsSync(directory)) continue;
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('native_staff_bootstrap_provisioner_test_cleanup_reparse_refused');
    }
    const check = `$item=Get-Item -LiteralPath '${quotePowerShellLiteral(directory)}' -Force; ` +
      'if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }';
    const child = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', check], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
    });
    if (child.error || child.status !== 0) {
      throw new Error('native_staff_bootstrap_provisioner_test_cleanup_reparse_refused');
    }
  }
  if (existsSync(resolvedTarget)) rmSync(resolvedTarget, { recursive: true, force: false });
}

test('Windows provisioner uses candidate key ACL, publishes one synthetic signed registry, and refuses replay',
  { skip: process.platform !== 'win32' }, async () => {
    const tempRoot = path.join(os.tmpdir(), `native-staff-bootstrap-provisioner-windows-${randomUUID()}`);
    const packageRoot = path.join(tempRoot, 'reviewed-package');
    const scriptsRoot = path.join(packageRoot, 'scripts');
    const localAppData = path.join(tempRoot, 'LocalAppData');
    const keyDirectory = path.join(localAppData, 'synthetic-candidate');
    const receiptDirectory = path.join(localAppData, `native-staff-bootstrap-receipts-${randomUUID()}`);
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
    const config = {
      schemaVersion: 1, kind: 'operations-native-staff-bootstrap-trust-config-v1',
      target: { accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111' },
      source: { commit: 'b'.repeat(40), migrationNamesSha256: 'c'.repeat(64) },
      access: { origin: 'https://ops.example.test', issuer: 'https://synthetic.cloudflareaccess.com',
        audience: 'syntheticAudience01', owner: { staffId: 'synthetic-owner', accessSubject: 'synthetic-subject' },
        cloudflaredExecutablePath: 'C:\\synthetic\\cloudflared.exe', cloudflaredExecutableSha256: 'd'.repeat(64) },
      signer: { algorithm: 'RSA-PSS-SHA256', keyId: hash(publicDer),
        publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
        protectedPrivateKeyPath: path.join(keyDirectory, 'signer-key.dpapi'),
        dpapiEntropy: 'synthetic-only-entropy-for-provisioner-tests-32-bytes' },
      receiptDirectory,
    };
    const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
    const configSha256 = hash(configBytes);
    const packageFiles = [...NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES].sort();
    const realPackagePinFile = path.join(ROOT, 'scripts', 'native-staff-bootstrap-provisioner-pin-value.mjs');

    try {
      mkdirSync(scriptsRoot, { recursive: true });
      mkdirSync(localAppData, { recursive: true });
      for (const relative of packageFiles) {
        const destination = path.join(packageRoot, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(ROOT, relative), destination);
      }
      const ownerApprovalPath = path.join(packageRoot, 'scripts/native-staff-bootstrap-owner-approval.mjs');
      const ownerApproval = readFileSync(ownerApprovalPath, 'utf8').replace(
        "PINNED_TRUST_CONFIG_SHA256 = '0'.repeat(64)",
        `PINNED_TRUST_CONFIG_SHA256 = '${configSha256}'`);
      assert.notEqual(ownerApproval, readFileSync(ownerApprovalPath, 'utf8'));
      writeFileSync(ownerApprovalPath, ownerApproval);

      const manifest = { schemaVersion: 1, kind: 'operations-native-staff-bootstrap-provisioner-package-v1',
        files: packageFiles.map(relative => ({ path: relative,
          sha256: hash(readFileSync(path.join(packageRoot, relative))) })) };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      const packageSha256 = hash(manifestBytes);
      writeFileSync(path.join(scriptsRoot, 'native-staff-bootstrap-provisioner-package-manifest.json'), manifestBytes);
      writeFileSync(path.join(scriptsRoot, 'native-staff-bootstrap-provisioner-pin-value.mjs'),
        `export const PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 = '${packageSha256}';\n` +
        `export const PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 = '${configSha256}';\n` +
        `export const PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY = '${receiptDirectory.replaceAll('\\', '\\\\')}';\n`);
      const realPins = readFileSync(realPackagePinFile, 'utf8');
      assert.match(realPins,
        /PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 = '0'\.repeat\(64\)/u);
      assert.match(realPins, /PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 = '0'\.repeat\(64\)/u);
      assert.match(realPins, /PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY = ''/u);

      const helperPath = path.join(scriptsRoot, 'native-staff-bootstrap-provisioner-windows.ps1');
      const call = (operation, request = {}) => {
        const child = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath], {
          input: JSON.stringify({ operation, ...request }), encoding: 'utf8', windowsHide: true,
          timeout: 20_000, maxBuffer: 64 * 1024,
          env: { ...process.env, LOCALAPPDATA: localAppData },
        });
        if (child.error || child.status !== 0) {
          throw new Error(typeof child.stderr === 'string' ? child.stderr.trim() : 'synthetic_windows_helper_failed');
        }
        return JSON.parse(child.stdout);
      };
      const makeInheritedSyntheticKey = () => {
        const script = `$directory='${quotePowerShellLiteral(keyDirectory)}'; ` +
          '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
          "$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18'); " +
          '$acl=[Security.AccessControl.DirectorySecurity]::new(); ' +
          '$acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($current); ' +
          '$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor ' +
          '[Security.AccessControl.InheritanceFlags]::ObjectInherit; ' +
          'foreach($sid in @($current,$system)){ ' +
          '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,' +
          '[Security.AccessControl.FileSystemRights]::FullControl,$inherit,' +
          '[Security.AccessControl.PropagationFlags]::None,' +
          '[Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule) }; ' +
          '[void][IO.Directory]::CreateDirectory($directory); ' +
          'Set-Acl -LiteralPath $directory -AclObject $acl; ' +
          "[IO.File]::WriteAllText((Join-Path $directory 'signer-key.dpapi'),'synthetic placeholder only')";
        const child = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
        });
        assert.equal(child.status, 0, child.stderr);
      };

      const paths = {
        configPath: path.join(localAppData, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json'),
        receiptDirectory, protectedPrivateKeyPath: config.signer.protectedPrivateKeyPath,
        journalPath: path.join(localAppData, 'native-staff-bootstrap-provisioning-attempt.json'),
        lockPath: path.join(localAppData, 'native-staff-bootstrap-provisioning.lock'),
      };
      const intent = {
        configPath: paths.configPath, receiptDirectory, journalPath: paths.journalPath, lockPath: paths.lockPath,
        packageSha256, configSha256, sourceCommit: config.source.commit,
        initialPayloadSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), operationId: randomUUID(),
      };
      const { runNativeStaffBootstrapProvisioningWorkflow, reconcileNativeStaffBootstrapProvisioningReadOnly } =
        await import(pathToFileURL(path.join(ROOT, 'scripts/native-staff-bootstrap-provisioner-core.mjs')));
      const adapter = {
        preflight: value => call('preflight', { paths: value }),
        begin: value => call('begin', { intent: value }),
        installConfigNoReplace: (destination, bytes, sha256) => call('install-config', {
          destination, configBase64: bytes.toString('base64'), configSha256: sha256,
        }),
        advanceJournal: phase => call('advance-journal', { phase }),
        createReceiptDirectory: value => call('create-receipt-directory', { receiptDirectory: value }),
        publishInitialRegistryNoReplace: (temporary, destination) => call('publish-initial-registry', { temporary, destination }),
        verifyPublishedRegistry: destination => call('verify-registry', { destination }),
        finish: result => call('finish', { result }),
        failClosed: () => undefined,
        reconcileReadOnly: value => call('reconcile-read-only', value),
      };

      // Fail after the durable intent; reconciliation is read-only and neither a
      // direct second begin nor preflight may change the locked attempt.
      makeInheritedSyntheticKey();
      call('preflight', { paths });
      call('begin', { intent });
      assert.throws(() => call('install-config', { destination: paths.configPath,
        configBase64: configBytes.toString('base64'), configSha256: '0'.repeat(64) }), failCode('config_bytes_invalid'));
      assert.equal(call('reconcile-read-only', { localAppData, receiptDirectory }).phase, 'started');
      const failedJournalHash = hash(readFileSync(paths.journalPath));
      const failedLockHash = hash(readFileSync(paths.lockPath));
      assert.throws(() => call('begin', { intent: { ...intent, operationId: randomUUID() } }), failCode('prior_attempt_exists'));
      assert.equal(hash(readFileSync(paths.journalPath)), failedJournalHash);
      assert.equal(hash(readFileSync(paths.lockPath)), failedLockHash);
      assert.equal(existsSync(paths.configPath), false);

      // A stale atomic journal temp also blocks preflight without mutation.
      safeRemoveOwnedTestDirectory(tempRoot, localAppData);
      mkdirSync(localAppData, { recursive: true });
      makeInheritedSyntheticKey();
      const staleJournalTemp = `${paths.journalPath}.${randomUUID().replaceAll('-', '')}.tmp`;
      writeFileSync(staleJournalTemp, 'synthetic stale intent');
      assert.throws(() => call('preflight', { paths }), failCode('prior_attempt_exists'));
      assert.equal(readFileSync(staleJournalTemp, 'utf8'), 'synthetic stale intent');
      assert.equal(existsSync(paths.lockPath), false);
      rmSync(staleJournalTemp);

      // Separate clean synthetic attempt exercises the real initializer callback
      // and verified RSA signature, plus actual Windows no-replace publication.
      safeRemoveOwnedTestDirectory(tempRoot, localAppData);
      mkdirSync(localAppData, { recursive: true });
      makeInheritedSyntheticKey();
      const sign = payloadJson => signBytes('sha256', Buffer.from(payloadJson), { key: pair.privateKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
      const result = runNativeStaffBootstrapProvisioningWorkflow({ candidateBytes: configBytes, config, configSha256,
        paths, adapter, packageSha256, sourceVerifier: () => true, sign });
      assert.equal(result.receipt.complete, true);
      assert.match(result.registryStateSha256, /^[0-9a-f]{64}$/u);
      const registryPath = path.join(receiptDirectory, 'approval-state.json');
      assert.match(call('verify-registry', { destination: registryPath }).registryRawSha256, /^[0-9a-f]{64}$/u);
      assert.equal(reconcileNativeStaffBootstrapProvisioningReadOnly(adapter, { localAppData, receiptDirectory }).phase,
        'complete');
      const completedConfigHash = hash(readFileSync(paths.configPath));
      const completedRegistryHash = hash(readFileSync(registryPath));
      const completedJournalHash = hash(readFileSync(paths.journalPath));
      assert.throws(() => call('begin', { intent: { ...intent, operationId: randomUUID() } }), failCode('prior_attempt_exists'));
      assert.equal(hash(readFileSync(paths.configPath)), completedConfigHash);
      assert.equal(hash(readFileSync(registryPath)), completedRegistryHash);
      assert.equal(hash(readFileSync(paths.journalPath)), completedJournalHash);
      assert.equal(existsSync(paths.lockPath), false);
    } finally {
      // This path is uniquely created above and contains only this test's data.
      safeRemoveOwnedTestDirectory(tempRoot, tempRoot);
    }
  });
