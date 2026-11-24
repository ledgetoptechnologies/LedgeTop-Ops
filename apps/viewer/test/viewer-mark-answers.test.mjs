import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as marksStore from '../viewer-marks-store.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';

// What happens to a change whose answer never comes: it may have been made or not.
const { createMarksStore, READ_MS = 15_000, WRITE_MS = 30_000 } = marksStore;
const SLOT = 'ltds-viewer-mark-draft';
const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
const form = panel => panel.q('.viewer-mark-form');
const shown = panel => panel.q('.viewer-mark-card').textContent;

// A network that fails the next writes in a chosen way, and reads while it is down.
function network() {
  const net = { write: null, down: false, sent: [], late: [],
    request: async (path, init) => {
      const write = init.method !== 'GET', how = write ? net.write : null;
      net.sent.push(`${init.method} ${path.replace(/^.*\/api\/v1\/marks/, '').replace(/[0-9a-f-]{36}/, ':id')}`);
      const go = () => fetch(path, { ...init, signal: undefined });
      if (!write && net.down) throw new TypeError('Failed to fetch');
      if (!how) return go();
      if (how === 'never sent') throw new TypeError('Failed to fetch');
      if (how === 'arrives late') { net.late.push(go); throw new TypeError('Failed to fetch'); }
      const response = await go();
      await response.arrayBuffer();
      if (how === 'lost') throw new TypeError('Failed to fetch');
      if (how === 'cut off') return new Response(new ReadableStream({ start: body => body.error(new TypeError('network error')) }), { status: response.status === 204 ? 200 : response.status });
      if (how === 'gateway') return new Response('<html>', { status: 504 });
      if (how === 'hangs') return new Promise(() => {});
      throw new Error('unknown: ' + how);
    } };
  return net;
}
async function start(t) {
  const setup = await openMarksPanel(t), net = network(), storage = memoryStorage();
  const person = setup.scope('client', 'client-a');
  // A new page in the same tab.
  const page = async (dom = createMiniDocument({ sessionStorage: storage })) => {
    const panel = setup.mount({ dom, request: net.request });
    await panel.marks.setScope({ ...person });
    net.sent.length = 0;
    return panel;
  };
  const rows = () => setup.database.prepare('SELECT id, revision, document_json FROM viewer_marks WHERE deleted_at IS NULL ORDER BY created_at, id').all()
    .map(row => ({ id: row.id, revision: row.revision, ...JSON.parse(row.document_json) }));
  const one = async () => {
    const panel = await page();
    await panel.place('43.05, -87');
    await panel.type('[name=name]', 'One');
    await panel.save();
    net.sent.length = 0;
    return panel;
  };
  return { ...setup, net, storage, person, page, rows, one, stored: () => storage.items.has(SLOT) };
}

test('an edit that was stored but not answered is found again, not called someone else\'s', async t => {
  for (const how of ['lost', 'cut off', 'gateway']) {
    const { net, rows, one, stored, storage } = await start(t);
    const panel = await one(), [{ id }] = rows();
    await panel.open('One');
    await panel.type('[name=note]', 'Ladder');
    net.write = how;
    await panel.save();
    net.write = null;
    assert.deepEqual(net.sent.slice(0, 2), ['PUT /:id', 'GET '], how);
    assert.equal(net.sent.filter(item => item.startsWith('PUT')).length, 1, 'not sent twice');
    assert.equal(form(panel).hidden, true, how);
    assert.doesNotMatch(panel.text(), /Someone else|Could not|No answer/);
    assert.deepEqual(rows().map(row => [row.id, row.revision, row.note]), [[id, 2, 'Ladder']]);
    assert.deepEqual([stored(), storage.items.size], [false, storage.items.size]);
    // It is a change like any other: Undo takes it back.
    assert.equal(panel.store.state.undo.at(-1).done, 'One changed');
    assert.equal(await panel.store.undo(), true);
    assert.deepEqual(rows().map(row => [row.id, row.revision, row.note]), [[id, 3, '']]);
  }
});

