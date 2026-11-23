'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { collectRecoveryCompanions } = require('../server/lodRecoveryCompanions');
const { recoveryRegistrationIdentity } = require('../server/outputPreservation');
const { scopedStorageRootKey } = require('../server/storageManager');
const { ContentChunkBackfill, backfillRoot, contentChunkReport, createByteBudget, LOCATIONS_PER_DIGEST, scanCandidates, setPaused } = require('../server/contentChunkBackfill');

const MIB = 1024 * 1024, HOUR = 3600000, DAY = 24 * HOUR;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const linux = { skip: process.platform === 'win32' };
const unlimited = async () => {};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-content-chunks-'));
  const config = { modelsMount: path.join(root, 'models'), datasetsMount: path.join(root, 'datasets'), webodmMediaMount: path.join(root, 'webodm'), terraImportMount: path.join(root, 'terra'), derivativesMount: '' };
  for (const directory of Object.values(config)) if (directory) fs.mkdirSync(directory);
  const databasePath = path.join(root, 'viewer.sqlite'), database = openDatabase(databasePath);
  const c = { root, config, databasePath, database, repository: new ViewerRepository(database), processing: new ProcessingRepository(database), log: [], clock: Date.parse('2026-11-23T12:00:00.000Z'), versions: 0 };
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  c.backfill = (options = {}) => new ContentChunkBackfill({ database, config, budget: unlimited, log: line => c.log.push(line), now: () => c.clock, ...options });
  c.run = async (options) => { const lane = c.backfill(options); let files = 0; while (await lane.runOne()) files += 1; return files; };
  c.sets = () => database.prepare('SELECT * FROM content_chunk_sets ORDER BY content_sha256').all();
  c.failures = () => database.prepare('SELECT content_sha256,byte_size,reason,attempts,next_attempt_at FROM content_chunk_failures ORDER BY content_sha256').all().map(row => ({ ...row }));
  c.audits = () => database.prepare("SELECT entity_id,details_json FROM audit_events WHERE action='content_chunks.verification_failed'").all();
  c.write = (relativePath, bytes, mount = config.modelsMount) => {
    const file = path.join(mount, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return { file, rootKey: mount === config.datasetsMount ? 'datasets' : 'models', relativePath, byteSize: bytes.length, sha256: sha(bytes) };
  };
  c.register = (assets, extra = {}) => {
    c.versions += 1;
    const id = `version-${c.versions}`;
    // Files registered without chunk rows: writers refuse new ones of 4 MiB or
    // more unless they are marked as copies of such a legacy file.
    c.repository.upsertModelVersion({ modelId: `model-${c.versions}`, versionId: id, provider: 'ltds-processing', providerModelId: `p${c.versions}`, providerVersionId: 'v', displayName: 'Fixture', status: 'ready', sourceLocator: {}, makeActive: true,
      assets: assets.map(({ file, ...asset }) => ({ ...asset, recoveryCopy: true })), ...extra });
    return id;
  };
  return c;
}

const raster = (c, name = 'ortho.tif', size = 5 * MIB + 123) => ({ kind: 'ortho', ...c.write(name, crypto.randomBytes(size)) });

function expectedDigests(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += MIB) parts.push(crypto.createHash('sha256').update(bytes.subarray(offset, offset + MIB)).digest());
  return Buffer.concat(parts);
}

function assertNothingBlessed(c, asset, reason) {
  assert.deepEqual(c.sets(), []);
  assert.deepEqual(c.failures().map(({ content_sha256, reason: value }) => [content_sha256, value]), [[asset.sha256, reason]]);
}

test('a verified file gets one immutable 1 MiB set and the file itself is untouched', async t => {
  const c = fixture(t), asset = raster(c), bytes = fs.readFileSync(asset.file), before = fs.statSync(asset.file);
  c.register([asset]);
  fs.chmodSync(asset.file, 0o444);
  assert.equal(await c.run(), 1);
  const [set] = c.sets();
  assert.equal(set.content_sha256, asset.sha256);
  assert.equal(set.byte_size, asset.byteSize);
  assert.equal(set.chunk_size, MIB);
  assert.deepEqual(Buffer.from(set.digests), expectedDigests(bytes));
  assert.deepEqual(fs.readFileSync(asset.file), bytes);
  assert.equal(fs.statSync(asset.file).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(c.config.modelsMount), ['ortho.tif']);
  fs.chmodSync(asset.file, 0o644);
  assert.throws(() => c.database.prepare('UPDATE content_chunk_sets SET byte_size=byte_size').run(), /immutable/);
  const insert = (key, size, digests) => c.database.prepare('INSERT INTO content_chunk_sets VALUES (?,?,?,?,?)').run(key, size, MIB, digests, 'now');
  assert.throws(() => insert('a'.repeat(64), 5 * MIB, Buffer.alloc(32 * 4)), /CHECK/, 'a short blob is refused');
  assert.throws(() => insert('A'.repeat(64), MIB, Buffer.alloc(32)), /CHECK/, 'keys are lowercase');
});

