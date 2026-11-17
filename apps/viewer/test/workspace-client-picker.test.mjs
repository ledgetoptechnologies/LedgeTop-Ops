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
  assert.equal(picker.state.query, 'Same Name (Division B)');
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
  assert.equal(clientPickerLabel(hostile), `${hostile.displayName} — ${hostile.organizationName} (${hostile.businessName})`);
});

test('options show what tells same-named clients apart', () => {
  const html = clientPickerOptions({ items: [client('ws-1', 'Pat Example', { organizationName: 'Lakeside Builders', rootType: 'organization' }),
    client('ws-2', 'Pat Example', { businessName: 'Division B', rootType: 'standalone_client' })], active: -1, loadingMore: false });
  assert.match(html, /Lakeside Builders · Division: Division A · Organisation/);
  assert.match(html, /Division: Division B · Individual client/);
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
  assert.equal(input.value, 'Acme <Survey> (Division A)'); assert.match(status.textContent, /^Selected: Acme <Survey>/);
  assert.equal(prevented, 4);
  input.value = 'Acme'; input.oninput(); assert.equal(hidden.value, ''); assert.equal(chosen.at(-1), null);
  picker.dispose(); assert.equal(time.pending(), 0);
});
