import assert from 'node:assert/strict';
import test from 'node:test';
import { beginIsolatedViewerLaunch } from '../isolated-viewer-launch.mjs';

const ORIGIN = 'https://viewer.example';
const CHANNEL_ID = '12345678-1234-4123-8123-123456789abc';
const GRANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function channelHub() {
  const byName = new Map();
  function create(name) {
    const channel = {
      name, closed: false, onmessage: null,
      postMessage(message) {
        for (const peer of byName.get(name) || []) {
          if (peer !== channel && !peer.closed) peer.onmessage?.({ data: structuredClone(message) });
        }
      },
      close() { channel.closed = true; byName.get(name)?.delete(channel); },
    };
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(channel);
    return channel;
  }
  return { create };
}

test('delayed launcher readiness is acknowledged before scoped navigation is posted', async () => {
  const hub = channelHub(), opens = [];
  const launch = beginIsolatedViewerLaunch({
    windowRef: { open: (...args) => { opens.push(args); return null; } },
    origin: ORIGIN, channelId: CHANNEL_ID, createChannel: hub.create, timeoutMs: 100,
  });
  assert.deepEqual(opens, [[`/review-launch.html#channel=${CHANNEL_ID}`, `ltds-viewer-${CHANNEL_ID}`, 'noopener']]);
  const receiver = hub.create(`ltds-viewer-review:${CHANNEL_ID}`);
  let navigation = null;
  receiver.onmessage = ({ data }) => { if (data.type === 'ltds-viewer:navigate') navigation = data; };
  receiver.postMessage({ version: 1, type: 'ltds-viewer:launcher-ready', channelId: CHANNEL_ID });
  assert.equal(await launch.waitUntilReady(), true);
  assert.equal(launch.navigate(`${ORIGIN}/session/${GRANT}`, { renewable: true }), true);
  assert.deepEqual(navigation, {
    version: 1, type: 'ltds-viewer:navigate',
    url: `${ORIGIN}/session/${GRANT}#reviewController=${CHANNEL_ID}`,
  });
  launch.close();
});

test('missing launcher receiver times out, closes state, and cannot navigate', async () => {
  const hub = channelHub();
  const launch = beginIsolatedViewerLaunch({
    windowRef: { open: () => null }, origin: ORIGIN, channelId: CHANNEL_ID,
    createChannel: hub.create, timeoutMs: 5,
  });
  assert.equal(await launch.waitUntilReady(), false);
  assert.equal(launch.navigate(`${ORIGIN}/session/${GRANT}`, { renewable: true }), false);
  assert.equal(launch.closed, true);
});

test('wrong or malformed readiness messages do not satisfy the exact launcher handshake', async () => {
  const hub = channelHub();
  const launch = beginIsolatedViewerLaunch({
    windowRef: { open: () => null }, origin: ORIGIN, channelId: CHANNEL_ID,
    createChannel: hub.create, timeoutMs: 10,
  });
  const receiver = hub.create(`ltds-viewer-review:${CHANNEL_ID}`);
  receiver.postMessage({ version: 1, type: 'ltds-viewer:launcher-ready', channelId: GRANT });
  receiver.postMessage({ version: 1, type: 'ltds-viewer:launcher-ready', channelId: CHANNEL_ID, extra: true });
  assert.equal(await launch.waitUntilReady(), false);
});