test('an exact multiple of 1 MiB and exactly 4 MiB are covered without an empty chunk', async t => {
  const c = fixture(t), four = raster(c, 'four.tif', 4 * MIB), six = { ...raster(c, 'six.tif', 6 * MIB), kind: 'dsm' };
  c.register([four, six]);
  assert.equal(await c.run(), 2);
  assert.deepEqual(Object.fromEntries(c.sets().map(set => [set.byte_size, set.digests.length / 32])), { [4 * MIB]: 4, [6 * MIB]: 6 });
});

test('tampered bytes of the same size are never blessed, are audited once and retried daily', async t => {
  const c = fixture(t), asset = raster(c);
  c.register([asset]);
  const good = fs.readFileSync(asset.file), bad = Buffer.from(good);
  bad[bad.length - 1] ^= 1;
  fs.writeFileSync(asset.file, bad);
  assert.equal(await c.run(), 1);
  assertNothingBlessed(c, asset, 'digest_mismatch');
  assert.equal(c.audits().length, 1);
  assert.equal(c.failures()[0].next_attempt_at, new Date(c.clock + DAY).toISOString());
  assert.equal(await c.run(), 0, 'not before the retry time');
  c.clock += DAY + 1;
  assert.equal(await c.run(), 1);
  assertNothingBlessed(c, asset, 'digest_mismatch');
  assert.equal(c.failures()[0].attempts, 2);
  assert.equal(c.audits().length, 1, 'a daily retry does not repeat the audit event');
  fs.writeFileSync(asset.file, good);
  c.clock += DAY + 1;
  assert.equal(await c.run(), 1);
  assert.equal(c.sets().length, 1);
  assert.deepEqual(c.failures(), [], 'a restored file clears its failure');
});

for (const [label, change] of [['shorter', bytes => bytes.subarray(0, bytes.length - 1)], ['longer', bytes => Buffer.concat([bytes, Buffer.from([0])])]]) {
  test(`a ${label} file is refused before it is read`, async t => {
    const c = fixture(t), asset = raster(c);
    c.register([asset]);
    fs.writeFileSync(asset.file, change(fs.readFileSync(asset.file)));
    let read = 0;
    await c.run({ budget: async bytes => { read += bytes; } });
    assertNothingBlessed(c, asset, 'size_mismatch');
    assert.equal(read, 0);
  });
}

for (const [label, swap, reason] of [
  ['overwritten in place behind the reader', file => { const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, Buffer.from('x'), 0, 1, 4 * MIB); fs.closeSync(fd); }, 'digest_mismatch'],
  ['truncated', file => fs.truncateSync(file, 3 * MIB), 'size_mismatch'],
  ['extended', file => fs.appendFileSync(file, 'x'), 'size_mismatch'],
]) test(`a file ${label} during the read gets no set`, async t => {
  const c = fixture(t), asset = raster(c);
  c.register([asset]);
  let reads = 0;
  await c.run({ budget: async () => { reads += 1; if (reads === 3) swap(asset.file); } });
  assertNothingBlessed(c, asset, reason);
  assert.equal(c.audits().length, 1);
});

test('bytes written over an already hashed chunk leave no set, although the pass read the recorded bytes', async t => {
  const c = fixture(t), asset = raster(c);
  c.register([asset]);
  let reads = 0;
  await c.run({ budget: async () => { reads += 1; if (reads === 3) { const fd = fs.openSync(asset.file, 'r+'); fs.writeSync(fd, Buffer.from('tampered'), 0, 8, 0); fs.closeSync(fd); } } });
  assertNothingBlessed(c, asset, 'read_error');
  c.clock += HOUR + 1;
  await c.run();
  assertNothingBlessed(c, asset, 'digest_mismatch');
});

test('a file that grew and shrank back during the read gets no set', async t => {
  const c = fixture(t), asset = raster(c);
  c.register([asset]);
  let reads = 0;
  await c.run({ budget: async () => { reads += 1; if (reads === 3) { fs.appendFileSync(asset.file, 'x'); fs.truncateSync(asset.file, asset.byteSize); } } });
  assertNothingBlessed(c, asset, 'read_error');
});

// Wraps the next matching open so a test can act around it.
function onOpen(t, file, { before = () => {}, beforeClose = () => {}, afterClose = () => {} }) {
  const open = fs.promises.open;
  t.after(() => { fs.promises.open = open; });
  fs.promises.open = async (target, ...rest) => {
    if (target !== file) return open.call(fs.promises, target, ...rest);
    before();
    const handle = await open.call(fs.promises, target, ...rest), close = handle.close.bind(handle);
    handle.close = async () => { beforeClose(); await close(); afterClose(); };
    return handle;
  };
}

test('a directory swapped for a link to outside between the checks and the open is refused', linux, async t => {
  const c = fixture(t), asset = raster(c, 'tree/ortho.tif'), outside = path.join(c.root, 'outside'), tree = path.join(c.config.modelsMount, 'tree');
  c.register([asset]);
  let read = 0;
  onOpen(t, asset.file, { before: () => { fs.renameSync(tree, outside); fs.symlinkSync(outside, tree); } });
  await c.run({ budget: async bytes => { read += bytes; } });
  assertNothingBlessed(c, asset, 'unsafe_path');
  assert.equal(read, 0, 'the recorded bytes outside the root are not read');
});

