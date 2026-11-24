'use strict';

// Invented, isolated fixtures only, in a temporary directory.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { closeOnThrow, openAssetFile, safeExistingFile } = require('../server/assetPath');

const linux = process.platform === 'linux';
const onLinux = { skip: linux ? false : 'Linux only' };
const FULL_CHECK = { platform: 'other' }; // what every platform but Linux runs

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-asset-path-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'task', 'tiles'), { recursive: true });
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(base, 'root-sibling'));
  fs.writeFileSync(path.join(root, 'top.tif'), 'top');
  fs.writeFileSync(path.join(root, 'task', 'tiles', 'a b#%.b3dm'), 'nested');
  fs.writeFileSync(path.join(outside, 'secret.tif'), 'secret');
  fs.writeFileSync(path.join(base, 'root-sibling', 'secret.tif'), 'secret');
  return { base, root, outside };
}

// Opens, checks that the handle is the file at the returned path, closes.
async function read(root, rel, options) {
  const opened = await openAssetFile(root, rel, options);
  if (!opened) return null;
  try {
    assert.equal(opened.stat.isFile(), true);
    assert.equal(typeof opened.stat.size, 'bigint');
    return { body: await opened.handle.readFile('utf8'), filePath: opened.filePath };
  } finally { await opened.handle.close(); }
}

function countSync(t) {
  const calls = [];
  for (const name of ['lstatSync', 'realpathSync', 'statSync', 'openSync', 'existsSync']) {
    const original = fs[name];
    t.mock.method(fs, name, Object.assign((...args) => { calls.push(name); return original(...args); }, original));
  }
  return calls;
}

function link(t, target, at, type) {
  try { fs.symlinkSync(target, at, type); return true; } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic(`symlinks unavailable: ${at}`);
    return false;
  }
}

test('both checks accept the same files and refuse the same paths', async (t) => {
  const { base, root, outside } = fixture(t);
  const linked = [
    link(t, path.join(outside, 'secret.tif'), path.join(root, 'link-out.tif')) && 'link-out.tif',
    link(t, path.join(root, 'top.tif'), path.join(root, 'link-in.tif')) && 'link-in.tif',
    link(t, 'top.tif', path.join(root, 'link-relative.tif')) && 'link-relative.tif',
    link(t, path.join(root, 'missing'), path.join(root, 'link-broken.tif')) && 'link-broken.tif',
    link(t, outside, path.join(root, 'task', 'dir-out'), 'junction') && 'task/dir-out/secret.tif',
    link(t, path.join(root, 'task'), path.join(root, 'dir-in'), 'junction') && 'dir-in/tiles/a b#%.b3dm',
    link(t, path.join(root, 'task', 'loop'), path.join(root, 'task', 'loop'), 'junction') && 'task/loop/x',
  ].filter(Boolean);
  const refused = [
    '', '.', '/', '..', '../outside/secret.tif', '../root-sibling/secret.tif', 'task/../../outside/secret.tif', 'task/tiles/../../../outside/secret.tif',
    path.join(outside, 'secret.tif'), 'missing.tif', 'task', 'task/tiles', 'task/tiles/', 'top.tif/x', 'top.tif/../../outside/secret.tif',
    'top.tif\0', 'top.tif\0.png', '%2e%2e/outside/secret.tif', '..%2foutside/secret.tif', 'x'.repeat(5000), ...linked,
  ];
  const accepted = { 'top.tif': 'top', './top.tif': 'top', 'task/../top.tif': 'top', 'task//tiles/a b#%.b3dm': 'nested', 'task/tiles/a b#%.b3dm': 'nested' };
  if (process.platform === 'win32') accepted['task\\tiles\\a b#%.b3dm'] = 'nested';
  else refused.push('task\\tiles\\a b#%.b3dm', '..\\outside\\secret.tif');
  for (const options of [undefined, FULL_CHECK]) {
    for (const rel of refused) {
      assert.equal(await read(root, rel, options), null, `refused: ${JSON.stringify(rel.slice(0, 60))}`);
      assert.equal(safeExistingFile(root, rel), null);
    }
    for (const [rel, body] of Object.entries(accepted)) {
      const result = await read(root, rel, options);
      assert.equal(result?.body, body, rel);
      assert.equal(result.filePath, safeExistingFile(root, rel), 'same real path as the full check');
      assert.equal(result.filePath, path.join(root, path.normalize(rel)));
    }
  }
  assert.equal(await read(path.join(base, 'no-such-root'), 'top.tif'), null);
  assert.equal(await read(path.join(root, 'top.tif'), 'x'), null, 'a file as root');
});

