import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.github/workflows');
const read = filename => fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');

// Hosted runs are for main only: pushes to main and ready pull requests into main.
// Drafts, stacked pull requests and other branches are tested on staging.
const MAIN_ONLY = '    branches: [main]';
// No `edited` or other no-op activity: such runs would only emit skipped jobs,
// and skipped jobs count as passing required checks.
const PULL_REQUEST_TYPES = '    types: [opened, synchronize, reopened, ready_for_review]';
const DRAFT_GATE = "    if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}";

// Deliberately accept only the small trigger syntax used here. A new event or
// YAML representation needs policy review rather than silently bypassing it.
function assertTriggerPolicy(source) {
  assert.equal((source.match(/^on:/gm) ?? []).length, 1, 'one explicit trigger mapping is required');
  const mapping = source.match(/^on:\n((?:[ \t].*\n|\n)*)/m)?.[1];
  assert.ok(mapping, 'triggers must use an explicit block mapping');
  for (const line of mapping.split('\n').filter(line => /^  \S/.test(line))) {
    assert.match(line, /^  (?:push|pull_request):$/, 'each event must use a supported block representation');
  }
  const events = [...mapping.matchAll(/^  ([a-z_]+):\s*$/gm)].map(match => match[1]);
  assert.ok(events.length > 0, 'at least one supported event is required');
  assert.equal(new Set(events).size, events.length, 'duplicate events are forbidden');
  for (const event of events) assert.ok(['push', 'pull_request'].includes(event), `unsupported event: ${event}`);
  for (const block of mapping.split(/^  (?=[a-z_]+:)/m).slice(1)) {
    const [event, ...lines] = block.trimEnd().split('\n');
    const isPush = event === 'push:';
    assert.equal(lines.filter(line => line === MAIN_ONLY).length, 1,
      `${event.slice(0, -1)} must explicitly target only main`);
    if (!isPush) assert.equal(lines.filter(line => line === PULL_REQUEST_TYPES).length, 1,
      'pull_request must list exactly the approved activity types');
    for (const line of lines) {
      assert.ok(!line.trim() || line === MAIN_ONLY || (!isPush && line === PULL_REQUEST_TYPES) ||
        line === '    paths:' || /^      - (?:'[^']+'|"[^"]+"|[^\s'"#][^#]*)$/.test(line),
      `unsupported trigger filter: ${line}`);
    }
  }
  if (events.includes('pull_request')) {
    // Every job either skips draft pull requests itself or waits on a job that does.
    const jobs = source.slice(source.indexOf('\njobs:\n') + 7).split(/^  (?=[A-Za-z0-9_-]+:\n)/m).slice(1);
    assert.ok(jobs.length > 0, 'jobs are required');
    for (const job of jobs) {
      const name = job.slice(0, job.indexOf(':'));
      const steps = job.search(/^    steps:/m);
      const header = (steps < 0 ? job : job.slice(0, steps)).split('\n');
      assert.ok(header.includes(DRAFT_GATE) || header.some(line => line.startsWith('    needs: ')),
        `job ${name} must skip draft pull requests`);
    }
  }
}

for (const name of fs.readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort()) {
  test(`${name} has a reviewed trigger boundary`, () => {
    const source = read(path.join(directory, name));
    if (name === 'production-auto-release.yml') assertProductionAutoReleasePolicy(source);
    else assertTriggerPolicy(source);
  });
}

