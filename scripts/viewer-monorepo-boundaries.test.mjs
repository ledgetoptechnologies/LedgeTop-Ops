import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const workflow = read('.github/workflows/publish-viewer.yml');
const upstream = read('apps/viewer/.github/workflows/viewer-image.yml');
const releaseGuard = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const shaTagStep = 'Publish immutable sha tag for verified digest';
const moveStep = 'Move latest to this verified main build (never to an older commit)';
const beforeMove = workflow.slice(0, workflow.indexOf(`      - name: ${moveStep}\n`));

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
const reviewedFolderMigration = { version: 48, name: 'project_organizational_folders' };
const reviewedAuthorizationGenerationMigration = { version: 91, name: 'task_authorization_generations' };
const reviewedRestrictedSessionLifecycleMigration = { version: 92, name: 'restricted_viewer_session_lifecycle' };
const reviewedRestrictedSessionLifecycleSqlSha256 = '9f562ccdcf1923d52b3298527f8a25d64033cea9b1b8e507c2575defd697d243';
const reviewedGcpRolesMigration = { version: 93, name: 'gcp_point_roles' };
const reviewedGcpRolesSqlSha256 = '35741fb2eb5a77d0bb24c1f2a4c42c3ee535a0a079b66f37e4a229ac49be8adc';
const reviewedTimerMigration = { version: 83, name: 'provider_engine_processing_elapsed' };
const reviewedTimerSqlSha256 = 'c8b8205fbcf5b066030223c1176527f347ffc1bf4861b6ccf32e5845000f3214';
// Schema 84 is below the pinned maximum (it was reserved before 85 and 86 shipped), so
// MAX(version) is the same with or without it. It is pinned by name and SQL here and the
// candidate image is checked for it by name.
const reviewedMarksMigration = { version: 84, name: 'viewer_coordinate_marks' };
const reviewedMarksSqlSha256 = 'a52d3f8dca73392f6032d080364e50e2eb1253fb62083f5f7f57943c848d69ab';
const attestedMigrations = [reviewedMarksMigration, { version: 90, name: 'viewer_mark_sharing' }, reviewedAuthorizationGenerationMigration, reviewedRestrictedSessionLifecycleMigration, reviewedGcpRolesMigration];
const imageSchemaQuery = '            try{process.stdout.write(String(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version));}\n';
const reviewedImageSchemaQuery = `            try {
              const readMigration=db.prepare("SELECT name FROM schema_migrations WHERE version=?");
              for(const [version,name] of ${JSON.stringify(attestedMigrations.map(({ version, name }) => [version, name]))}){
                if(readMigration.get(version)?.name!==name)throw new Error(\`Schema \${version} is missing or recorded under another name\`);
              }
              process.stdout.write(String(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version));
            }\n`;
