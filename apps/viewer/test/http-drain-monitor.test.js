'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createHttpDrainMonitor } = require('../server/httpDrainMonitor');

test('shutdown reports only aggregate requests and sockets and settles once', () => {
  const messages = [], monitor = createHttpDrainMonitor({ intervalMs: 60_000, log: message => messages.push(message) });
  const response = new EventEmitter();
  let called = false;
  monitor.track({ url: '/private/token' }, response, () => { called = true; });
  assert.equal(called, true);
  monitor.start({ getConnections: callback => callback(null, 2) });
  assert.deepEqual(messages, ['[shutdown] waiting for HTTP drain: activeRequests=1 openSockets=2']);
  response.emit('finish');
  response.emit('close');
  monitor.start({ getConnections: () => { throw new Error('duplicate start'); } });
  monitor.stop();
  assert.equal(messages.some(message => message.includes('private')), false);
});

test('aborted responses and late socket callbacks do not produce misleading logs', () => {
  const messages = [], monitor = createHttpDrainMonitor({ intervalMs: 60_000, log: message => messages.push(message) });
  const response = new EventEmitter();
  monitor.track({}, response, () => {});
  response.emit('close');
  let callback;
  monitor.start({ getConnections: cb => { callback = cb; } });
  monitor.stop();
  callback(null, 1);
  assert.deepEqual(messages, []);
});

test('a real in-flight HTTP response drains before server close', { timeout: 2000 }, async t => {
  const messages = [], monitor = createHttpDrainMonitor({ intervalMs: 60_000, log: message => messages.push(message) });
  let response, started;
  const ready = new Promise(resolve => { started = resolve; });
  const server = http.createServer((req, res) => monitor.track(req, res, () => { response = res; res.writeHead(200); res.write('part'); started(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { monitor.stop(); server.closeAllConnections(); server.close(); });
  const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/private/token', agent: false });
  const received = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', res => { res.once('error', reject); res.once('end', resolve); res.resume(); });
  });
  t.after(() => request.destroy());
  await ready;
  monitor.start(server);
  let closed = false;
  const closing = new Promise(resolve => server.close(() => { closed = true; resolve(); }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'active response must not be terminated by diagnostics');
  assert.match(messages[0], /activeRequests=1 openSockets=1/);
  response.end('done');
  await received;
  await closing;
  monitor.stop();
  assert.equal(messages.some(message => message.includes('private')), false);
});