test('reloading after such an edit keeps the one mark: nothing unsaved, no new mark, no copy', async t => {
  for (const when of ['while it is on its way', 'after the check failed too']) {
    const { net, rows, page, one, stored } = await start(t);
    const panel = await one(), [{ id }] = rows();
    await panel.open('One');
    await panel.type('[name=note]', 'Ladder');
    await panel.type('[name=elevation]', '812.5');
    await panel.type('[name=pointCoordinates]', '43.05031234, -86.99971234');
    net.write = when.startsWith('while') ? 'hangs' : 'lost';
    net.down = true;
    const saving = panel.save();
    await (when.startsWith('while') ? settle(60) : saving);
    net.write = null;
    net.down = false;
    assert.equal(rows()[0].revision, 2, 'it was stored');
    assert.equal(stored(), true);
    const second = await page();
    assert.equal(form(second).hidden, true, when + ': nothing is unsaved');
    assert.doesNotMatch(second.text(), /changed elsewhere|restored/);
    assert.equal(stored(), false);
    assert.deepEqual(second.store.state.marks.map(mark => [mark.id, mark.revision, mark.note, mark.geometry.coordinates]), [[id, 2, 'Ladder', [-86.99971234, 43.05031234]]]);
    await second.open('One');
    await second.type('[name=note]', 'Ladder, strap');
    await second.save();
    assert.deepEqual(rows().map(row => [row.id, row.revision, row.note]), [[id, 3, 'Ladder, strap']], when);
  }
});

test('what was typed after such an edit comes back as an edit of the same mark', async t => {
  const { net, rows, page, one, stored } = await start(t);
  const panel = await one(), [{ id }] = rows();
  await panel.open('One');
  await panel.type('[name=note]', 'First');
  net.write = 'lost';
  net.down = true;
  await panel.save();
  net.write = null;
  assert.match(shown(panel), /No answer/);
  await panel.type('[name=note]', 'First and more');
  net.down = false;
  const second = await page();
  assert.deepEqual([form(second).hidden, second.q('[name=note]').value], [false, 'First and more']);
  assert.doesNotMatch(second.text(), /changed elsewhere/);
  await second.save();
  assert.deepEqual(rows().map(row => [row.id, row.revision, row.note]), [[id, 3, 'First and more']]);
  assert.equal(stored(), false);
});

test('a change someone made meanwhile is still said and still kept apart', async t => {
  const { net, rows, page, one, mount, scope } = await start(t);
  for (const reload of [false, true]) {
    const panel = reload ? await page() : await one();
    const other = mount();
    await other.marks.setScope(scope('client', 'client-a'));
    const [{ id }] = rows();
    await panel.open('One');
    await panel.type('[name=note]', 'Mine ' + reload);
    net.write = 'never sent';
    net.down = true;
    await panel.save();
    net.write = null;
    net.down = false;
    await other.store.update(other.store.find(id), { note: 'Other ' + reload });
    if (!reload) {
      await panel.save();
      assert.match(shown(panel), /Someone else changed this mark/);
      assert.equal(rows()[0].note, 'Other false', 'not written over');
      await panel.card('Cancel').click();
      continue;
    }
    const second = await page();
    assert.match(second.text(), /changed elsewhere/);
    await second.save();
    assert.deepEqual(rows().map(row => row.note).sort(), ['Mine true', 'Other true']);
    assert.equal(rows().find(row => row.id === id).note, 'Other true');
  }
});

test('saving again checks first: the same, or more typed, is one mark and no false warning', async t => {
  for (const kind of ['edit', 'new']) for (const more of [false, true]) for (const how of ['lost', 'never sent', 'arrives late']) {
    const at = [kind, more, how].join();
    const { net, rows, page, one, stored } = await start(t);
    const panel = kind === 'edit' ? await one() : await page();
    const id = kind === 'edit' ? rows()[0].id : null;
    if (kind === 'edit') await panel.open('One'); else await panel.place('43.05, -87');
    await panel.type('[name=name]', 'One');
    await panel.type('[name=note]', 'First');
    net.write = how;
    net.down = true;
    await panel.save();
    assert.match(shown(panel), /No answer/, at);
    assert.deepEqual([form(panel).hidden, stored(), panel.store.state.busy], [false, true, false], at);
    // Still down: it only asks, it does not send again.
    net.sent.length = 0;
    net.write = null;
    await panel.save();
    assert.deepEqual(net.sent, ['GET '], at);
    net.down = false;
    if (more) await panel.type('[name=note]', 'Second');
    net.sent.length = 0;
    if (net.late.length) await (await net.late.shift()()).arrayBuffer();
    await panel.save();
    assert.equal(net.sent[0], 'GET ', at + ': asks before sending');
    assert.equal(form(panel).hidden, true, at);
    assert.doesNotMatch(panel.text(), /Someone else|No answer|Could not/, at);
    assert.equal(stored(), false, at);
    assert.deepEqual(rows().map(row => row.note), [more ? 'Second' : 'First'], at);
    if (id) assert.equal(rows()[0].id, id, at);
    if (!more && how !== 'never sent') assert.deepEqual(net.sent.filter(item => !item.startsWith('GET')), [], at + ': already there');
    assert.equal(panel.store.state.undo.length, kind === 'edit' ? 2 : 1, at);
  }
});

