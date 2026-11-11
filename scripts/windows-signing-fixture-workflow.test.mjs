import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../.github/workflows/windows-signing-fixture.yml', import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
function validate(s) {
  assert.match(s, /^on:\n  workflow_dispatch:\n\npermissions: \{\}\n/m);
  assert.equal((s.match(/^  workflow_dispatch:/gm) ?? []).length, 1);
  assert.doesNotMatch(s, /^  (push|pull_request|workflow_run|schedule|repository_dispatch):/m);
  assert.match(s, /^  fixture:\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'workflow_dispatch' && github\.repository == 'ledgetoptechnologies\/LedgeTop-Ops'\) \}\}/m);
  assert.equal((s.match(/^  [a-z_-]+:\n    if:/gm) ?? []).length, 1);
  assert.match(s, /^    environment: windows-release$/m);
  assert.match(s, /^    permissions:\n      contents: read\n      id-token: write$/m);
  assert.match(s, /^    timeout-minutes: 15$/m);
  assert.match(s, /SIGNING_PROFILE -cne 'LedgeTopFiles'/);
  assert.match(s, /SIGNING_ACCOUNT -cne 'ltt-signing'/);
  assert.match(s, /SIGNING_ENDPOINT -cne 'https:\/\/eus\.codesigning\.azure\.net\/'/);
  assert.match(s, /Add-Type -TypeDefinition \$code -OutputAssembly \$signed/);
  assert.match(s, /'35375a4bc4e1102da729fc3d8d9925f774c3baae6b8b7ff6398d948ca9ab0d8a'/);
  assert.match(s, /'180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022'/);
  assert.match(s, /Get-FileHash -LiteralPath \$file -Algorithm SHA256/);
  assert.ok(s.indexOf('Get-FileHash -LiteralPath $file -Algorithm SHA256') < s.indexOf('ExtractToDirectory($file'));
  assert.match(s, /& \$exe sign \/fd SHA256 \/tr http:\/\/timestamp\.acs\.microsoft\.com \/td SHA256 \/dlib \$dlib \/dmdf \$metadataPath \$signed/);
  assert.match(s, /Test-LedgeSignedPeEquivalent \$before \$after/);
  assert.match(s, /ExcludeCredentials = @\('EnvironmentCredential','WorkloadIdentityCredential'/);
  assert.match(s, /^          retention-days: 1$/m);
  assert.match(s, /^          if-no-files-found: error$/m);
  const actions = [...s.matchAll(/^\s+uses: ([^\s#]+)/gm)].map(m => m[1]);
  assert.deepEqual(actions, [
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ]);
  const paths = [...s.matchAll(/^            (\$\{\{ runner\.temp \}\}\\ledgetop-signing-fixture\\[^\r\n]+)$/gm)].map(m => m[1]);
  assert.deepEqual(paths.map(p => p.split('\\').at(-1)), ['fixture-unsigned.dll', 'fixture-signed.dll', 'fixture-receipt.json']);
  assert.match(s, /persist-credentials: false/);
  assert.doesNotMatch(s, /upload-release-asset|gh release|workflow_call|artifact-signing-action/);
}
test('fixture workflow uses the scoped main-only reviewed path', () => validate(source));
test('ref, artifact, scope and pin mutations are rejected', () => {
  for (const changed of [
    source.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/feature'"),
    source.replace('retention-days: 1', 'retention-days: 90'),
    source.replace('Test-LedgeSignedPeEquivalent $before $after', 'Write-Output skipped'),
    source.replace('180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022', '0'.repeat(64)),
    source.replace('azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6', 'azure/login@v2'),
    source.replace('environment: windows-release', 'environment: staging'),
  ]) assert.throws(() => validate(changed));
});
