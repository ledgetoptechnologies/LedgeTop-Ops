// Automatic promotion of `latest` by the four main publishers (Viewer, logs-local full, proxy generator, thumbnail
// images). Like Project-Alpha, a push to main moves latest in the same run that built the image, but here only in a
// `promote-latest` job that runs after the publishing job (every verify/test step) passed, only to the exact digest that
// job verified, and only forward from whatever latest names at write time. The automatic job and the hand-run, gated
// promote-*.yml workflow (rollback and re-promotion) share ONE writer concurrency group per mutable tag, so their read,
// compare, write and read-back never interleave, and every writer queues (queue: max) instead of replacing a pending
// one. A manual rollback lasts until the next automatic write. The repository variable AUTO_PROMOTE_LATEST_PAUSED=true
// pauses promote-latest jobs of runs created after it is set; the job decides that first, before any registry access.
// Static checks everywhere; the real steps are also executed under bash with stubbed docker and gh. Nothing is published.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const read = name => fs.readFileSync(path.join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
const MOVE_STEP = 'Move latest to this verified main build (never to an older commit)';
const PUBLISHERS = {
  'publish-viewer.yml': { needs: 'verify-and-build', manual: 'promote-viewer.yml', group: 'latest-writer-viewer',
    manualGroup: 'latest-writer-viewer',
    env: { IMAGE_NAME: '${{ needs.verify-and-build.outputs.image }}', IMMUTABLE_TAG: '${{ needs.verify-and-build.outputs.image }}:sha-${{ github.sha }}', PROMOTE_DIGEST: '${{ needs.verify-and-build.outputs.digest }}' } },
  'publish-logs-local.yml': { needs: 'publish-full', manual: 'promote-logs-local.yml', group: 'latest-writer-logs-local',
    manualGroup: 'latest-writer-logs-local',
    env: { IMAGE_NAME: '${{ needs.publish-full.outputs.image }}', IMMUTABLE_TAG: '${{ needs.publish-full.outputs.image }}:sha-${{ github.sha }}-full', PROMOTE_DIGEST: '${{ needs.publish-full.outputs.digest }}' } },
  'publish-proxy-generator.yml': { needs: 'verify-and-publish', manual: 'promote-proxy-generator.yml', group: 'latest-writer-proxy-generator',
    manualGroup: 'latest-writer-proxy-generator',
    env: { IMAGE_NAME: '${{ needs.verify-and-publish.outputs.image }}', IMMUTABLE_TAG: '${{ needs.verify-and-publish.outputs.image }}:sha-${{ github.sha }}', PROMOTE_DIGEST: '${{ needs.verify-and-publish.outputs.digest }}' } },
  'publish-thumbnail-renderer.yml': { needs: 'publish', manual: 'promote-thumbnail-renderer.yml', group: 'latest-writer-thumbnail-${{ matrix.target }}',
    manualGroup: 'latest-writer-thumbnail-${{ inputs.target }}',
    env: { IMAGE_NAME: '${{ steps.verified.outputs.image }}', IMMUTABLE_TAG: '${{ steps.verified.outputs.image }}:sha-${{ github.sha }}', PROMOTE_DIGEST: '${{ steps.verified.outputs.digest }}' } },
};
const jobsOf = text => {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  return new Map(body.split(/^  (?=[A-Za-z0-9_-]+:\n)/m).filter(Boolean).map(block => [block.slice(0, block.indexOf(':')), block]));
};
const moveStepOf = text => { const at = text.indexOf(`\n      - name: ${MOVE_STEP}\n`); assert.ok(at > 0, 'move step present'); return text.slice(at + 1); };
const scriptOf = step => step.slice(step.indexOf('        run: |\n') + 15).split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
const WRITE = /imagetools\s+create[^\n]*:latest\b/;
const GATE = "steps.pause.outputs.paused == 'false'";
const PAUSE_STEP = 'Check the automatic promotion pause';
const stepsOf = job => job.split(/^      - name: /m).slice(1).map(block => ({ name: block.slice(0, block.indexOf('\n')), block }));