test('a write that arrives after the check found nothing is recognised by the next one', async t => {
  for (const kind of ['edit', 'new']) {
    const { net, rows, page, one } = await start(t);
    const panel = kind === 'edit' ? await one() : await page();
    if (kind === 'edit') await panel.open('One'); else await panel.place('43.05, -87');
    await panel.type('[name=name]', 'One');
    await panel.type('[name=note]', 'First');
    net.write = 'arrives late';
    await panel.save();
    net.write = null;
    assert.match(shown(panel), /Could not save the change\. Try again\./);
    await (await net.late.shift()()).arrayBuffer();
    await panel.type('[name=note]', 'Second');
    await panel.save();
    assert.equal(form(panel).hidden, true, kind);
    assert.doesNotMatch(panel.text(), /Someone else|Could not/, kind);
    assert.deepEqual(rows().map(row => row.note), ['Second'], kind);
  }
});

// A window whose timers the test moves by hand.
function clock(storage) {
  const dom = createMiniDocument({ sessionStorage: storage }), timers = new Map();
  let now = 0, next = 1;
  dom.window.setTimeout = (work, ms) => { timers.set(next, { work, at: now + ms }); return next++; };
  dom.window.clearTimeout = id => timers.delete(id);
  return { dom, pending: () => timers.size, pass(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.work(); }
  } };
}

test('a write that is never answered ends by itself and is checked', async t => {
  const { net, rows, one, page, storage, stored } = await start(t);
  await one();
  const time = clock(storage), panel = await page(time.dom);
  await panel.open('One');
  await panel.type('[name=note]', 'Ladder');
  net.write = 'hangs';
  const saving = panel.save();
  await settle(60);
  assert.equal(panel.store.state.busy, true);
  time.pass(WRITE_MS - 1);
  await settle();
  assert.equal(panel.store.state.busy, true, 'not before its time');
  time.pass(1);
  await saving;
  assert.deepEqual([panel.store.state.busy, form(panel).hidden, stored()], [false, true, false]);
  assert.deepEqual(rows().map(row => [row.revision, row.note]), [[2, 'Ladder']]);
  assert.equal(time.pending(), 1, 'only the undo bar is left');
});

// ---- the store, change by change ---------------------------------------------
async function open(t, options) {
  const setup = await openMarksPanel(t, options), timers = new Map();
  let now = 0, next = 1;
  const net = { how: null, down: false, hangReads: false, sent: [], before: null, answer: null, late: [],
    deliver: async () => { for (const go of net.late.splice(0)) await (await go()).arrayBuffer(); } };
  const request = async (path, init) => {
    const write = init.method !== 'GET';
    net.sent.push(init.method + ' ' + path.replace('/api/v1/marks', ''));
    if (!write && net.hangReads) return new Promise(() => {});
    if (!write && net.down) throw new TypeError('offline');
    const go = () => setup.request(path, { ...init, signal: undefined });
    // Something happens between the change and the look-up.
    if (!write && net.before) { const before = net.before; net.before = null; await before(); }
    if (!write && net.answer) return net.answer(path, go);
    if (write && net.how === 'late') { net.late.push(go); throw new TypeError('offline'); }
    if (write && net.how === 'never') return new Promise(() => {});
    if (write && net.how === 'refused') throw new TypeError('offline');
    const response = await setup.request(path, { ...init, signal: undefined });
    if (write && net.how === 'lost') { await response.arrayBuffer(); throw new TypeError('connection lost'); }
    if (write && net.how === 'hangs') return new Promise(() => {});
    return response;
  };
  const store = createMarksStore({ request, later: (work, ms) => { const id = next++; timers.set(id, { work, at: now + ms }); return () => timers.delete(id); } });
  await store.setScope(setup.scope('client', 'client-a'));
  net.sent.length = 0;
  const pass = async ms => {
    await settle(40);
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.work(); }
    await settle(40);
  };
  const count = (where = 'deleted_at IS NULL') => setup.database.prepare('SELECT count(*) n FROM viewer_marks WHERE ' + where).get().n;
  return { ...setup, store, net, pass, count, timers };
}
const point = (name, changes = {}) => ({ geometry: { type: 'Point', coordinates: [-87, 43] }, name, color: '#1565c0', icon: 'pin', note: '', ...changes });

