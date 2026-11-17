import test from 'node:test';
import assert from 'node:assert/strict';
import { bindClientPicker, clientPickerLabel, clientPickerMarkup, clientPickerOptions, clientPickerStatus, createClientPicker } from '../workspace-client-picker.mjs';

// Synthetic clients only.
const client = (id, name, extra = {}) => ({ sourceId: 'project-alpha:primary', workspaceId: id, displayName: name, businessName: 'Division A', ...extra });
function clock() {
  let now = 0, next = 1; const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: id => { timers.delete(id); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    pending: () => timers.size,
  };
}
function deferredFetch() {
  const calls = [];
  const fetchPage = request => new Promise((resolve, reject) => { calls.push({ ...request, resolve, reject }); });
  return { calls, fetchPage };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('typing is debounced into one request per pause', async () => {
  const time = clock(), remote = deferredFetch();
  const picker = createClientPicker({ fetchPage: remote.fetchPage, setTimer: time.setTimer, clearTimer: time.clearTimer });
  for (const text of ['a', 'ac', 'acm', 'acme']) { picker.input(text); time.advance(100); }
  assert.equal(remote.calls.length, 0);
  assert.equal(clientPickerStatus(picker.state), 'Searching clients…');
  time.advance(250);
  assert.equal(remote.calls.length, 1); assert.equal(remote.calls[0].query, 'acme'); assert.equal(remote.calls[0].cursor, null);
});

test('an older response can never overwrite a newer one, and the older request is aborted', async () => {
  const time = clock(), remote = deferredFetch();
  const picker = createClientPicker({ fetchPage: remote.fetchPage, setTimer: time.setTimer, clearTimer: time.clearTimer });
  picker.input('ha'); time.advance(250);
  picker.input('harbor'); time.advance(250);
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.calls[0].signal.aborted, true); assert.equal(remote.calls[1].signal.aborted, false);
  remote.calls[1].resolve({ clients: [client('ws-new', 'Harbor Works')], clientsNextCursor: null });
  await settle();
  remote.calls[0].resolve({ clients: [client('ws-old', 'Hall Survey')], clientsNextCursor: 'v1.old' });
  await settle();
  assert.deepEqual(picker.state.items.map(item => item.workspaceId), ['ws-new']);
  assert.equal(picker.state.cursor, null); assert.equal(picker.state.loading, false);
  // A late failure of the stale request does not show an error either.
  picker.input('harb'); time.advance(250); picker.input('harbo'); time.advance(250);
  remote.calls[3].resolve({ clients: [client('ws-3', 'Harbor Works')], clientsNextCursor: null }); await settle();
  remote.calls[2].reject(new Error('aborted')); await settle();
  assert.equal(picker.state.error, null); assert.equal(picker.state.items.length, 1);
});

test('scrolling loads the next page once, without duplicates, and a stale page is dropped after a new search', async () => {
  const time = clock(), remote = deferredFetch();
  const picker = createClientPicker({ fetchPage: remote.fetchPage, setTimer: time.setTimer, clearTimer: time.clearTimer,
    initial: { clients: [client('ws-1', 'A'), client('ws-2', 'B')], clientsNextCursor: 'v1.page2' } });
  void picker.more(); void picker.more();
  assert.equal(remote.calls.length, 1); assert.equal(remote.calls[0].cursor, 'v1.page2');
  remote.calls[0].resolve({ clients: [client('ws-2', 'B'), client('ws-3', 'C')], clientsNextCursor: 'v1.page3' }); await settle();
  assert.deepEqual(picker.state.items.map(item => item.workspaceId), ['ws-1', 'ws-2', 'ws-3']);
  void picker.more();
  picker.input('z'); time.advance(250);
  remote.calls[1].resolve({ clients: [client('ws-4', 'D')], clientsNextCursor: null }); await settle();
  remote.calls[2].resolve({ clients: [client('ws-z', 'Zed')], clientsNextCursor: null }); await settle();
  assert.deepEqual(picker.state.items.map(item => item.workspaceId), ['ws-z']);
});

test('keyboard: arrows move, Enter chooses without submitting, Escape closes, typing clears the choice', async () => {
  const time = clock(), remote = deferredFetch(), chosen = [];
  const picker = createClientPicker({ fetchPage: remote.fetchPage, setTimer: time.setTimer, clearTimer: time.clearTimer, onSelect: value => chosen.push(value),
    initial: { clients: [client('ws-1', 'Same Name'), client('ws-2', 'Same Name', { businessName: 'Division B' })], clientsNextCursor: null } });
  assert.equal(picker.key('Enter'), true, 'Enter is always consumed so it never submits the share form');
  assert.deepEqual(chosen, []);
  assert.equal(picker.key('Escape'), false, 'Escape with the list closed is left to the dialog');
  assert.equal(picker.key('ArrowDown'), true); assert.equal(picker.state.open, true); assert.equal(picker.state.active, 0);
  picker.key('ArrowDown'); picker.key('ArrowDown'); assert.equal(picker.state.active, 1, 'stops at the last option');
  picker.key('ArrowUp'); assert.equal(picker.state.active, 0);
  picker.key('End'); assert.equal(picker.state.active, 1);
  assert.equal(picker.key('Escape'), true); assert.equal(picker.state.open, false);
  picker.key('ArrowDown'); assert.equal(picker.key('Enter'), true);
  assert.equal(chosen.at(-1).workspaceId, 'ws-2'); assert.equal(picker.state.open, false);
  assert.equal(picker.state.query, 'Same Name (Division B, ref ws-2)');
  assert.equal(picker.key('Tab'), false);
  picker.input('Same Nam');
  assert.equal(chosen.at(-1), null, 'editing the text clears the chosen client');
});