const reviewedProviderRemovalMigration = { version: 85, name: 'processing_provider_removal' };
const reviewedProviderRemovalSqlSha256 = 'a916f9316bc0c2d332e599113b8bf8eee0657294bc6236270612b3902808a913';
const reviewedTrashPurgeMigration = { version: 86, name: 'trash_container_purge_started' };
const reviewedTrashPurgeSqlSha256 = '52576879d42af94bde93b510d936442a8d6e407e559068bbb1874442b2d61f8b';
const reviewedMarkSharingMigration = { version: 90, name: 'viewer_mark_sharing' };
const reviewedMarkSharingSqlSha256 = 'cb17340d0a549ba04ece26cfb31aec4253d02a6cf3ad771eb1be114f656c15dc';
const reviewedCandidateSchemaPin = 'EXPECTED_SCHEMA_VERSION: "93"';
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
// migration. Schema 48 adds project folders and same-project task placement;
// schema 83 adds an attempt- and provider-task-bound engine elapsed
// record; schema 84 adds Viewer Marks, mark categories and mark accounts; schema 85
// adds nullable removed_at/removed_by provider archive
// columns; schema 86 adds a nullable storage_trash.purge_started_at marker for
// crash-safe Recycle Bin container purges; schema 90 adds tables for staff marks
// shared on a model and their earlier versions (87 to 89 are not used here).
// Schema 91 adds the monotonic per-task
// authorization generation that fences restricted client credentials and requires
// 48 (its earlier reservation, 52, was never shipped). Schema 92 guards redemption
// and renewal of restricted Viewer credentials. Schema 93 adds the ground control
// point role (control or checkpoint) and immutable per-attempt checkpoint lists.
// The candidate image verification and attestation pins advance from the upstream 38 to 93; the other runtime,
// numerical, promotion and digest
// guards remain fully compared.
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
  assert.equal(original.split('EXPECTED_SCHEMA_VERSION: "38"').length - 1, 1,
    `${name}: expected historical schema pin must occur exactly once`);
  let reviewed = replaceReviewedOnce(original, 'EXPECTED_SCHEMA_VERSION: "38"',
    reviewedCandidateSchemaPin, `${name} schema pin`);

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
    reviewed = replaceReviewedOnce(reviewed, imageSchemaQuery, reviewedImageSchemaQuery, 'named image migrations');
  } else {
    reviewed = replaceReviewedOnce(reviewed,
      '          EXPECTED_OBJ2TILES_VERSION: "1.6.2"',
      `          EXPECTED_OBJ2TILES_VERSION: "1.6.2"\n          EXPECTED_OBJ2TILES_LOCKSET_SHA256: "${reviewedConverter.lockSetSha256}"\n          EXPECTED_OBJ2TILES_LICENSE_NOTICE_SHA256: "${reviewedConverter.licenseNoticeSha256}"`,
      'attestation dependency and license pins');
  }

  assert.equal(migratedSteps.get(name).split(reviewedCandidateSchemaPin).length - 1, 1,
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
  for (const name of ['Log in to GitHub Container Registry', shaTagStep, 'Write verified release attestation', 'Upload release attestation']) {
    assert.ok(migratedSteps.get(name).includes(`if: ${releaseGuard}\n`), `${name} must execute only on main pushes`);
  }
  assert.match(migratedSteps.get('Set isolated candidate reference'), /candidate-\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/);
});