test('writes and checks are bounded, larger ones get longer, and nothing stays busy', async t => {
  const { store, net, pass, count, timers } = await open(t, { maxRequestBytes: 2_000_000 });
  net.how = 'never';
  const saving = store.create(point('One'));
  await pass(WRITE_MS - 1);
  assert.equal(store.state.busy, true);
  await pass(1);
  assert.equal(await saving, null);
  assert.deepEqual([store.state.busy, store.state.message], [false, 'Could not save the change. Try again.'], 'the check found it was not made');
  // Neither is answered.
  net.hangReads = true;
  const again = store.create(point('Two'));
  await pass(WRITE_MS);
  assert.equal(store.state.busy, true, 'checking');
  await pass(READ_MS);
  assert.equal(await again, null);
  assert.equal(store.state.busy, false);
  assert.match(store.state.message, /No answer/);
  net.hangReads = false;
  net.how = null;
  // A large import may take longer before it is given up.
  const marks = Array.from({ length: 400 }, (_, i) => ({ ...point('m' + i, { note: 'x'.repeat(800) }), id: randomUUID() }));
  net.how = 'never';
  const importing = store.importMarks({ marks });
  await settle(150);
  assert.equal(store.state.busy, true, store.state.message);
  await pass(WRITE_MS);
  assert.equal(store.state.busy, true);
  await pass(WRITE_MS);
  assert.equal(await importing, 0);
  assert.deepEqual([store.state.busy, count(), timers.size], [false, 0, 0]);
  // Leaving ends the wait without a word to the next person.
  const left = store.create(point('Three'));
  await settle();
  await store.setScope(null);
  assert.equal(await left, null);
  assert.deepEqual([store.state.busy, store.state.message, timers.size], [false, '', 0]);
});

test('every kind of change whose answer was lost is found by the check, once', async t => {
  for (const how of ['lost', 'hangs']) {
    const { store, net, pass, count, database } = await open(t);
    const run = async work => {
      net.how = how;
      const result = work();
      if (how === 'hangs') await pass(WRITE_MS);
      const value = await result;
      net.how = null;
      assert.equal(store.state.message, '', how);
      return value;
    };
    const one = await run(() => store.create(point('One')));
    assert.deepEqual([one.name, count(), store.state.undo.length], ['One', 1, 1]);
    const changed = await run(() => store.update(store.find(one.id), { name: 'Uno', elevationNavd88M: 250.123456 }));
    assert.deepEqual([changed.name, changed.revision, changed.elevationNavd88M], ['Uno', 2, 250.123]);
    assert.equal(await run(() => store.undo()), true);
    assert.deepEqual([store.find(one.id).name, store.state.undo.length], ['One', 1]);
    assert.equal(await run(() => store.remove(store.find(one.id))), true);
    assert.deepEqual([count(), store.state.marks], [0, []]);
    assert.equal(await run(() => store.undo()), true);
    assert.equal(store.find(one.id).name, 'One');
    await store.remove(store.find(one.id));
    await store.loadDeleted();
    assert.equal((await run(() => store.restore(store.state.deleted[0]))).id, one.id);
    assert.equal(await run(() => store.remove(store.find(one.id), { permanent: true })), true);
    assert.ok(!store.state.undo.some(entry => entry.id === one.id || entry.before?.id === one.id));
    const category = await run(() => store.saveCategory({ name: 'Gates', color: '#1565c0', icon: 'gate' }));
    assert.equal(category.name, 'Gates');
    const renamed = await run(() => store.saveCategory({ ...category, name: 'Gate' }));
    assert.deepEqual([renamed.name, renamed.revision, store.state.categories.length], ['Gate', 2, 1]);
    assert.equal(await run(() => store.deleteCategory(store.state.categories[0])), true);
    assert.deepEqual(store.state.categories, []);
    const marks = ['a', 'b', 'c'].map(name => ({ ...point(name), id: randomUUID() }));
    assert.equal(await run(() => store.importMarks({ marks })), 3);
    assert.deepEqual([count(), store.state.undo.at(-1).done], [3, '3 marks imported']);
    assert.equal(await run(() => store.undo()), true);
    assert.deepEqual([count(), store.state.marks], [0, []]);
    assert.equal(database.prepare('SELECT count(*) n FROM viewer_mark_categories WHERE deleted_at IS NULL').get().n, 0);
  }
});

test('a starter whose answer was lost is made once', async t => {
  const { store, net, database } = await open(t);
  const [starter] = store.starters();
  net.how = 'lost';
  const made = await store.addStarter(starter);
  assert.equal(made.name, starter.name);
  assert.equal(database.prepare('SELECT count(*) n FROM viewer_mark_categories').get().n, 1);
});

