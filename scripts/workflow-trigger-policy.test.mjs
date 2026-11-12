import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.github/workflows');
const read = filename => fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');

// Hosted runners are main-only. PR and work-branch checks run locally before merge.
const MAIN_ONLY = '    branches: [main]';
// Deliberately accept only the small trigger syntax used here. A new event or
// YAML representation needs policy review rather than silently bypassing it.
function assertTriggerPolicy(source) {
  assert.equal((source.match(/^on:/gm) ?? []).length, 1, 'one explicit trigger mapping is required');
  const mapping = source.match(/^on:\n((?:[ \t].*\n|\n)*)/m)?.[1];
  assert.ok(mapping, 'triggers must use an explicit block mapping');
  const events = [...mapping.matchAll(/^  ([a-z_]+):\s*$/gm)].map(match => match[1]);
  assert.ok(events.length > 0, 'at least one supported event is required');
  assert.equal(new Set(events).size, events.length, 'duplicate events are forbidden');
  for (const line of mapping.split('\n').filter(line => /^  \S/.test(line))) {
    assert.match(line, /^  (?:push|workflow_dispatch):$/, 'each event must use a supported block representation');
  }
  for (const block of mapping.split(/^  (?=[a-z_]+:)/m).slice(1)) {
    const [event, ...lines] = block.trimEnd().split('\n');
    if (event === 'workflow_dispatch:') {
      const jobs = source.slice(source.indexOf('\njobs:\n') + 7).split(/^  (?=[A-Za-z0-9_-]+:\n)/m).slice(1);
      assert.ok(jobs.length > 0, 'manual dispatch requires guarded jobs');
      for (const job of jobs) {
        const header = job.split(/^    (?:steps|uses):/m)[0];
        assert.match(header, /^    if: \$\{\{ github\.ref == 'refs\/heads\/main'(?: && \(| \}\})/m,
          'manual dispatch requires every job to be main-guarded');
      }
      continue;
    }
    assert.equal(event, 'push:', 'only main push or guarded manual events are allowed');
    assert.equal(lines.filter(line => line === MAIN_ONLY).length, 1, 'push must explicitly target only main');
    for (const line of lines) {
      assert.ok(!line.trim() || line === MAIN_ONLY || line === '    paths:' ||
        /^      - (?:'[^']+'|"[^"]+"|[^\s'"#][^#]*)$/.test(line), `unsupported trigger filter: ${line}`);
    }
  }
}

for (const name of fs.readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort()) {
  test(`${name} has a reviewed trigger boundary`, () => {
    const source = read(path.join(directory, name));
    if (name === 'production-auto-release.yml') assertProductionAutoReleasePolicy(source);
    else if (name === 'production-auto-diagnostic.yml') assertProductionAutoDiagnosticPolicy(source);
    else assertTriggerPolicy(source);
  });
}

function assertProductionAutoReleasePolicy(source) {
  const trigger = `on:\n  workflow_run:\n    branches: [main]\n    workflows: [CI]\n    types: [completed]\n`;
  assert.ok(source.startsWith(`name: Production automatic frontend and backend release\n\n${trigger}`), 'only the exact CI-completion event is allowed');
  assert.equal((source.match(/^  workflow_run:/gm) ?? []).length, 1);
  assert.ok(!/^  (?:push|pull_request|pull_request_target|schedule|workflow_dispatch|repository_dispatch):/m.test(source));
  assert.ok(source.includes("github.event.workflow_run.event == 'push'"));
  assert.ok(source.includes("github.event.workflow_run.head_branch == 'main'"));
  assert.ok(source.includes("github.event.workflow_run.conclusion == 'success'"));
  assert.ok(source.includes("github.event.workflow_run.repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'"));
  assert.ok(source.includes("github.event.workflow_run.head_repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'"));
  assert.ok(source.includes("vars.PRODUCTION_AUTO_RELEASE_ENABLED == 'true'"));
  assert.doesNotMatch(source, /^permissions:/m, 'write permissions must not be granted to every workflow job');
  assert.match(source, /^concurrency:\n  group: production-auto-installation-\$\{\{ github\.repository \}\}\n  cancel-in-progress: false$/m,
    'all release workers share one non-cancelling installation lock');
  assert.doesNotMatch(source, /^    concurrency:/m, 'release jobs must not use separate worker locks');
  assert.doesNotMatch(source, /^      matrix:/m, 'release lanes must not run concurrently as a matrix');
  assert.doesNotMatch(source, /^permissions:/m, 'write permissions must remain scoped to release jobs');
  assert.match(source, /These source-bound handoff fields are not proof of a predecessor's active version/);
  const jobs = source.slice(source.indexOf('\njobs:\n') + 7);
  const job = id => {
    const match = jobs.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  release-[a-z-]+:\\n|(?![\\s\\S]))`, 'm'));
    assert.ok(match, `missing job ${id}`);
    return match[1];
  };
  const client = job('release-client'), operations = job('release-operations'), sync = job('release-sync');
  assert.ok(jobs.indexOf('release-client:') < jobs.indexOf('release-operations:')
    && jobs.indexOf('release-operations:') < jobs.indexOf('release-sync:'), 'release jobs must be declared Client, Operations, Sync');
  assert.doesNotMatch(client, /^    needs:/m);
  assert.match(operations, /^    needs: release-client$/m);
  assert.match(sync, /^    needs: release-operations$/m);

  const exactGate = ["github.ref == 'refs/heads/main'", "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'",
    "github.event.workflow_run.head_repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'",
    "vars.PRODUCTION_AUTO_RELEASE_ENABLED == 'true'"];
  for (const [id, content] of [['release-client', client], ['release-operations', operations], ['release-sync', sync]]) {
    for (const gate of exactGate) assert.ok(content.includes(gate), `${id} must retain exact main-CI gate ${gate}`);
    assert.match(content, /^    permissions:\n      contents: write\n      actions: read$/m,
      `${id} must receive only release job token permissions`);
    assert.match(content, /^      completion: \$\{\{ steps\.completion\.outputs\.completion \}\}$/m);
    assert.match(content, /^      source_sha: \$\{\{ steps\.completion\.outputs\.source_sha \}\}$/m);
    assert.match(content, /^      release_id: \$\{\{ steps\.release\.outputs\.release_id \}\}$/m);
    assert.match(content, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    assert.match(content, /persist-credentials: false/);
    assert.match(content, /Install locked application build dependencies/);
    assert.match(content, /Require durable release artifact association/);
    assert.match(content, /if-no-files-found: error/);
    assert.match(content, /include-hidden-files: true/);
    assert.match(content, /node scripts\/production-auto-journal-artifact\.mjs/);
    assert.match(content, /RELEASE_OUTCOME: \$\{\{ steps\.release\.outcome \}\}/);
    assert.match(content, /JOURNAL_OUTCOME: \$\{\{ steps\.journal\.outcome \}\}/);
    assert.match(content, /Publish source-bound .* job completion/);
    assert.ok(content.indexOf('Require durable release artifact association') < content.indexOf('Publish source-bound '),
      `${id} may publish completion only after artifact association`);
    assert.match(content, /echo "completion=success" >> "\$GITHUB_OUTPUT"/);
    assert.match(content, /echo "source_sha=\$\{\{ github\.event\.workflow_run\.head_sha \}\}" >> "\$GITHUB_OUTPUT"/);
  }
  assert.match(operations, /needs\.release-client\.result == 'success'/);
  assert.match(operations, /needs\.release-client\.outputs\.completion == 'success'/);
  assert.match(operations, /needs\.release-client\.outputs\.source_sha == github\.event\.workflow_run\.head_sha/);
  assert.match(operations, /needs\.release-client\.outputs\.release_id != ''/);
  assert.match(operations, /PRODUCTION_AUTO_PREDECESSOR_COMPLETION: \$\{\{ needs\.release-client\.outputs\.completion \}\}/);
  assert.match(operations, /PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: \$\{\{ needs\.release-client\.outputs\.source_sha \}\}/);
  assert.match(operations, /PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: \$\{\{ needs\.release-client\.outputs\.release_id \}\}/);
  assert.match(sync, /needs\.release-operations\.result == 'success'/);
  assert.match(sync, /needs\.release-operations\.outputs\.completion == 'success'/);
  assert.match(sync, /needs\.release-operations\.outputs\.source_sha == github\.event\.workflow_run\.head_sha/);
  assert.match(sync, /needs\.release-operations\.outputs\.release_id != ''/);
  assert.match(sync, /PRODUCTION_AUTO_PREDECESSOR_COMPLETION: \$\{\{ needs\.release-operations\.outputs\.completion \}\}/);
  assert.match(sync, /PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: \$\{\{ needs\.release-operations\.outputs\.source_sha \}\}/);
  assert.match(sync, /PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: \$\{\{ needs\.release-operations\.outputs\.release_id \}\}/);

  for (const [content, worker, app, runtime] of [
    [client,'ledgetop-clients','client','production-auto-runtime.mjs'],
    [operations,'ledgetop-ops','operations','production-auto-runtime.mjs'],
    [sync,'ledgetop-ops-sync','ops-sync','production-auto-sync-runtime.mjs'],
  ]) {
    assert.ok(content.includes(`npm ci --prefix apps/${app}`), `missing locked dependency install for ${worker}`);
    assert.ok(content.includes(`PRODUCTION_AUTO_WORKER: ${worker}`), `missing worker lane ${worker}`);
    assert.ok(content.includes(`node scripts/${runtime}`), `missing runtime ${runtime}`);
    assert.ok(content.includes(`.backups/production-auto-release/${worker}/`), `missing exact response path for ${worker}`);
  }
  const dependencyInstalls = [...source.matchAll(/- name: Install locked application build dependencies\n([\s\S]*?)\n\n      - name:/g)].map(match => match[1]);
  assert.equal(dependencyInstalls.length, 3, 'each target installs its own locked app dependencies');
  for (const install of dependencyInstalls) assert.doesNotMatch(install, /secrets\.|GITHUB_TOKEN|CLOUDFLARE_API_TOKEN|NATIVE_STAFF_CUTOVER_REVIEW_JSON/,
    'dependency lifecycle scripts receive no provider or GitHub token secrets');
  assert.ok(source.includes('node scripts/production-auto-runtime.mjs'));
  assert.ok(source.includes('node scripts/production-auto-sync-runtime.mjs'));
  assert.ok(source.includes('node scripts/production-auto-journal-artifact.mjs'));
  assert.ok(source.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
  assert.ok(source.includes('actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f'));
  assert.ok(source.includes('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'));
  assert.ok(!source.includes('download-artifact') && !source.includes('workflow_dispatch') && !source.includes('schedule:'));
}

// The read-only diagnostic: the same exact CI-completion trigger as the release, off by default, only while the
// global release is OFF, read-only token, the release's shared lock, and the pinned probe run outside the checkout.
function assertProductionAutoDiagnosticPolicy(source) {
  const trigger = `on:\n  workflow_run:\n    branches: [main]\n    workflows: [CI]\n    types: [completed]\n`;
  assert.ok(source.startsWith(`name: Production automatic release read-only diagnostic\n\n${trigger}`), 'only the exact CI-completion event is allowed');
  assert.equal((source.match(/^  workflow_run:/gm) ?? []).length, 1);
  assert.ok(!/^  (?:push|pull_request|pull_request_target|schedule|workflow_dispatch|repository_dispatch|workflow_call):/m.test(source));
  assert.doesNotMatch(source, /^permissions:/m);
  assert.match(source, /^concurrency:\n  group: production-auto-installation-\$\{\{ github\.repository \}\}\n  cancel-in-progress: false$/m,
    'the diagnostic shares the release installation lock');
  const jobs = [...source.slice(source.indexOf('\njobs:\n') + 7).matchAll(/^  ([A-Za-z0-9_-]+):\n/gm)].map(match => match[1]);
  assert.deepEqual(jobs, ['diagnose-client'], 'exactly one diagnostic job');
  for (const gate of ["github.ref == 'refs/heads/main'", "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'",
    "github.event.workflow_run.head_repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'",
    "vars.PRODUCTION_AUTO_DIAGNOSTIC_ENABLED == 'true'", "vars.PRODUCTION_AUTO_RELEASE_ENABLED == 'false'"])
    assert.ok(source.includes(gate), `diagnostic must retain gate ${gate}`);
  assert.doesNotMatch(source, /vars\.PRODUCTION_AUTO_RELEASE_ENABLED == 'true'/, 'never runs while the release is on');
  assert.match(source, /^    permissions:\n      contents: read\n      actions: read$/m, 'read-only token');
  assert.doesNotMatch(source, /write/, 'no write permission, upload or journal step');
  assert.ok(!source.includes('upload-artifact') && !source.includes('download-artifact') && !source.includes('production-auto-journal-artifact'));
  assert.ok(!/node scripts\/production-auto-(?:sync-)?runtime\.mjs/.test(source), 'never runs a release runtime');
  assert.match(source, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.ok(source.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
  assert.ok(source.includes('actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f'));
  const install = source.match(/- name: Install locked application build dependencies\n([\s\S]*?)\n\n      - name:/)?.[1];
  assert.ok(install?.includes('npm ci --prefix apps/client'), 'same Client dependency preparation as the release lane');
  assert.doesNotMatch(install, /secrets\.|GITHUB_TOKEN|CLOUDFLARE_API_TOKEN/, 'npm receives no secrets');
  assert.equal((source.match(/secrets\./g) ?? []).length, 1, 'only the existing Cloudflare secret');
  assert.ok(source.includes('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'));
  assert.ok(source.includes('PRODUCTION_AUTO_WORKER: ledgetop-clients'));
  assert.ok(source.includes('PRODUCTION_AUTO_PROBE_CHECKOUT: ${{ github.workspace }}'));
  for (const name of ['PROBE_SHA256', 'RUNNER_SHA256']) assert.match(source, new RegExp(`${name}: [0-9a-f]{64}\n`), `${name} pinned`);
  assert.match(source, /sha256sum --check --strict/);
  assert.match(source, /node "\$RUNNER_TEMP\/production-auto-diagnostic\/production-auto-diagnostic-run\.mjs"/, 'probe runs outside the checkout');
  assert.match(source, /timeout-minutes: 25/);
  assert.match(source, /timeout 20m node/);
  assert.match(source, /head -c 16384/);
  assert.match(source, /ORIGINAL_CI_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(source, /DIAGNOSTIC_RUN_ID: \$\{\{ github\.run_id \}\}/);
  // The bounded report is also printed to the job log (the only API-readable place), from the bounded file only.
  assert.ok(source.includes(`printf 'diagnostic_report %s\\n' "$(head -c 16384 "$RUNNER_TEMP/production-auto-diagnostic/report.json.bounded")"`),
    'the job log carries the bounded report line');
}

test('production automatic diagnostic policy rejects enabling it with the release, write tokens and extra triggers', () => {
  const source = read(path.join(directory, 'production-auto-diagnostic.yml'));
  for (const [before, after] of [
    ["vars.PRODUCTION_AUTO_RELEASE_ENABLED == 'false'", "vars.PRODUCTION_AUTO_RELEASE_ENABLED == 'true'"],
    ["vars.PRODUCTION_AUTO_DIAGNOSTIC_ENABLED == 'true'", "true"],
    ['contents: read', 'contents: write'],
    ['branches: [main]', 'branches: [main, dev]'],
    ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.conclusion == 'failure'"],
    ['persist-credentials: false', 'persist-credentials: true'],
    ['cancel-in-progress: false', 'cancel-in-progress: true'],
    ['npm ci --prefix apps/client', 'npm ci --prefix apps/client\n        env:\n          CLOUDFLARE_API_TOKEN: x'],
    ['sha256sum --check --strict', 'true'],
    ['timeout 20m node', 'node'],
  ]) assert.throws(() => assertProductionAutoDiagnosticPolicy(source.replaceAll(before, after)), before);
  assert.throws(() => assertProductionAutoDiagnosticPolicy(source.replace('  workflow_run:', '  workflow_dispatch:\n  workflow_run:')));
  assert.throws(() => assertProductionAutoDiagnosticPolicy(`${source}\n      - run: node scripts/production-auto-runtime.mjs\n`));
});

test('production automatic release policy rejects PR, fork, unsuccessful, manual and push trigger changes', () => {
  const source = read(path.join(directory, 'production-auto-release.yml'));
  for (const [before, after] of [
    ['branches: [main]', 'branches: [main, dev]'],
    ['types: [completed]', 'types: [requested]'],
    ["github.event.workflow_run.event == 'push'", "github.event.workflow_run.event == 'pull_request'"],
    ["github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_branch == 'feature'"],
    ["github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.conclusion == 'failure'"],
    ["github.event.workflow_run.head_repository.full_name == 'ledgetoptechnologies/LedgeTop-Ops'", "github.event.workflow_run.head_repository.full_name == 'fork/repo'"],
    ['cancel-in-progress: false', 'cancel-in-progress: true'],
    ['persist-credentials: false', 'persist-credentials: true'],
    ['contents: write', 'contents: read'],
  ]) assert.throws(() => assertProductionAutoReleasePolicy(source.replace(before, after)), before);
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('  workflow_run:', '  push:\n    branches: [main]\n  workflow_run:')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('    workflows: [CI]', '    workflows: [Other]')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('concurrency:\n  group: production-auto-installation-${{ github.repository }}\n  cancel-in-progress: false\n', '')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('    permissions:\n      contents: write\n      actions: read\n', '')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace(
    "needs.release-client.outputs.source_sha == github.event.workflow_run.head_sha",
    "needs.release-client.outputs.source_sha == 'wrong'")));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('needs: release-client', 'needs: release-sync')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('needs: release-operations', 'needs: release-client')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace(
    '    permissions:\n      contents: write\n      actions: read\n',
    'permissions:\n  contents: write\n  actions: read\n')));
});

test('policy rejects branch pushes, tags, schedules and manual or external dispatch', () => {
  for (const triggers of [
    '  push:\n',
    '  push:\n    branches: [main, dev]\n',
    '  push:\n    branches: [main]\n    tags: ["*"]\n',
    '  workflow_dispatch:\n',
    '  repository_dispatch:\n',
    '  workflow_call:\n',
    '  schedule:\n    - cron: "0 * * * *"\n',
    '  pull_request:\n  push: {branches: [dev]}\n',
    '  push:\n    branches: [main]\n  schedule: [{cron: "0 * * * *"}]\n',
    '  push:\n    branches: [main]\n  workflow_dispatch: {}\n',
    '  push:\n    branches: [main]\n  repository_dispatch: {}\n',
  ]) assert.throws(() => assertTriggerPolicy(`on:\n${triggers}\njobs:\n`), triggers);
  assert.throws(() => assertTriggerPolicy('on: [push, pull_request]\njobs:\n'));
});

test('policy accepts only main pushes with optional exact path filters', () => {
  assertTriggerPolicy(`on:\n  push:\n${MAIN_ONLY}\n\njobs:\n`);
  assertTriggerPolicy(`on:\n  push:\n${MAIN_ONLY}\n    paths:\n      - 'apps/x/**'\n\njobs:\n`);
});

test('policy rejects every pull-request event even when the target is main', () => {
  for (const event of ['pull_request', 'pull_request_target']) {
    for (const filter of ['', `${MAIN_ONLY}\n`, `${MAIN_ONLY}\n    types: [opened, synchronize]\n`]) {
      assert.throws(() => assertTriggerPolicy(`on:\n  ${event}:\n${filter}  push:\n${MAIN_ONLY}\n\njobs:\n`));
    }
  }
});

test('trigger policy is enforced by ordinary source-invariants CI', () => {
  const ci = read(path.join(directory, 'ci.yml'));
  const job = ci.slice(ci.indexOf('  source-invariants:'), ci.indexOf('  incoming-pickup:'));
  assert.ok(job.includes('run: node --test scripts/workflow-trigger-policy.test.mjs'));
});
