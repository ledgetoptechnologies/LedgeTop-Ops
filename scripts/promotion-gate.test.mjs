// The approval gate shared by every image promotion (logs-local, Viewer, thumbnail renderer, proxy generator):
// identical in all four, first step, before any registry write. Static checks everywhere; the real gate script is
// also executed under bash + jq with stubbed API answers (Linux). Synthetic values only; nothing is published.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const read = name => fs.readFileSync(path.join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
const PROMOTIONS = ['promote-logs-local.yml', 'promote-proxy-generator.yml', 'promote-thumbnail-renderer.yml', 'promote-viewer.yml'];
const GATE_NAME = 'Require the protected promotion environment and its recorded approval';
const gateOf = text => { const at = text.indexOf(`- name: ${GATE_NAME}`); assert.ok(at > 0); return text.slice(at, text.indexOf('\n      - name: ', at + 1)); };

test('every promotion runs in image-promotion with the same gate as its first step, before any registry write', () => {
  const gates = new Set();
  for (const name of PROMOTIONS) {
    const text = read(name);
    assert.match(text, /\n  promote:\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 20\n    environment: image-promotion\n/, name);
    assert.match(text, /\non:\n  workflow_dispatch:\n/, name);
    const steps = [...text.matchAll(/\n      - name: ([^\n]+)/g)].map(m => m[1]);
    assert.equal(steps[0], GATE_NAME, `${name}: the gate is the first step`);
    assert.ok(text.indexOf(GATE_NAME) < text.indexOf('imagetools create'), name);
    assert.ok(!/gh api[^\n]*(-X|--method)\s*(PUT|POST|PATCH|DELETE)/i.test(text), `${name}: never changes repository settings`);
    for (const field of ['"approvedBy": "%s",\\n  "approvalEnvironment": "image-promotion",\\n  "typedApprovedBy": "%s"', '"approvalEnforced": true', 'APPROVERS: ${{ steps.approval.outputs.approvers }}'])
      assert.ok(text.includes(field), `${name}: ${field}`);
    for (const line of text.replace(/^\s*#.*$/gm, '').match(/imagetools create[^\n]*/g)) assert.match(line, /--prefer-index=false/, name);
    gates.add(gateOf(text));
  }
  assert.equal(gates.size, 1, 'the gate is identical in all four promotions');
  const gate = [...gates][0];
  assert.ok(gate.includes('PROMOTION_APPROVER: ${{ vars.PROMOTION_APPROVER }}'), 'one approver login from the owner-set variable');
  assert.ok(gate.includes('[[ "$GITHUB_RUN_ATTEMPT" == 1 ]]'), 'reruns are refused outright');
  assert.ok(gate.includes('[[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]'));
  assert.ok(gate.includes('[[ "$REVIEWERS" == "$EXPECTED" ]]') && gate.includes('"non-user-reviewer"'));
  assert.ok(gate.includes('[[ "$BRANCHES" == "branch:main" ]]'));
  assert.ok(gate.includes('[[ "$REVIEWS" == "approved:$EXPECTED" ]]'), 'exactly one approval, by that login');
});

test('the real gate: one expected reviewer, main only, first attempt, exactly one approval by that login', t => {
  if (process.platform === 'win32' || spawnSync('bash', ['-c', 'command -v jq']).status !== 0) return t.skip('bash and jq are required');
  const gate = gateOf(read('promote-logs-local.yml'));
  const script = gate.slice(gate.indexOf('run: |\n') + 7).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envOk = { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'OwnerA' } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const review = (login, state = 'approved') => ({ state, environments: [{ name: 'image-promotion' }], user: { login } });
  const run = ({ approver = 'OwnerA', environment = envOk, branches = { branch_policies: [{ name: 'main', type: 'branch' }] },
    history = [review('OwnerA')], attempt = '1', event = 'workflow_dispatch' } = {}) => {
    fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify(environment));
    fs.writeFileSync(path.join(dir, 'branches.json'), JSON.stringify(branches));
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(history));
    const stub = `gh() { case "$2" in */deployment-branch-policies) jq -r "$4" "${dir}/branches.json";; */approvals) cat "${dir}/history.json";; */environments/*) cat "${dir}/env.json";; esac; }\n`;
    const out = path.join(dir, 'out');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', stub + script], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: attempt, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: out, PROMOTION_ENVIRONMENT: 'image-promotion', PROMOTION_APPROVER: approver } });
    return { status: r.status, stdout: r.stdout, output: fs.readFileSync(out, 'utf8') };
  };
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(ok.output.trim(), 'approvers=ownera');
  const stops = (options, why) => assert.equal(run(options).status, 1, why);
  stops({ approver: '' }, 'variable unset');
  stops({ approver: 'ownera,ownerb' }, 'a list is not one login');
  stops({ approver: 'someone-else' }, 'reviewer is not the expected owner');
  stops({ environment: { ...envOk, protection_rules: [{ type: 'required_reviewers', reviewers: [
    { type: 'User', reviewer: { login: 'OwnerA' } }, { type: 'User', reviewer: { login: 'OwnerB' } }] }] } }, 'a second reviewer');
  stops({ environment: { ...envOk, protection_rules: [] } }, 'no required reviewers');
  stops({ environment: { ...envOk, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'Team', reviewer: { slug: 'owners' } }] }] } }, 'team');
  stops({ environment: { ...envOk, deployment_branch_policy: null } }, 'any branch');
  stops({ environment: { ...envOk, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } }, 'protected branches');
  stops({ branches: { branch_policies: [{ name: 'main', type: 'branch' }, { name: 'dev', type: 'branch' }] } }, 'extra branch');
  stops({ branches: { branch_policies: [{ name: 'main', type: 'tag' }] } }, 'tag, not branch');
  stops({ history: [] }, 'no approval');
  stops({ history: [review('Mallory')] }, 'approval by someone else');
  stops({ history: [review('OwnerA'), review('OwnerA')] }, 'more than one approval');
  stops({ history: [review('OwnerA', 'rejected')] }, 'a rejection');
  stops({ attempt: '2', history: [review('OwnerA'), review('OwnerA')] }, 'reruns are refused outright');
  stops({ event: 'push' }, 'only a manual dispatch');
});