test('when nothing can be checked, a second go at a pin, a file or a category adds no copy', async t => {
  for (const arrived of [true, false]) {
    const { store, net, count, database } = await open(t);
    const doubt = async work => {
      net.how = arrived ? 'lost' : 'refused';
      net.down = true;
      const first = await work();
      assert.ok(!first);
      assert.match(store.state.message, /No answer/);
      net.how = null;
      net.down = false;
    };
    const file = () => store.importMarks({ categories: [{ id: randomUUID(), name: 'Gates', color: '#1565c0', icon: 'gate' }],
      marks: ['a', 'b'].map(name => ({ ...point(name), id: randomUUID() })) });
    await doubt(file);
    assert.equal(await file(), 2, 'the same file again');
    assert.equal(count(), 2);
    assert.equal(store.state.undo.filter(entry => entry.type === 'import').length, 1);
    await store.undo();
    // Something else instead: if the first was made after all, that is said before more is added.
    await doubt(() => store.create(point('One')));
    const next = await store.create(point('Two'));
    if (arrived) {
      assert.equal(next, null);
      assert.match(store.state.message, /was saved after all/);
      assert.deepEqual(store.state.marks.map(mark => mark.name), ['One']);
      assert.equal((await store.create(point('Two'))).name, 'Two');
      assert.deepEqual(store.state.undo.map(entry => entry.done), ['One added', 'Two added']);
    }
    assert.deepEqual(store.state.marks.map(mark => mark.name), arrived ? ['One', 'Two'] : ['Two']);
    await doubt(() => store.saveCategory({ name: 'Water', color: '#1565c0', icon: 'water' }));
    const water = await store.saveCategory({ name: 'Water', color: '#1565c0', icon: 'water' });
    assert.equal(water.name, 'Water');
    assert.equal(database.prepare("SELECT count(*) n FROM viewer_mark_categories WHERE deleted_at IS NULL AND name='Water'").get().n, 1);
    const one = store.state.marks[0];
    await doubt(() => store.remove(one));
    assert.equal(await store.remove(one), true, 'deleting it again');
    assert.equal(count('deleted_at IS NULL AND id=\'' + one.id + '\''), 0);
    assert.equal(store.state.undo.at(-1).done, one.name + ' deleted');
    assert.equal(await store.undo(), true);
    assert.ok(store.find(one.id));
  }
});

test('Place several after a click without an answer places one pin', async t => {
  for (const how of ['lost', 'never sent', 'arrives late']) {
    const { net, rows, page } = await start(t);
    const panel = await page();
    const strip = text => panel.q('.viewer-mark-strip').querySelectorAll('button').find(node => node.textContent === text);
    await panel.q('.viewer-mark-add').click();
    await strip('Place several').click();
    const click = async lat => { panel.marks.mapClick({ lat, lng: -87 }); await settle(80); };
    net.write = how;
    net.down = how !== 'arrives late';
    await click(43);
    net.write = null;
    net.down = false;
    if (net.late.length) await (await net.late.shift()()).arrayBuffer();
    await click(43.001);
    assert.equal(rows().length, 1, how);
    assert.doesNotMatch(panel.text(), /Someone else/, how);
    await click(43.002);
    assert.equal(rows().length, 2, how);
  }
});

test('nothing of a change without an answer reaches the next person', async t => {
  const { store, net, scope, count } = await open(t);
  net.how = 'lost';
  net.down = true;
  await store.create(point('Private'));
  net.how = null;
  net.down = false;
  net.sent.length = 0;
  await store.setScope(scope('client', 'client-b'));
  net.sent.length = 0;
  assert.equal((await store.create(point('Mine'))).name, 'Mine');
  assert.deepEqual([net.sent, store.state.marks.map(mark => mark.name), count()], [['POST '], ['Mine'], 2]);
});

// ---- independent changes meanwhile --------------------------------------------
// Another tab or device of the same person, on its own store.
async function beside(t, options) {
  const setup = await open(t, options);
  const other = createMarksStore({ request: (path, init) => setup.request(path, { ...init, signal: undefined }) });
  await other.setScope(setup.scope('client', 'client-a'));
  return { ...setup, other, fresh: async () => { await other.refresh(); return other; },
    kinds: () => setup.store.state.undo.map(entry => entry.type) };
}
const texts = (...names) => names.map(name => ({ ...point(name), id: randomUUID() }));