test('a file replaced between the checks and the open is hashed from the opened file only', async t => {
  const c = fixture(t), asset = raster(c);
  c.register([asset]);
  onOpen(t, asset.file, { before: () => { fs.rmSync(asset.file); fs.writeFileSync(asset.file, Buffer.alloc(asset.byteSize, 1)); } });
  await c.run();
  assertNothingBlessed(c, asset, 'digest_mismatch');
});

for (const [label, prepare, reason] of [
  ['a verified set', () => {}, null],
  ['a mismatch', file => { const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); }, 'digest_mismatch'],
]) for (const edge of ['beforeClose', 'afterClose']) {
  test(`a stop ${edge === 'beforeClose' ? 'before' : 'after'} the final close does not record ${label}`, async t => {
    const c = fixture(t), asset = raster(c), stop = new AbortController();
    c.register([asset]);
    prepare(asset.file);
    onOpen(t, asset.file, { [edge]: () => stop.abort() });
    const lane = c.backfill({ signal: stop.signal });
    assert.equal(await lane.runOne(), false);
    assert.deepEqual([c.sets(), c.failures(), c.audits()], [[], [], []]);
    assert.deepEqual([lane.status().stored, lane.status().failed], [0, 0]);
    assert.doesNotMatch(c.log.join('\n'), /sha256=/);
  });

  test(`a pause ${edge === 'beforeClose' ? 'before' : 'after'} the final close holds back ${label} until it is released`, async t => {
    const c = fixture(t), asset = raster(c);
    c.register([asset]);
    prepare(asset.file);
    let polls = 0;
    onOpen(t, asset.file, { [edge]: () => setPaused(c.database, true) });
    // The clock does not move: the gate must not trust a cached pause state.
    await c.run({ hold: async () => {
      polls += 1;
      assert.deepEqual([c.sets(), c.failures(), c.audits()], [[], [], []]);
      if (polls === 3) setPaused(c.database, false);
    } });
    assert.equal(polls, 3);
    assert.deepEqual([c.sets().length, c.failures().map(row => row.reason)], reason ? [0, [reason]] : [1, []]);
  });
}

test('a stop while a missing file is being looked up records nothing', async t => {
  const c = fixture(t), asset = raster(c), stop = new AbortController(), lstat = fs.promises.lstat;
  c.register([asset]);
  fs.rmSync(asset.file);
  t.after(() => { fs.promises.lstat = lstat; });
  fs.promises.lstat = async target => { stop.abort(); return lstat.call(fs.promises, target); };
  assert.equal(await c.run({ signal: stop.signal }), 0);
  assert.deepEqual([c.sets(), c.failures()], [[], []]);
});

for (const [label, spoil, reason, audits] of [
  ['tampered', file => { const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); }, 'digest_mismatch', 1],
  ['missing', file => fs.rmSync(file), 'unavailable', 0],
]) for (const first of ['good', 'bad']) test(`two workers, one ${label} copy, ${first} result first: the proven set wins and no retry record survives`, async t => {
  const c = fixture(t), bad = raster(c, 'bad/ortho.tif'), bytes = fs.readFileSync(bad.file), good = { kind: 'ortho', ...c.write('good/ortho.tif', bytes) };
  const badVersion = c.register([bad]), goodVersion = c.register([good]);
  spoil(bad.file);
  const other = openDatabase(c.databasePath);
  const item = (asset, versionId) => ({ sha256: asset.sha256, byteSize: asset.byteSize, kind: 'ortho', locations: [{ versionId, rootKey: 'models', relativePath: asset.relativePath, assetId: null }] });
  let go = {};
  const gate = { good: new Promise(resolve => { go.good = resolve; }), bad: new Promise(resolve => { go.bad = resolve; }) };
  const lane = (name, database, value) => {
    const worker = c.backfill({ database });
    worker.queue = [value];
    const publish = worker.publish.bind(worker);
    // Both have finished reading before either may publish.
    worker.publish = async record => { go[`${name}Ready`](); await gate[name]; return publish(record); };
    return worker;
  };
  const ready = Promise.all(['good', 'bad'].map(name => new Promise(resolve => { go[`${name}Ready`] = resolve; })));
  const runs = { good: lane('good', c.database, item(good, goodVersion)).runOne(), bad: lane('bad', other, item(bad, badVersion)).runOne() };
  await ready;
  go[first]();
  await runs[first];
  assert.deepEqual([c.sets().length, c.failures().map(row => row.reason)], first === 'good' ? [1, []] : [0, [reason]]);
  go[first === 'good' ? 'bad' : 'good']();
  await Promise.all(Object.values(runs));
  assert.equal(c.sets().length, 1);
  assert.deepEqual(c.failures(), []);
  assert.equal(c.audits().length, audits, 'a tampered copy is audited whoever finishes first');
  c.clock += 30 * DAY;
  assert.equal(await c.run(), 0);
  other.close();
});

