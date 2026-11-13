import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUpdatePolicy, validateRelease, compareWindowsVersions,
  parseWindowsVersion, renderAppInstaller, selectUpdate, publisherDisplayName, updateBehavior } from './windows-update-policy.mjs';

// Synthetic observations only: these tests do not inspect or sign a real package.
function policy() {
  return { schemaVersion: 1, channels: Object.fromEntries(['pilot', 'stable'].map(channel => [channel, {
    packageName: `Example.Files.${channel}`, publisher: 'CN=Verified Test Publisher, O=A & B',
    signingProfileId: 'synthetic-verified-profile', signingProfileVerified: true, architecture: 'x64',
    origin: 'https://updates.example.invalid', feedUrl: `https://updates.example.invalid/${channel}/app.appinstaller`,
    packageBaseUrl: `https://updates.example.invalid/${channel}/packages`,
  }])) };
}
function release(channel = 'pilot', version = '1.9.0.0', hash = 'a'.repeat(64)) {
  const p = policy().channels[channel];
  return { channel, packageName: p.packageName, publisher: p.publisher, architecture: 'x64', version,
    sha256: hash, sizeBytes: 12345, sourceCommit: 'c'.repeat(40),
    packageUrl: `${p.packageBaseUrl}/${version}/${hash}.msix` };
}
function observation(r) { return { ...r, compiledChannel: r.channel, developerBuild: false, verified: true, trusted: true, signingProfileId: 'synthetic-verified-profile' }; }
const reject = (r, s = observation(r), p = policy()) => assert.throws(() => validateRelease(p, r, s));

test('policy snapshots caller values and requires distinct channel identities', () => {
  const input = policy(), accepted = validateUpdatePolicy(input);
  input.channels.pilot.publisher = 'CN=Changed';
  assert.equal(accepted.channels.pilot.publisher, policy().channels.pilot.publisher);
  assert(Object.isFrozen(accepted.channels.pilot));
  for (const field of ['packageName', 'feedUrl', 'packageBaseUrl']) {
    const p = policy(); p.channels.stable[field] = p.channels.pilot[field];
    assert.throws(() => validateUpdatePolicy(p));
  }
});
test('display name does not invent certificate publisher', () => {
  assert.equal(publisherDisplayName, 'Ledge Top Technologies LLC');
  const p = policy(); delete p.channels.pilot.publisher;
  assert.throws(() => validateUpdatePolicy(p));
  const missingName = policy(); delete missingName.channels.pilot.packageName;
  assert.throws(() => validateUpdatePolicy(missingName));
});
test('only reviewed pilot can be configured while stable remains unavailable', () => {
  const p = policy(); delete p.channels.stable;
  const r = release(); assert.equal(validateRelease(p, r, observation(r)).channel, 'pilot');
  const stable = release('stable'); reject(stable, observation(stable), p);
  assert.throws(() => validateUpdatePolicy({ schemaVersion: 1, channels: {} }));
  assert.throws(() => validateUpdatePolicy({ schemaVersion: 1, channels: { ...p.channels, developer: p.channels.pilot } }));
});
test('version comparison is numeric Windows tuple order', () => {
  assert.equal(compareWindowsVersions('1.10.0.0', '1.9.65535.65535'), 1);
  assert.equal(compareWindowsVersions('2.0.0.0', '10.0.0.0'), -1);
  assert.equal(compareWindowsVersions('1.2.3.4', '1.2.3.4'), 0);
});
for (const version of ['1.2.3', '1.2.3.4.5', '1.2.3.65536', '-1.0.0.0', '01.0.0.0', '1.0.0.0 ', '1.0.0.1e2'])
  test(`reject malformed version ${JSON.stringify(version)}`, () => assert.throws(() => parseWindowsVersion(version)));

test('valid observed release produces immutable sanitized result', () => {
  const r = release(); const accepted = validateRelease(policy(), r, observation(r));
  r.sha256 = 'b'.repeat(64);
  assert.equal(accepted.sha256, 'a'.repeat(64)); assert(Object.isFrozen(accepted));
  assert.equal(accepted.verified, undefined);
});
for (const [field, value] of Object.entries({ channel: 'development', packageName: 'Example.Other',
  publisher: 'CN=Wrong', architecture: 'arm64', sha256: 'A'.repeat(64), sizeBytes: 0,
  sourceCommit: 'main', packageUrl: 'https://updates.example.invalid/pilot/current.msix' }))
  test(`reject release ${field} tamper even with matching claimed observation`, () => {
    const r = { ...release(), [field]: value }; reject(r);
  });