test('empty and error states are explicit', async () => {
  const time = clock(), remote = deferredFetch();
  const picker = createClientPicker({ fetchPage: remote.fetchPage, setTimer: time.setTimer, clearTimer: time.clearTimer });
  picker.input('nobody'); time.advance(250);
  remote.calls[0].resolve({ clients: [], clientsNextCursor: null }); await settle();
  assert.equal(clientPickerStatus(picker.state), 'No clients match “nobody”.');
  picker.input('x'); time.advance(250); remote.calls[1].reject(new Error('Request failed (502)')); await settle();
  assert.match(clientPickerStatus(picker.state), /could not be loaded/);
  const retry = picker.retry(); remote.calls[2].resolve({ clients: [client('ws-1', 'X Ltd')], clientsNextCursor: 'v1.more' }); await retry;
  assert.equal(picker.state.error, null); assert.match(clientPickerStatus(picker.state), /1\+ clients found/);
});

test('names, organisations and divisions containing markup are escaped', () => {
  const hostile = client('ws-1', '<img src=x onerror=alert(1)>', { organizationName: '"><script>x</script>', businessName: "O'Brien & <b>Co</b>", rootType: 'organization' });
  const html = clientPickerOptions({ items: [hostile], active: 0, loadingMore: false });
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /O&#39;Brien &amp; &lt;b&gt;Co&lt;\/b&gt;/);
  assert.match(html, /role="option"[^>]*aria-selected="true"/);
  const markup = clientPickerMarkup({ query: '"><script>alert(1)</script>' });
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /role="combobox"/); assert.match(markup, /aria-controls="direct-client-picker-list"/); assert.match(markup, /role="listbox"/);
  assert.doesNotMatch(markup, /<button|<select/);
  // Labels are plain text (set with textContent / escaped by callers).
  assert.equal(clientPickerLabel(hostile), `${hostile.displayName} — ${hostile.organizationName} (${hostile.businessName}, Organisation, ref ws-1)`);
});

test('options show what tells same-named clients apart', () => {
  const html = clientPickerOptions({ items: [client('ws-1', 'Pat Example', { organizationName: 'Lakeside Builders', rootType: 'organization' }),
    client('ws-2', 'Pat Example', { businessName: 'Division B', rootType: 'standalone_client' })], active: -1, loadingMore: false });
  assert.match(html, /Lakeside Builders · Division: Division A · Organisation · ref ws-1/);
  assert.match(html, /Division: Division B · Individual client · ref ws-2/);
  // Same name, division and type still differ by the reference, in the row and in the label used for confirmation.
  const twins = [client('workspace-aaa111', 'Pat Example'), client('workspace-bbb222', 'Pat Example')];
  assert.notEqual(clientPickerLabel(twins[0]), clientPickerLabel(twins[1]));
  assert.match(clientPickerLabel(twins[0]), /ref aaa111/);
  assert.match(clientPickerOptions({ items: twins, active: -1, loadingMore: false }), /ref bbb222/);
});

test('Enter or a click before results for the new text arrive never picks from the old list', async () => {
  const time = clock(), remote = deferredFetch(), chosen = [];
  const picker = createClientPicker({ fetchPage: remote.fetchPage, setTimer: time.setTimer, clearTimer: time.clearTimer, onSelect: value => chosen.push(value),
    initial: { clients: [client('ws-jones', 'Jones Farms'), client('ws-other', 'Other')], clientsNextCursor: null } });
  picker.key('ArrowDown'); assert.equal(picker.state.active, 0);
  picker.input('Smith');
  assert.equal(picker.key('Enter'), true, 'Enter is consumed');
  assert.equal(picker.select(0), false, 'a click on a stale row is ignored');
  assert.deepEqual(chosen, []); assert.equal(picker.state.selected, null);
  assert.deepEqual(picker.state.items, []); assert.equal(picker.state.active, -1);
  time.advance(250);
  picker.key('Enter'); assert.deepEqual(chosen, [], 'still waiting for the answer');
  remote.calls[0].resolve({ clients: [client('ws-smith', 'Smith Survey')], clientsNextCursor: null }); await settle();
  picker.key('Enter'); assert.equal(chosen.at(-1).workspaceId, 'ws-smith');
});

