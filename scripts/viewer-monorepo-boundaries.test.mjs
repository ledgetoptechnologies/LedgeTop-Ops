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
const reviewedAckMigrations = [
  { version: 41, name: 'viewer_acceptance_ack_outbox' },
  { version: 42, name: 'viewer_acceptance_ack_outbox_schema_reconcile' },
];
const reviewedConverter = {
  patchSha256: 'fb35e1f99e76d6af99748681b65e08c3e0072da23cb7d61098c4bea1e45e604c',
  lockSetSha256: 'b30f6a37f1d3cc542ea10a484672750d93af70d76b57257dce2ff47abab64d98',
  licenseNoticeSha256: '86768eb4bb03feacad31ba6ec90c003abafdebeb5257a1c3eeb1b4f348530a4e',
};
// `read` normalizes CRLF/LF differences caused by Windows and Linux checkouts;
// after that normalization every unreviewed upstream step is compared exactly.
// Schema 41 adds a task/provider/attempt-bound durable ACK outbox with immutable
// identity; schema 42 validates and preserves legacy rows, maps accepted to
// delivered, and prevents ACK deletion. Unknown or mismatched rows abort the
// migration. Only the candidate image verification and attestation schema gates
// advance from 38 to 42; all other upstream runtime, numerical, promotion and
// digest guards remain fully compared.
// The reviewed Obj2Tiles build updates its bounded-concurrency patch and adds
// the ImageSharp 3.2.0 locked dependency/license notices. The image verifier pins
// the exact patch, lock-set and license-notice digests, checks the embedded
// license manifest/files, and validates the v2 build receipt. Future converter,
// dependency or license changes require a new explicit boundary review.
function replaceReviewedOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, `${label}: upstream anchor must occur exactly once`);
  return source.replace(before, after);
}
function reviewedUpstreamStep(name) {
  const original = originalSteps.get(name);
  if (!['Verify exact candidate image', 'Write verified release attestation'].includes(name)) return original;
  assert.deepEqual(MIGRATIONS.slice(-2).map(({ version, name }) => ({ version, name })), reviewedAckMigrations,
    'another schema advance requires a new explicit gate review');
  assert.equal(original.split('EXPECTED_SCHEMA_VERSION: "38"').length - 1, 1,
    `${name}: expected historical schema pin must occur exactly once`);
  let reviewed = replaceReviewedOnce(original, 'EXPECTED_SCHEMA_VERSION: "38"',
    'EXPECTED_SCHEMA_VERSION: "42"', `${name} schema pin`);

  if (name === 'Verify exact candidate image') {
    reviewed = replaceReviewedOnce(reviewed,
      'EXPECTED_OBJ2TILES_PATCH_SHA256: "6d5d99ea1d1e36208e44d0456d35cb0d8c68092dfd4a6ad01288bf85bb67322b"',
      `EXPECTED_OBJ2TILES_PATCH_SHA256: "${reviewedConverter.patchSha256}"`, 'Obj2Tiles patch pin');
    reviewed = replaceReviewedOnce(reviewed,
      `          EXPECTED_OBJ2TILES_PATCH_SHA256: "${reviewedConverter.patchSha256}"`,
      `          EXPECTED_OBJ2TILES_PATCH_SHA256: "${reviewedConverter.patchSha256}"\n          EXPECTED_OBJ2TILES_LOCKSET_SHA256: "${reviewedConverter.lockSetSha256}"\n          EXPECTED_OBJ2TILES_LICENSE_NOTICE_SHA256: "${reviewedConverter.licenseNoticeSha256}"`,
      'Obj2Tiles lock and license pins');
    reviewed = replaceReviewedOnce(reviewed,
      '            -e EXPECTED_OBJ2TILES_PATCH_SHA256="$EXPECTED_OBJ2TILES_PATCH_SHA256" \\\n            "$VERIFY_IMAGE" -e',
      '            -e EXPECTED_OBJ2TILES_PATCH_SHA256="$EXPECTED_OBJ2TILES_PATCH_SHA256" \\\n            -e EXPECTED_OBJ2TILES_LOCKSET_SHA256="$EXPECTED_OBJ2TILES_LOCKSET_SHA256" \\\n            -e EXPECTED_OBJ2TILES_LICENSE_NOTICE_SHA256="$EXPECTED_OBJ2TILES_LICENSE_NOTICE_SHA256" \\\n            "$VERIFY_IMAGE" -e',
      'Obj2Tiles verifier environment');
    reviewed = replaceReviewedOnce(reviewed,
      '              if(info.schemaVersion!==1||info.sourceVersion!=="v1.6.2"||info.sourceSha256!==process.env.EXPECTED_OBJ2TILES_SOURCE_SHA256||info.patchSha256!==process.env.EXPECTED_OBJ2TILES_PATCH_SHA256||info.binarySha256!==binary)process.exit(1);',
      '              if(info.schemaVersion!==2||info.sourceVersion!=="v1.6.2"||info.sourceSha256!==process.env.EXPECTED_OBJ2TILES_SOURCE_SHA256||info.patchSha256!==process.env.EXPECTED_OBJ2TILES_PATCH_SHA256||info.imageSharpVersion!=="3.2.0"||info.lockSetSha256!==process.env.EXPECTED_OBJ2TILES_LOCKSET_SHA256||info.licenseNoticeSha256!==process.env.EXPECTED_OBJ2TILES_LICENSE_NOTICE_SHA256||info.binarySha256!==binary)process.exit(1);\n' +
      '              const license="/opt/obj2tiles/licenses/imagesharp-3.2.0/";\n' +
      '              if(crypto.createHash("sha256").update(fs.readFileSync(license+"manifest.json")).digest("hex")!==info.licenseNoticeSha256)process.exit(2);\n' +
      '              const manifest=JSON.parse(fs.readFileSync(license+"manifest.json","utf8"));\n' +
      '              for(const item of manifest.files){const actual=crypto.createHash("sha256").update(fs.readFileSync(license+item.path)).digest("hex");if(actual!==item.sha256)process.exit(3);}',
      'Obj2Tiles build and license manifest verification');
  } else {
    reviewed = replaceReviewedOnce(reviewed,
      '          EXPECTED_OBJ2TILES_VERSION: "1.6.2"',
      `          EXPECTED_OBJ2TILES_VERSION: "1.6.2"\n          EXPECTED_OBJ2TILES_LOCKSET_SHA256: "${reviewedConverter.lockSetSha256}"\n          EXPECTED_OBJ2TILES_LICENSE_NOTICE_SHA256: "${reviewedConverter.licenseNoticeSha256}"`,
      'attestation dependency and license pins');
  }

  assert.equal(migratedSteps.get(name).split('EXPECTED_SCHEMA_VERSION: "42"').length - 1, 1,
    `${name}: candidate schema pin must match the reviewed migration`);
  return reviewed;
}


test('Viewer publication only watches its imported application and workflow', () => {
  assert.doesNotMatch(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  push:\n    branches: \[main\]\n    paths:/m);
  assert.doesNotMatch(workflow, /^  (?:pull_request|pull_request_target):/m);
  for (const event of ['push']) {
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
  assert.equal(actual, reviewedUpstreamStep('Verify exact candidate image'), 'Only the explicitly reviewed schema and converter advances may differ from the upstream runtime gate');
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