for (const [field, value] of Object.entries({ verified: false, trusted: false, signingProfileId: 'other',
  sha256: 'b'.repeat(64), sizeBytes: 12346, publisher: 'CN=Wrong', version: '1.10.0.0',
  packageName: 'Example.Wrong', architecture: 'arm64', compiledChannel: 'stable', developerBuild: true, sourceCommit: 'd'.repeat(40) }))
  test(`reject signature observation ${field} mismatch`, () => {
    const r = release(); reject(r, { ...observation(r), [field]: value });
  });
test('unsigned/missing observation and unverified signing profile refused', () => {
  const r = release(); reject(r, null);
  const p = policy(); p.channels.pilot.signingProfileVerified = false;
  reject(r, observation(r), p);
});
for (const url of ['http://updates.example.invalid/pilot/app.appinstaller',
  'https://user:pass@updates.example.invalid/pilot/app.appinstaller',
  'https://updates.example.invalid:8443/pilot/app.appinstaller',
  'https://updates.example.invalid/pilot/%61pp.appinstaller',
  'https://updates.example.invalid/pilot/../app.appinstaller',
  'https://updates.example.invalid//pilot/app.appinstaller',
  'https://updates.example.invalid/pilot/app.appinstaller?token=secret',
  'https://updates.example.invalid/pilot/app.appinstaller#x',
  'https://foreign.example.invalid/pilot/app.appinstaller',
  'https://updates.example.invalid/pilot\\app.appinstaller'])
  test(`reject unsafe feed ${url}`, () => {
    const p = policy(); p.channels.pilot.feedUrl = url; assert.throws(() => validateUpdatePolicy(p));
  });
test('foreign/escaped package paths cannot use a verified observation to redirect policy', () => {
  for (const packageUrl of [release().packageUrl.replace('updates.', 'foreign.'),
    `${release().packageUrl}?x=y`, release().packageUrl.replace('/1.9.', '/%31.9.')])
    reject({ ...release(), packageUrl });
});
test('render XML escapes publisher and only generates approved attributes', () => {
  const p = policy(); p.channels.pilot.publisher = 'CN=Test "A" <B> & C';
  const r = { ...release(), publisher: p.channels.pilot.publisher };
  const output = renderAppInstaller(p, r, observation(r));
  assert.match(output, /Publisher="CN=Test &quot;A&quot; &lt;B&gt; &amp; C"/);
  assert.match(output, /HoursBetweenUpdateChecks="12" ShowPrompt="false" UpdateBlocksActivation="false"/);
  assert.match(output, /<AutomaticBackgroundTask \/>/);
  assert(!output.includes('ForceUpdateFromAnyVersion')); assert(!output.includes('<!DOCTYPE'));
  assert.deepEqual(updateBehavior, { onLaunchHours: 12, backgroundHours: 8, showPrompt: false, updateBlocksActivation: false, forceDowngrade: false });
  p.channels.pilot.publisher = 'CN=Test <!DOCTYPE injected SYSTEM "file:///secret">';
  r.publisher = p.channels.pilot.publisher;
  const escaped = renderAppInstaller(p, r, observation(r));
  assert(!escaped.includes('<!DOCTYPE')); assert(escaped.includes('&lt;!DOCTYPE'));
});
test('update selects numeric forward version and refuses channel switch', () => {
  const old = release(), next = release('pilot', '1.10.0.0', 'b'.repeat(64));
  assert.equal(selectUpdate(policy(), old, observation(old), next, observation(next)).version, '1.10.0.0');
  const stable = release('stable', '1.10.0.0');
  assert.throws(() => selectUpdate(policy(), old, observation(old), stable, observation(stable)));
});
test('same immutable version is no-op but changed hash/length/commit is refused', () => {
  const old = release();
  assert.equal(selectUpdate(policy(), old, observation(old), old, observation(old)), null);
  for (const next of [release('pilot', old.version, 'b'.repeat(64)),
    { ...old, sizeBytes: 2 }, { ...old, sourceCommit: 'd'.repeat(40) }])
    assert.throws(() => selectUpdate(policy(), old, observation(old), next, observation(next)));
});
test('rollback requires new forward version and older payload target', () => {
  const old = release(), lower = release('pilot', '1.8.0.0'), next = release('pilot', '1.10.0.0');
  assert.throws(() => selectUpdate(policy(), old, observation(old), lower, observation(lower), { rollbackPayloadVersion: '1.7.0.0' }));
  assert.throws(() => selectUpdate(policy(), old, observation(old), next, observation(next), { rollbackPayloadVersion: '1.9.0.0' }));
  assert.equal(selectUpdate(policy(), old, observation(old), next, observation(next), { rollbackPayloadVersion: '1.8.0.0' }).version, '1.10.0.0');
});