test('pages emptied by the server checks are skipped instead of leaving the picker stuck', async () => {
  const time = clock(), cursors = [];
  const pages = { first: { clients: [], clientsNextCursor: 'v1.b' }, 'v1.b': { clients: [], clientsNextCursor: 'v1.c' },
    'v1.c': { clients: [client('ws-1', 'A')], clientsNextCursor: 'v1.d' }, 'v1.d': { clients: [], clientsNextCursor: 'v1.e' },
    'v1.e': { clients: [client('ws-2', 'B')], clientsNextCursor: null } };
  const picker = createClientPicker({ setTimer: time.setTimer, clearTimer: time.clearTimer,
    fetchPage: async ({ cursor }) => { cursors.push(cursor); return pages[cursor || 'first']; } });
  await picker.retry();
  assert.deepEqual(picker.state.items.map(item => item.workspaceId), ['ws-1']); assert.equal(picker.state.cursor, 'v1.d');
  await picker.more();
  assert.deepEqual(picker.state.items.map(item => item.workspaceId), ['ws-1', 'ws-2']); assert.equal(picker.state.cursor, null);
  assert.deepEqual(cursors, [null, 'v1.b', 'v1.c', 'v1.d', 'v1.e']);
  // Bounded: an endless run of empty pages stops and leaves the cursor for a later attempt.
  let calls = 0;
  const endless = createClientPicker({ setTimer: time.setTimer, clearTimer: time.clearTimer,
    fetchPage: async () => { calls++; return { clients: [], clientsNextCursor: `v1.${calls}` }; } });
  await endless.retry(); assert.equal(calls, 6); assert.equal(endless.state.items.length, 0); assert.ok(endless.state.cursor);
});

test('a list too short to scroll keeps loading until it fills or runs out', async () => {
  const input = element({ role: 'combobox' }), list = element(), status = element(), hidden = element();
  list.scrollHeight = 40; list.clientHeight = 256;
  const root = { isConnected: true, querySelector: selector => selector === '[role="combobox"]' ? input : selector === '[data-client-picker-list]' ? list
    : selector === '[data-client-picker-status]' ? status : selector === 'input[name="client"]' ? hidden : null };
  const cursors = [];
  const picker = bindClientPicker(root, { initial: { clients: [client('ws-1', 'A')], clientsNextCursor: 'v1.2' },
    fetchPage: async ({ cursor }) => { cursors.push(cursor); return cursor === 'v1.2' ? { clients: [client('ws-2', 'B')], clientsNextCursor: 'v1.3' }
      : { clients: [client('ws-3', 'C')], clientsNextCursor: null }; } });
  input.onkeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(cursors, ['v1.2', 'v1.3']);
  assert.deepEqual(picker.state.items.map(item => item.workspaceId), ['ws-1', 'ws-2', 'ws-3']);
  picker.dispose();
});

// Minimal DOM stand-in, enough to check the ARIA wiring of bindClientPicker.
function element(attributes = {}) {
  return { attributes: { ...attributes }, hidden: false, value: '', innerHTML: '', textContent: '', dataset: {},
    setAttribute(name, value) { this.attributes[name] = String(value); }, removeAttribute(name) { delete this.attributes[name]; },
    querySelector() { return null; } };
}
test('the bound combobox keeps aria-expanded, aria-activedescendant and the chosen client in sync', async () => {
  const time = clock(), input = element({ role: 'combobox' }), list = element(), status = element(), hidden = element(), chosen = [];
  const root = { isConnected: true, querySelector: selector => selector === '[role="combobox"]' ? input : selector === '[data-client-picker-list]' ? list
    : selector === '[data-client-picker-status]' ? status : selector === 'input[name="client"]' ? hidden : null };
  const picker = bindClientPicker(root, { setTimer: time.setTimer, clearTimer: time.clearTimer, onSelect: value => chosen.push(value),
    initial: { clients: [client('ws-1', 'Acme <Survey>')], clientsNextCursor: null }, fetchPage: async () => ({ clients: [], clientsNextCursor: null }) });
  assert.equal(input.attributes['aria-expanded'], 'false'); assert.equal(list.hidden, true);
  let prevented = 0, stopped = 0; const key = name => input.onkeydown({ key: name, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  key('ArrowDown');
  assert.equal(input.attributes['aria-expanded'], 'true'); assert.equal(list.hidden, false);
  assert.equal(input.attributes['aria-activedescendant'], 'direct-client-picker-option-0');
  assert.match(list.innerHTML, /Acme &lt;Survey&gt;/);
  key('Escape'); assert.equal(stopped, 1, 'Escape closes only the list, not the dialog'); assert.equal(list.hidden, true);
  key('ArrowDown'); key('Enter');
  assert.equal(hidden.value, JSON.stringify(['project-alpha:primary', 'ws-1'])); assert.equal(chosen.at(-1).workspaceId, 'ws-1');
  assert.equal(input.value, 'Acme <Survey> (Division A, ref ws-1)'); assert.match(status.textContent, /^Selected: Acme <Survey>/);
  assert.equal(prevented, 4);
  input.value = 'Acme'; input.oninput(); assert.equal(hidden.value, ''); assert.equal(chosen.at(-1), null);
  picker.dispose(); assert.equal(time.pending(), 0);
});