test('an import that was changed since is reported, and Undo takes nothing of it', async t => {
  for (const change of ['edited', 'edited and put back', 'deleted']) for (const when of ['before the check', 'after the check failed', 'before it is sent again']) {
    const at = `${change}, ${when}`;
    const { store, net, fresh, count, kinds } = await beside(t);
    const marks = texts('a', 'b', 'c');
    const meddle = async () => {
      const other = await fresh(), row = other.state.marks.find(mark => mark.name === 'b');
      if (change === 'deleted') await other.remove(row);
      else {
        const edited = await other.update(row, { note: 'Independent' });
        if (change === 'edited and put back') await other.update(edited, { note: '' });
      }
    };
    const again = () => store.importMarks({ marks: marks.map(mark => ({ ...mark, id: randomUUID() })) });
    let made;
    if (when === 'before the check') {
      net.how = 'lost';
      net.before = meddle;
      made = await store.importMarks({ marks });
    } else if (when === 'after the check failed') {
      net.how = 'lost';
      net.down = true;
      assert.equal(await store.importMarks({ marks }), 0);
      net.down = false;
      net.how = null;
      await meddle();
      made = await again();
    } else {
      net.how = 'late';
      assert.equal(await store.importMarks({ marks }), 0);
      assert.equal(store.state.message, 'Could not save the change. Try again.');
      net.how = null;
      await net.deliver();
      await meddle();
      made = await again();
    }
    net.how = null;
    assert.equal(made, change === 'deleted' ? 2 : 3, at);
    assert.match(store.state.message, /cannot be undone/, at);
    assert.deepEqual(kinds(), [], at);
    assert.equal(await store.undo(), false);
    assert.equal(count(), change === 'deleted' ? 2 : 3, at + ': none went, none was added');
    if (change === 'edited') assert.equal(store.state.marks.find(mark => mark.name === 'b').note, 'Independent');
  }
  // Untouched, it can be undone as before.
  const { store, net, count, kinds } = await beside(t);
  net.how = 'lost';
  assert.equal(await store.importMarks({ marks: texts('a', 'b') }), 2);
  net.how = null;
  assert.deepEqual(kinds(), ['import']);
  assert.equal(await store.undo(), true);
  assert.equal(count(), 0);
});

test('matching content at a later version is not one\'s own change', async t => {
  // Stored, then changed and put back to exactly that by another.
  const { store, net, fresh } = await beside(t);
  const one = await store.create(point('One'));
  net.how = 'lost';
  net.down = true;
  assert.equal(await store.update(one, { note: 'Mine' }), null);
  net.how = null;
  net.down = false;
  let other = await fresh();
  await other.update(other.find(one.id), { note: 'Independent' });
  await other.update(other.find(one.id), { note: 'Mine' });
  assert.equal(await store.update(one, { note: 'Mine and more' }), null);
  assert.equal(store.state.failure, 'mark_revision_conflict');
  assert.deepEqual([store.find(one.id).note, store.find(one.id).revision], ['Mine', 4], 'not written over');
  // A new mark whose save arrived and was then changed by another.
  for (const when of ['before the check', 'before it is sent again']) {
    const id = randomUUID(), mark = { ...point('New'), id };
    const meddle = async () => { other = await fresh(); await other.update(other.find(id), { note: 'Independent' }); };
    if (when === 'before the check') { net.how = 'lost'; net.before = meddle; assert.equal(await store.create(mark), null); }
    else {
      net.how = 'late';
      assert.equal(await store.create(mark), null);
      net.how = null;
      await net.deliver();
      await meddle();
      assert.equal(await store.create(mark), null);
    }
    net.how = null;
    assert.equal(store.state.failure, 'mark_id_conflict', when);
    assert.match(store.state.message, /Someone else changed this mark/);
    assert.equal(store.find(id).note, 'Independent');
    assert.ok(!store.state.undo.some(entry => entry.id === id), when);
  }
});

