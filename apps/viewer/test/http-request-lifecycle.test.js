'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { createHttpRequestLifecycle } = require('../server/httpRequestLifecycle');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, install) {
  const lifecycle = createHttpRequestLifecycle(), app = express(), router = lifecycle.trackedRouter();
  app.use(lifecycle.admission); install(router, lifecycle, app); app.use(router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { lifecycle, server, port: server.address().port };
}
function shutdown(server, lifecycle, closeDatabase = () => {}) {
  lifecycle.beginDrain();
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { closed, drained: Promise.all([closed, lifecycle.waitForIdle()]).then(closeDatabase) };
}
function request(port, path = '/') {
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path, agent: false }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject));
}

test('pipelined request on an active socket is refused after admission closes', { timeout: 4000 }, async t => {
  const done = deferred(); let secondCalls = 0, closing;
  const f = await fixture(t, (router, lifecycle) => {
    router.get('/first', async (_req, res) => {
      closing = shutdown(f.server, lifecycle);
      await done.promise; res.end('first');
    });
    router.get('/second', (_req, res) => { secondCalls++; res.end('unsafe'); });
  });
  const socket = net.connect(f.port, '127.0.0.1'); t.after(() => socket.destroy());
  let bytes = '';
  const ended = new Promise(resolve => socket.once('close', resolve));
  socket.on('data', chunk => { bytes += chunk; });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET /first HTTP/1.1\r\nHost: synthetic\r\n\r\nGET /second HTTP/1.1\r\nHost: synthetic\r\n\r\n');
  // The first handler deliberately remains active while the parser dispatches
  // the second request already buffered on this same admitted TCP connection.
  for (let i = 0; i < 10 && !closing; i++) await turn();
  assert.ok(closing); await turn(); done.resolve(); await ended; await closing.drained;
  assert.equal(secondCalls, 0); assert.match(bytes, /503 Service Unavailable/); assert.match(bytes, /Connection: close/i);
});

test('disconnect cannot close SQLite before the awaited handler mutation settles', { timeout: 4000 }, async t => {
  const entered = deferred(), release = deferred(), db = new DatabaseSync(':memory:'), events = [];
  db.exec('CREATE TABLE writes(value TEXT)');
  const f = await fixture(t, router => router.get('/', async (_req, res) => {
    res.write('started'); entered.resolve(); await release.promise;
    db.prepare('INSERT INTO writes VALUES (?)').run('done'); events.push('write');
    res.end();
  }));
  const req = http.get({ host: '127.0.0.1', port: f.port, agent: false }); req.on('error', () => {});
  req.on('response', res => { res.on('error', () => {}); res.resume(); });
  await entered.promise; req.destroy();
  const closing = shutdown(f.server, f.lifecycle, () => { events.push('db-close'); db.close(); });
  await closing.closed; assert.equal(f.lifecycle.snapshot().work, 1); assert.deepEqual(events, []);
  release.resolve(); await closing.drained; assert.deepEqual(events, ['write', 'db-close']);
});

test('a handler calling next before await retains its promise through response finish', { timeout: 4000 }, async t => {
  const entered = deferred(), release = deferred(); let mutated = false;
  const f = await fixture(t, router => {
    router.get('/', async (_req, _res, next) => { next(); entered.resolve(); await release.promise; mutated = true; });
    router.get('/', (_req, res) => res.end('done'));
  });
  assert.equal((await request(f.port)).body, 'done'); await entered.promise;
  const closing = shutdown(f.server, f.lifecycle); await closing.closed;
  assert.equal(f.lifecycle.snapshot().work, 1); release.resolve(); await closing.drained; assert.equal(mutated, true);
});

test('late callback-style next after disconnect cannot enter an exhausted permit', { timeout: 4000 }, async t => {
  const entered = deferred(); let later, writes = 0;
  const f = await fixture(t, router => {
    router.use((_req, res, next) => { later = next; res.write('started'); entered.resolve(); });
    router.get('/', (_req, res) => { writes++; res.end(); });
  });
  const req = http.get({ host: '127.0.0.1', port: f.port, agent: false }); req.on('error', () => {});
  req.on('response', res => { res.on('error', () => {}); res.resume(); });
  await entered.promise; req.destroy();
  const closing = shutdown(f.server, f.lifecycle); await closing.drained;
  later(); await turn(); assert.equal(writes, 0);
});