test('a root that is itself a link is allowed, and a retargeted root is followed at once', async (t) => {
  const { base, root, outside } = fixture(t);
  const alias = path.join(base, 'alias');
  if (!link(t, root, alias, 'junction')) return;
  for (const options of [undefined, FULL_CHECK]) {
    assert.deepEqual(await read(alias, 'top.tif', options), { body: 'top', filePath: path.join(root, 'top.tif') });
  }
  fs.unlinkSync(alias);
  link(t, outside, alias, 'junction');
  // Content now reached only through a link below the new root stays refused,
  // even though it lies in the old one.
  const back = link(t, root, path.join(outside, 'task'), 'junction');
  for (const options of [undefined, FULL_CHECK]) {
    assert.equal(await read(alias, 'top.tif', options), null);
    assert.equal((await read(alias, 'secret.tif', options)).body, 'secret');
    if (back) assert.equal(await read(alias, 'task/top.tif', options), null);
  }
});

test('non-regular files are refused without blocking', onLinux, async (t) => {
  const { root } = fixture(t);
  execFileSync('mkfifo', [path.join(root, 'pipe.tif')]);
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(path.join(root, 'sock.tif'), resolve));
  t.after(() => new Promise((resolve) => socket.close(resolve)));
  const started = Date.now();
  for (const rel of ['pipe.tif', 'sock.tif', 'task']) assert.equal(await read(root, rel), null, rel);
  assert.ok(Date.now() - started < 2000, 'opening a FIFO did not wait for a writer');
  for (const device of ['null', 'zero', 'tty']) assert.equal(await read('/dev', device), null, device);
  assert.equal(await read('/', 'etc/hostname'), null, 'the filesystem root is never an asset root');
});

test('Linux runs no synchronous filesystem call for a normal asset and none for a missing one', onLinux, async (t) => {
  const { root } = fixture(t);
  const calls = countSync(t);
  assert.equal((await read(root, 'task/tiles/a b#%.b3dm')).body, 'nested');
  assert.equal(await read(root, 'task/tiles/missing.b3dm'), null);
  assert.equal(await read(root, 'task'), null);
  assert.deepEqual(calls, []);
});

test('a renamed, replaced or deleted file during the open never serves another location', onLinux, async (t) => {
  const { root, outside } = fixture(t);
  const file = path.join(root, 'top.tif');
  const open = fs.promises.open;
  const during = async (change, rel = 'top.tif') => {
    const mocked = t.mock.method(fs.promises, 'open', async (...args) => { const handle = await open(...args); mocked.mock.restore(); change(); return handle; });
    try { return await read(root, rel); } finally { mocked.mock.restore(); }
  };
  assert.equal(await during(() => fs.renameSync(file, path.join(outside, 'moved.tif'))), null, 'moved out of the root');
  fs.writeFileSync(file, 'top');
  assert.equal(await during(() => fs.unlinkSync(file)), null, 'deleted');
  fs.writeFileSync(file, 'top');
  const replaced = await during(() => { fs.writeFileSync(`${file}.new`, 'new'); fs.renameSync(`${file}.new`, file); });
  assert.equal(replaced, null, 'replaced: the unlinked file is refused, nothing is opened twice');
  assert.equal((await read(root, 'top.tif')).body, 'new', 'the next request serves the new one');
  // A directory swapped for a link to outside after the open.
  const swapped = await during(() => { fs.renameSync(path.join(root, 'task'), path.join(root, 'task-old')); fs.symlinkSync(outside, path.join(root, 'task')); }, 'task/tiles/a b#%.b3dm');
  assert.equal(swapped, null);
});

test('a directory flipping between a real one and a link out never leaks outside content', onLinux, async (t) => {
  const { root, outside } = fixture(t);
  fs.mkdirSync(path.join(root, 'flip'));
  fs.writeFileSync(path.join(root, 'flip', 'secret.tif'), 'inside');
  const real = path.join(root, 'flip-real'), dir = path.join(root, 'flip'), evil = path.join(root, 'flip-link');
  fs.symlinkSync(outside, evil);
  let stop = false, flips = 0;
  const flipper = (async () => {
    while (!stop) {
      await fs.promises.rename(dir, real); await fs.promises.rename(evil, dir);
      await fs.promises.rename(dir, evil); await fs.promises.rename(real, dir);
      flips += 1;
      await new Promise((resolve) => setTimeout(resolve, flips % 3)); // let some opens meet the real directory
    }
  })();
  const seen = {};
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    for (const result of await Promise.all(Array.from({ length: 8 }, () => read(root, 'flip/secret.tif').catch(() => null)))) {
      const body = result ? result.body : 'refused';
      seen[body] = (seen[body] || 0) + 1;
    }
  }
  stop = true;
  await flipper;
  t.diagnostic(`${flips} flips, ${JSON.stringify(seen)}`);
  assert.equal(seen.secret || 0, 0);
  assert.ok(seen.inside > 0, 'the real file was served');
});