test('deleting for good counts as done only when the owner\'s lists say it is gone', async t => {
  const begin = async () => {
    const setup = await beside(t);
    const one = await setup.store.create(point('One'));
    const changed = await setup.store.update(one, { note: 'x' });
    return { ...setup, changed, id: one.id };
  };
  // Done.
  for (const down of [false, true]) {
    const { store, net, changed, kinds } = await begin();
    net.how = 'lost';
    net.down = down;
    assert.equal(await store.remove(changed, { permanent: true }), !down);
    if (down) {
      assert.match(store.state.message, /No answer/);
      assert.deepEqual(kinds(), ['create', 'update']);
      net.how = null;
      net.down = false;
      assert.equal(await store.remove(changed, { permanent: true }), true);
    }
    assert.deepEqual([kinds(), store.state.marks], [[], []]);
  }
  // Only put in Recently deleted, by another.
  {
    const { store, net, changed, id, fresh, kinds, count } = await begin();
    net.how = 'refused';
    net.before = async () => { const other = await fresh(); await other.remove(other.find(id)); };
    assert.equal(await store.remove(changed, { permanent: true }), false);
    net.how = null;
    assert.match(store.state.message, /Recently deleted/);
    assert.deepEqual(kinds(), ['create', 'update']);
    assert.deepEqual(store.state.deleted.map(mark => mark.id), [id]);
    assert.equal(count("document_json<>'{}'"), 1, 'nothing is lost');
  }
  // Not in the list, but still there; not readable; the list of deleted not answered; no write access.
  for (const odd of ['hidden', 'deleted list fails', 'single read fails', 'read only']) {
    const { store, net, changed, id, kinds, database } = await begin();
    net.how = odd === 'hidden' ? 'refused' : 'lost';
    net.answer = async (path, go) => {
      const url = path.replace('/api/v1/marks', '');
      if (url === '' && ['hidden', 'read only'].includes(odd)) {
        const data = await (await go()).json();
        return Response.json({ ...data, marks: [], capabilities: { ...data.capabilities, write: odd !== 'read only' } });
      }
      if (url === '/deleted' && odd === 'deleted list fails') return new Response('x', { status: 500 });
      if (url === '/' + id && odd === 'single read fails') return Response.json({ code: 'busy' }, { status: 503 });
      return go();
    };
    const had = kinds();
    assert.equal(await store.remove(changed, { permanent: true }), false, odd);
    net.how = null;
    net.answer = null;
    assert.match(store.state.message, odd === 'hidden' ? /Could not save/ : /No answer/, odd);
    if (odd !== 'read only') assert.deepEqual(kinds(), had, odd);
    assert.equal(database.prepare("SELECT document_json<>'{}' n FROM viewer_marks WHERE id=?").get(id).n, odd === 'hidden' ? 1 : 0);
  }
});

test('a delete, a restore and their undo are recovered at their own version only', async t => {
  // Deleted by another at a later version: no Undo that is not one's own.
  for (const later of [false, true]) {
    const { store, net, fresh, kinds } = await beside(t);
    const one = await store.create(point('One'));
    net.how = 'refused';
    net.before = async () => {
      const other = await fresh();
      if (later) await other.update(other.find(one.id), { note: 'Independent' });
      await other.remove(other.find(one.id));
    };
    assert.equal(await store.remove(one), !later);
    net.how = null;
    assert.deepEqual(kinds(), later ? ['create'] : ['create', 'delete']);
    if (later) assert.match(store.state.message, /no longer there/);
  }
  // Restored, then changed by another: it is back, and Undo would not delete their change.
  for (const way of ['list', 'undo']) for (const changed of [false, true]) {
    const at = [way, changed].join();
    const { store, net, fresh, kinds, count } = await beside(t);
    const one = await store.create(point('One'));
    await store.remove(one);
    await store.loadDeleted();
    net.how = 'lost';
    if (changed) net.before = async () => { const other = await fresh(); await other.update(other.find(one.id), { note: 'Independent' }); };
    const back = way === 'list' ? await store.restore(store.state.deleted[0]) : await store.undo();
    net.how = null;
    assert.ok(back, at);
    assert.equal(store.find(one.id).note, changed ? 'Independent' : '', at);
    if (way === 'list') assert.deepEqual(kinds(), changed ? ['create', 'delete'] : ['create', 'delete', 'create'], at);
    for (let i = 0; i < 5 && store.state.undo.length; i += 1) await store.undo();
    assert.equal(count(), changed ? 1 : 0, at + ': an independent change is not deleted');
  }
});

test('Undo does not write over or delete a change made elsewhere, also one read since', async t => {
  for (const kind of ['create', 'update']) {
    const { store, fresh, count } = await beside(t);
    const one = await store.create(point('One'));
    if (kind === 'update') await store.update(one, { note: 'Mine' });
    const other = await fresh();
    await other.update(other.find(one.id), { note: 'Independent' });
    await store.refresh();
    assert.equal(await store.undo(), false, kind);
    assert.match(store.state.message, /Someone else changed this mark/);
    assert.deepEqual([store.find(one.id).note, count()], ['Independent', 1]);
  }
  // One's own steps, also through Undo and back, stay undoable to the start.
  const { store, count } = await beside(t);
  const one = await store.create(point('One'));
  await store.update(one, { note: 'a' });
  await store.update(store.find(one.id), { note: 'b' });
  await store.remove(store.find(one.id));
  await store.refresh();
  for (const [note, left] of [['b', 1], ['a', 1], ['', 1], [null, 0]]) {
    assert.equal(await store.undo(), true, String(note));
    assert.equal(count(), left);
    if (note !== null) assert.equal(store.find(one.id).note, note);
  }
});

