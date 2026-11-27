import assert from 'node:assert/strict';
import test from 'node:test';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument } from './helpers/mini-dom.mjs';

// Save answers at once: Saving… while the server works, Saved. after, one request for repeated
// presses, and a Save pressed while another change runs goes out after it instead of doing nothing.
const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

function slowNetwork() {
  const net = { holdWrites: false, held: [], writes: [],
    request: async (path, init) => {
      const go = () => fetch(path, { ...init, signal: undefined });
      if (init.method === 'GET' || !net.holdWrites) { if (init.method !== 'GET') net.writes.push(init.method); return go(); }
      net.writes.push(init.method);
      await new Promise(resolve => net.held.push(resolve));
      return go();
    } };
  net.release = () => { for (const resolve of net.held.splice(0)) resolve(); };
  return net;
}

async function start(t) {
  const setup = await openMarksPanel(t), net = slowNetwork();
  const panel = setup.mount({ dom: createMiniDocument(), request: net.request });
  await panel.marks.setScope({ ...setup.scope('client', 'client-a') });
  return { setup, net, panel, saveButton: () => panel.q('.viewer-mark-form .viewer-mark-primary'),
    status: () => panel.q('.viewer-mark-status').textContent };
}

test('Save shows Saving… at once, sends once for repeated presses, then says Saved.', async t => {
  const { net, panel, saveButton, status } = await start(t);
  await panel.place('43.05, -87');
  await panel.type('[name=name]', 'Gate');
  net.holdWrites = true;
  const first = panel.save();
  await settle();
  assert.equal(saveButton().textContent, 'Saving…');
  assert.equal(saveButton().disabled, true);
  await panel.save();
  await settle();
  assert.equal(net.writes.length, 1, 'a second press does not send a second request');
  net.release();
  await first;
  await settle(50);
  assert.equal(status(), 'Saved.');
  assert.equal(net.writes.length, 1);
});

test('a Save pressed while another change is running waits for it, then saves', async t => {
  const { net, panel, status } = await start(t);
  await panel.place('43.05, -87');
  await panel.type('[name=name]', 'First');
  await panel.save();
  await settle(50);
  // Another change is in flight: undo of the first mark is held by the server.
  net.holdWrites = true;
  const undo = panel.bar().querySelectorAll('button').find(node => node.textContent === 'Undo');
  assert.ok(undo, 'undo control exists');
  const undoing = undo.click();
  await settle();
  assert.equal(panel.marks.store.state.busy, true);
  // A new mark's Save now must not be dropped.
  net.holdWrites = false;
  await panel.place('43.06, -87');
  await panel.type('[name=name]', 'Second');
  const saving = panel.save();
  await settle();
  net.release();
  await saving;
  await undoing;
  await settle(80);
  assert.notEqual(status(), '');
  assert.ok(panel.marks.store.find && panel.marks.store.state.marks.some(mark => mark.name === 'Second'), 'the second mark was saved');
});