const codeError = (code) => Object.assign(new Error(code), { code });
// Records every open: its flags and whether its handle was closed.
function recordOpens(t, { before = () => {}, onHandle = () => {} } = {}) {
  const opens = [];
  const { open } = fs.promises;
  const mocked = t.mock.method(fs.promises, 'open', async (file, flags, ...rest) => {
    const entry = { flags, handle: null };
    opens.push(entry);
    await before(opens.length, file, flags);
    entry.handle = await open(file, flags, ...rest);
    await onHandle(entry.handle, opens.length);
    return entry.handle;
  });
  return { opens, restore: () => mocked.mock.restore(), open: () => opens.filter(({ handle }) => handle && handle.fd !== -1).length };
}

test('when the kernel cannot confirm the path, the full check decides about the same open file', onLinux, async (t) => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'task', 'dir-out'));
  fs.symlinkSync(path.join(root, 'top.tif'), path.join(root, 'link-in.tif'));
  execFileSync('mkfifo', [path.join(root, 'pipe.tif')]);
  const cases = {
    'no /proc': () => t.mock.method(fs.promises, 'readlink', async () => { throw codeError('ENOENT'); }),
    'another spelling': () => t.mock.method(fs.promises, 'readlink', async () => path.join(root, 'TOP.TIF')),
    'realpath failed': () => t.mock.method(fs.promises, 'realpath', async () => { throw codeError('EIO'); }),
  };
  const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  for (const [label, setup] of Object.entries(cases)) {
    const mocked = setup();
    const calls = countSync(t), record = recordOpens(t);
    assert.equal((await read(root, 'top.tif')).body, 'top', label);
    assert.ok(calls.includes('lstatSync'), `${label}: full check ran`);
    for (const rel of ['task/dir-out/secret.tif', 'link-in.tif', 'pipe.tif', '../outside/secret.tif', 'task', 'missing.tif']) assert.equal(await read(root, rel), null, `${label} ${rel}`);
    assert.ok(record.opens.length >= 6, label);
    for (const { flags } of record.opens) assert.equal(flags & (O_NOFOLLOW | O_NONBLOCK), O_NOFOLLOW | O_NONBLOCK, `${label}: every open is no-follow and nonblocking`);
    assert.equal(record.open(), 0, `${label}: every handle is closed`);
    const before = record.opens.length;
    assert.equal((await read(root, 'top.tif')).body, 'top');
    assert.equal(record.opens.length, before + 1, `${label}: the file is opened once`);
    record.restore();
    mocked.mock.restore();
    t.mock.restoreAll();
  }
  // The directory becomes a link after the open, then the full check runs.
  fs.writeFileSync(path.join(root, 'task', 'secret.tif'), 'inside');
  const swap = () => { fs.renameSync(path.join(root, 'task'), path.join(root, 'task-old')); fs.symlinkSync(outside, path.join(root, 'task')); };
  t.mock.method(fs.promises, 'readlink', async () => { swap(); throw codeError('ENOENT'); });
  const record = recordOpens(t);
  assert.equal(await read(root, 'task/secret.tif'), null);
  assert.equal(record.open(), 0);
  t.mock.restoreAll();
  // The directory was a link during the open and is real again for the check.
  t.mock.method(fs.promises, 'readlink', async () => { fs.unlinkSync(path.join(root, 'task')); fs.renameSync(path.join(root, 'task-old'), path.join(root, 'task')); throw codeError('ENOENT'); });
  const second = recordOpens(t);
  assert.equal(await read(root, 'task/secret.tif'), null, 'the opened outside file is not the checked one');
  assert.equal(second.open(), 0);
});