test('each publisher moves latest only in a promote-latest job after its publishing job, with the exact verified digest', () => {
  const bodies = new Set();
  for (const [name, { needs, manual, group, env }] of Object.entries(PUBLISHERS)) {
    const text = read(name);
    assert.match(text, /\non:\n  push:\n    branches: \[main\]\n/, `${name}: main pushes only`);
    assert.ok(!/\n  (?:pull_request|pull_request_target|workflow_dispatch|schedule|workflow_run):/.test(text.split('\nconcurrency:')[0]), `${name}: no other trigger`);
    assert.match(text, /\nconcurrency:\n  group: [^\n]+\$\{\{ github\.ref \}\}\n  cancel-in-progress: false\n/, `${name}: builds are serialized, never cancelled`);
    const jobs = jobsOf(text);
    const writers = [...jobs].filter(([, block]) => WRITE.test(block.replace(/^\s*#.*$/gm, ''))).map(([job]) => job);
    assert.deepEqual(writers, ['promote-latest'], `${name}: only promote-latest writes latest`);
    const job = jobs.get('promote-latest');
    assert.ok(job.includes("    if: ${{ github.ref == 'refs/heads/main' && github.event_name == 'push' }}\n"), `${name}: main pushes only`);
    assert.ok(job.includes(`    needs: ${needs}\n`), `${name}: only after ${needs} passed`);
    assert.ok(job.includes(`    concurrency:\n      group: ${group}\n      cancel-in-progress: false\n      queue: max\n`), `${name}: the shared writer group, queued`);
    assert.ok(job.includes('    permissions:\n      contents: read\n      packages: write\n    steps:\n'), `${name}: least privilege`);
    assert.ok(!/environment:|always\(\)|continue-on-error/.test(job), `${name}: no gated environment and no bypass`);
    const step = moveStepOf(text);
    assert.ok(!/\n      - name: /.test(step.slice(1)), `${name}: the move is the last step`);
    assert.ok(step.startsWith(`      - name: ${MOVE_STEP}\n        if: github.event_name == 'push' && github.ref == 'refs/heads/main' && ${GATE}\n        shell: bash\n        env:\n          GH_TOKEN: \${{ github.token }}\n`), name);
    for (const [key, value] of Object.entries(env)) assert.ok(step.includes(`\n          ${key}: ${value}\n`), `${name}: ${key}`);
    for (const line of job.split('\n').filter(l => l.includes('uses: '))) assert.match(line, /@[0-9a-f]{40} # v/, `${name}: pinned ${line.trim()}`);
    const before = text.slice(0, text.indexOf('\n  promote-latest:\n')).replace(/^\s*#.*$/gm, '');
    assert.ok(!/:latest\b/.test(before), `${name}: nothing before promote-latest names latest`);
    bodies.add(scriptOf(step));
  }
  assert.equal(bodies.size, 1, 'the move script is identical in all four publishers');
  const script = [...bodies][0];
  assert.equal((script.match(/imagetools create/g) ?? []).length, 1, 'exactly one registry write');
  assert.ok(script.includes('docker buildx imagetools create --prefer-index=false --tag "$IMAGE_NAME:latest" "$IMAGE_NAME@$PROMOTE_DIGEST"'));
  assert.ok(script.includes('[[ "$GITHUB_EVENT_NAME" == push && "$GITHUB_REF" == refs/heads/main ]]'), 'main pushes only, checked again in the script');
  assert.ok(script.includes('compare/$PREVIOUS_COMMIT...$COMMIT'), 'ancestry is checked against the commit latest names now');
  assert.ok(!/2>\/dev\/null|\|\| echo absent/.test(script), 'no read hides an error as absence');
  assert.equal(script.split('NOW="$(read_latest)" || fail').length - 1, 1, 'the final re-read uses the same classifier and fails closed');
  assert.equal(script.split('PREVIOUS_DIGEST="$(read_latest)" || fail').length - 1, 1, 'so does the first read');
  for (const word of ['Commit:', 'Digest:', 'Previous latest:', 'Decision:']) assert.ok(script.includes(word), `summary names ${word}`);
  // The pause is decided by the job's first step; the move script itself never sees it.
  assert.ok(!script.includes('AUTO_PROMOTE_LATEST_PAUSED'));
  // No suppression based on manual run history: forward-only from what latest names at write time is the whole rule.
  assert.ok(!/actions\/runs|actions\/workflows|MANUAL_WORKFLOW|kept-manual/.test(script));
  for (const call of script.match(/gh api [^\n]*/g)) assert.ok(!/(-X|--method|-f |-F |--field|--raw-field|--input)\b/.test(call), `read-only API call: ${call}`);
});

test('overlapping writers: the automatic and manual writers of each latest share one concurrency group', () => {
  for (const [name, { manual, group, manualGroup }] of Object.entries(PUBLISHERS)) {
    const promote = read(manual);
    assert.match(promote, /\non:\n  workflow_dispatch:\n/, manual);
    assert.ok(promote.includes('    environment: image-promotion\n'), `${manual} keeps its approval gate`);
    assert.ok(promote.includes(`\nconcurrency:\n  group: ${manualGroup}\n  cancel-in-progress: false\n  queue: max\n`), `${manual}: ${manualGroup}, queued`);
    assert.ok(promote.includes('rollback and re-promotion path'), `${manual} says what it is for now`);
    // The groups resolve to the same string for the same image (the thumbnail images per target).
    for (const target of ['decoder', 'broker', 'queue-worker'])
      assert.equal(group.replace('${{ matrix.target }}', target), manualGroup.replace('${{ inputs.target }}', target), `${name} and ${manual}`);
    if (name === 'publish-thumbnail-renderer.yml') assert.match(read(name), /promote-latest:[\s\S]*matrix:\n        target: \[decoder, broker, queue-worker\]\n/);
  }
  // No other workflow job writes any of these latest tags, so nothing outside the shared groups can interleave.
  const writers = [];
  for (const name of fs.readdirSync(workflows).filter(n => /\.ya?ml$/.test(n)).sort())
    for (const [job, block] of jobsOf(read(name))) if (WRITE.test(block.replace(/^\s*#.*$/gm, ''))) writers.push(`${name}#${job}`);
  assert.deepEqual(writers, ['promote-logs-local.yml#promote', 'promote-proxy-generator.yml#promote', 'promote-thumbnail-renderer.yml#promote',
    'promote-viewer.yml#promote', 'publish-logs-local.yml#promote-latest', 'publish-proxy-generator.yml#promote-latest',
    'publish-thumbnail-renderer.yml#promote-latest', 'publish-viewer.yml#promote-latest']);
});

test('the thumbnail job promotes the digest from its own target\'s verified receipt in this run', () => {
  const job = jobsOf(read('publish-thumbnail-renderer.yml')).get('promote-latest');
  assert.ok(job.includes('name: thumbnail-renderer-${{ matrix.target }}-${{ github.sha }}'));
  assert.ok(job.includes('.target == $target and .commit == $commit and .image == $image and .reference == ($image + "@" + .digest)'));
  assert.ok(job.indexOf('Read the verified digest from the receipt') < job.indexOf(MOVE_STEP));
});

// Executes the real step script. A stub registry is a directory: tags/<name> holds a digest, revisions/<digest> a commit,
// and latest-seq (optional) scripts successive answers for latest: a digest, "notfound", "manifest-unknown" or "503".
const C = n => String(n).repeat(40).slice(0, 40);
const D = n => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const IMAGE = 'ghcr.io/ledgetoptechnologies/thumbnail-broker';
const bashUsable = () => spawnSync('bash', ['-c', 'set -o pipefail; printf ok | tr -d x'], { encoding: 'utf8' }).stdout === 'ok';

for (const name of Object.keys(PUBLISHERS)) test(`the real move script (${name}): forward only, exact digest, one writer, fail closed`, t => {
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
    printf '%s' "\${7##*@}" > "$REG/tags/$(echo "\${6##*/}" | tr ':' '_')"; rm -f "$REG/latest-seq"; return 0
  fi
  local ref="$4" fmt="$6" digest key
  if [[ "$ref" == *@* ]]; then digest="\${ref##*@}"; else
    key="$(echo "\${ref##*/}" | tr ':' '_')"
    if [[ "$key" == *_latest && -s "$REG/latest-seq" ]]; then
      local answer; answer="$(head -n1 "$REG/latest-seq")"; tail -n +2 "$REG/latest-seq" > "$REG/seq.tmp"; mv "$REG/seq.tmp" "$REG/latest-seq"
      case "$answer" in
        notfound) echo "ERROR: $ref: not found" >&2; return 1 ;;
        manifest-unknown) echo "ERROR: $ref: MANIFEST_UNKNOWN: manifest unknown; map[Tag:latest]" >&2; return 1 ;;
        503) echo "ERROR: $ref: unexpected status 503 Service Unavailable" >&2; return 1 ;;
        denied) echo "ERROR: $ref: denied" >&2; return 1 ;;
        *) digest="$answer" ;;
      esac
    else
      [[ -f "$REG/tags/$key" ]] || { echo "ERROR: $ref: not found" >&2; return 1; }
      digest="$(cat "$REG/tags/$key")"
    fi
  fi
  case "$fmt" in
    *Manifest.Digest*) printf '"%s"\\n' "$digest" ;;
    *revision*) cat "$REG/revisions/\${digest#sha256:}" 2>/dev/null || true ;;
  esac
}
gh() {
  echo "$2" >> "$REG/api"
  case "$2" in
    */compare/*) cat "$REG/compare-status" ;;
    *) return 1 ;;
  esac
}
`;
  const run = ({ event = 'push', ref = 'refs/heads/main', commit = C(2), digest = D(2), tag, latest = D(1), latestCommit = C(1), status = 'ahead',
    seq, built = { [D(2)]: C(2) }, immutable = D(2) } = {}) => {
    const reg = path.join(dir, 'reg');
    fs.rmSync(reg, { recursive: true, force: true });
    fs.mkdirSync(path.join(reg, 'tags'), { recursive: true });
    fs.mkdirSync(path.join(reg, 'revisions'));
    const image = IMAGE.split('/').pop();
    fs.writeFileSync(path.join(reg, 'tags', `${image}_sha-${commit}`), immutable);
    if (latest) fs.writeFileSync(path.join(reg, 'tags', `${image}_latest`), latest);
    for (const [d, c] of Object.entries({ ...built, ...(latest ? { [latest]: latestCommit } : {}) })) fs.writeFileSync(path.join(reg, 'revisions', d.slice(7)), c);
    fs.writeFileSync(path.join(reg, 'compare-status'), `${status}\n`);
    if (seq) fs.writeFileSync(path.join(reg, 'latest-seq'), `${seq.join('\n')}\n`);
    const summary = path.join(dir, 'summary');
    fs.writeFileSync(summary, '');
    const r = spawnSync('bash', ['-c', stub + script], { encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_SHA: commit,
      GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '77', GITHUB_STEP_SUMMARY: posix(summary), RUNNER_TEMP: posix(dir), IMAGE_NAME: IMAGE, PROMOTE_DIGEST: digest,
      IMMUTABLE_TAG: tag ?? `${IMAGE}:sha-${commit}` } });
    const file = f => fs.existsSync(path.join(reg, f)) ? fs.readFileSync(path.join(reg, f), 'utf8') : '';
    return { status: r.status, out: r.stdout + r.stderr, writes: file('writes'), api: file('api'), latest: file(`tags/${image}_latest`), summary: fs.readFileSync(summary, 'utf8') };
  };
  const refuses = (options, why) => { const r = run(options); assert.notEqual(r.status, 0, why); assert.equal(r.writes, '', `${why}: nothing written`); return r; };
  const keeps = (options, decision, why) => { const r = run(options); assert.equal(r.status, 0, `${why}: ${r.out}`); assert.equal(r.writes, '', `${why}: nothing written`);
    assert.ok(r.summary.includes(`Decision: ${decision}`), why); return r; };

  const ok = run();
  assert.equal(ok.status, 0, ok.out);
  assert.equal(ok.writes, `${IMAGE}:latest ${IMAGE}@${D(2)}\n`, 'latest moves to the exact verified digest');
  assert.equal(ok.latest, D(2));
  assert.ok(ok.api.includes(`repos/o/r/compare/${C(1)}...${C(2)}\n`), 'compared against the commit latest names now');
  assert.equal(ok.api, `repos/o/r/compare/${C(1)}...${C(2)}\n`, 'the compare is the only API call');
  for (const line of [`Commit: \`${C(2)}\``, `Digest: \`${D(2)}\``, `Previous latest: \`${D(1)}\` (commit \`${C(1)}\`)`, 'Decision: promote', `latest now names \`${D(2)}\``])
    assert.ok(ok.summary.includes(line), line);

  // Never backwards relative to what latest names now.
  assert.match(keeps({ status: 'behind' }, 'kept-newer', 'an older build finishing late').out, /never moved back automatically/);
  // A manual rollback lasts until the next automatic write: latest names an older commit now, so this build moves it forward.
  const afterRollback = run({ latest: D(0), latestCommit: C(0) });
  assert.equal(afterRollback.status, 0, afterRollback.out);
  assert.equal(afterRollback.writes, `${IMAGE}:latest ${IMAGE}@${D(2)}\n`);
  assert.ok(afterRollback.api.includes(`compare/${C(0)}...${C(2)}`), 'compared with what latest names at write time');
  // Overlapping writers: latest changes between the first read and the final re-read.
  refuses({ seq: [D(1), D(9)] }, 'another writer moved latest between the reads');
  refuses({ seq: [D(1), 'notfound'] }, 'latest disappeared between the reads');
  // Absent first read followed by an unavailable final read: fail closed.
  refuses({ latest: '', seq: ['notfound', '503'] }, 'absent, then the registry is unavailable');
  refuses({ latest: '', seq: ['notfound', 'denied'] }, 'absent, then an auth error');
  refuses({ seq: [D(1), '503'] }, 'present, then the registry is unavailable');
  refuses({ seq: ['503'] }, 'the first read is unavailable');
  refuses({ seq: ['denied'] }, 'the first read is denied');
  const created = run({ latest: '', seq: ['notfound', 'notfound'] });
  assert.equal(created.status, 0, created.out);
  assert.equal(created.writes, `${IMAGE}:latest ${IMAGE}@${D(2)}\n`, 'exact absence twice: latest is created');
  assert.equal(run({ latest: '', seq: ['manifest-unknown', 'manifest-unknown'] }).status, 0, 'MANIFEST_UNKNOWN for the exact tag is absence too');

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
  refuses({ tag: `${IMAGE}:candidate-${C(2)}` }, 'an unexpected tag');
  refuses({ latestCommit: '' }, 'latest carries no commit label');
  keeps({ latest: D(2), latestCommit: C(2) }, 'already-latest', 'already latest');
});

test('the pause is decided first: while paused no later step runs, so no login, registry read or API call', () => {
  const bodies = new Set();
  for (const name of Object.keys(PUBLISHERS)) {
    const job = jobsOf(read(name)).get('promote-latest');
    const steps = stepsOf(job);
    assert.equal(steps[0].name, PAUSE_STEP, `${name}: the pause is the first step`);
    assert.ok(steps[0].block.includes('        id: pause\n') && !steps[0].block.includes('uses: '), `${name}: a plain script, no action`);
    assert.ok(steps[0].block.includes('          AUTO_PROMOTE_LATEST_PAUSED: ${{ vars.AUTO_PROMOTE_LATEST_PAUSED }}\n'));
    assert.ok(!/docker|gh api|curl|wget|git /.test(scriptOf(steps[0].block)), `${name}: the pause step touches nothing external`);
    bodies.add(steps[0].block.trimEnd());
    // With paused=true every later step's if is false, so the job runs only the pause step.
    for (const { name: step, block } of steps.slice(1)) {
      const condition = /^        if: ([^\n]+)$/m.exec(block)?.[1] ?? '';
      assert.ok(condition === GATE || condition.endsWith(` && ${GATE}`), `${name}: "${step}" is skipped while paused`);
      assert.ok(!/always\(\)|failure\(\)|cancelled\(\)/.test(condition), `${name}: "${step}" cannot bypass the pause`);
    }
  }
  assert.equal(bodies.size, 1, 'the pause step is identical in all four publishers');
});

test('the paused profile makes zero external calls and succeeds even with GHCR unavailable', t => {
  if (!bashUsable()) return t.skip('bash is required');
  const pauseStep = stepsOf(jobsOf(read('publish-viewer.yml')).get('promote-latest'))[0].block;
  const script = scriptOf(pauseStep);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-promote-pause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const posix = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const calls = path.join(dir, 'calls');
  // Every external tool records the call and fails, as if GHCR and the API were unreachable.
  const stub = ['docker', 'gh', 'curl', 'wget', 'git', 'jq'].map(tool => `${tool}() { echo "${tool} $*" >> '${posix(calls)}'; echo "ERROR: unavailable" >&2; return 1; }`).join('\n') + '\n';
  const runPause = value => {
    for (const f of ['calls', 'out', 'summary']) fs.writeFileSync(path.join(dir, f), '');
    const r = spawnSync('bash', ['-c', stub + script], { encoding: 'utf8', env: { ...process.env, AUTO_PROMOTE_LATEST_PAUSED: value, GITHUB_SHA: C(2),
      GITHUB_OUTPUT: posix(path.join(dir, 'out')), GITHUB_STEP_SUMMARY: posix(path.join(dir, 'summary')) } });
    const file = f => fs.readFileSync(path.join(dir, f), 'utf8');
    return { status: r.status, out: r.stdout + r.stderr, output: file('out'), calls: file('calls'), summary: file('summary') };
  };
  const paused = runPause('true');
  assert.equal(paused.status, 0, paused.out);
  assert.equal(paused.output, 'paused=true\n');
  assert.equal(paused.calls, '', 'zero external calls while paused');
  assert.match(paused.out, /::warning::Automatic promotion is paused by AUTO_PROMOTE_LATEST_PAUSED/);
  assert.match(paused.summary, /is paused \(AUTO_PROMOTE_LATEST_PAUSED=true\)/);
  for (const value of ['', 'false']) {
    const r = runPause(value);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.output, 'paused=false\n', `"${value}" runs`);
    assert.equal(r.calls, '');
  }
  for (const value of ['yes', 'TRUE', '1', 'paused']) {
    const r = runPause(value);
    assert.equal(r.status, 1, `an unclear pause value (${value}) fails the job`);
    assert.equal(r.output, '', `${value}: no decision is recorded, so later steps are skipped`);
    assert.equal(r.calls, '');
  }
});

test('the runbook keeps a rollback in the documented order, and covers a full writer queue', () => {
  const releasing = fs.readFileSync(fileURLToPath(new URL('../apps/viewer/docs/RELEASING.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const order = ['1. Set the repository variable `AUTO_PROMOTE_LATEST_PAUSED` to `true`.', '2. Wait for, or cancel, every publisher run already in progress',
    '3. Check that no publisher run is still queued.', '4. Then run the manual promotion to roll back.', '5. To resume, unset the variable'];
  const at = order.map(step => releasing.indexOf(step));
  assert.ok(at.every(i => i > 0), `every step is documented: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'pause, settle in-flight runs, check the queue, then roll back');
  assert.match(releasing, /governs publisher runs created after it\s+was set, not runs already in flight/);
  assert.match(releasing, /up to 100 pending writers per group/);
  assert.match(releasing, /A cancelled manual promotion must be dispatched again/);
  for (const readme of ['../apps/logs-local/README.md', '../apps/thumbnail-renderer/README.md'])
    assert.match(fs.readFileSync(fileURLToPath(new URL(readme, import.meta.url)), 'utf8'), /ordered rollback steps in `apps\/viewer\/docs\/RELEASING\.md`/, readme);
});
