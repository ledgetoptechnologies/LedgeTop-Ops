'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { childCalculation } = require('../server/measurementCalculationWorker');

async function sentLimit(kind, config = {}) {
  let sent;
  await childCalculation('unused', { source: { kind }, method: 'surface-cut-fill' }, {
    config, isLive: () => true,
    forkProcess: () => {
      const child = new EventEmitter();
      child.kill = () => {};
      child.send = message => { sent = message; queueMicrotask(() => child.emit('message', { type: 'result', result: {} })); };
      return child;
    }
  });
  return sent.maxCells;
}
test('native DSM and DTM capacity does not expand point or mesh budgets', async () => {
  assert.equal(await sentLimit('dsm'), 100_000_000);
  assert.equal(await sentLimit('dtm'), 100_000_000);
  assert.equal(await sentLimit('ept'), 2_000_000);
  assert.equal(await sentLimit('obj'), 2_000_000);
});
test('independent configured raster and point limits reach the bounded child', async () => {
  const config = { measurementMaxCells: 100, measurementRasterMaxCells: 300 };
  assert.equal(await sentLimit('dsm', config), 300);
  assert.equal(await sentLimit('ept', config), 100);
});