test('a leased file is retried without blocking, then refused; other open errors refuse at once', onLinux, async (t) => {
  const { root } = fixture(t);
  const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  for (const [label, failures, expected, opens] of [['released in time', 2, 'top', 3], ['never released', Infinity, null, 5]]) {
    const record = recordOpens(t, { before: (count) => { if (count <= failures) throw codeError('EAGAIN'); } });
    assert.equal((await read(root, 'top.tif'))?.body ?? null, expected, label);
    assert.equal(record.opens.length, opens, label);
    for (const { flags } of record.opens) assert.equal(flags & (O_NOFOLLOW | O_NONBLOCK), O_NOFOLLOW | O_NONBLOCK, `${label}: never a blocking open`);
    record.restore();
  }
  for (const code of ['EACCES', 'EMFILE', 'ENFILE', 'ENXIO', 'EIO', 'ESTALE']) {
    const record = recordOpens(t, { before: () => { throw codeError(code); } });
    assert.equal(await read(root, 'top.tif'), null, code);
    assert.equal(record.opens.length, 1, code);
    record.restore();
  }
});

test('every early exit closes the opened file', onLinux, async (t) => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'task', 'dir-out'));
  const failing = (target, name, code) => () => t.mock.method(target, name, () => { throw codeError(code); });
  const cases = {
    'fstat fails': [(handle) => { handle.stat = async () => { throw codeError('EIO'); }; }, () => {}],
    'not a file': [(handle) => { handle.stat = async () => ({ isFile: () => false }); }, () => {}],
    'a directory': [() => {}, () => {}, 'task'],
    'outside through a link': [() => {}, () => {}, 'task/dir-out/secret.tif'],
    'full check throws': [() => {}, () => { failing(fs.promises, 'readlink', 'ENOENT')(); failing(fs, 'lstatSync', 'EIO')(); }],
    'full check finds nothing': [() => {}, () => { failing(fs.promises, 'readlink', 'ENOENT')(); failing(fs, 'realpathSync', 'EIO')(); }],
    'another inode': [(handle) => { const stat = handle.stat.bind(handle); handle.stat = async (options) => Object.assign(await stat(options), { ino: 1n }); }, failing(fs.promises, 'readlink', 'ENOENT')],
    'another device': [(handle) => { const stat = handle.stat.bind(handle); handle.stat = async (options) => Object.assign(await stat(options), { dev: 1n }); }, failing(fs.promises, 'readlink', 'ENOENT')],
  };
  for (const [label, [onHandle, setup, rel = 'top.tif']] of Object.entries(cases)) {
    const record = recordOpens(t, { onHandle });
    setup();
    assert.equal(await openAssetFile(root, rel), null, label);
    t.mock.restoreAll();
    assert.equal(record.opens.length, 1, label);
    assert.equal(record.opens[0].handle.fd, -1, `${label}: closed`);
  }
});

test('closeOnThrow closes the handle only when the work throws', async (t) => {
  const { root } = fixture(t);
  const opened = await openAssetFile(root, 'top.tif');
  assert.equal(closeOnThrow(opened, () => 7), 7);
  assert.notEqual(opened.handle.fd, -1);
  assert.throws(() => closeOnThrow(opened, () => { throw codeError('boom'); }), { code: 'boom' });
  for (let i = 0; i < 100 && opened.handle.fd !== -1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(opened.handle.fd, -1);
});

test('handles never leak, whatever the outcome', onLinux, async (t) => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'task', 'dir-out'));
  const openFds = () => fs.readdirSync('/proc/self/fd').filter((fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(path.dirname(root)); } catch { return false; } });
  for (const rel of ['top.tif', 'task', 'missing', 'task/dir-out/secret.tif', '../outside/secret.tif']) await read(root, rel);
  assert.deepEqual(openFds(), []);
});

