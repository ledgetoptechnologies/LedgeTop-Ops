import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/publish-viewer.yml');
const upstream = read('apps/viewer/.github/workflows/viewer-image.yml');
const releaseGuard = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

function steps(source) {
  return new Map(source.split(/^      - name: /m).slice(1).map(block => {
    const firstNewline = block.indexOf('\n');
    return [block.slice(0, firstNewline), block.slice(firstNewline + 1).trimEnd()];
  }));
}
const migratedSteps = steps(workflow);
const originalSteps = steps(upstream);
const { MIGRATIONS } = createRequire(import.meta.url)('../apps/viewer/server/database.js');
// The original imported workflow is historical evidence. Reviewed migrations
// 39 (controller pinning) and 40 (typed direct-client session authority) advance
// only these two schema gates from 38 to 40. Migration 40 transactionally rebuilds
// three leaf tables, preserving legacy rows, indexes and immutable triggers;
// direct-client-delivery.test.js covers continuity, typed revocation isolation,
// atomic rollback for unexpected inbound references and idempotent reapplication.
// Every other byte of the upstream verification/promotion contract stays compared.
function reviewedUpstreamStep(name) {
  const original = originalSteps.get(name);
  if (!['Verify exact candidate image', 'Write verified release attestation'].includes(name)) return original;
  assert.equal(MIGRATIONS.at(-1).version, 40, 'another schema advance requires a new explicit gate review');
  assert.equal(MIGRATIONS.at(-1).name, 'direct_client_session_source_authorizations');
  assert.equal(original.split('EXPECTED_SCHEMA_VERSION: "38"').length - 1, 1);
  assert.equal(migratedSteps.get(name).split('EXPECTED_SCHEMA_VERSION: "40"').length - 1, 1);
  return original.replace('EXPECTED_SCHEMA_VERSION: "38"', 'EXPECTED_SCHEMA_VERSION: "40"');
}


test('Viewer publication only watches its imported application and workflow', () => {
  assert.doesNotMatch(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  push:\n    branches: \[main\]\n    paths:/m);
  for (const event of ['pull_request', 'push']) {
    const eventBlock = workflow.split(`  ${event}:\n`)[1].split(/^(?:  [a-z_]+:|\S)/m)[0];
    const paths = [...eventBlock.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]);
    assert.deepEqual(paths, ['apps/viewer/**', '.github/workflows/publish-viewer.yml', 'scripts/viewer-monorepo-boundaries.test.mjs']);
  }
  assert.doesNotMatch(workflow, /wrangler|production:deploy|apps\/(?:operations|client|ops-sync)\//);
});

test('Actions use the nested locked application and Docker build context', () => {
  assert.match(workflow, /defaults:\n      run:\n        working-directory: apps\/viewer/);
  assert.match(migratedSteps.get('Set up Node.js'), /node-version: 24\n          cache: npm\n          cache-dependency-path: apps\/viewer\/package-lock\.json/);
  assert.match(migratedSteps.get('Install dependencies'), /run: npm ci$/);
  assert.match(migratedSteps.get('Run checks'), /run: npm run check$/);
  assert.match(migratedSteps.get('Verify monorepo publication boundaries'), /node --test \.\.\/\.\.\/scripts\/viewer-monorepo-boundaries\.test\.mjs/);
  const build = migratedSteps.get('Build isolated candidate');
  assert.match(build, /context: apps\/viewer\n          file: apps\/viewer\/Dockerfile\n          platforms: linux\/amd64/);
  assert.match(build, /VIEWER_SOURCE_COMMIT=\$\{\{ github\.sha \}\}/);
  assert.match(migratedSteps.get('Normalize image name'), /name=ghcr\.io\/ledgetoptechnologies\/ledgetop-ops-viewer/);
  assert.match(workflow, /type=sha,prefix=sha-,format=long/);
});

test('PR builds load local candidates and cannot promote or publish', () => {
  const build = migratedSteps.get('Build isolated candidate');
  for (const flag of ['push', 'provenance', 'sbom']) {
    assert.ok(build.includes(`${flag}: \${{ ${releaseGuard} }}`), `${flag} must be main-push only`);
  }
  assert.ok(build.includes("load: ${{ github.event_name != 'push' || github.ref != 'refs/heads/main' }}"));
  for (const name of ['Log in to GitHub Container Registry', 'Promote verified digest to release tags', 'Write verified release attestation', 'Upload release attestation']) {
    assert.ok(migratedSteps.get(name).includes(`if: ${releaseGuard}\n`), `${name} must execute only on main pushes`);
  }
  assert.match(migratedSteps.get('Set isolated candidate reference'), /candidate-\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
  assert.ok(migratedSteps.get('Generate image metadata').includes(`type=raw,value=latest,enable=\${{ ${releaseGuard} }}`));
});

test('All upstream runtime and numerical-engine verification remains intact', () => {
  const actual = migratedSteps.get('Verify exact candidate image').replace(
    'if [[ "$GITHUB_EVENT_NAME" == "push" && "$GITHUB_REF" == "refs/heads/main" ]]; then',
    'if [[ "$GITHUB_EVENT_NAME" == "push" ]]; then',
  );
  assert.equal(actual, reviewedUpstreamStep('Verify exact candidate image'), 'Only the reviewed schema-40 advance may differ from the upstream runtime gate');
  assert.ok(workflow.indexOf('- name: Verify exact candidate image') < workflow.indexOf('- name: Promote verified digest to release tags'));
  assert.match(actual, /test "\$CANDIDATE_DIGEST" = "\$IMAGE_DIGEST"/);
  assert.match(actual, /VERIFY_IMAGE="\$IMAGE_NAME@\$IMAGE_DIGEST"/);
  assert.match(actual, /-v "\$PWD\/test:\/app\/test:ro"/);
});

test('Promotion and attestation retain exact verified digest semantics', () => {
  for (const name of ['Promote verified digest to release tags', 'Write verified release attestation']) {
    const actual = migratedSteps.get(name).replace(`if: ${releaseGuard}`, "if: github.event_name == 'push'");
    assert.equal(actual, reviewedUpstreamStep(name), `${name} must retain the upstream digest/attestation checks`);
  }
  assert.match(migratedSteps.get('Upload release attestation'), /path: \|\n            apps\/viewer\/viewer-image-attestation\.json\n            apps\/viewer\/viewer-image-attestation\.json\.sha256/);
});

test('Container Viewer does not join the Cloudflare application source registry', () => {
  const requirements = read('scripts/staging-requirements.mjs');
  const registry = requirements.match(/export const APP_SOURCE_DIRS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  assert.ok(registry);
  assert.doesNotMatch(registry, /viewer/);
});
