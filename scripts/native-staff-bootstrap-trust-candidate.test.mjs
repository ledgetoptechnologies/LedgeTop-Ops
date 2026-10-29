import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseTrustConfig, PINNED_TRUST_CONFIG_SHA256, protectedSign } from './native-staff-bootstrap-owner-approval.mjs';
import { PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256 } from './native-staff-bootstrap-owner-approval-distribution-pin-value.mjs';
import { loadPinnedNativeStaffBootstrapExecutorConfig } from './native-staff-bootstrap-approved-executor-config.mjs';
import {
  createNativeStaffBootstrapTrustCandidate,
  TRUST_CANDIDATE_INPUT_KIND,
  TRUST_CANDIDATE_STATUS,
  validateNativeStaffBootstrapTrustCandidateFile,
  validateNativeStaffBootstrapTrustCandidateInput,
} from './native-staff-bootstrap-trust-candidate.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const syntheticInput = () => ({
  schemaVersion: 1,
  kind: TRUST_CANDIDATE_INPUT_KIND,
  target: { accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111' },
  source: { commit: 'b'.repeat(40), migrationNamesSha256: 'c'.repeat(64) },
  access: {
    origin: 'https://ops.example.test',
    issuer: 'https://synthetic.cloudflareaccess.com',
    audience: 'syntheticAudience01',
    owner: { staffId: 'synthetic-owner-test-id', accessSubject: 'synthetic-test-subject-not-real' },
    cloudflaredExecutablePath: 'C:\\synthetic-test\\cloudflared.exe',
    cloudflaredExecutableSha256: 'd'.repeat(64),
  },
  receiptDirectory: 'C:\\synthetic-test\\receipts',
});

test('candidate inputs require explicit closed-schema operator facts and reject inferred identity fields', () => {
  const input = syntheticInput();
  assert.equal(validateNativeStaffBootstrapTrustCandidateInput(input), input);
  assert.throws(() => validateNativeStaffBootstrapTrustCandidateInput({ ...input, email: 'synthetic@example.test' }),
    /native_staff_bootstrap_trust_candidate_input_invalid/u);
  assert.throws(() => validateNativeStaffBootstrapTrustCandidateInput({ ...input, cohort: { staff: [] } }),
    /native_staff_bootstrap_trust_candidate_input_invalid/u);
  assert.throws(() => validateNativeStaffBootstrapTrustCandidateInput({ ...input,
    access: { ...input.access, owner: { ...input.access.owner, staffId: '' } } }),
  /native_staff_bootstrap_trust_candidate_input_invalid/u);
});