// One real request per route that opens an asset.
test('asset, photo and download routes refuse links and serve through the checked handle', async (t) => {
  let cleanup = () => {};
  t.after(() => cleanup()); // before the fixture removes its files
  const { base, root, outside } = fixture(t);
  const previous = { modelsMount: config.modelsMount, xAccelRedirectPrefix: config.xAccelRedirectPrefix };
  Object.assign(config, { modelsMount: root, xAccelRedirectPrefix: '' });
  const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const single = (kind, relativePath, body) => ({ kind, rootKey: 'models', relativePath, format: path.extname(relativePath).slice(1), byteSize: body.length, sha256: sha256(body), storageMode: 'managed', published: true });
  fs.writeFileSync(path.join(root, 'task', 'ortho.tif'), 'ortho');
  fs.writeFileSync(path.join(root, 'task', 'photo.jpg'), 'photo');
  fs.writeFileSync(path.join(outside, 'dsm.tif'), 'dsm');
  const database = openDatabase(path.join(base, 'viewer.sqlite')), repository = new ViewerRepository(database);
  const modelId = crypto.randomUUID(), versionId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  repository.upsertModelVersion({ modelId, versionId, provider: 'ltds-processing', providerModelId: 'path', providerVersionId: sha256('path'), displayName: 'Path', status: 'ready', sourceLocator: {}, versionMetadata: {}, makeActive: true,
    assets: [single('ortho', 'task/ortho.tif', 'ortho'), single('dsm', 'task/linked/dsm.tif', 'dsm'), single('glb', 'task/gone.glb', 'x'), single('shots', 'task/shots.geojson', '{}')] });
  const photo = (filename, relativePath) => ({ filename, rootKey: 'models', relativePath, contentType: 'image/jpeg', byteSize: 5, sha256: sha256('photo') });
  repository.replaceCameraPhotos(versionId, [photo('photo.jpg', 'task/photo.jpg'), photo('linked.jpg', 'task/linked/photo.jpg')]);
  fs.writeFileSync(path.join(outside, 'photo.jpg'), 'photo');
  const linked = link(t, outside, path.join(root, 'task', 'linked'), 'junction');
  repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId, modelVersionId: versionId, subject: 'x', audience: 'ops', permissions: { view: true, download: true }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assets.setRepository(repository);
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  cleanup = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assets.setRepository(null);
    Object.assign(config, previous);
    database.close();
  };
  const origin = `http://127.0.0.1:${server.address().port}`;
  // node:http sends the path as written; fetch() would resolve `..` itself.
  const get = (url) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: url, agent: false }, async (response) => {
      let body = '';
      for await (const part of response) body += part;
      resolve([response.statusCode, body]);
    }).on('error', reject);
  });
  const asset = (rel) => get(`/session-assets/${token}/${modelId}/models/${rel}`);
  const notFound = [404, JSON.stringify({ error: 'asset not found' })];
  const sync = countSync(t);
  assert.deepEqual(await asset('task/ortho.tif'), [200, 'ortho']);
  assert.deepEqual(await get(`/session-camera-photos/${token}/${modelId}/photo.jpg`), [200, 'photo']);
  const products = async (kind) => { const response = await fetch(`${origin}/session-products/${token}/${modelId}/${kind}/download-grants`, { method: 'POST' }); return (await response.json()).url; };
  assert.deepEqual(await get(await products('ortho')), [200, 'ortho']);
  if (linux) assert.deepEqual(sync, [], 'no synchronous filesystem call on any of the three routes');
  assert.deepEqual(await asset('task/gone.glb'), notFound);
  assert.deepEqual(await asset('task/..%2f..%2foutside%2fdsm.tif'), notFound);
  for (const rel of ['%2e%2e/outside/dsm.tif', '../outside/dsm.tif', '..%5c..%5coutside%5cdsm.tif', '%2fetc%2fhostname', 'task%00/ortho.tif']) assert.equal((await asset(rel))[0], 404, rel);
  if (linked) {
    assert.deepEqual(await asset('task/linked/dsm.tif'), notFound);
    assert.equal((await get(`/session-camera-photos/${token}/${modelId}/linked.jpg`))[0], 404);
    assert.equal((await get(await products('dsm')))[0], 404);
  }

  // Integrity setup or the X-Accel location throws after the file is open.
  const record = recordOpens(t);
  const closed = async (label, status) => {
    const opens = record.opens.filter(({ handle }) => handle);
    assert.equal(opens.length, 1, `${label}: one open`);
    for (let i = 0; i < 100 && opens[0].handle.fd !== -1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(opens[0].handle.fd, -1, `${label}: the descriptor is closed`);
    assert.equal(status, 500, label);
    record.opens.length = 0;
  };
  const dbDown = () => { throw new Error('database failed'); };
  const downloadUrl = await products('ortho');
  Object.assign(repository, { getModelAssetChunks: dbDown, getModelAssetFile: dbDown });
  await closed('asset', (await asset('task/ortho.tif'))[0]);
  await closed('product download', (await get(downloadUrl))[0]);
  delete repository.getModelAssetChunks; delete repository.getModelAssetFile;
  Object.defineProperty(config, 'xAccelRedirectPrefix', { configurable: true, get: dbDown });
  await closed('asset X-Accel', (await asset('task/ortho.tif'))[0]);
  await closed('photo X-Accel', (await get(`/session-camera-photos/${token}/${modelId}/photo.jpg`))[0]);
  Object.defineProperty(config, 'xAccelRedirectPrefix', { configurable: true, enumerable: true, writable: true, value: '' });
  assert.deepEqual(await asset('task/ortho.tif'), [200, 'ortho']);
});
