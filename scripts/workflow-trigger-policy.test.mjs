import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.github/workflows');
const read = filename => fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');

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
    if (isPush) assert.equal(lines.filter(line => line === '    branches: [main]').length, 1,
      'push must explicitly target only main');
    for (const line of lines) {
      assert.ok(!line.trim() || (isPush && line === '    branches: [main]') ||
        line === '    paths:' || /^      - (?:'[^']+'|"[^"]+"|[^\s'"#][^#]*)$/.test(line),
      `unsupported trigger filter: ${line}`);
    }
  }
}

for (const name of fs.readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort()) {
  test(`${name} runs only for main pushes or pull requests`, () => {
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

test('trigger policy is enforced by ordinary source-invariants CI', () => {
  const ci = read(path.join(directory, 'ci.yml'));
  const job = ci.slice(ci.indexOf('  source-invariants:'), ci.indexOf('  incoming-pickup:'));
  assert.ok(job.includes('run: node --test scripts/workflow-trigger-policy.test.mjs'));
});
