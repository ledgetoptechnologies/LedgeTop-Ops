// Repository-wide inventory of registry writes that name a mutable tag (latest, stable, full, keyless). Each image's
// latest has exactly one reviewed writer: its hand-run promotion. Main publishers write immutable sha/candidate tags
// only. A new mutable-tag writer anywhere fails here until it is reviewed. Static: nothing is published.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflows = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const read = name => fs.readFileSync(path.join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
const REGISTRY_WRITE = /imagetools\s+create|docker\s+push|buildx\s+build[^\n]*--push|crane\s+(?:tag|copy|cp|push)|skopeo\s+copy|oras\s+(?:push|tag)|uses: docker\/build-push-action/;
const MUTABLE_TAG = /:(?:latest|stable|full|keyless)\b(?![\w.-])/;

function mutableWriters() {
  const writers = [];
  for (const name of fs.readdirSync(workflows).filter(n => /\.ya?ml$/.test(n)).sort()) {
    const text = read(name);
    const body = text.slice(text.indexOf('\njobs:\n') + 7);
    for (const block of body.split(/^  (?=[A-Za-z0-9_-]+:\n)/m).filter(Boolean)) {
      const job = block.slice(0, block.indexOf(':'));
      const code = block.replace(/^\s*#.*$/gm, '').split('\n').filter(line => !/imagetools inspect|echo |printf /.test(line)).join('\n');
      if (REGISTRY_WRITE.test(code) && MUTABLE_TAG.test(code)) writers.push(`${name}#${job}`);
    }
  }
  return writers;
}

test('mutable tags are written only by the reviewed logs-local and Viewer promotions', () => {
  assert.deepEqual(mutableWriters(), ['promote-logs-local.yml#promote', 'promote-viewer.yml#promote']);
});

test('the thumbnail and proxy publishers write only immutable sha and candidate tags', () => {
  for (const name of ['publish-thumbnail-renderer.yml', 'publish-proxy-generator.yml']) {
    const code = read(name).replace(/^\s*#.*$/gm, '');
    assert.ok(!/:(?:latest|stable)\b/.test(code.replace(/echo[^\n]*/g, '')), `${name}: no mutable tag`);
    assert.match(code, /candidate-\$\{GITHUB_SHA\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/, `${name}: candidate tag`);
    for (const line of code.match(/imagetools create[^\n]*/g) ?? []) assert.match(line, /--prefer-index=false/, `${name}: digest kept`);
  }
});

test('the detector catches a mutable write and ignores reads', () => {
  const write = '      - run: docker buildx imagetools create --tag "$IMAGE:latest" "$IMAGE@$D"\n';
  assert.ok(REGISTRY_WRITE.test(write) && MUTABLE_TAG.test(write));
  assert.ok(!MUTABLE_TAG.test('--tag "$IMAGE:latest-old"'));
  assert.ok(!MUTABLE_TAG.test('--tag "$IMAGE:candidate-abc"'));
});