test('Before its last step a main build publishes only immutable candidate tags', () => {
  const metadata = migratedSteps.get('Generate image metadata');
  assert.match(metadata, /flavor: \|\n            latest=false/);
  assert.match(metadata, /tags: \|\n            type=sha,prefix=sha-,format=long\n            type=ref,event=tag$/);
  assert.ok(beforeMove.length > 0 && beforeMove.length < workflow.length);
  assert.doesNotMatch(beforeMove, /value=latest|:latest\b|--tag "\$IMAGE_NAME:latest"/);
  assert.equal(migratedSteps.has('Promote verified digest to release tags'), false);
  const tagStep = migratedSteps.get(shaTagStep);
  assert.match(tagStep, /tag="\$IMAGE_NAME:sha-\$EXPECTED_REVISION"\n          test "\$FINAL_TAGS" = "\$tag"/);
  assert.match(tagStep, /test "\$EXISTING_DIGEST" = "\$IMAGE_DIGEST" \|\| \{ echo "::error::\$tag already names \$EXISTING_DIGEST; immutable sha tags are never moved"; exit 1; \}/);
  assert.match(tagStep, /grep -qi 'not found' inspect-error\.txt \|\| \{ cat inspect-error\.txt >&2; exit 1; \}\n            docker buildx imagetools create --tag "\$tag" "\$PUBLISHED_IMAGE"/);
  assert.match(tagStep, /PROMOTED_DIGEST="\$\(docker buildx imagetools inspect "\$tag" --format '\{\{json \.Manifest\.Digest\}\}' \| tr -d '"'\)"\n          test "\$PROMOTED_DIGEST" = "\$IMAGE_DIGEST"/);
  assert.equal((tagStep.match(/imagetools create/g) ?? []).length, 1);
  assert.doesNotMatch(tagStep, /always\(\)|continue-on-error|\|\|\s*true/);
  assert.match(workflow, /^concurrency:\n  group: publish-viewer-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m,
    'a running build is never cancelled between its tag and attestation steps');
});

test('Only the manual main-only promotion moves latest, after verifying a successful main candidate', () => {
  const promote = read('.github/workflows/promote-viewer.yml');
  const promoteSteps = steps(promote);
  assert.match(promote, /^on:\n  workflow_dispatch:\n    inputs:\n      commit:\n[\s\S]*?\n      digest:\n/m);
  assert.doesNotMatch(promote, /^  (?:push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call):/m);
  assert.match(promote, /^permissions:\n  contents: read\n\nconcurrency:\n  group: latest-writer-viewer\n  cancel-in-progress: false$/m);
  assert.match(promote, /^    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}$/m);
  assert.match(promote, /^    permissions:\n      contents: read\n      actions: read\n      packages: write$/m);
  assert.doesNotMatch(promote, /\$\{\{ (?:inputs|github\.event\.inputs)\.[a-z]+ \}\}"|run: .*\$\{\{ inputs\./, 'inputs reach shell only through env');
  assert.doesNotMatch(promote, /secrets\.(?!GITHUB_TOKEN\b)/, 'promotion needs no build or licence secrets');
  assert.doesNotMatch(promote, /build-push-action|docker build\b|continue-on-error/);
  assert.deepEqual(promote.match(/always\(\)/g), ['always()'], 'only the result upload runs after a failure');
  const order = ['Require the protected promotion environment and its recorded approval', 'Validate requested candidate', 'Check out promotion verifier', 'Require the commit to be on main',
    'Find the successful main publish run for the commit', "Verify the candidate's release attestation",
    'Log in to GitHub Container Registry', 'Set up Docker Buildx', 'Verify the registry still holds the exact candidate',
    'Read current latest and resolve the rollback target', 'Persist the rollback receipt before moving latest',
    'Upload the rollback receipt', 'Move latest to the verified digest', 'Upload the promotion result'];
  assert.deepEqual([...promoteSteps.keys()], order);
  assert.match(promoteSteps.get('Require the commit to be on main'), /compare\/\$PROMOTE_COMMIT\.\.\.\$GITHUB_SHA[\s\S]*"\$STATUS" == ahead \|\| "\$STATUS" == identical/);
  const run = promoteSteps.get('Find the successful main publish run for the commit');
  for (const guard of ['-f branch=main', '-f event=push', '-f status=success', '.head_branch == \\"main\\"', '.event == \\"push\\"',
    '.conclusion == \\"success\\"', '.path == \\".github/workflows/publish-viewer.yml\\"', '.head_repository.full_name == \\"$GITHUB_REPOSITORY\\"']) {
    assert.ok(run.includes(guard), `run lookup must keep ${guard}`);
  }
  const attestation = promoteSteps.get("Verify the candidate's release attestation");
  assert.match(attestation, /--name "viewer-image-attestation-\$PROMOTE_COMMIT"/);
  assert.match(attestation, /sha256sum --check --strict viewer-image-attestation\.json\.sha256/);
  assert.match(attestation, /node apps\/viewer\/scripts\/verify-promotion-attestation\.mjs/);
  const registry = promoteSteps.get('Verify the registry still holds the exact candidate');
  assert.match(registry, /imagetools inspect "\$IMAGE_NAME:sha-\$PROMOTE_COMMIT"[\s\S]*test "\$SHA_DIGEST" = "\$PROMOTE_DIGEST"/);
  assert.match(registry, /docker pull "\$VERIFY_IMAGE"[\s\S]*568:568[\s\S]*org\.opencontainers\.image\.revision[\s\S]*= "\$PROMOTE_COMMIT"/);
  const previous = promoteSteps.get('Read current latest and resolve the rollback target');
  assert.doesNotMatch(previous, /imagetools create|2>\/dev\/null|PREVIOUS_DIGEST=none/, 'reading latest never writes and never hides errors');
  const classifierBody = previous.split('manifest_unknown_only() {')[1].split('\n          }')[0];
  assert.doesNotMatch(classifierBody, /grep -q|not found/, 'absence is an exact whole-output match, never a substring search');
  assert.ok(previous.includes('INITIALIZE_LATEST: ${{ inputs.initialize_latest }}'));
  assert.ok(previous.includes(`[[ "$INITIALIZE_LATEST" == true ]] || { echo '::error::latest is missing although production latest is expected to exist`));
  assert.ok(previous.includes(`[[ "$INITIALIZE_LATEST" == false ]] || { echo '::error::initialize_latest was requested but latest already exists`));
  assert.match(promote, /      initialize_latest:\n[\s\S]*?        default: false\n        type: boolean/);
  assert.ok(promoteSteps.get('Persist the rollback receipt before moving latest').includes('"mode": "%s"'));
  assert.match(previous, /for attempt in 1 2 3/);
  assert.ok(previous.includes('if manifest_unknown_only "$RUNNER_TEMP/inspect-error.txt" "$ref"; then'), 'absence only for the exact requested reference');
  assert.ok(previous.includes('[[ "$line" == "ERROR: $ref: MANIFEST_UNKNOWN: manifest unknown"'));
  assert.ok(previous.includes("cannot read the current latest; nothing was changed'; exit 1"));
  assert.ok(previous.includes('current latest digest is malformed'));
  assert.ok(previous.includes('inspect_digest "$IMAGE_NAME@$PREVIOUS_DIGEST"'));
  const receipt = promoteSteps.get('Persist the rollback receipt before moving latest');
  for (const field of ['previousDigest', 'newDigest', 'commit', 'candidateRunId', 'promotionRunId', 'recordedAt']) assert.ok(receipt.includes(field), field);
  assert.match(receipt, /Previous latest \(rollback target\)/);
  assert.match(promoteSteps.get('Upload the rollback receipt'), /if-no-files-found: error/);
  assert.ok(promoteSteps.get('Upload the promotion result').trimStart().startsWith("if: ${{ always() && steps.receipt.outcome == 'success' }}"));
  const move = promoteSteps.get('Move latest to the verified digest');
  assert.equal((promote.match(/imagetools create --prefer-index=false --tag "\$IMAGE_NAME:latest"/g) ?? []).length, 1, 'only the move step writes latest');
  assert.ok(move.includes('docker buildx imagetools create --prefer-index=false --tag "$IMAGE_NAME:latest" "$IMAGE_NAME@$PROMOTE_DIGEST"'));
  assert.match(move, /if \[\[ "\$PROMOTED_DIGEST" != "\$PROMOTE_DIGEST" \]\]; then\n\s+record verify-failed[\s\S]*?rollback_help[\s\S]*?exit 1/);
  assert.ok(order.indexOf('Upload the rollback receipt') < order.indexOf('Move latest to the verified digest'), 'receipt is stored before latest moves');
  // Fail-closed re-read immediately before the single write; documented as not an atomic CAS.
  const reread = move.indexOf('CURRENT="$(docker buildx imagetools inspect "$IMAGE_NAME:latest"');
  const abort = move.indexOf('record aborted-latest-changed');
  const write = move.indexOf('docker buildx imagetools create --prefer-index=false --tag "$IMAGE_NAME:latest"');
  assert.ok(reread > 0 && reread < abort && abort < write, 're-read and abort precede the write');
  assert.ok(move.includes('if [[ "$CURRENT" != "$PREVIOUS_DIGEST" ]]; then'));
  assert.ok(move.includes('if [[ "$PREVIOUS_DIGEST" == absent ]] && manifest_unknown_only "$RUNNER_TEMP/reread-error.txt" "$IMAGE_NAME:latest"; then'));
  assert.ok(move.includes('NOT an atomic compare-and-swap') && promote.split('\non:\n')[0].includes('NOT an atomic compare-and-swap'));
  assert.ok(move.includes('latest was NOT restored automatically.') && move.includes('It was NOT restored automatically'));
  // Approval is recorded, not enforced.
  assert.match(promote, /      approved_by:\n[^\n]*\n        required: true\n        type: string\n      approval_reference:\n[^\n]*\n        required: true\n        type: string/);
  assert.ok(promote.includes('APPROVED_BY: ${{ inputs.approved_by }}') && promote.includes('APPROVAL_REFERENCE: ${{ inputs.approval_reference }}'));
  const validate = promoteSteps.get('Validate requested candidate');
  assert.ok(validate.includes('"$APPROVED_BY" =~') && validate.includes('"$APPROVAL_REFERENCE" =~'));
  for (const field of ['dispatchedBy', 'approvedBy', 'typedApprovedBy', 'approvalReference', '"approvalEnvironment": "image-promotion"', '"approvalEnforced": true'])
    assert.ok(receipt.includes(field), field);
  assert.ok(promote.includes('    environment: image-promotion\n'));
  assert.ok(promote.includes('protected GitHub Environment `image-promotion`') && promote.includes('never creates or changes them'));
  assert.ok(promote.indexOf('Require the protected promotion environment and its recorded approval') < promote.indexOf('Validate requested candidate'));
});

// Every registry writer in the repository, for the Viewer image's `latest` and
// immutable tags. A new writer anywhere fails here until it is reviewed.
const REGISTRY_WRITE = /imagetools\s+create|'imagetools',\s*'create'|docker\s+push|'docker',\s*'push'|buildx\s+build[^\n]*--push|crane\s+(?:tag|copy|cp|push)|skopeo\s+copy|oras\s+(?:push|tag)/;
function workflowJobs(name) {
  const source = read(`.github/workflows/${name}`);
  const body = source.slice(source.indexOf('\njobs:\n') + 7);
  return body.split(/^  (?=[A-Za-z0-9_-]+:\n)/m).filter(Boolean).map(block => [block.slice(0, block.indexOf(':')), block]);
}
function jobWritesRegistry(block) {
  return REGISTRY_WRITE.test(block) || /uses: docker\/build-push-action[\s\S]*?\n\s+push: (?!false\b)/.test(block);
}
// Two ways a job can write the Viewer `latest`: naming the image literally (in any
// workflow), or tagging `<variable>:latest` inside a workflow that names the Viewer
// image (an alias such as $IMAGE_NAME). Other images' workflows may use the same
// variable name for their own latest and stay out of scope.
const VIEWER_LATEST_LITERAL = /ledgetop-ops-viewer:latest(?![\w.-])/;
const VIEWER_LATEST_ALIAS = /--tag\s+"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?:latest(?![\w.-])/;
function writesViewerLatest(block, viewerWorkflow) {
  return REGISTRY_WRITE.test(block)
    && (VIEWER_LATEST_LITERAL.test(block) || (viewerWorkflow && VIEWER_LATEST_ALIAS.test(block)));
}

test('Viewer latest-writer detection covers both the literal image and an alias, and only in scope', () => {
  const literal = '      - run: docker buildx imagetools create --tag ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest "$SRC"\n';
  const alias = '      - run: docker buildx imagetools create --tag "$VIEWER_REF:latest" "$VIEWER_REF@$DIGEST"\n';
  const braced = '      - run: docker buildx imagetools create --tag ${VIEWER_REF}:latest "$VIEWER_REF@$DIGEST"\n';
  // Each sample exercises exactly one alternative, so removing either alternative fails here.
  assert.ok(VIEWER_LATEST_LITERAL.test(literal) && !VIEWER_LATEST_ALIAS.test(literal));
  assert.ok(VIEWER_LATEST_ALIAS.test(alias) && !VIEWER_LATEST_LITERAL.test(alias));
  assert.ok(VIEWER_LATEST_ALIAS.test(braced));
  assert.equal(writesViewerLatest(literal, false), true, 'a literal Viewer latest write is caught in any workflow');
  assert.equal(writesViewerLatest(alias, true), true, 'an alias latest write is caught in a Viewer workflow');
  assert.equal(writesViewerLatest(braced, true), true);
  assert.equal(writesViewerLatest(alias, false), false, "another image's own latest stays out of scope");
  assert.equal(writesViewerLatest('      - run: docker buildx imagetools inspect ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest\n', true), false, 'reads are not writes');
  assert.equal(writesViewerLatest('      - run: docker buildx imagetools create --tag "$IMAGE_NAME:latest-old" x\n', true), false);
});

test('Only publish-viewer writes Viewer candidate and sha tags; latest is written only by promote-viewer and promote-latest, in one writer group', () => {
  const viewerWriters = [];
  for (const name of fs.readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/.test(file)).sort()) {
    // A workflow is in scope when it names the Viewer image anywhere (job, step or
    // workflow-level env). Other images' own latest tags (logs, thumbnails, ...) are
    // out of scope here and have their own tests.
    const viewerWorkflow = read(`.github/workflows/${name}`).includes('ledgetop-ops-viewer');
    for (const [job, block] of workflowJobs(name)) {
      const viewer = viewerWorkflow;
      if (viewer && jobWritesRegistry(block)) viewerWriters.push(`${name}#${job}`);
      if (writesViewerLatest(block, viewer)) {
        assert.ok(['promote-viewer.yml#promote', 'publish-viewer.yml#promote-latest'].includes(`${name}#${job}`), `${name}#${job} may not write the Viewer latest tag`);
      }
      if (viewer && /imagetools create --tag (?:"\$tag"|[^\n]*:sha-)/.test(block)) {
        assert.equal(`${name}#${job}`, 'publish-viewer.yml#verify-and-build', 'only the main build may write Viewer sha tags');
      }
    }
  }
  assert.deepEqual(viewerWriters.sort(), ['promote-viewer.yml#promote', 'publish-viewer.yml#promote-latest', 'publish-viewer.yml#verify-and-build']);
  // Another image's promotion that writes its own latest stays out of scope.
  assert.ok(!read('.github/workflows/promote-logs-local.yml').includes('ledgetop-ops-viewer'));
  assert.doesNotMatch(beforeMove, /:latest\b/);
  // In the publisher, only the promote-latest job writes latest: once, after the build job passed, forward only,
  // in the same writer concurrency group as promote-viewer.yml.
  assert.equal((workflow.match(/imagetools create --prefer-index=false --tag "\$IMAGE_NAME:latest"/g) ?? []).length, 1);
  assert.equal([...migratedSteps.keys()].at(-1), moveStep);
  assert.match(workflow, /\n  promote-latest:\n[^]*?\n    needs: verify-and-build\n[^]*?\n    concurrency:\n      group: latest-writer-viewer\n      cancel-in-progress: false\n      queue: max\n/);
  assert.match(migratedSteps.get(moveStep), /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.pause\.outputs\.paused == 'false'\n/);
  const promote = read('.github/workflows/promote-viewer.yml');
  assert.equal((promote.match(/docker buildx imagetools create --prefer-index=false --tag "\$IMAGE_NAME:latest"/g) ?? []).length, 1);
  // Writers are serialized: the manual and automatic writers share one group; builds never cancel mid-run.
  assert.match(promote, /^concurrency:\n  group: latest-writer-viewer\n  cancel-in-progress: false\n  queue: max$/m);
  assert.match(workflow, /^concurrency:\n  group: publish-viewer-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false$/m);
});