test('an undo without an answer is not taken as done on absence or a later match', async t => {
  // Undo of an import: all in Recently deleted as they were, or it is not known.
  for (const meddled of [false, true]) {
    const { store, net, fresh, kinds } = await beside(t);
    await store.importMarks({ marks: texts('a', 'b') });
    net.how = meddled ? 'refused' : 'lost';
    if (meddled) net.before = async () => { const other = await fresh(); for (const mark of [...other.state.marks]) { await other.update(mark, { note: 'x' }); await other.remove(other.find(mark.id)); } };
    assert.equal(await store.undo(), !meddled);
    net.how = null;
    assert.deepEqual(kinds(), meddled ? ['import'] : []);
  }
  // Undo of an edit: the same text put there later by another is theirs.
  const { store, net, fresh, kinds } = await beside(t);
  const one = await store.create(point('One'));
  await store.update(one, { note: 'Mine' });
  net.how = 'refused';
  net.before = async () => { const other = await fresh(); await other.update(other.find(one.id), { note: 'x' }); await other.update(other.find(one.id), { note: '' }); };
  assert.equal(await store.undo(), false);
  net.how = null;
  assert.equal(store.find(one.id).revision, 4);
  assert.equal(await store.undo(), false, 'and it is not written over');
  assert.equal(store.find(one.id).revision, 4);
  assert.deepEqual(kinds(), ['create']);
});

test('a reload takes a stored edit for one\'s own at its own version only', async t => {
  for (const kind of ['edit', 'new']) for (const change of ['edited', 'edited and put back']) {
    const at = [kind, change].join();
    const { net, rows, page, one, mount, scope } = await start(t);
    const panel = kind === 'edit' ? await one() : await page();
    if (kind === 'edit') await panel.open('One'); else await panel.place('43.05, -87');
    await panel.type('[name=name]', 'One');
    await panel.type('[name=note]', 'Mine');
    net.write = 'lost';
    net.down = true;
    await panel.save();
    net.write = null;
    net.down = false;
    const other = mount(), [{ id }] = rows();
    await other.marks.setScope(scope('client', 'client-a'));
    await other.store.update(other.store.find(id), { note: 'Independent' });
    if (change !== 'edited') await other.store.update(other.store.find(id), { note: 'Mine' });
    const second = await page();
    assert.match(second.text(), /changed elsewhere/, at);
    await second.save();
    assert.equal(rows().find(row => row.id === id).note, change === 'edited' ? 'Independent' : 'Mine', at);
    assert.equal(rows().length, 2, at + ': kept apart');
  }
});

test('a Save does not write over a change that was read while the editor was open', async t => {
  for (const kind of ['edit', 'new']) for (const how of ['same save', 'another change']) {
    const at = [kind, how].join();
    const { net, rows, page, one, mount, scope } = await start(t);
    const panel = kind === 'edit' ? await one() : await page();
    const other = mount();
    const meddle = async id => { await other.marks.setScope(scope('client', 'client-a')); await other.store.update(other.store.find(id), { note: 'Independent' }); };
    if (kind === 'edit') await panel.open('One'); else await panel.place('43.05, -87');
    await panel.type('[name=name]', 'One');
    await panel.type('[name=note]', 'Mine');
    let id = kind === 'edit' ? rows()[0].id : null;
    if (how === 'same save') {
      // Never sent (an edit), or sent and answered by nothing (a new mark), and changed before the look-up.
      net.write = kind === 'edit' ? 'never sent' : 'lost';
      net.down = true;
      await panel.save();
      net.write = null;
      id ||= rows()[0].id;
      await meddle(id);
      net.down = false;
      await panel.save();
    } else {
      if (kind === 'new') { net.write = 'lost'; net.down = true; await panel.save(); net.write = null; net.down = false; id = rows()[0].id; }
      await meddle(id);
      // Something else reads the list again.
      await panel.store.refresh();
      await panel.save();
    }
    assert.match(shown(panel), /Someone else changed this mark/, at);
    assert.equal(rows().find(row => row.id === id).note, 'Independent', at);
    assert.equal(panel.q('[name=note]').value, 'Mine', at);
    // Told of it, saving again is a decision, as it was.
    await panel.save();
    assert.equal(form(panel).hidden, true, at);
    assert.deepEqual(rows().map(row => [row.id, row.note]), [[id, 'Mine']], at);
  }
});