function assertProductionAutoReleasePolicy(source) {
  const trigger = `on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n`;
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
  assert.doesNotMatch(source, /^concurrency:/m, 'matrix.worker is not available at workflow-level concurrency');
  const releaseJob = source.slice(source.indexOf('\n  release:\n') + 10);
  const jobHeader = releaseJob.split(/^    steps:\n/m)[0];
  assert.match(jobHeader, /^    concurrency:\n      group: production-auto-\$\{\{ matrix\.worker \}\}\n      cancel-in-progress: false$/m,
    'the per-worker concurrency key must be in the matrix job');
  assert.match(jobHeader, /^    permissions:\n      contents: write\n      actions: read$/m,
    'only the release job receives the exact minimum token permissions');
  assert.ok(source.includes('if-no-files-found: error') && source.includes('include-hidden-files: true'));
  const dependencyInstall = source.split('- name: Install locked application build dependencies\n')[1]?.split('\n      - name:')[0] ?? '';
  assert.ok(dependencyInstall.includes('npm ci --prefix apps/${{ matrix.app }}'));
  assert.ok(!dependencyInstall.includes('secrets.') && !dependencyInstall.includes('GITHUB_TOKEN')
    && !dependencyInstall.includes('CLOUDFLARE_API_TOKEN') && !dependencyInstall.includes('NATIVE_STAFF_CUTOVER_REVIEW_JSON'),
  'dependency lifecycle scripts receive no provider or GitHub token secrets');
  assert.ok(source.includes('RELEASE_OUTCOME: ${{ steps.release.outcome }}'));
  assert.ok(source.includes('JOURNAL_OUTCOME: ${{ steps.journal.outcome }}'));
  assert.ok(source.includes('Require durable release artifact association'));
  assert.ok(source.includes('cancel-in-progress: false'));
  assert.ok(source.includes('ref: ${{ github.event.workflow_run.head_sha }}'));
  assert.ok(source.includes('persist-credentials: false'));
  assert.ok(source.includes('node scripts/production-auto-runtime.mjs'));
  assert.ok(source.includes('node scripts/production-auto-sync-runtime.mjs'));
  for (const [worker, app] of [['ledgetop-ops','operations'],['ledgetop-clients','client'],['ledgetop-ops-sync','ops-sync']])
    assert.ok(source.includes(`worker: ${worker}\n            app: ${app}`), `missing exact runtime lane ${worker}`);
  assert.ok(source.includes('node scripts/production-auto-journal-artifact.mjs'));
  assert.ok(source.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'));
  assert.ok(source.includes('actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f'));
  assert.ok(source.includes('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'));
  assert.ok(!source.includes('download-artifact') && !source.includes('workflow_dispatch') && !source.includes('schedule:'));
}

test('production automatic release policy rejects PR, fork, unsuccessful, manual and push trigger changes', () => {
  const source = read(path.join(directory, 'production-auto-release.yml'));
  for (const [before, after] of [
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
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('    concurrency:\n      group: production-auto-${{ matrix.worker }}\n      cancel-in-progress: false\n', '')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace('    permissions:\n      contents: write\n      actions: read\n', '')));
  assert.throws(() => assertProductionAutoReleasePolicy(source.replace(
    '    concurrency:\n      group: production-auto-${{ matrix.worker }}\n      cancel-in-progress: false\n',
    'concurrency:\n  group: production-auto-${{ matrix.worker }}\n  cancel-in-progress: false\n')));
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

const gatedJob = `jobs:\n  check:\n${DRAFT_GATE}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n`;
const pullRequest = `  pull_request:\n${MAIN_ONLY}\n${PULL_REQUEST_TYPES}\n`;

test('policy accepts ready pull requests into main with draft-gated jobs', () => {
  assertTriggerPolicy(`on:\n${pullRequest}  push:\n${MAIN_ONLY}\n\n${gatedJob}`);
  assertTriggerPolicy(`on:\n${pullRequest}    paths:\n      - 'apps/x/**'\n\n${gatedJob}`);
  assertTriggerPolicy(`on:\n${pullRequest}\n${gatedJob}  after:\n    needs: check\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n`);
});

test('policy rejects pull requests into other branches, extra activity types and ungated jobs', () => {
  for (const triggers of [
    '  pull_request:\n',
    `  pull_request:\n${PULL_REQUEST_TYPES}\n`,
    `  pull_request:\n${MAIN_ONLY}\n`,
    `  pull_request:\n    branches: [main, dev]\n${PULL_REQUEST_TYPES}\n`,
    `  pull_request:\n    branches: ['**']\n${PULL_REQUEST_TYPES}\n`,
    `  pull_request:\n    branches-ignore: [dev]\n${PULL_REQUEST_TYPES}\n`,
    `  pull_request:\n${MAIN_ONLY}\n    types: [opened, synchronize, reopened, ready_for_review, edited]\n`,
    `  pull_request:\n${MAIN_ONLY}\n    types: [opened, synchronize]\n`,
    `  pull_request:\n${MAIN_ONLY}\n${PULL_REQUEST_TYPES}\n${PULL_REQUEST_TYPES}\n`,
    `  pull_request:\n${MAIN_ONLY}\n${MAIN_ONLY}\n${PULL_REQUEST_TYPES}\n`,
    `  pull_request_target:\n${MAIN_ONLY}\n${PULL_REQUEST_TYPES}\n`,
    `  push:\n${MAIN_ONLY}\n${PULL_REQUEST_TYPES}\n`,
  ]) assert.throws(() => assertTriggerPolicy(`on:\n${triggers}\n${gatedJob}`), triggers);
  const ungated = 'jobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n';
  assert.throws(() => assertTriggerPolicy(`on:\n${pullRequest}\n${ungated}`), /must skip draft pull requests/);
  const wrongGate = 'jobs:\n  check:\n    if: ${{ !github.event.pull_request.draft }}\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n';
  assert.throws(() => assertTriggerPolicy(`on:\n${pullRequest}\n${wrongGate}`), /must skip draft pull requests/);
  const gateInStep = 'jobs:\n  check:\n    runs-on: ubuntu-24.04\n    steps:\n' + DRAFT_GATE.replace('    ', '      - ') + '\n';
  assert.throws(() => assertTriggerPolicy(`on:\n${pullRequest}\n${gateInStep}`), /must skip draft pull requests/);
});

test('trigger policy is enforced by ordinary source-invariants CI', () => {
  const ci = read(path.join(directory, 'ci.yml'));
  const job = ci.slice(ci.indexOf('  source-invariants:'), ci.indexOf('  incoming-pickup:'));
  assert.ok(job.includes('run: node --test scripts/workflow-trigger-policy.test.mjs'));
});