test('a batch is bounded by digests and by places, and one file linked by many versions is one place', t => {
  const c = fixture(t), shared = { filename: 'A.JPG', rootKey: 'datasets', relativePath: 'd/A.JPG', contentType: 'image/jpeg', byteSize: 5 * MIB, sha256: 'a'.repeat(64) };
  for (let index = 0; index < 40; index += 1) c.register([], { cameraPhotos: [shared, { ...shared, filename: 'B.JPG', relativePath: `copy-${index}/B.JPG`, sha256: 'b'.repeat(64) }] });
  const { items, totalFiles } = scanCandidates(c.database);
  assert.equal(totalFiles, 2);
  assert.deepEqual(items.map(item => [item.sha256[0], item.locations.length]), [['a', 1], ['b', LOCATIONS_PER_DIGEST]]);
});

test('retries move through every place, so a good copy beyond the first eight is found', async t => {
  const c = fixture(t), bytes = crypto.randomBytes(4 * MIB), total = 3 * LOCATIONS_PER_DIGEST + 3;
  const copies = Array.from({ length: total }, (_, index) => ({ kind: 'ortho', ...c.write(`copy-${String(index).padStart(2, '0')}/ortho.tif`, bytes) }));
  for (const copy of copies) c.register([copy]);
  for (const copy of copies.slice(0, -1)) fs.rmSync(copy.file);
  const seen = new Set();
  let passes = 0;
  while (!c.sets().length && passes < 10) {
    for (const location of scanCandidates(c.database, { at: c.clock }).items[0].locations) seen.add(location.relativePath);
    await c.run();
    passes += 1;
    c.clock += DAY + 1;
  }
  assert.equal(passes, 4);
  assert.equal(seen.size, total);
  assert.equal(c.sets().length, 1);
});

test('a tampered copy is audited even when another location of the same digest is good', async t => {
  const c = fixture(t), first = raster(c, 'a/ortho.tif'), bytes = fs.readFileSync(first.file), second = { kind: 'ortho', ...c.write('b/ortho.tif', bytes) };
  c.register([first]);
  c.register([second]);
  for (const file of [first.file]) { const bad = Buffer.from(bytes); bad[0] ^= 1; fs.writeFileSync(file, bad); }
  c.database.prepare('UPDATE model_assets SET published=0 WHERE relative_path=?').run('b/ortho.tif');
  assert.equal(await c.run(), 1);
  assert.deepEqual(Buffer.from(c.sets()[0].digests), expectedDigests(bytes));
  assert.equal(c.audits().length, 1);
  assert.deepEqual(c.failures(), []);
});

test('a missing location falls back to another copy, then backs off when there is none', async t => {
  const c = fixture(t), first = raster(c, 'a/ortho.tif'), bytes = fs.readFileSync(first.file), second = { kind: 'ortho', ...c.write('b/ortho.tif', bytes) };
  c.register([first]);
  c.register([second]);
  fs.rmSync(first.file);
  fs.renameSync(second.file, `${second.file}.away`);
  assert.equal(await c.run(), 1);
  assertNothingBlessed(c, first, 'unavailable');
  assert.deepEqual(c.audits(), [], 'a missing file is not evidence of tampering');
  for (const hours of [1, 2, 4, 8, 16, 24, 24]) {
    assert.equal(Date.parse(c.failures()[0].next_attempt_at) - c.clock, hours * HOUR);
    c.clock += hours * HOUR + 1;
    assert.equal(await c.run(), 1);
  }
  fs.renameSync(`${second.file}.away`, second.file);
  c.clock += DAY + 1;
  await c.run();
  assert.equal(c.sets().length, 1);
});

test('the skip list: no recorded hash, unusable hash, unlisted tree, small, trashed and unready files', async t => {
  const c = fixture(t), big = crypto.randomBytes(4 * MIB), skip = name => ({ kind: 'ortho', ...c.write(name, Buffer.concat([big, Buffer.from(name)])) });
  c.register([{ ...skip('null.tif'), sha256: null }]);
  const upper = skip('upper.tif');
  c.register([{ ...upper, sha256: upper.sha256.toUpperCase() }]);
  c.register([raster(c, 'small.tif', 4 * MIB - 1)]);
  c.register([skip('importing.tif')], { status: 'importing' });
  const unregistered = c.register([skip('unregistered.tif')]);
  c.database.prepare("UPDATE models SET status='unregistered' WHERE id=(SELECT model_id FROM model_versions WHERE id=?)").run(unregistered);
  const child = c.write('tree/data/0.bin', big);
  c.register([{ kind: 'ept', rootKey: 'models', relativePath: 'tree/ept.json', byteSize: 2, sha256: sha('{}'), manifestSha256: null, manifestFiles: [{ relativePath: 'data/0.bin', byteSize: child.byteSize, sha256: child.sha256 }] }]);
  const trashed = c.register([skip('trashed.tif')]);
  const project = c.processing.createProject({ displayName: 'P' }), dataset = c.processing.createDataset({ projectId: project.id, displayName: 'D', storageMode: 'managed', rootKey: 'datasets', relativePath: 'd' });
  c.processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'T' }), attempt = c.processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: 'x', createdBy: 'test', staged: false });
  c.processing.registerModelOutput({ versionId: trashed, modelId: c.database.prepare('SELECT model_id FROM model_versions WHERE id=?').get(trashed).model_id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: 'out', byteSize: 1, assetCount: 1 });
  c.database.prepare("UPDATE model_outputs SET status='trashed' WHERE id=?").run(trashed);
  let read = 0;
  assert.equal(await c.run({ budget: async bytes => { read += bytes; } }), 0);
  assert.equal(read, 0);
  assert.deepEqual(c.sets(), []);
  const { skipped } = contentChunkReport(c.database);
  assert.deepEqual(skipped, { noRecordedHash: 1, invalidRecordedHash: 1, noRecordedManifest: 1, sizeConflict: 0 });
  assert.match(c.log.join('\n'), /skipped=\{"noRecordedHash":1,"invalidRecordedHash":1,"noRecordedManifest":1/);
});

