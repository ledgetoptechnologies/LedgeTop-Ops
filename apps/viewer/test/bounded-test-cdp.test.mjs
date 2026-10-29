import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedTestCdp } from './bounded-test-cdp.mjs';

class FakeSocket extends EventTarget {
  sent = [];
  send(message) { this.sent.push(JSON.parse(message)); }
  reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close() { this.dispatchEvent(new Event('close')); }
}

test('unanswered command times out, ignores its late reply, and allows a healthy request', async () => {
  const socket = new FakeSocket(), client = new BoundedTestCdp(socket, { timeoutMs: 20 });
  await assert.rejects(client.command('Page.navigate'), /Page.navigate: CDP command timed out after 20ms/);
  assert.equal(client.pending.size, 0);
  socket.reply({ id: socket.sent[0].id, result: { stale: true } });
  const healthy = client.command('Page.enable');
  socket.reply({ id: socket.sent[1].id, result: { enabled: true } });
  assert.deepEqual(await healthy, { enabled: true });
  assert.equal(client.pending.size, 0);
  client.close();
});

for (const ending of ['client close', 'socket close', 'socket error']) {
  test(`${ending} rejects every pending request and future commands immediately`, async () => {
    const socket = new FakeSocket(), client = new BoundedTestCdp(socket);
    const first = client.command('Runtime.evaluate'), second = client.command('Page.navigate');
    const errors = [assert.rejects(first, /CDP .*clos|CDP socket error/), assert.rejects(second, /CDP .*clos|CDP socket error/)];
    if (ending === 'client close') client.close();
    else socket.dispatchEvent(new Event(ending === 'socket close' ? 'close' : 'error'));
    await Promise.all(errors);
    assert.equal(client.pending.size, 0);
    await assert.rejects(client.command('Page.enable'), /CDP .*clos|CDP socket error/);
    assert.equal(socket.sent.length, 2);
    socket.reply({ id: 1, result: {} });
  });
}

test('healthy commands correlate out-of-order responses and retain protocol events', async () => {
  const socket = new FakeSocket(), client = new BoundedTestCdp(socket);
  const value = client.evaluate('1 + 1'), enabled = client.command('Page.enable');
  socket.reply({ method: 'Page.javascriptDialogOpening', params: { type: 'beforeunload' } });
  socket.reply({ id: 2, result: {} });
  socket.reply({ id: 1, result: { result: { value: 2 } } });
  assert.deepEqual(await enabled, {});
  assert.equal(await value, 2);
  assert.equal(client.events[0].params.type, 'beforeunload');
  const rejected = client.command('Invalid.method');
  socket.reply({ id: 3, error: { message: 'Unknown method' } });
  await assert.rejects(rejected, /Invalid.method: Unknown method/);
  client.close();
});

test('connection startup is bounded and closes its own unanswered socket', async () => {
  let socket;
  class NeverOpens extends FakeSocket {
    constructor() { super(); socket = this; }
    close() { this.wasClosed = true; super.close(); }
  }
  await assert.rejects(BoundedTestCdp.connect('ws://synthetic', { WebSocketImpl: NeverOpens, timeoutMs: 20 }),
    /CDP connection timed out after 20ms/);
  assert.equal(socket.wasClosed, true);
});

test('connection rejects an early socket close instead of waiting for startup deadline', async () => {
  class ClosesEarly extends FakeSocket {
    constructor() { super(); queueMicrotask(() => this.close()); }
  }
  await assert.rejects(BoundedTestCdp.connect('ws://synthetic', { WebSocketImpl: ClosesEarly }),
    /CDP connection closed before opening/);
});

test('a synchronous send failure clears all outstanding command timers', async () => {
  const socket = new FakeSocket(), client = new BoundedTestCdp(socket);
  const waiting = client.command('Page.enable');
  const rejection = assert.rejects(waiting, /synthetic send failure/);
  socket.send = () => { throw new Error('synthetic send failure'); };
  await assert.rejects(client.command('Runtime.enable'), /synthetic send failure/);
  await rejection;
  assert.equal(client.pending.size, 0);
  client.close();
});
