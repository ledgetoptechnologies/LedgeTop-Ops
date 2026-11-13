'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { drainWorkerLanes } = require('../server/workerLaneDrain');

test('failed lane stops admissions but waits for sibling work before database close', async () => {
  const events = [], failure = Error('synthetic lane failure');
  let finish;
  const writer = new Promise(resolve => { finish = resolve; });
  const drained = drainWorkerLanes({
    lanes: [async () => { throw failure; }, async () => { await writer; events.push('writer settled'); }],
    stop: error => { assert.equal(error, failure); events.push('stop'); },
    maintenance: async () => { events.push('maintenance settled'); },
    close: () => events.push('db closed'),
  });
  const rejected = assert.rejects(drained, error => error === failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['stop']);
  finish();
  await rejected;
  assert.deepEqual(events, ['stop', 'writer settled', 'maintenance settled', 'db closed']);
});

test('normal drain waits for maintenance and closes once', async () => {
  const events = [];
  await drainWorkerLanes({ lanes: [async () => events.push('lane')], stop: error => { assert.equal(error, null); events.push('stop'); }, maintenance: async () => events.push('maintenance'), close: () => events.push('close') });
  assert.deepEqual(events, ['lane', 'stop', 'maintenance', 'close']);
});

test('unknown failed maintenance does not force database closure', async () => {
  let closed = false;
  await assert.rejects(drainWorkerLanes({ lanes: [], stop() {}, maintenance: async () => { throw Error('maintenance failed'); }, close: () => { closed = true; } }), /maintenance failed/);
  assert.equal(closed, false);
});

test('falsy lane rejections remain failures after siblings drain', async () => {
  for (const failure of [null, undefined, 0]) {
    let stopped = 0, closed = 0, rejected = false;
    try { await drainWorkerLanes({ lanes: [() => Promise.reject(failure)], stop: () => stopped++, maintenance: async () => {}, close: () => closed++ }); }
    catch (error) { rejected = true; assert.equal(error, failure); }
    assert.equal(rejected, true);
    assert.equal(stopped, 1);
    assert.equal(closed, 1);
  }
});
