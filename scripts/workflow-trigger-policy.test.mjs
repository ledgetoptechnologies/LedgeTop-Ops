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
  test(`${name} runs only for main pushes or ready pull requests into main`, () => {
    assertTriggerPolicy(read(path.join(directory, name)));
  });
}

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
