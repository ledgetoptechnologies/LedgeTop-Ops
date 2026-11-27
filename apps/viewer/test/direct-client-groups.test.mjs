import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientPicker, clientPickerLabel, clientPickerOptions } from '../workspace-client-picker.mjs';
import { DIRECT_CLIENT_GROUPS_PATH, directDestinationMarkup, directGrantRows, directClientGroupOf, loadDirectClientGroups, readDirectShareForm }
  from '../workspace-direct-client-share.mjs';

// Synthetic data only. Two divisions (sources) of one business; one real client linked across both,
// and a different client with the same name in division A that is not linked.
const A = 'project-alpha:division-a', B = 'project-alpha:division-b';
const row = (sourceId, workspaceId, displayName, businessName) => ({ sourceId, workspaceId, displayName, businessName });
const linkedA = row(A, 'ws-linked-a', 'Acme Survey', 'Ledge Top Drone Services Project Alpha');
const linkedB = row(B, 'ws-linked-b', 'Acme Survey', 'Ledge Top Technologies Project Alpha');
const otherA = row(A, 'ws-other-a', 'Acme Survey', 'Ledge Top Drone Services Project Alpha');
const page = clients => ({ clients, grants: [], clientsNextCursor: null });
const linkedGroups = { groups: [[[A, 'ws-linked-a'], [B, 'ws-linked-b']]] };
const settle = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let now = 0, next = 1; const timers = new Map();
  return { setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: id => timers.delete(id),
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}
async function search(groups, clients) {
  const picker = createClientPicker({ fetchPage: async () => page(clients), groupOf: directClientGroupOf(groups), debounceMs: 0, setTimer: fn => { fn(); return 1; }, clearTimer() {} });
  picker.input('Acme'); await settle(); await settle();
  return picker;
}

test('linked workspaces show as one row; a same-named unlinked client stays separate', async () => {
  const groups = await loadDirectClientGroups(async path => { assert.equal(path, DIRECT_CLIENT_GROUPS_PATH); return linkedGroups; });
  const picker = await search(groups, [linkedA, otherA, linkedB]);
  assert.equal(picker.state.items.length, 2);
  const [linked, other] = picker.state.items;
  assert.deepEqual(linked.members.map(member => member.workspaceId), ['ws-linked-a', 'ws-linked-b']);
  assert.equal(other.workspaceId, 'ws-other-a'); assert.equal(other.members, undefined);
  // The two Acme rows still read as different clients.
  assert.notEqual(clientPickerLabel(linked, picker.state.items), clientPickerLabel(other, picker.state.items));
  assert.match(clientPickerOptions(picker.state), /Drone Services and Technologies/);
});

test('two different clients with the same name are never merged without a link', async () => {
  const picker = await search(new Map(), [linkedA, otherA, linkedB]);
  assert.equal(picker.state.items.length, 3);
  assert.ok(picker.state.items.every(item => !item.members));
});

test('a group that no longer lists a workspace (link revoked) leaves the rows separate', async () => {
  const groups = await loadDirectClientGroups(async () => ({ groups: [] }));
  const picker = await search(groups, [linkedA, linkedB]);
  assert.deepEqual(picker.state.items, [linkedA, linkedB]);
});

test('a workspace listed in two groups joins neither', async () => {
  const groups = await loadDirectClientGroups(async () => ({ groups: [[[A, 'ws-linked-a'], [B, 'ws-linked-b']], [[A, 'ws-linked-a'], [B, 'ws-x']]] }));
  assert.equal(groups.has(JSON.stringify([A, 'ws-linked-a'])), false);
  assert.equal(groups.get(JSON.stringify([B, 'ws-linked-b'])), JSON.stringify(linkedGroups.groups[0]));
});

test('grouping that fails, is malformed, or comes from an older Operations gives no groups', async () => {
  for (const api of [async () => { throw Object.assign(new Error('refused'), { status: 400 }); },
    async () => { throw new Error('operations_unavailable'); }, async () => null, async () => ({ groups: 'no' }), async () => ({ groups: [[[A, 'only-one']]] })]) {
    const groups = await loadDirectClientGroups(api);
    assert.equal(groups.size, 0);
  }
});

test('grouping that stalls gives up at the timeout and the base rows are unchanged', async () => {
  const time = clock(); let signal = null;
  const pending = loadDirectClientGroups((path, options) => { signal = options.signal; return new Promise(() => {}); }, { setTimer: time.setTimer, clearTimer: time.clearTimer });
  time.advance(2499); await settle(); time.advance(1);
  const groups = await pending;
  assert.equal(groups.size, 0); assert.equal(signal?.aborted, true);
  const base = [linkedA, linkedB];
  const picker = await search(groups, base);
  assert.deepEqual(picker.state.items, base);
});

