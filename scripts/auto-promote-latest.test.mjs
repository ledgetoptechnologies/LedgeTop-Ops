// Automatic promotion of `latest` by the four main publishers (Viewer, logs-local full, proxy generator, thumbnail
// images). Like Project-Alpha, a push to main moves latest in the same run that built the image, but here only as the
// publishing job's last step (so every verify/test step before it passed), only to the exact digest that job verified,
// and never back to an older main commit. The hand-run promote-*.yml workflows stay the gated rollback path.
// Static checks everywhere; the real step is also executed under bash with stubbed docker and gh. Nothing is published.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const read = name => fs.readFileSync(path.join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
export const MOVE_STEP = 'Move latest to this verified main build (never to an older commit)';
const PUBLISHERS = {
  'publish-viewer.yml': { job: 'verify-and-build', after: 'Upload release attestation',
    env: { IMAGE_NAME: '${{ steps.image.outputs.name }}', IMMUTABLE_TAG: '${{ steps.image.outputs.name }}:sha-${{ github.sha }}', PROMOTE_DIGEST: '${{ steps.build.outputs.digest }}' } },
  'publish-logs-local.yml': { job: 'publish-full', after: 'Tag the smoke-tested digest as an immutable full candidate (never latest)',
    env: { IMAGE_NAME: '${{ steps.names.outputs.image }}', IMMUTABLE_TAG: '${{ steps.names.outputs.tag }}', PROMOTE_DIGEST: '${{ steps.build.outputs.digest }}' } },
  'publish-proxy-generator.yml': { job: 'verify-and-publish', after: 'Upload immutable deployment receipt',
    env: { IMAGE_NAME: '${{ steps.publish.outputs.image }}', IMMUTABLE_TAG: '${{ steps.publish.outputs.image }}:sha-${{ github.sha }}', PROMOTE_DIGEST: '${{ steps.publish.outputs.digest }}' } },
  'publish-thumbnail-renderer.yml': { job: 'publish', after: 'Upload the deployment receipt',
    env: { IMAGE_NAME: '${{ steps.names.outputs.image }}', IMMUTABLE_TAG: '${{ steps.names.outputs.tag }}', PROMOTE_DIGEST: '${{ steps.build.outputs.digest }}' } },
};
const moveStepOf = text => { const at = text.indexOf(`\n      - name: ${MOVE_STEP}\n`); assert.ok(at > 0, 'move step present'); return text.slice(at + 1); };
const scriptOf = step => step.slice(step.indexOf('        run: |\n') + 15).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');

