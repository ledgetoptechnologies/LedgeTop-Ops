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
  assert.match(s, /^          files: \$\{\{ runner\.temp \}\}\\ledgetop-signing-fixture\\fixture-signed\.dll$/m);
  assert.doesNotMatch(s, /^\s+(files-folder|files-catalog|generate-digest-path|ingest-digest-path):/m);
  assert.match(s, /^          timestamp-rfc3161: http:\/\/timestamp\.acs\.microsoft\.com$/m);
  assert.match(s, /^          timestamp-digest: SHA256$/m);
  assert.match(s, /^          cache-dependencies: false$/m);
  assert.match(s, /^          retention-days: 1$/m);
  assert.match(s, /^          if-no-files-found: error$/m);
  const actions = [...s.matchAll(/^\s+uses: ([^\s#]+)/gm)].map(m => m[1]);
  assert.deepEqual(actions, [
    'azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6',
    'azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ]);
  const paths = [...s.matchAll(/^            (\$\{\{ runner\.temp \}\}\\ledgetop-signing-fixture\\[^\r\n]+)$/gm)].map(m => m[1]);
  assert.deepEqual(paths.map(p => p.split('\\').at(-1)), ['fixture-unsigned.dll', 'fixture-signed.dll', 'fixture-receipt.json']);
  assert.doesNotMatch(s, /upload-release-asset|gh release|workflow_call|actions\/checkout/);
}
test('fixture workflow uses the scoped main-only reviewed path', () => validate(source));
test('ref, artifact, scope and pin mutations are rejected', () => {
  for (const changed of [
    source.replace("github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/feature'"),
    source.replace('retention-days: 1', 'retention-days: 90'),
    source.replace('fixture-signed.dll\n          file-digest', 'other.dll\n          file-digest'),
    source.replace('azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6', 'azure/login@v2'),
    source.replace('environment: windows-release', 'environment: staging'),
  ]) assert.throws(() => validate(changed));
});