test('one hash recorded with two sizes: only the proven size is stored, the other is reported', async t => {
  const c = fixture(t), asset = raster(c, 'a.tif');
  c.register([asset]);
  c.register([{ ...asset, byteSize: asset.byteSize + 1 }]);
  await c.run();
  assert.deepEqual(c.sets().map(set => set.byte_size), [asset.byteSize]);
  assert.equal(await c.run(), 0);
  assert.equal(contentChunkReport(c.database).skipped.sizeConflict, 1);
});

test('EPT and 3D Tiles children need a tree digest that follows from the registered rows', async t => {
  const c = fixture(t), entry = c.write('cloud/ept.json', Buffer.from('{}')), child = c.write('cloud/ept-data/0.laz', crypto.randomBytes(5 * MIB));
  const files = [{ relativePath: 'ept-data/0.laz', byteSize: child.byteSize, sha256: child.sha256 }, { relativePath: 'ept.json', byteSize: 2, sha256: entry.sha256 }];
  const id = c.register([{ kind: 'ept', rootKey: 'models', relativePath: 'cloud/ept.json', byteSize: 2, sha256: entry.sha256, manifestSha256: sha(JSON.stringify(files)), manifestFiles: files }]);
  const registered = c.database.prepare('SELECT manifest_sha256 FROM model_assets WHERE version_id=?').get(id).manifest_sha256;
  c.database.prepare('UPDATE model_assets SET manifest_sha256=? WHERE version_id=?').run('f'.repeat(64), id);
  await c.run();
  assertNothingBlessed(c, child, 'manifest_mismatch');
  assert.equal(c.audits().length, 1);
  c.database.prepare('UPDATE model_assets SET manifest_sha256=? WHERE version_id=?').run(registered, id);
  c.clock += DAY + 1;
  await c.run();
  assert.equal(c.sets()[0].content_sha256, child.sha256);
});

test('idempotent: a rerun is a no-op and one digest in many places is read once', async t => {
  const c = fixture(t), photo = { filename: 'A.JPG', contentType: 'image/jpeg', ...c.write('photos/A.JPG', crypto.randomBytes(5 * MIB), c.config.datasetsMount) };
  const { file, ...link } = photo;
  c.register([], { cameraPhotos: [link] });
  c.register([], { cameraPhotos: [link, { ...link, filename: 'B.JPG' }] });
  let read = 0;
  const budget = async bytes => { read += bytes; };
  assert.equal(await c.run({ budget }), 1);
  assert.equal(read, photo.byteSize);
  const before = c.sets();
  assert.equal(await c.run({ budget }), 0);
  assert.equal(read, photo.byteSize);
  assert.deepEqual(c.sets(), before);
});

test('two lanes racing on the same file store exactly one set', async t => {
  const c = fixture(t), asset = raster(c);
  c.register([asset]);
  let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const budget = async () => { entered += 1; if (entered === 2) release(); if (entered <= 2) await gate; };
  const lanes = [c.backfill({ budget }), c.backfill({ budget })];
  assert.deepEqual(await Promise.all(lanes.map(lane => lane.runOne())), [true, true]);
  assert.equal(c.sets().length, 1);
  assert.equal(c.log.filter(line => / already stored /.test(line)).length, 1);
  const late = c.backfill();
  late.queue = scanCandidates(c.database).items.concat({ sha256: asset.sha256, byteSize: asset.byteSize, kind: 'ortho', locations: [{ versionId: 'gone' }] });
  assert.equal(await late.runOne(), true, 'a file finished since the scan is skipped without a read');
  assert.deepEqual(c.failures(), []);
});

test('a stop in the middle of a file stores nothing and the next run finishes it', async t => {
  const c = fixture(t), asset = raster(c), stop = new AbortController();
  c.register([asset]);
  let reads = 0;
  assert.equal(await c.run({ signal: stop.signal, budget: async () => { reads += 1; if (reads === 3) stop.abort(); } }), 0);
  assert.equal(reads, 3);
  assert.deepEqual([c.sets(), c.failures()], [[], []]);
  assert.equal(await c.run(), 1);
  assert.equal(c.sets().length, 1);
});

test('a stop during the rate wait ends at once', async t => {
  const c = fixture(t), stop = new AbortController();
  c.register([raster(c)]);
  const running = c.run({ signal: stop.signal, budget: createByteBudget({ bytesPerSecond: 1024 }) }), startedAt = Date.now();
  setTimeout(() => stop.abort(), 50);
  assert.equal(await running, 0);
  assert.ok(Date.now() - startedAt < 5000);
  assert.deepEqual([c.sets(), c.failures()], [[], []]);
});