test('each main publisher moves latest only in its publishing job\'s last step, after every verify step', () => {
  const bodies = new Set();
  for (const [name, { job, after, env }] of Object.entries(PUBLISHERS)) {
    const text = read(name);
    assert.match(text, /\non:\n  push:\n    branches: \[main\]\n/, `${name}: main pushes only`);
    assert.ok(!/\n  (?:pull_request|pull_request_target|workflow_dispatch|schedule|workflow_run):/.test(text.split('\nconcurrency:')[0]), `${name}: no other trigger`);
    assert.match(text, /\nconcurrency:\n  group: [^\n]+\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/, `${name}: builds are serialized, never cancelled`);
    const step = moveStepOf(text);
    assert.equal(text.split(`- name: ${MOVE_STEP}`).length - 1, 1, `${name}: one move step`);
    assert.ok(!/\n      - name: /.test(step.slice(1)), `${name}: the move is the last step`);
    const steps = [...text.matchAll(/\n      - name: ([^\n]+)/g)].map(m => m[1]);
    assert.equal(steps.at(-2), after, `${name}: runs right after ${after}`);
    const jobs = [...text.matchAll(/\n  ([a-z-]+):\n    if:/g)].map(m => m[1]);
    assert.equal(jobs.at(-1), job, `${name}: inside ${job}`);
    assert.ok(step.startsWith(`      - name: ${MOVE_STEP}\n        if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n        shell: bash\n        env:\n          GH_TOKEN: \${{ github.token }}\n`));
    for (const [key, value] of Object.entries(env)) assert.ok(step.includes(`\n          ${key}: ${value}\n`), `${name}: ${key}`);
    assert.ok(!/always\(\)|continue-on-error|environment:/.test(step), `${name}: no bypass and no gated environment`);
    // Everything before the move writes immutable tags only.
    const before = text.slice(0, text.indexOf(`- name: ${MOVE_STEP}`)).replace(/^\s*#.*$/gm, '');
    assert.ok(!/:latest\b/.test(before), `${name}: nothing before the move step names latest`);
    bodies.add(scriptOf(step));
  }
  assert.equal(bodies.size, 1, 'the move script is identical in all four publishers');
  const script = [...bodies][0];
  assert.equal((script.match(/imagetools create/g) ?? []).length, 1, 'exactly one registry write');
  assert.ok(script.includes('docker buildx imagetools create --prefer-index=false --tag "$IMAGE_NAME:latest" "$IMAGE_NAME@$PROMOTE_DIGEST"'));
  assert.ok(script.includes('[[ "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF" == refs/heads/main ]]'), 'main pushes only, checked again in the script');
  assert.ok(script.includes('compare/$PREVIOUS_COMMIT...$COMMIT'), 'ancestry is checked against the commit latest names');
  for (const word of ['Commit:', 'Digest:', 'Previous latest:', 'Decision:']) assert.ok(script.includes(word), `summary names ${word}`);
  assert.ok(!/gh api[^\n]*(-X|--method|-f |--field|--input)/.test(script), 'the only API call is a read');
});

test('the gated manual promotions remain the rollback path', () => {
  for (const name of ['promote-logs-local.yml', 'promote-proxy-generator.yml', 'promote-thumbnail-renderer.yml', 'promote-viewer.yml']) {
    const text = read(name);
    assert.match(text, /\non:\n  workflow_dispatch:\n/, name);
    assert.ok(text.includes('    environment: image-promotion\n'), name);
    assert.ok(text.includes('rollback and re-promotion path'), `${name} says what it is for now`);
  }
});

// Executes the real step script. A stub registry is a directory: tags/<name> holds a digest, revisions/<digest> a commit.
const C = n => String(n).repeat(40).slice(0, 40);
const D = n => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const IMAGE = 'ghcr.io/ledgetoptechnologies/thumbnail-broker';
const bashUsable = () => spawnSync('bash', ['-c', 'set -o pipefail; printf ok | tr -d x'], { encoding: 'utf8' }).stdout === 'ok';

for (const name of Object.keys(PUBLISHERS)) test(`the real move script (${name}): forward only, exact digest, main pushes only`, t => {
  if (!bashUsable()) return t.skip('bash is required');
  const script = scriptOf(moveStepOf(read(name)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-promote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const posix = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const stub = `
REG='${posix(dir)}/reg'
docker() {
  # docker buildx imagetools inspect REF --format FMT | docker buildx imagetools create --prefer-index=false --tag REF SRC
  if [[ "$3" == create ]]; then
    echo "$6 $7" >> "$REG/writes"
    [[ -f "$REG/fail-write" ]] && return 1
    printf '%s' "\${7##*@}" > "$REG/tags/$(echo "\${6##*/}" | tr ':' '_')"; return 0
  fi
  local ref="$4" fmt="$6" digest
  if [[ -f "$REG/unreadable" && "$ref" == *:latest ]]; then echo "ERROR: $ref: 503 Service Unavailable" >&2; return 1; fi
  if [[ "$ref" == *@* ]]; then digest="\${ref##*@}"; else
    local key; key="$(echo "\${ref##*/}" | tr ':' '_')"
    [[ -f "$REG/tags/$key" ]] || { echo "ERROR: $ref: not found" >&2; return 1; }
    digest="$(cat "$REG/tags/$key")"
    if [[ "$key" == *_latest && -f "$REG/latest-moves-to" ]]; then cp "$REG/latest-moves-to" "$REG/tags/$key"; rm "$REG/latest-moves-to"; fi
  fi
  case "$fmt" in
    *Manifest.Digest*) printf '"%s"\\n' "$digest" ;;
    *revision*) cat "$REG/revisions/\${digest#sha256:}" 2>/dev/null || true ;;
  esac
}
gh() { echo "$2" >> "$REG/compares"; cat "$REG/compare-status"; }
`;
  const run = ({ event = 'push', ref = 'refs/heads/main', commit = C(2), digest = D(2), tag, latest = D(1), latestCommit = C(1), status = 'ahead',
    unreadable = false, changes = false, built = { [D(2)]: C(2) }, immutable = D(2) } = {}) => {
    const reg = path.join(dir, 'reg');
    fs.rmSync(reg, { recursive: true, force: true });
    fs.mkdirSync(path.join(reg, 'tags'), { recursive: true });
    fs.mkdirSync(path.join(reg, 'revisions'));
    const image = IMAGE.split('/').pop();
    fs.writeFileSync(path.join(reg, 'tags', `${image}_sha-${commit}`), immutable);
    if (latest) fs.writeFileSync(path.join(reg, 'tags', `${image}_latest`), latest);
    for (const [d, c] of Object.entries({ ...built, ...(latest ? { [latest]: latestCommit } : {}) })) fs.writeFileSync(path.join(reg, 'revisions', d.slice(7)), c);
    fs.writeFileSync(path.join(reg, 'compare-status'), `${status}\n`);
    if (unreadable) fs.writeFileSync(path.join(reg, 'unreadable'), '');
    if (changes) fs.writeFileSync(path.join(reg, 'latest-moves-to'), D(9));
    const summary = path.join(dir, 'summary');
    fs.writeFileSync(summary, '');
    const r = spawnSync('bash', ['-c', stub + script], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: commit,
      GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: posix(summary), RUNNER_TEMP: posix(dir), IMAGE_NAME: IMAGE, PROMOTE_DIGEST: digest,
      IMMUTABLE_TAG: tag ?? `${IMAGE}:sha-${commit}` } });
    const file = f => fs.existsSync(path.join(reg, f)) ? fs.readFileSync(path.join(reg, f), 'utf8') : '';
    return { status: r.status, out: r.stdout + r.stderr, writes: file('writes'), compares: file('compares'), latest: file(`tags/${image}_latest`), summary: fs.readFileSync(summary, 'utf8') };
  };

  const ok = run();
  assert.equal(ok.status, 0, ok.out);
  assert.equal(ok.writes, `${IMAGE}:latest ${IMAGE}@${D(2)}\n`, 'latest moves to the exact verified digest');
  assert.equal(ok.latest, D(2));
  assert.equal(ok.compares, `repos/o/r/compare/${C(1)}...${C(2)}\n`, 'compared against the commit latest named');
  for (const line of [`Commit: \`${C(2)}\``, `Digest: \`${D(2)}\``, `Previous latest: \`${D(1)}\` (commit \`${C(1)}\`)`, 'Decision: promote', `latest now names \`${D(2)}\``])
    assert.ok(ok.summary.includes(line), line);

  const kept = run({ status: 'behind' });
  assert.equal(kept.status, 0, 'an older build is not an error');
  assert.equal(kept.writes, '', 'latest is never moved back to an older main commit');
  assert.match(kept.out, /never moved back automatically/);
  assert.ok(kept.summary.includes('Decision: kept-newer'));

  const refuses = (options, why) => { const r = run(options); assert.notEqual(r.status, 0, why); assert.equal(r.writes, '', `${why}: nothing written`); return r; };
  refuses({ status: 'diverged' }, 'latest names a commit off this line of main');
  refuses({ status: 'identical' }, 'latest names this commit with another digest');
  refuses({ status: 'error' }, 'unknown compare result');
  refuses({ event: 'pull_request' }, 'pull requests never move latest');
  refuses({ ref: 'refs/tags/v1.0.0' }, 'tags never move latest');
  refuses({ ref: 'refs/heads/feature' }, 'other branches never move latest');
  refuses({ event: 'workflow_dispatch' }, 'a manual run of a publisher never moves latest');
  refuses({ digest: '' }, 'no verified digest');
  refuses({ immutable: D(3) }, 'the sha tag names another digest than the verified one');
  refuses({ built: { [D(2)]: C(7) } }, 'the digest carries another commit');
  refuses({ tag: `${IMAGE}:sha-${C(7)}` }, 'another commit\'s tag');
  refuses({ tag: `${IMAGE}:candidate-${C(2)}` }, 'a mutable or unexpected tag');
  refuses({ latestCommit: '' }, 'latest carries no commit label');
  refuses({ unreadable: true }, 'registry errors are not absence');
  refuses({ changes: true }, 'latest changed between the read and the write');

  const same = run({ latest: D(2), latestCommit: C(2) });
  assert.equal(same.status, 0);
  assert.equal(same.writes, '', 'already latest: nothing to write');
  const created = run({ latest: '' });
  assert.equal(created.status, 0, created.out);
  assert.equal(created.writes, `${IMAGE}:latest ${IMAGE}@${D(2)}\n`, 'a missing latest (exact GHCR not found) is created');
  assert.equal(created.compares, '');
});