test('No script writes the Viewer image to a registry', () => {
  const writers = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'test-results'].includes(entry.name)) walk(relative);
      } else if (/\.(?:js|mjs|cjs|ts|sh|ps1|py)$/.test(entry.name)) {
        const text = fs.readFileSync(path.join(root, relative), 'utf8');
        if (text.includes('ledgetop-ops-viewer') && REGISTRY_WRITE.test(text)) writers.push(relative);
      }
    }
  };
  for (const directory of ['scripts', 'apps/viewer/scripts', 'apps/viewer/deploy']) {
    if (fs.existsSync(path.join(root, directory))) walk(directory);
  }
  assert.deepEqual(writers.filter(file => !file.endsWith('.test.mjs')), []);
});

test('Viewer publication preserves the reviewed migrations through schema 93', () => {
  const migrations = MIGRATIONS.filter(({ version }) => version >= reviewedAckMigrations[0].version);
  assert.deepEqual(migrations.map(({ version, name }) => ({ version, name })),
    [...reviewedAckMigrations, reviewedFolderMigration, reviewedTimerMigration, reviewedMarksMigration, reviewedProviderRemovalMigration, reviewedTrashPurgeMigration, reviewedMarkSharingMigration, reviewedAuthorizationGenerationMigration, reviewedRestrictedSessionLifecycleMigration, reviewedGcpRolesMigration], 'another schema advance requires a new explicit gate review');
  const timer = migrations.find(({ version }) => version === reviewedTimerMigration.version);
  const sqlSha256 = createHash('sha256').update(timer.sql.replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(sqlSha256, reviewedTimerSqlSha256, 'migration 83 SQL must match the reviewed timer schema');
  const marks = migrations.find(({ version }) => version === reviewedMarksMigration.version);
  assert.equal(createHash('sha256').update(marks.sql.replace(/\r\n/g, '\n')).digest('hex'), reviewedMarksSqlSha256, 'migration 84 SQL must match the reviewed Marks schema');
  const removal = migrations.find(({ version }) => version === reviewedProviderRemovalMigration.version);
  assert.equal(createHash('sha256').update(removal.sql.replace(/\r\n/g, '\n')).digest('hex'), reviewedProviderRemovalSqlSha256, 'migration 85 SQL must match the reviewed provider-removal schema');
  const trashPurge = migrations.find(({ version }) => version === reviewedTrashPurgeMigration.version);
  assert.equal(createHash('sha256').update(trashPurge.sql.replace(/\r\n/g, '\n')).digest('hex'), reviewedTrashPurgeSqlSha256, 'migration 86 SQL must match the reviewed trash-purge schema');
  const sharing = migrations.find(({ version }) => version === reviewedMarkSharingMigration.version);
  assert.equal(createHash('sha256').update(sharing.sql.replace(/\r\n/g, '\n')).digest('hex'), reviewedMarkSharingSqlSha256, 'migration 90 SQL must match the reviewed mark-sharing schema');
  const restrictedSessions = migrations.find(({ version }) => version === reviewedRestrictedSessionLifecycleMigration.version);
  assert.equal(createHash('sha256').update(restrictedSessions.sql.replace(/\r\n/g, '\n')).digest('hex'), reviewedRestrictedSessionLifecycleSqlSha256, 'migration 92 SQL must match the reviewed lifecycle schema');
  const gcpRoles = migrations.find(({ version }) => version === reviewedGcpRolesMigration.version);
  assert.equal(createHash('sha256').update(gcpRoles.sql.replace(/\r\n/g, '\n')).digest('hex'), reviewedGcpRolesSqlSha256, 'migration 93 SQL must match the reviewed GCP roles schema');
});

test('The candidate image check refuses missing or renamed Marks and authorization migrations', () => {
  const step = migratedSteps.get('Verify exact candidate image');
  const start = step.indexOf('            const {openDatabase}=require("./server/database");');
  const end = step.indexOf("\n          ')\"", start);
  assert.ok(start > 0 && end > start);
  const script = step.slice(start, end).replace('"/tmp/release-attestation.sqlite"', '":memory:"');
  const check = prelude => spawnSync(process.execPath, ['-e', prelude + script], { cwd: path.join(root, 'apps/viewer'), encoding: 'utf8' });
  const migrations = 'const {MIGRATIONS}=require("./server/database");';
  const complete = check('');
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(`EXPECTED_SCHEMA_VERSION: "${complete.stdout}"`, reviewedCandidateSchemaPin);
  for (const { version } of attestedMigrations) {
    const at = `MIGRATIONS.findIndex(item=>item.version===${version})`;
    for (const prelude of [`${migrations}MIGRATIONS.splice(${at},1);`, `${migrations}MIGRATIONS[${at}].name='another_name';`]) {
      const refused = check(prelude);
      assert.notEqual(refused.status, 0);
      assert.equal(refused.stdout, '');
      assert.match(refused.stderr, new RegExp(`Schema ${version} is missing or recorded under another name`));
    }
  }
});

test('All upstream runtime and numerical-engine verification remains intact', () => {
  const actual = migratedSteps.get('Verify exact candidate image').replace(
    'if [[ "$GITHUB_EVENT_NAME" == "push" && "$GITHUB_REF" == "refs/heads/main" ]]; then',
    'if [[ "$GITHUB_EVENT_NAME" == "push" ]]; then',
  );
  assert.equal(actual, reviewedUpstreamStep('Verify exact candidate image'), 'Only the explicitly reviewed schema and converter advances may differ from the upstream runtime gate');
  assert.ok(workflow.indexOf('- name: Verify exact candidate image') < workflow.indexOf(`- name: ${shaTagStep}`));
  assert.match(actual, /test "\$CANDIDATE_DIGEST" = "\$IMAGE_DIGEST"/);
  assert.match(actual, /VERIFY_IMAGE="\$IMAGE_NAME@\$IMAGE_DIGEST"/);
  assert.match(actual, /-v "\$PWD\/test:\/app\/test:ro"/);
});

test('Attestation retains exact verified digest semantics', () => {
  // The upstream "Promote verified digest to release tags" step is replaced by the
  // reviewed write-once sha tag step above; `latest` moves in the promote-latest job (promote-viewer.yml for rollback).
  for (const name of ['Write verified release attestation']) {
    const actual = migratedSteps.get(name).replace(`if: ${releaseGuard}`, "if: github.event_name == 'push'");
    assert.equal(actual, reviewedUpstreamStep(name), `${name} must retain the upstream digest/attestation checks`);
  }
  assert.ok(workflow.indexOf(`- name: ${shaTagStep}`) < workflow.indexOf('- name: Write verified release attestation'),
    'the attestation is written only after the sha tag is confirmed');
  assert.match(migratedSteps.get('Upload release attestation'), /path: \|\n            apps\/viewer\/viewer-image-attestation\.json\n            apps\/viewer\/viewer-image-attestation\.json\.sha256/);
});

test('Container Viewer does not join the Cloudflare application source registry', () => {
  const requirements = read('scripts/staging-requirements.mjs');
  const registry = requirements.match(/export const APP_SOURCE_DIRS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1];
  assert.ok(registry);
  assert.doesNotMatch(registry, /viewer/);
});

test('Latest absence is accepted only from an exact MANIFEST_UNKNOWN for the exact requested reference', (t) => {
  const bash = spawnSync('bash', ['-c', 'true']);
  if (bash.error || bash.status !== 0) { t.skip('needs bash'); return; }
  const promote = read('.github/workflows/promote-viewer.yml');
  const start = promote.indexOf('          manifest_unknown_only() {');
  const end = promote.indexOf('\n          }\n', start) + '\n          }\n'.length;
  assert.ok(start > 0 && end > start);
  assert.equal(promote.split(promote.slice(start, end)).length - 1, 2, 'the same classifier guards the first read and the pre-write re-read');
  const classifier = promote.slice(start, end);
  const classify = message => spawnSync('bash', ['-c', `${classifier}\nf="$(mktemp)"; printf '%s' "$MSG" > "$f"; manifest_unknown_only "$f" "$REF"; r=$?; rm -f "$f"; exit $r`],
    { env: { ...process.env, MSG: message, REF: requested } }).status;
  const ref = 'ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest';
  let requested = ref;
  assert.equal(classify(`ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown; map[Tag:latest]`), 0);
  assert.equal(classify(`ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown`), 0);
  requested = `ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@sha256:${'a'.repeat(64)}`;
  assert.notEqual(classify(`ERROR: ${requested}: MANIFEST_UNKNOWN: manifest unknown`), 0, 'digest references never count as absent');
  requested = ref;
  for (const message of [
    `ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown; 401 Unauthorized`,
    `ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown; NAME_UNKNOWN: repository name not known`,
    `ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown\nERROR: dial tcp: i/o timeout`,
    `ERROR: ${ref}: manifest unknown (tls handshake retry)`,
    `ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown; 503 Service Unavailable`,
    'ERROR: ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:other: MANIFEST_UNKNOWN: manifest unknown',
    'ERROR: ghcr.io/ledgetoptechnologies/other-image:latest: MANIFEST_UNKNOWN: manifest unknown',
    'ERROR: ghcr.io/someone-else/ledgetop-ops-viewer:latest: MANIFEST_UNKNOWN: manifest unknown',
    'ERROR: docker.io/ledgetoptechnologies/ledgetop-ops-viewer:latest: MANIFEST_UNKNOWN: manifest unknown',
    `ERROR: ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@sha256:${'a'.repeat(64)}: MANIFEST_UNKNOWN: manifest unknown`,
    'ERROR: ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest-old: MANIFEST_UNKNOWN: manifest unknown',
    `ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown; map[Tag:other]`,
    `failed: ${ref}: MANIFEST_UNKNOWN: manifest unknown`,
    `ERROR: ${ref}: not found`,
    'MANIFEST_UNKNOWN',
    '',
  ]) assert.notEqual(classify(message), 0, JSON.stringify(message));
});