test('grouping is fixed: a late page adds a destination to its row but never changes the chosen client', async () => {
  const groups = await loadDirectClientGroups(async () => linkedGroups);
  const pages = [{ clients: [linkedA], grants: [], clientsNextCursor: 'v1.next' }, { clients: [linkedB], grants: [], clientsNextCursor: null }];
  const picker = createClientPicker({ fetchPage: async ({ cursor }) => pages[cursor ? 1 : 0], groupOf: directClientGroupOf(groups),
    debounceMs: 0, setTimer: fn => { fn(); return 1; }, clearTimer() {} });
  picker.input('Acme'); await settle(); await settle();
  assert.equal(picker.state.items.length, 1);
  assert.equal(picker.select(0), true);
  const chosen = picker.state.selected;
  await picker.more();
  assert.equal(picker.state.items.length, 1, 'still one row');
  assert.equal(picker.state.items[0].members.length, 2);
  assert.equal(chosen.members.length, 1, 'the choice already made is not changed');
});

function shareForm({ client, destination = null }) {
  return { elements: { client: { value: JSON.stringify([client.sourceId, client.workspaceId]) }, includeLater: { checked: true }, expiresAt: { value: '' },
    measure: { checked: true }, cameras: { checked: false }, download: { checked: false } },
    querySelector: selector => selector === 'input[name="scope"]:checked' ? { value: 'project' }
      : selector === 'input[name="destination"]:checked' ? (destination ? { value: destination } : null) : null,
    querySelectorAll: () => [] };
}

test('a linked client needs its portal account chosen, and exactly one grant goes to that workspace', () => {
  const linked = { ...linkedA, groupKey: 'g', members: [linkedA, linkedB] };
  const options = { projectId: 'viewer-project', projectName: 'Site', tasks: [], clients: [linked] };
  assert.throws(() => readDirectShareForm(shareForm({ client: linked }), options).bodies(), /portal account/);
  const markup = directDestinationMarkup(linked);
  assert.match(markup, /Drone Services/); assert.match(markup, /Technologies/); assert.doesNotMatch(markup, /checked/);
  const read = readDirectShareForm(shareForm({ client: linked, destination: JSON.stringify([B, 'ws-linked-b']) }), options);
  const bodies = read.bodies({ confirmed: true });
  assert.equal(bodies.length, 1, 'no fan-out');
  assert.equal(bodies[0].sourceId, B); assert.equal(bodies[0].workspaceId, 'ws-linked-b');
  assert.equal(read.client.workspaceId, 'ws-linked-b', 'review names the exact destination');
  // An unlinked client is unchanged: no choice, its own workspace.
  const single = readDirectShareForm(shareForm({ client: otherA }), { ...options, clients: [otherA] }).bodies({ confirmed: true });
  assert.equal(single.length, 1); assert.equal(single[0].workspaceId, 'ws-other-a');
  assert.equal(directDestinationMarkup(otherA), '');
});

test('access list: linked grants read as one client, revoke stays per grant', async () => {
  const groups = await loadDirectClientGroups(async () => linkedGroups);
  const grant = (grantId, client, extra = {}) => ({ grantId, sourceId: client.sourceId, workspaceId: client.workspaceId, viewerProjectId: 'p',
    taskId: null, scopeType: 'project', includeFuturePublished: true, permissions: { measure: true, cameras: false, download: false }, expiresAt: null,
    revokedAt: null, clientDisplayName: client.displayName, ...extra });
  const access = { grants: [grant('g1', linkedA, { scopeType: 'task', taskId: 't1', includeFuturePublished: false }), grant('g2', linkedB), grant('g3', otherA)],
    clientNames: [linkedA, linkedB, otherA] };
  const html = directGrantRows(access, { projectId: 'p', tasks: [{ id: 't1', name: 'North' }], groups });
  assert.equal((html.match(/data-action="revoke-direct-client-grant"/g) || []).length, 3);
  for (const id of ['g1', 'g2', 'g3']) assert.match(html, new RegExp(`data-id="${id}"`));
  // The unrelated same-named client is still set apart from the linked one.
  assert.match(html, /class="client-picker-meta"/);
  // Without grouping the linked client's grants are labelled as two divisions; with it, as one client.
  const linkedOnly = { grants: access.grants.slice(0, 2), clientNames: [linkedA, linkedB] };
  const plain = directGrantRows(linkedOnly, { projectId: 'p', tasks: [{ id: 't1', name: 'North' }] });
  assert.match(plain, /Technologies/);
  const grouped = directGrantRows(linkedOnly, { projectId: 'p', tasks: [{ id: 't1', name: 'North' }], groups });
  assert.doesNotMatch(grouped, /client-picker-meta/);
  // The same share in both divisions says which division each grant is, so the right one can be revoked.
  const twins = { grants: [grant('g4', linkedA), grant('g5', linkedB)], clientNames: [linkedA, linkedB] };
  const twinRows = directGrantRows(twins, { projectId: 'p', tasks: [], groups });
  assert.match(twinRows, /Drone Services/); assert.match(twinRows, /Technologies/);
});