test('validation command path does not create candidate directories or invoke PowerShell', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-trust-candidate-validate-'));
  try {
    const inputPath = path.join(root, 'synthetic-input.json');
    writeFileSync(inputPath, `${JSON.stringify(syntheticInput())}\n`, { flag: 'wx' });
    assert.deepEqual(validateNativeStaffBootstrapTrustCandidateFile(inputPath), {
      status: 'input-valid-candidate-not-created',
    });
    assert.deepEqual(readdirSync(root).sort(), ['synthetic-input.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate API validates before any key operation', () => {
  const input = { ...syntheticInput(), guessedOwnerFromEmail: true };
  assert.throws(() => createNativeStaffBootstrapTrustCandidate(input, {
    candidateParent: 'C:\\synthetic-test',
  }), /native_staff_bootstrap_trust_candidate_input_invalid/u);
});

test('candidate preparation leaves trust and distribution pins fail-closed', () => {
  assert.equal(PINNED_TRUST_CONFIG_SHA256, '0'.repeat(64));
  assert.equal(PINNED_OWNER_APPROVAL_DISTRIBUTION_SHA256, '0'.repeat(64));
  assert.throws(() => loadPinnedNativeStaffBootstrapExecutorConfig(),
    /native_staff_bootstrap_executor_trust_config_pin_unprovisioned/u);
});

test('PowerShell writer refuses an existing candidate path without changing it', {
  skip: process.platform !== 'win32' ? 'Windows ACL qualification only' : false,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-trust-candidate-existing-'));
  try {
    const existing = path.join(root, `native-staff-bootstrap-trust-candidate-${randomUUID()}`);
    const sentinel = path.join(existing, 'keep.txt');
    mkdirSync(existing);
    writeFileSync(sentinel, 'synthetic fixture sentinel', { flag: 'wx' });
    const request = {
      operation: 'create-candidate', directoryPath: existing, configJson: '{}', configSha256: 'a'.repeat(64),
      reviewJson: '{}', protectedPrivateKeyBase64: Buffer.alloc(64, 1).toString('base64'), keyId: 'b'.repeat(64),
    };
    const script = fileURLToPath(new URL('./native-staff-bootstrap-trust-candidate.ps1', import.meta.url));
    const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
      input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 20_000,
      maxBuffer: 4096, stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.trim(), /^native_staff_bootstrap_trust_candidate_candidate_exists$/u);
    assert.equal(readFileSync(sentinel, 'utf8'), 'synthetic fixture sentinel');
    assert.deepEqual(readdirSync(existing), ['keep.txt']);
  } finally {
    rmSync(root, { recursive: true, force: false });
  }
});

test('Windows DPAPI candidate fixture produces a strict config and a private owner+SYSTEM directory', {
  skip: process.platform !== 'win32' ? 'Windows DPAPI/ACL qualification only' : false,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-trust-candidate-runtime-'));
  let candidate;
  try {
    const info = lstatSync(root);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    candidate = createNativeStaffBootstrapTrustCandidate(syntheticInput(), { candidateParent: root });
    assert.equal(candidate.status, TRUST_CANDIDATE_STATUS);
    assert.match(candidate.keyId, /^[0-9a-f]{64}$/u);
    assert.match(candidate.configSha256, /^[0-9a-f]{64}$/u);
    assert.equal(candidate.directoryPath.startsWith(`${root}\\`), true);
    const configBytes = readFileSync(candidate.configPath);
    assert.equal(hash(configBytes), candidate.configSha256);
    const config = parseTrustConfig(configBytes.toString('utf8'), candidate.configSha256);
    assert.equal(config.signer.keyId, candidate.keyId);
    assert.equal(config.signer.protectedPrivateKeyPath, candidate.protectedPrivateKeyPath);
    const protectedBytes = readFileSync(candidate.protectedPrivateKeyPath);
    assert.ok(protectedBytes.length >= 64 && protectedBytes.length < 16 * 1024);
    assert.equal(protectedBytes.includes(Buffer.from('PRIVATE KEY')), false);
    const review = JSON.parse(readFileSync(candidate.reviewPath, 'utf8'));
    assert.equal(review.status, TRUST_CANDIDATE_STATUS);
    assert.equal(review.configSha256, candidate.configSha256);
    assert.equal(review.keyId, candidate.keyId);

    // This uses the existing production signer only on the synthetic temp key
    // and a non-approval payload; it verifies DPAPI interoperability end-to-end.
    const payload = 'synthetic candidate interoperability proof';
    const signature = protectedSign(payload, config);
    assert.equal(verifySignature('sha256', Buffer.from(payload), {
      key: createPublicKey(config.signer.publicKeyPem),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, Buffer.from(signature, 'base64')), true);

    const aclScript = [
      '$ErrorActionPreference = \'Stop\'',
      '$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()) -AsHashtable',
      '$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
      '$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, \'S-1-5-18\')',
      '$directoryAcl = Get-Acl -LiteralPath $request.directoryPath',
      '$directoryRules = @($directoryAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))',
      'if (-not $directoryAcl.AreAccessRulesProtected -or $directoryAcl.Owner -ne $owner -or $directoryRules.Count -ne 2) { exit 2 }',
      'if (@($directoryRules | Where-Object { $_.AccessControlType -ne \'Allow\' -or $_.FileSystemRights -ne \'FullControl\' -or $_.IdentityReference.Value -notin $allowed }).Count -ne 0) { exit 3 }',
      'foreach ($file in $request.files) {',
      '  $item = Get-Item -LiteralPath $file -Force',
      '  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 4 }',
      '  $acl = Get-Acl -LiteralPath $file',
      '  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))',
      '  $explicitRules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))',
      '  if ($acl.AreAccessRulesProtected -or $acl.Owner -ne $owner -or $explicitRules.Count -ne 0 -or $rules.Count -ne 2) { exit 5 }',
      '  if (@($rules | Where-Object { $_.AccessControlType -ne \'Allow\' -or $_.FileSystemRights -ne \'FullControl\' -or $_.IdentityReference.Value -notin $allowed }).Count -ne 0) { exit 6 }',
      '}',
      '[Console]::Out.Write(\'acl-ok\')',
    ].join('\n');
    const aclScriptPath = path.join(root, 'verify-acl.ps1');
    writeFileSync(aclScriptPath, aclScript, { flag: 'wx' });
    const aclResult = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', aclScriptPath], {
      input: JSON.stringify({ directoryPath: candidate.directoryPath,
        files: [candidate.configPath, candidate.protectedPrivateKeyPath, candidate.reviewPath] }),
      encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 4096,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(aclResult.status, 0);
    assert.equal(aclResult.stdout, 'acl-ok');
  } finally {
    if (candidate) {
      const target = path.resolve(candidate.directoryPath), base = path.resolve(root);
      assert.equal(path.dirname(target), base);
      const candidateInfo = lstatSync(candidate.directoryPath);
      assert.ok(candidateInfo.isDirectory() && !candidateInfo.isSymbolicLink());
      rmSync(candidate.directoryPath, { recursive: true, force: false });
    }
    rmSync(root, { recursive: true, force: false });
  }
});
