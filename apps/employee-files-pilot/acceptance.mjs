import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compose, occ, secret, root, state, url } from './pilot.mjs';

const encode = value => value.split('/').map(encodeURIComponent).join('/');
const dav = (user, file = '') => `${url}/remote.php/dav/files/${encodeURIComponent(user)}/${encode(file)}`;
const digest = value => createHash('sha256').update(value).digest('hex');

async function request(user, target, method = 'GET', body, headers = {}) {
  const response = await fetch(target, {
    method, body, redirect: 'manual', signal: AbortSignal.timeout(60_000),
    headers: { ...(user ? { Authorization: `Basic ${Buffer.from(`${user}:${secret(user)}`).toString('base64')}` } : {}), ...headers },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8') };
}

export async function acceptance() {
  if (!fs.existsSync(path.join(state, 'bootstrap.json'))) throw new Error('Run bootstrap before acceptance tests.');
  const report = { startedAt: new Date().toISOString(), target: url, images: JSON.parse(fs.readFileSync(path.join(root, 'images.lock.json'), 'utf8')), results: [], windowsExplorer: 'not tested', trueNAS: 'not contacted', opsSSO: 'not implemented' };
  const check = async (name, test) => {
    try { await test(); report.results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { report.results.push({ name, passed: false, error: error.message }); throw new Error(`${name}: ${error.message}`); }
  };
  const fixture = path.join(state, 'source', 'nested', 'server-note.txt');
  const original = fs.readFileSync(fixture);
  const folder = `Acceptance-${randomUUID()}`;
  const file = `${folder}/save.txt`;
  const modifiedAt = Math.floor(Date.now() / 1000) - 30;
  let created = false;
  let disabled = false;
  try {
    await check('Only app port is published, bound to host loopback', async () => {
      const ids = compose(['ps', '-q'], { quiet: true }).split(/\r?\n/).filter(Boolean);
      assert.equal(ids.length, 4);
      const { docker } = await import('./pilot.mjs');
      for (const id of ids) {
        const [container] = JSON.parse(docker(['inspect', id], { quiet: true }));
        const ports = Object.values(container.HostConfig.PortBindings ?? {}).flat().filter(Boolean);
        for (const port of ports) { assert.equal(port.HostIp, '127.0.0.1'); assert.equal(port.HostPort, '18087'); }
        const source = container.Mounts.find(mount => mount.Destination === '/pilot-source');
        if (source) assert.equal(source.RW, false);
      }
    });
    await check('Anonymous DAV access is denied', async () => {
      assert.equal((await request(null, dav('employee-one'), 'PROPFIND', undefined, { Depth: '1' })).status, 401);
    });
    await check('Both employees can read the exact server fixture', async () => {
      for (const user of ['employee-one', 'employee-two']) {
        const listing = await request(user, dav(user), 'PROPFIND', undefined, { Depth: '1' });
        assert.equal(listing.status, 207);
        assert.match(listing.text, /Server(?:%20| )Reference/);
        const result = await request(user, dav(user, 'Server Reference/nested/server-note.txt'));
        assert.equal(result.status, 200); assert.deepEqual(result.bytes, original);
      }
    });
    await check('An unassigned account cannot list or guess the source mount', async () => {
      const listing = await request('outsider', dav('outsider'), 'PROPFIND', undefined, { Depth: '1' });
      assert.equal(listing.status, 207); assert.doesNotMatch(listing.text, /Server(?:%20| )Reference/);
      assert.equal((await request('outsider', dav('outsider', 'Server Reference/nested/server-note.txt'))).status, 404);
      assert.ok([403, 404].includes((await request('outsider', dav('employee-one', 'Server Reference/nested/server-note.txt'))).status));
    });
    await check('Read-only mount rejects create, overwrite, delete, mkdir and rename', async () => {
      const cases = [
        ['PUT', 'Server Reference/new.txt', 'must not exist', {}],
        ['PUT', 'Server Reference/nested/server-note.txt', 'must not replace', {}],
        ['DELETE', 'Server Reference/nested/server-note.txt', undefined, {}],
        ['MKCOL', 'Server Reference/new-folder', undefined, {}],
        ['MOVE', 'Server Reference/nested/server-note.txt', undefined, { Destination: dav('employee-one', 'moved-source.txt'), Overwrite: 'F' }],
      ];
      for (const [method, target, body, headers] of cases) {
        const response = await request('employee-one', dav('employee-one', target), method, body, headers);
        assert.ok([403, 405].includes(response.status), `${method}: expected denied, got ${response.status}`);
      }
      assert.equal(digest(fs.readFileSync(fixture)), digest(original));
      assert.equal(fs.existsSync(path.join(state, 'source', 'new.txt')), false);
    });
    await check('Disposable employee folder supports create and download', async () => {
      assert.equal((await request('employee-one', dav('employee-one', folder), 'MKCOL')).status, 201); created = true;
      assert.equal((await request('employee-one', dav('employee-one', file), 'PUT', 'version one', { 'If-None-Match': '*', 'X-OC-Mtime': String(modifiedAt) })).status, 201);
      const result = await request('employee-one', dav('employee-one', file));
      assert.equal(result.text, 'version one'); assert.ok(result.headers.get('etag'));
      const other = await request('employee-two', dav('employee-one', file));
      assert.ok([403, 404].includes(other.status));
    });
    await check('Distinct-timestamp version checks reject duplicate creation and stale edits', async () => {
      assert.equal((await request('employee-one', dav('employee-one', file), 'PUT', 'duplicate', { 'If-None-Match': '*' })).status, 412, 'Duplicate creation must fail');
      const before = await request('employee-one', dav('employee-one', file));
      const etag = before.headers.get('etag');
      assert.ok([200, 204].includes((await request('employee-one', dav('employee-one', file), 'PUT', 'version two', { 'If-Match': etag, 'X-OC-Mtime': String(modifiedAt + 1) })).status));
      const after = await request('employee-one', dav('employee-one', file));
      assert.notEqual(after.headers.get('etag'), etag, 'A same-size write must advance the ETag');
      assert.equal((await request('employee-one', dav('employee-one', file), 'PUT', 'stale overwrite', { 'If-Match': etag })).status, 412, 'A stale ETag must not overwrite a new version');
      assert.equal((await request('employee-one', dav('employee-one', file))).text, 'version two');
    });
    await check('Byte ranges return the requested bytes', async () => {
      const result = await request('employee-one', dav('employee-one', file), 'GET', undefined, { Range: 'bytes=0-6' });
      assert.equal(result.status, 206); assert.equal(result.text, 'version');
    });
    await check('Rename and delete work inside the disposable folder', async () => {
      const renamed = `${folder}/renamed.txt`;
      assert.equal((await request('employee-one', dav('employee-one', file), 'MOVE', undefined, { Destination: dav('employee-one', renamed), Overwrite: 'F' })).status, 201);
      assert.equal((await request('employee-one', dav('employee-one', file))).status, 404);
      assert.equal((await request('employee-one', dav('employee-one', renamed))).text, 'version two');
      assert.equal((await request('employee-one', dav('employee-one', renamed), 'DELETE')).status, 204);
      assert.equal((await request('employee-one', dav('employee-one', renamed))).status, 404);
    });
    await check('Direct server edits become visible after explicit index refresh', async () => {
      fs.writeFileSync(fixture, 'Synthetic external change for indexing acceptance.\n');
      occ(['files:scan', '--path=employee-one/files/Server Reference'], { quiet: true });
      const result = await request('employee-one', dav('employee-one', 'Server Reference/nested/server-note.txt'));
      assert.equal(result.status, 200); assert.equal(result.text, fs.readFileSync(fixture, 'utf8'));
    });
    await check('Disabling an employee denies fresh authenticated requests', async () => {
      occ(['user:disable', 'employee-one'], { quiet: true }); disabled = true;
      const denied = await request('employee-one', dav('employee-one'), 'PROPFIND', undefined, { Depth: '0' });
      assert.ok([401, 403, 503].includes(denied.status), `Disabled account returned ${denied.status}`);
      assert.doesNotMatch(denied.text, /<d:multistatus/);
      occ(['user:enable', 'employee-one'], { quiet: true }); disabled = false;
      assert.equal((await request('employee-one', dav('employee-one'), 'PROPFIND', undefined, { Depth: '0' })).status, 207);
    });
    // Keep this gate last so a known engine failure does not hide independent results.
    await check('Timestamp-preserving edits advance revisions and reject stale writes', async () => {
      const target = dav('employee-one', `${folder}/preserved-time.txt`);
      const headers = { 'X-OC-Mtime': String(modifiedAt) };
      assert.equal((await request('employee-one', target, 'PUT', 'version one', { ...headers, 'If-None-Match': '*' })).status, 201);
      const before = await request('employee-one', target);
      const etag = before.headers.get('etag');
      assert.ok(etag);
      assert.ok([200, 204].includes((await request('employee-one', target, 'PUT', 'version two', { ...headers, 'If-Match': etag })).status));
      const after = await request('employee-one', target);
      const stale = await request('employee-one', target, 'PUT', 'stale edit!', { ...headers, 'If-Match': etag });
      report.revisionProbe = { sameSize: true, preservedModificationTime: true, revisionAdvanced: etag !== after.headers.get('etag'), staleWriteStatus: stale.status };
      assert.equal(stale.status, 412, 'Stale write must be rejected even when file size and modification time are preserved');
      assert.notEqual(etag, after.headers.get('etag'), 'Every completed write needs a distinct revision');
      assert.equal((await request('employee-one', target)).text, 'version two');
    });
  } finally {
    const cleanupErrors = [];
    if (disabled) { try { occ(['user:enable', 'employee-one'], { quiet: true }); } catch (error) { cleanupErrors.push(error.message); } }
    try {
      fs.writeFileSync(fixture, original);
      for (const user of ['employee-one', 'employee-two']) occ(['files:scan', `--path=${user}/files/Server Reference`], { quiet: true });
    } catch (error) { cleanupErrors.push(error.message); }
    if (created) { try { const result = await request('employee-one', dav('employee-one', folder), 'DELETE'); assert.ok([204, 404].includes(result.status)); } catch (error) { cleanupErrors.push(error.message); } }
    report.completedAt = new Date().toISOString(); report.cleanupErrors = cleanupErrors;
    report.passed = report.results.length === 12 && report.results.every(result => result.passed) && cleanupErrors.length === 0;
    fs.mkdirSync(path.join(state, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(state, 'receipts', `acceptance-${report.startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
    fs.writeFileSync(path.join(state, 'acceptance.json'), JSON.stringify(report, null, 2));
    if (cleanupErrors.length) throw new Error(`Pilot cleanup failed: ${cleanupErrors.join('; ')}`);
  }
  assert.equal(report.passed, true);
  console.log('Local service acceptance passed. Windows Explorer and TrueNAS testing remain pending.');
}
