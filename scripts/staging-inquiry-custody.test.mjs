import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createStagingInquiryCustody, createWindowsDpapiSealer } from './staging-inquiry-custody.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');

test('custody creates a unique attempt, keeps raw response out of files, and refuses a second worker claim', async t => {
  const root = await mkdtemp(join(tmpdir(), 'staging-inquiry-custody-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = Buffer.from('synthetic provider response with private-looking synthetic content');
  const ciphertext = Buffer.from(`synthetic-ciphertext:${sha(raw)}`);
  const sealer = async ({ rawResponseBytes, destination }) => {
    assert.deepEqual(rawResponseBytes, raw);
    // Test sealer stores synthetic ciphertext only; this is not DPAPI evidence.
    await (await import('node:fs/promises')).writeFile(destination, Buffer.from(`synthetic-ciphertext:${sha(rawResponseBytes)}`), { flag: 'wx' });
    return { encrypted: true };
  };
  const custody = createStagingInquiryCustody({ root, sealRaw: sealer });
  const attemptId = randomUUID(), attempt = await custody.createAttempt(attemptId);
  assert.equal(await attempt.record('active-attempt.claim.json', { attemptId, synthetic: true }), true);
  assert.equal(await attempt.record('attempt.intent.json', { attemptId, synthetic: true }), true);
  assert.equal(await attempt.record('asset-000001.intent.json', { intentId: 'asset-000001', synthetic: true }), true);
  const sealed = await attempt.seal(raw, 'asset-000001.response');
  assert.equal(sealed.digest, sha(ciphertext));
  assert.notEqual(sealed.digest, sha(raw));
  assert.equal(sealed.verified, true);
  assert.equal(await attempt.record('asset-000001.outcome.json', { responseSha256: sha(raw), sealedDigest: sealed.digest }), true);
  assert.equal(await attempt.record('version-upload.intent.json', { request: 'synthetic' }), true);
  const versionSeal = await attempt.seal(raw, 'version-upload.response');
  assert.deepEqual(versionSeal, { verified: true, digest: sha(ciphertext) });
  assert.equal(await attempt.record('version-upload.outcome.json', { sealedDigest: versionSeal.digest }), true);
  assert.equal(await attempt.record('upload-summary.json', { status: 'synthetic' }), true);
  const files = await readdir(attempt.path);
  assert.deepEqual(files.sort(), ['active-attempt.claim.json', 'attempt.intent.json', 'asset-000001.intent.json',
    'asset-000001.outcome.json', 'asset-000001.response.dpapi', 'upload-summary.json',
    'version-upload.intent.json', 'version-upload.outcome.json', 'version-upload.response.dpapi'].sort());
  const joined = Buffer.concat(await Promise.all(files.map(name => readFile(join(attempt.path, name)))));
  assert.equal(joined.includes(raw), false);
  assert.equal(joined.toString().includes(raw.toString()), false);
  await assert.rejects(attempt.record('asset-000001.intent.json', { changed: true }), /record_exists/);
  await assert.rejects(attempt.seal(raw, 'asset-000001.response'), /createNew|already exists|file exists|dpapi_failed/i);
  await assert.rejects(createStagingInquiryCustody({ root, sealRaw: sealer }).createAttempt(randomUUID()), /worker_already_claimed/);
  await assert.rejects(custody.createAttempt(randomUUID()), /instance_already_used/);
  assert.equal((await stat(join(root, 'ledgetop-ops-staging', 'worker.claim'))).isFile(), true);
});

test('custody refuses reused attempt directory and invalid record names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'staging-inquiry-custody-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const custody = createStagingInquiryCustody({ root, sealRaw: async () => ({ encrypted: true }) });
  const id = randomUUID(), attempt = await custody.createAttempt(id);
  await assert.rejects(attempt.record('../escape.intent.json', {}), /record_name_invalid/);
  await assert.rejects(attempt.record('unknown.outcome.json', {}), /record_name_invalid/);
  await assert.rejects(custody.createAttempt(id), /instance_already_used/);
});

test('a custody instance allows exactly one attempt even with a new attempt id', async t => {
  const root = await mkdtemp(join(tmpdir(), 'staging-inquiry-custody-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const custody = createStagingInquiryCustody({ root, sealRaw: async ({ destination }) => {
    await (await import('node:fs/promises')).writeFile(destination, Buffer.from('ciphertext'), { flag: 'wx' });
    return { encrypted: true };
  } });
  await custody.createAttempt(randomUUID());
  await assert.rejects(custody.createAttempt(randomUUID()), /instance_already_used/);
});

test('Windows CurrentUser DPAPI seals a synthetic response', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'staging-inquiry-dpapi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = Buffer.from('synthetic-only DPAPI custody fixture');
  const sealRaw = createWindowsDpapiSealer();
  const custody = createStagingInquiryCustody({ root, sealRaw });
  const attempt = await custody.createAttempt(randomUUID());
  await attempt.seal(raw, 'asset-synthetic-dpapi.response');
  const encrypted = await readFile(join(attempt.path, 'asset-synthetic-dpapi.response.dpapi'));
  assert.ok(encrypted.length > 0);
  assert.equal(encrypted.includes(raw), false);
  const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $c=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $e=[Text.Encoding]::UTF8.GetBytes('LedgeTop-Ops/staging-inquiry-custody/v1'); $b=[Security.Cryptography.ProtectedData]::Unprotect($c,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); try { $h=[Security.Cryptography.SHA256]::Create(); try { [Console]::Out.WriteLine(([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()) } finally { $h.Dispose() } } finally { [Array]::Clear($b,0,$b.Length) }`;
  const encoded = Buffer.from(`& { ${ps} }`, 'utf16le').toString('base64');
  const plaintextDigest = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error('synthetic_dpapi_unprotect_failed')));
    child.stdin.end(encrypted.toString('base64'), 'utf8');
  });
  assert.equal(plaintextDigest, sha(raw));
  assert.equal((await attempt.seal(Buffer.from('another synthetic response'), 'asset-dpapi-second.response')).digest,
    sha(await readFile(join(attempt.path, 'asset-dpapi-second.response.dpapi'))));
  await assert.rejects(createStagingInquiryCustody({ root, sealRaw }).createAttempt(randomUUID()), /worker_already_claimed/);
});