test('late callback next retains normal Express behavior before drain begins', { timeout: 4000 }, async t => {
  let later, writes = 0;
  const f = await fixture(t, router => {
    router.use((_req, res, next) => { later = next; res.end('finished'); });
    router.get('/', () => { writes++; });
  });
  assert.equal((await request(f.port)).body, 'finished');
  later(); await turn(); assert.equal(writes, 1);
  await shutdown(f.server, f.lifecycle).drained;
});

test('returned rejection reaches an arity-four error handler and settles before DB close', { timeout: 4000 }, async t => {
  const entered = deferred(), release = deferred(), events = [];
  const f = await fixture(t, router => {
    router.get('/', async (_req, _res) => { entered.resolve(); await release.promise; throw Error('synthetic'); });
    router.use(function errorHandler(error, _req, res, _next) { events.push(error.message); res.status(500).end('handled'); });
  });
  const response = request(f.port); await entered.promise;
  const closing = shutdown(f.server, f.lifecycle, () => events.push('db-close'));
  release.resolve(); assert.equal((await response).status, 500); await closing.drained;
  assert.deepEqual(events, ['synthetic', 'db-close']);
});

test('arrays, route chaining, nested routers, this and arity-four param handlers are preserved', { timeout: 4000 }, async t => {
  const f = await fixture(t, (router, lifecycle) => {
    const child = lifecycle.trackedRouter({ mergeParams: true });
    child.param('id', function parameter(req, _res, next, value) { req.value = value; next(); });
    const context = { expected: true };
    const handler = function (req, res) { assert.equal(this, context); res.end(req.value); }.bind(context);
    const route = child.route('/:id'); assert.equal(route.get([handler]), route);
    assert.equal(router.use('/nested', [[child]]), router);
  });
  assert.deepEqual(await request(f.port, '/nested/preserved'), { status: 200, body: 'preserved' });
  assert.equal(f.lifecycle.snapshot().work, 0);
});

test('startup callback registered before scheduling remains owned during drain', { timeout: 4000 }, async () => {
  const lifecycle = createHttpRequestLifecycle(), events = [];
  const callback = lifecycle.ownCallback(() => { events.push('maintenance'); });
  lifecycle.beginDrain(); let closed = false;
  assert.throws(() => lifecycle.ownCallback(() => {}), /during HTTP drain/);
  const waiting = lifecycle.waitForIdle().then(() => { closed = true; events.push('db-close'); });
  await turn(); assert.equal(closed, false); callback(); callback(); await waiting;
  assert.deepEqual(events, ['maintenance', 'db-close']);
});

test('handler registration through router method and route builder wraps once', { timeout: 4000 }, async t => {
  const f = await fixture(t, (router, lifecycle) => router.get('/', (_req, res) => {
    assert.equal(lifecycle.snapshot().work, 1); res.end('once');
  }));
  assert.equal((await request(f.port)).body, 'once');
});

test('already admitted handler may register detached DB work after drain starts', { timeout: 4000 }, async t => {
  const entered = deferred(), proceed = deferred(), scan = deferred(), events = [];
  const f = await fixture(t, (router, lifecycle) => router.get('/', async (_req, res) => {
    entered.resolve(); await proceed.promise;
    const pending = scan.promise.then(() => { events.push('scan-db'); });
    const tracked = lifecycle.trackOwned(pending); assert.equal(lifecycle.trackOwned(pending), tracked);
    tracked.catch(() => {}); res.end('scheduled');
  }));
  const response = request(f.port); await entered.promise;
  const closing = shutdown(f.server, f.lifecycle, () => events.push('db-close'));
  proceed.resolve(); await response; await closing.closed; assert.deepEqual(events, []);
  scan.resolve(); await closing.drained; assert.deepEqual(events, ['scan-db', 'db-close']);
});