test('a killed process leaves nothing partial and a new worker redoes only that file', async t => {
  const c = fixture(t), first = raster(c, 'first.tif', 4 * MIB), second = { ...raster(c, 'second.tif', 8 * MIB), kind: 'dsm' };
  c.register([first, second]);
  const program = `
    const {openDatabase}=require(${JSON.stringify(path.join(__dirname, '../server/database'))});
    const {ContentChunkBackfill}=require(${JSON.stringify(path.join(__dirname, '../server/contentChunkBackfill'))});
    let reads=0;
    const lane=new ContentChunkBackfill({database:openDatabase(process.argv[1]),config:JSON.parse(process.argv[2]),log(){},budget:async()=>{reads+=1;if(reads===8){console.log('mid-file');await new Promise(()=>setInterval(()=>{},1000));}}});
    (async()=>{while(await lane.runOne());})();`;
  const child = spawn(process.execPath, ['-e', program, c.databasePath, JSON.stringify(c.config)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(c.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(c.sets().map(set => set.content_sha256), [first.sha256]);
  assert.deepEqual(c.failures(), []);
  let read = 0;
  assert.equal(await c.run({ budget: async bytes => { read += bytes; } }), 1);
  assert.equal(read, second.byteSize, 'the finished file is not read again');
  assert.equal(c.sets().length, 2);
});

test('the byte budget holds the rate and never saves up a burst', async () => {
  let clock = 0;
  const take = createByteBudget({ bytesPerSecond: 50 * MIB, now: () => clock, wait: async ms => { clock += ms; } });
  for (let index = 0; index < 501; index += 1) await take(MIB);
  assert.ok(Math.abs(clock - 10000) < 1, `500 MiB waits 10 s, waited ${clock}`);
  clock += 60000;
  const idleEnd = clock;
  for (let index = 0; index < 51; index += 1) await take(MIB);
  assert.ok(Math.abs(clock - idleEnd - 1000) < 1, 'a minute of idling buys nothing');
});

test('the budget applies to real reads in 1 MiB steps', async t => {
  const c = fixture(t), steps = [], take = createByteBudget({ bytesPerSecond: 20 * MIB }), startedAt = Date.now();
  c.register([raster(c, 'ortho.tif', 6 * MIB + 1)]);
  await c.run({ budget: async (bytes, signal) => { steps.push(bytes); await take(bytes, signal); } });
  assert.deepEqual(steps, [MIB, MIB, MIB, MIB, MIB, MIB, 1]);
  assert.ok(Date.now() - startedAt >= 290, 'six paid MiB at 20 MiB/s take 0.3 s');
  assert.equal(c.sets().length, 1);
});

for (const [label, hold, release] of [
  ['local heavy work', state => { state.busy = true; }, state => { state.busy = false; }],
  ['an operator pause', (state, c) => setPaused(c.database, true), (state, c) => setPaused(c.database, false)],
]) test(`${label} holds the lane between files and in the middle of one`, async t => {
  const c = fixture(t), state = { busy: false };
  c.register([raster(c)]);
  hold(state, c);
  let reads = 0, polls = 0;
  const options = { busy: () => state.busy, budget: async () => { reads += 1; if (reads === 2) { hold(state, c); c.clock += 1001; } },
    hold: async () => { polls += 1; c.clock += 1001; assert.equal(reads, 2, 'nothing is read while held'); if (polls === 3) release(state, c); } };
  const lane = c.backfill(options);
  assert.equal(await lane.runOne(), false, 'a held lane does not start a file');
  assert.equal(reads, 0);
  release(state, c);
  c.clock += 1001;
  assert.equal(await lane.runOne(), true);
  assert.equal(polls, 3);
  assert.equal(c.sets().length, 1);
});

test('shared rasters come first, then their photos, other published files, review files and downloads', t => {
  const c = fixture(t), make = (name, kind = 'ortho') => ({ kind, ...c.write(name, Buffer.concat([Buffer.alloc(4 * MIB), Buffer.from(name)])) });
  const photo = name => { const { file, ...link } = { filename: `${name}.JPG`, contentType: 'image/jpeg', ...c.write(`${name}.JPG`, Buffer.concat([Buffer.alloc(4 * MIB), Buffer.from(name)])) }; return link; };
  c.register([make('download.glb', 'glb')]);
  const review = make('review.tif');
  c.register([{ ...review, published: false }]);
  c.register([make('published.tif')]);
  const shared = c.register([make('shared.tif')], { cameraPhotos: [photo('shared')] });
  const model = c.database.prepare('SELECT model_id FROM model_versions WHERE id=?').get(shared).model_id;
  c.database.prepare("INSERT INTO public_shares(id,model_id,version_policy,public_id_hash,permissions_json,created_at,updated_at) VALUES ('s',?,'latest',?,'{}','now','now')").run(model, 'a'.repeat(64));
  const order = scanCandidates(c.database).items;
  assert.deepEqual(order.map(item => [item.tier, item.locations[0].relativePath]), [[1, 'shared.tif'], [2, 'shared.JPG'], [3, 'published.tif'], [4, 'review.tif'], [5, 'download.glb']]);
  assert.deepEqual(scanCandidates(c.database, { limit: 2 }).items.map(item => item.tier), [1, 2]);
  assert.equal(scanCandidates(c.database, { limit: 2 }).totalFiles, 5, 'the total is not cut by the batch size');
});

test('recovery plans, supersession identity and model_asset_chunks are identical before and after', async t => {
  const c = fixture(t), ortho = raster(c), dsm = { ...raster(c, 'dsm.tif'), kind: 'dsm' }, shots = { kind: 'shots', ...c.write('shots.geojson', Buffer.from('{}')) };
  const { file, ...photo } = { filename: 'A.JPG', contentType: 'image/jpeg', ...c.write('A.JPG', crypto.randomBytes(5 * MIB)) };
  const id = c.register([ortho, dsm, shots], { cameraPhotos: [photo] });
  const snapshot = () => JSON.stringify([collectRecoveryCompanions(c.database, id), recoveryRegistrationIdentity(c.database, id, id),
    ...['model_assets', 'model_asset_files', 'model_asset_chunks', 'model_camera_photos'].map(table => c.database.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all())]);
  const before = snapshot();
  assert.equal(await c.run(), 3);
  assert.equal(snapshot(), before);
});

test('unsafe registered paths are refused without opening anything', async t => {
  const c = fixture(t), outside = path.join(c.root, 'outside.tif'), bytes = crypto.randomBytes(4 * MIB);
  fs.writeFileSync(outside, bytes);
  for (const relativePath of ['../outside.tif', 'a/../../outside.tif', outside.replaceAll('\\', '/'), './ortho.tif', 'a//b.tif']) c.register([{ kind: 'ortho', rootKey: 'models', relativePath, byteSize: bytes.length, sha256: sha(bytes) }]);
  c.register([{ kind: 'ortho', rootKey: 'elsewhere', relativePath: 'ortho.tif', byteSize: bytes.length, sha256: sha(bytes) }]);
  let read = 0;
  await c.run({ budget: async size => { read += size; } });
  assert.equal(read, 0);
  assertNothingBlessed(c, { sha256: sha(bytes) }, 'unsafe_path');
});

const INVALID_PATHS = { 'a parent segment': 'sub/../safe', 'a leading parent': '../models/safe', 'a dot segment': './safe', 'an inner dot segment': 'sub/./safe', 'an empty segment': 'sub//safe', 'a trailing slash': 'safe/',
  'an absolute path': '/safe', 'a drive path': 'C:/safe', 'a drive path with a backslash': 'C:\\safe', 'a drive-relative path': 'C:safe', 'a lower-case drive-relative path': 'c:safe', 'a bare drive': 'C:',
  'a drive-relative parent': 'C:../safe', 'a drive-relative dot': 'C:./safe', 'a drive-relative folder': 'C:sub/safe', 'a drive in an inner segment': 'sub/C:safe', 'a bare drive in an inner segment': 'sub/Z:/safe',
  'a backslash': 'sub\\safe', 'a backslash parent': '..\\safe', 'a NUL': 'safe\0x', 'an empty path': '' };
function registerTree(c, entry, child, big) {
  const files = [{ relativePath: child, byteSize: big.length, sha256: sha(big) }];
  c.register([{ kind: 'ept', rootKey: 'models', relativePath: entry, byteSize: 2, sha256: sha('{}'), manifestSha256: sha(JSON.stringify(files)), manifestFiles: files }]);
}
const PLACES = {
  'single file': (c, bad, big) => c.register([{ kind: 'ortho', rootKey: 'models', relativePath: bad, byteSize: big.length, sha256: sha(big) }]),
  'camera photo': (c, bad, big) => {
    const id = c.register([], { cameraPhotos: [{ filename: 'A.JPG', rootKey: 'models', relativePath: 'A.JPG', contentType: 'image/jpeg', byteSize: big.length, sha256: sha(big) }] });
    c.database.prepare('UPDATE model_camera_photos SET relative_path=? WHERE version_id=?').run(bad, id);
  },
  'tree child': (c, bad, big) => registerTree(c, 'tree/ept.json', bad, big),
  'tree entry': (c, bad, big) => registerTree(c, `${bad}/ept.json`, 'child.bin', big),
};
for (const [place, register] of Object.entries(PLACES)) for (const [label, bad] of Object.entries(INVALID_PATHS))
  test(`${label} recorded for a ${place} is refused before any file system call`, async t => {
    const c = fixture(t), big = crypto.randomBytes(4 * MIB);
    // Matching files wait where a normalized path would lead.
    for (const name of ['safe', 'sub/safe', 'tree/safe', 'tree/sub/safe', 'child.bin', 'sub/child.bin'].filter(name => place !== 'tree entry' || name.endsWith('child.bin'))) c.write(name, big);
    if (place === 'tree entry') c.write('safe/child.bin', big);
    register(c, bad, big);
    assert.equal(scanCandidates(c.database).items.length, 1, 'the row reaches the lane');
    const saved = {};
    t.after(() => Object.assign(fs.promises, saved));
    let calls = 0;
    for (const name of ['open', 'lstat', 'realpath', 'stat', 'readlink']) { saved[name] = fs.promises[name]; fs.promises[name] = (...args) => { calls += 1; return saved[name].apply(fs.promises, args); }; }
    await c.run();
    Object.assign(fs.promises, saved);
    assert.equal(calls, 0);
    assertNothingBlessed(c, { sha256: sha(big) }, 'unsafe_path');
  });

test('a colon that is not a drive designator is an ordinary name on Linux', linux, async t => {
  const c = fixture(t), big = crypto.randomBytes(4 * MIB);
  for (const [index, name] of ['flight 12:30/ortho.tif', 'AB:c.tif', '1:2.tif'].entries()) c.register([{ kind: 'ortho', ...c.write(name, Buffer.concat([big, Buffer.from([index])])) }]);
  assert.equal(await c.run(), 3);
  assert.equal(c.sets().length, 3);
});

test('a tree whose entry is at the root of its storage still resolves its children', async t => {
  const c = fixture(t), big = crypto.randomBytes(4 * MIB);
  c.write('data/child.bin', big);
  registerTree(c, 'ept.json', 'data/child.bin', big);
  await c.run();
  assert.equal(c.sets().length, 1);
});

test('symbolic links and special files are refused', linux, async t => {
  const c = fixture(t), target = raster(c, 'real/ortho.tif'), bytes = fs.readFileSync(target.file);
  fs.symlinkSync(path.join(c.config.modelsMount, 'real'), path.join(c.config.modelsMount, 'linked'));
  fs.symlinkSync(target.file, path.join(c.config.modelsMount, 'link.tif'));
  assert.equal(spawnSync('mkfifo', [path.join(c.config.modelsMount, 'pipe.tif')]).status, 0);
  for (const relativePath of ['linked/ortho.tif', 'link.tif', 'pipe.tif']) c.register([{ kind: 'ortho', rootKey: 'models', relativePath, byteSize: bytes.length, sha256: target.sha256 }]);
  await c.run();
  assertNothingBlessed(c, target, 'unsafe_path');
});

test('a database error is not recorded against the file', async t => {
  const c = fixture(t);
  c.register([raster(c)]);
  c.database.exec("CREATE TRIGGER stop_insert BEFORE INSERT ON content_chunk_sets BEGIN SELECT RAISE(ABORT,'stopped'); END");
  const lane = c.backfill();
  await assert.rejects(lane.runOne(), /stopped/);
  assert.deepEqual([c.sets(), c.failures()], [[], []]);
  c.database.exec('DROP TRIGGER stop_insert');
  assert.equal(await lane.runOne(), false, 'waits for the next scan instead of spinning');
  c.clock += 11 * 60000;
  assert.equal(await lane.runOne(), true);
  assert.equal(c.sets().length, 1);
});

test('roots resolve exactly as delivery resolves them', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/assets.js'), 'utf8').match(/function canonicalAssetRoot\(model, rootKey\) \{[\s\S]*?\n\}\n/)[0];
  const config = { webodmMediaMount: '/w', terraImportMount: '/t', modelsMount: '/m', datasetsMount: '/d', derivativesMount: '/v' };
  const delivery = new Function('config', 'path', 'scopedStorageRootKey', `${source};return canonicalAssetRoot;`)(config, path, scopedStorageRootKey);
  const scoped = '11111111-1111-4111-8111-111111111111';
  for (const provider of ['webodm', 'terra', 'ltds-processing'])
    for (const locator of [{}, { catalogImport: true }, { projectId: 1, taskId: 'x' }, { projectId: null, taskId: null }, { legacyAssetRoots: { models: '/legacy' } }])
      for (const rootKey of ['models', 'datasets', 'webodm', 'terra', 'terra_import', 'derivatives', `webodm@${scoped}`, `terra_import@${scoped}`, 'unknown'])
        assert.equal(backfillRoot({ provider, locator }, rootKey, config), delivery({ provider, activeVersion: { sourceLocator: locator } }, rootKey), JSON.stringify([provider, locator, rootKey]));
});

test('the operator script reports, pauses and resumes without touching the schema', t => {
  const c = fixture(t);
  c.register([raster(c)]);
  const cli = command => spawnSync(process.execPath, [path.join(__dirname, '../scripts/content-chunk-backfill.js'), command], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', DATABASE_PATH: c.databasePath, DATA_DIR: c.root } });
  const before = c.database.prepare('SELECT * FROM schema_migrations').all();
  const status = cli('status');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual([JSON.parse(status.stdout).pending.files, JSON.parse(status.stdout).paused], [1, false]);
  assert.equal(JSON.parse(cli('pause').stdout).paused, true);
  assert.equal(c.backfill().held(), true);
  assert.equal(JSON.parse(cli('resume').stdout).paused, false);
  assert.equal(cli('erase').status, 1);
  assert.deepEqual(c.database.prepare('SELECT * FROM schema_migrations').all(), before);
});

test('the worker runs the backfill in its own lane, yields to heavy work and stops with the shared signal', () => {
  const worker = fs.readFileSync(path.join(__dirname, '../server/worker.js'), 'utf8');
  assert.match(worker, /lane\('content-chunk-backfill',\(\)=>contentChunks\.runOne\(\)\)/);
  assert.match(worker, /new ContentChunkBackfill\(\{database:db,config,signal:maintenanceAbort\.signal,busy:\(\)=>measurementActive\|\|heavyLocalActive>0\}\)/);
  assert.match(worker, /lanes=[^`\r\n]*\bcontent-chunk-backfill\b/);
});
