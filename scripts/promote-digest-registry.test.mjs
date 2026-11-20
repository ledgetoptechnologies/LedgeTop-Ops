// Opt-in registry test (LTDS_REGISTRY_TEST=1, Linux with Docker and buildx): the exact promotion command used by the
// three promote workflows keeps the candidate digest for BOTH a single-manifest candidate and an index candidate.
// It starts a throwaway local registry, uploads tiny synthetic images through the registry HTTP API, runs the
// workflow's own `imagetools create` line, and removes the registry. Nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const enabled = process.env.LTDS_REGISTRY_TEST === '1' && process.platform === 'linux';
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });

// The promotion line exactly as the workflows write it (one shared form; the static tests pin it in each file).
const PROMOTE_LINE = 'docker buildx imagetools create --prefer-index=false --tag "$IMAGE_NAME:latest" "$IMAGE_NAME@$PROMOTE_DIGEST"';
for (const name of ['promote-logs-local.yml', 'promote-viewer.yml', 'promote-thumbnail-renderer.yml'])
  assert.ok(fs.readFileSync(`${root}/.github/workflows/${name}`, 'utf8').includes(PROMOTE_LINE), name);

async function put(base, repo, kind, ref, body, type) {
  const res = await fetch(`${base}/v2/${repo}/${kind}/${ref}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
  assert.ok(res.status === 201, `${kind} ${ref}: ${res.status}`);
}
async function blob(base, repo, bytes) {
  const start = await fetch(`${base}/v2/${repo}/blobs/uploads/`, { method: 'POST' });
  const location = new URL(start.headers.get('location'), base);
  location.searchParams.set('digest', sha(bytes));
  const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(res.status, 201);
  return { digest: sha(bytes), size: bytes.length };
}

test('the workflow promotion keeps the digest of single-manifest and index candidates', { skip: !enabled && 'opt-in: LTDS_REGISTRY_TEST=1 on Linux' }, async t => {
  const name = `ltds-promote-digest-${process.pid}`;
  const started = run('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5000', 'registry:2']);
  assert.equal(started.status, 0, started.stderr);
  t.after(() => run('docker', ['rm', '-f', name]));
  const port = run('docker', ['port', name, '5000/tcp']).stdout.trim().split(':').pop();
  const host = `localhost:${port}`, base = `http://${host}`;
  for (let i = 0; i < 50 && !(await fetch(`${base}/v2/`).then(r => r.ok, () => false)); i++) await new Promise(r => setTimeout(r, 200));
  const repo = 'ltds/promote';
  const layer = await blob(base, repo, Buffer.from('synthetic layer'));
  const config = await blob(base, repo, Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [layer.digest] } })));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', ...layer }] }));
  const single = sha(manifest);
  await put(base, repo, 'manifests', single, manifest, 'application/vnd.oci.image.manifest.v1+json');
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: single, size: manifest.length, platform: { architecture: 'amd64', os: 'linux' } }] }));
  const indexed = sha(index);
  await put(base, repo, 'manifests', indexed, index, 'application/vnd.oci.image.index.v1+json');
  for (const candidate of [single, indexed]) {
    // Run the workflow's own line with the workflow's variable names.
    const res = spawnSync('bash', ['-c', PROMOTE_LINE], { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, IMAGE_NAME: `${host}/${repo}`, PROMOTE_DIGEST: candidate } });
    assert.equal(res.status, 0, res.stderr);
    const head = await fetch(`${base}/v2/${repo}/manifests/latest`, { method: 'HEAD', headers: { Accept:
      'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json' } });
    assert.equal(head.headers.get('docker-content-digest'), candidate, `latest keeps ${candidate === single ? 'the single manifest' : 'the index'} digest`);
  }
});
