import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMarkDraftRecovery, reconcileMarkDraft, validMarkDraft } from '../viewer-mark-draft-recovery.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';

const SLOT = 'ltds-viewer-mark-draft';
const editor = (changes = {}) => ({ kind: 'editor', id: null, newId: randomUUID(), revision: null, geometry: { type: 'Point', coordinates: [-87, 43] },
  name: 'Draft', note: 'Note', categoryId: null, color: '#1e88e5', icon: 'pin', elevation: '', units: 'imperial', visibility: 'private', coordinates: null, ...changes });

test('a draft is read back only for the same person and model, within a day, and whole', () => {
  let now = 1_000_000;
  const storage = memoryStorage();
  const open = () => createMarkDraftRecovery({ storage: () => storage, now: () => now });
  const draft = editor();
  open().save('person A', draft);
  assert.deepEqual(open().read('person A'), draft, 'a new page reads it');
  assert.equal(open().read('person B'), null);
  assert.equal(storage.items.size, 0, 'another person\'s draft is discarded, not kept');
  for (const age of [24 * 3600_000 + 1, -1]) {
    open().save('person A', draft);
    now += age;
    assert.equal(open().read('person A'), null);
    assert.equal(storage.items.size, 0);
  }
  for (const key of [null, undefined, '']) {
    open().save(key, draft);
    assert.equal(storage.items.size, 0);
    open().save('person A', draft);
    assert.equal(open().read(key), null);
  }
  for (const broken of ['', '{', 'null', '[]', '{"key":"person A"}', JSON.stringify({ key: 'person A', savedAt: now, draft: { kind: 'editor' } })]) {
    storage.setItem(SLOT, broken);
    assert.equal(open().read('person A'), null, broken);
  }
});

test('blocked storage keeps the draft for this page only', () => {
  const storage = () => { throw new Error('denied'); };
  const recovery = createMarkDraftRecovery({ storage });
  const draft = editor();
  recovery.save('person A', draft);
  assert.deepEqual(recovery.read('person A'), draft);
  assert.equal(createMarkDraftRecovery({ storage }).read('person A'), null);
  recovery.clear();
  assert.equal(recovery.read('person A'), null);
});

test('stored drafts are checked before use', () => {
  const ring = [[-87, 43], [-87.1, 43], [-87.1, 43.1], [-87, 43]];
  for (const good of [editor(), editor({ id: randomUUID(), newId: null, revision: 3 }), editor({ geometry: { type: 'Polygon', coordinates: [ring] } }),
    editor({ coordinates: 'not a place' }), { kind: 'drawing', type: 'LineString', positions: [[-87, 43]] }]) assert.equal(validMarkDraft(good), true);
  for (const bad of [null, 'text', {}, editor({ geometry: { type: 'Point', coordinates: [-187, 43] } }), editor({ geometry: { type: 'Circle' } }),
    editor({ geometry: { type: 'LineString', coordinates: [[-87, 43]] } }), editor({ geometry: { type: 'Polygon', coordinates: [ring.slice(0, 3)] } }),
    editor({ newId: null }), editor({ id: 'x' }), editor({ id: randomUUID() }), editor({ name: 'a'.repeat(101) }), editor({ note: 'a'.repeat(2001) }),
    editor({ units: 'furlongs' }), editor({ categoryId: 7 }), editor({ elevation: 4 }), { kind: 'drawing', type: 'Point', positions: [[-87, 43]] },
    { kind: 'drawing', type: 'LineString', positions: [] }, { kind: 'drawing', type: 'LineString', positions: Array.from({ length: 502 }, () => [-87, 43]) }]) {
    assert.equal(validMarkDraft(bad), false, JSON.stringify(bad)?.slice(0, 120));
  }
});

test('a restored edit never overwrites a mark that changed, went away or is not editable', () => {
  const id = randomUUID(), fresh = randomUUID();
  const mark = { id, revision: 2, mine: true, editable: true, geometry: { type: 'Point' } };
  const find = row => wanted => (wanted === row?.id ? row : null);
  const edit = editor({ id, newId: null, revision: 2 });
  assert.deepEqual(pick(reconcileMarkDraft(edit, find(mark), () => fresh)), [id, null, 2, false]);
  for (const row of [{ ...mark, revision: 3 }, null, { ...mark, mine: false }, { ...mark, editable: false }, { ...mark, geometry: { type: 'LineString' } }]) {
    assert.deepEqual(pick(reconcileMarkDraft(edit, find(row), () => fresh)), [null, fresh, null, true]);
  }
  // A new mark whose save reached the server although its answer was lost.
  const created = editor({ newId: id });
  assert.deepEqual(pick(reconcileMarkDraft(created, find(null), () => fresh)), [null, id, null, false]);
  assert.deepEqual(pick(reconcileMarkDraft(created, find({ ...mark, revision: 1 }), () => fresh)), [id, null, 1, false]);
  assert.deepEqual(pick(reconcileMarkDraft(created, find({ ...mark, mine: false }), () => fresh)), [null, fresh, null, false]);
});
const pick = draft => [draft.id, draft.newId, draft.revision, draft.changedElsewhere];

const form = panel => panel.q('.viewer-mark-form');
const button = (panel, text) => form(panel).querySelectorAll('button').find(node => node.textContent === text);
async function start(t, options) {
  const setup = await openMarksPanel(t);
  const storage = memoryStorage();
  // A new page in the same tab: new document, same sessionStorage.
  const page = more => setup.mount({ dom: createMiniDocument({ sessionStorage: storage }), ...options, ...more });
  return { ...setup, storage, page, person: setup.scope('client', 'client-a') };
}
const stored = storage => storage.items.has(SLOT);

test('a reload keeps a new mark that was not saved, and saving or closing it ends the draft', async t => {
  const { page, person, storage, database } = await start(t);
  const first = page();
  await first.marks.setScope(person);
  assert.equal(stored(storage), false);
  await first.place('43.05, -87');
  await first.type('[name=name]', 'North stand');
  await first.type('[name=note]', 'Ladder needs a strap');
  await first.type('[name=elevation]', '812.5');
  await first.type('[name=pointCoordinates]', '43.051, -87.001');
  first.q('[name=visibility]').value = 'staff';
  await first.q('[name=visibility]').fire('change');
  assert.equal(database.prepare('SELECT count(*) n FROM viewer_marks').get().n, 0);

  const second = page();
  await second.marks.setScope(person);
  assert.match(second.text(), /Your unsaved mark was restored\./);
  assert.deepEqual(['name', 'note', 'elevation', 'pointCoordinates', 'visibility'].map(name => second.q(`[name=${name}]`).value),
    ['North stand', 'Ladder needs a strap', '812.5', '43.051, -87.001', 'staff']);
  await second.save();
  const [mark] = second.store.state.marks;
  assert.deepEqual([mark.name, mark.note, mark.visibility, mark.geometry.coordinates], ['North stand', 'Ladder needs a strap', 'staff', [-87.001, 43.051]]);
  assert.ok(Math.abs(mark.elevationNavd88M - 812.5 / 3.28084) < 1e-3);
  assert.equal(stored(storage), false);

  const third = page();
  await third.marks.setScope(person);
  assert.equal(form(third).hidden, true);
  await third.place('43.06, -87');
  assert.equal(stored(storage), true);
  await button(third, 'Cancel').click();
  assert.equal(stored(storage), false);
});

test('an edit of a saved mark survives a reload; only opening it is not an edit', async t => {
  const { page, person, storage } = await start(t);
  const first = page();
  await first.marks.setScope(person);
  await first.place('43.05, -87');
  await first.save();
  await first.open('Pin');
  assert.equal(stored(storage), false, 'opened, nothing typed');
  await first.type('[name=name]', 'Renamed');
  assert.equal(stored(storage), true);
  await first.type('[name=name]', 'Pin');
  assert.equal(stored(storage), false, 'typed back to what it was');
  await first.type('[name=name]', 'Renamed');
  const second = page();
  await second.marks.setScope(person);
  assert.equal(second.q('[name=name]').value, 'Renamed');
  await second.save();
  assert.deepEqual(second.store.state.marks.map(mark => mark.name), ['Renamed']);
});

test('an edit of a mark that changed in another tab opens as a new mark', async t => {
  const { page, person, mount, scope } = await start(t);
  const first = page();
  await first.marks.setScope(person);
  await first.place('43.05, -87');
  await first.save();
  await first.open('Pin');
  await first.type('[name=name]', 'Mine, unsaved');
  const otherTab = mount();
  await otherTab.marks.setScope(scope('client', 'client-a'));
  await otherTab.store.update(otherTab.store.state.marks[0], { name: 'Other tab' });
  const second = page();
  await second.marks.setScope(person);
  assert.match(second.text(), /changed elsewhere/);
  await second.save();
  assert.deepEqual(second.store.state.marks.map(mark => mark.name).sort(), ['Mine, unsaved', 'Other tab']);
});

test('an expired session keeps the draft for the same person; refused access and other people lose it', async t => {
  const { page, person, storage, scope } = await start(t);
  const panel = page();
  await panel.marks.setScope(person);
  const write = async () => { await panel.place('43.05, -87'); await panel.type('[name=name]', 'Unsaved'); };
  await write();
  await panel.marks.setScope(null, { keepDraft: true });
  assert.equal(form(panel).hidden, true);
  assert.doesNotMatch(panel.values(), /Unsaved/, 'nothing stays on screen meanwhile');
  await panel.marks.setScope(person);
  assert.equal(panel.q('[name=name]').value, 'Unsaved');
  assert.equal(form(panel).hidden, false);

  await panel.marks.setScope(null, { keepDraft: false });
  assert.equal(stored(storage), false, 'refused access');
  await panel.marks.setScope(person);
  assert.equal(form(panel).hidden, true);

  for (const other of [scope('client', 'client-b'), scope('ops', 'client-a'), scope('client', 'client-a', { modelId: 'other-model' })]) {
    await write();
    await panel.marks.setScope(other);
    assert.doesNotMatch(panel.text() + panel.values(), /Unsaved/);
    assert.equal(stored(storage), false);
    await panel.marks.setScope(person);
    assert.equal(form(panel).hidden, true);
  }
  await write();
  await panel.marks.setScope(scope('client', 'client-a', { permissions: { view: true, measure: true } }));
  assert.equal(stored(storage), false, 'a login without an individual identity is not offered it');
});

test('a lost identity or another person clears the stored draft at once, even with no map open', async t => {
  const { page, person, storage, scope } = await start(t);
  for (const next of [scope('client', 'client-a', { permissions: { view: true, measure: true } }), scope('client', 'client-b')]) {
    const panel = page();
    await panel.marks.setScope(person);
    await panel.place('43.05, -87');
    await panel.type('[name=name]', 'Unsaved');
    panel.marks.setView({ map: false });
    assert.equal(stored(storage), true);
    await panel.marks.setScope(next);
    assert.equal(stored(storage), false);
    assert.doesNotMatch(panel.text() + panel.values(), /Unsaved/);
  }
});

test('a draft renewed under the same scope stays open, and public links store nothing', async t => {
  const { page, person, storage } = await start(t);
  const panel = page();
  await panel.marks.setScope(person);
  await panel.place('43.05, -87');
  await panel.type('[name=name]', 'Unsaved');
  await panel.marks.setScope({ ...person });
  assert.equal(panel.q('[name=name]').value, 'Unsaved');
  assert.equal(form(panel).hidden, false);
  await panel.marks.setScope(null);
  const link = page();
  await link.marks.setScope({ mode: 'temporary', key: 'public' });
  storage.removeItem(SLOT);
  await link.place('43.05, -87');
  await link.type('[name=name]', 'Public');
  assert.equal(stored(storage), false);
});

test('saving again after a lost answer updates the one mark instead of adding a copy', async t => {
  let lose = false;
  const lossy = async (path, init) => {
    const response = await fetch(path, init);
    if (lose && init.method === 'POST') { lose = false; await response.arrayBuffer(); throw new TypeError('connection lost'); }
    return response;
  };
  for (const reload of [false, true]) {
    const { page, person, storage } = await start(t, { request: lossy });
    let panel = page();
    await panel.marks.setScope(person);
    await panel.place('43.05, -87');
    await panel.type('[name=name]', 'Once');
    lose = true;
    await panel.save();
    assert.equal(form(panel).hidden, false, 'the editor stays open');
    assert.equal(stored(storage), true);
    if (reload) { panel = page(); await panel.marks.setScope(person); }
    await panel.type('[name=name]', 'Once, changed');
    await panel.save();
    if (!reload) await panel.save(); // the first retry reports the conflict and reloads the list
    assert.deepEqual(panel.store.state.marks.map(mark => mark.name), ['Once, changed']);
    assert.equal(stored(storage), false);
  }
});

test('an unfinished drawing is restored when the map opens', async t => {
  const { page, person, storage } = await start(t);
  const first = page();
  await first.marks.setScope(person);
  await first.q('[data-add=LineString]').click();
  for (const lng of [-87, -87.001, -87.002]) first.marks.mapClick({ lat: 43, lng });
  assert.equal(stored(storage), true);
  const second = page({ map: false });
  await second.marks.setScope(person);
  assert.equal(stored(storage), true, 'waits for the map');
  second.marks.setView({ map: true });
  assert.match(second.text(), /3 points/);
  second.marks.mapDoubleClick();
  await second.save();
  assert.deepEqual(second.store.state.marks[0].geometry, { type: 'LineString', coordinates: [[-87, 43], [-87.001, 43], [-87.002, 43]] });
  const third = page();
  await third.marks.setScope(person);
  await third.q('[data-add=Polygon]').click();
  third.marks.mapClick({ lat: 43, lng: -87 });
  await third.q('.viewer-mark-draw').querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
  assert.equal(stored(storage), false);
});

test('an elevation typed in one unit is not read as another after a reload', async t => {
  const { page, person } = await start(t);
  const first = page({ units: () => 'imperial' });
  await first.marks.setScope(person);
  await first.place('43.05, -87');
  await first.type('[name=elevation]', '820.21');
  const second = page({ units: () => 'metric' });
  await second.marks.setScope(person);
  assert.equal(second.q('[name=elevation]').value, '250.00');
  await second.type('[name=elevation]', 'abc');
  const third = page({ units: () => 'imperial' });
  await third.marks.setScope(person);
  assert.equal(third.q('[name=elevation]').value, 'abc');
  await third.save();
  assert.match(third.text(), /must be a number/);
});

test('marks work in 2D on a NAD83 model: lon/lat is stored as given, UTM and typed points round-trip', async t => {
  const { scope, mount } = await openMarksPanel(t);
  const panel = mount({ georef: () => ({ epsg: 26916, utmZoneLon0Deg: -87, hemisphere: 'N' }) });
  await panel.marks.setScope(scope('client', 'client-a'));
  await panel.place('43.05000001, -87.00000002');
  await panel.save();
  assert.deepEqual(panel.store.state.marks[0].geometry.coordinates, [-87.00000002, 43.05000001]);
  await panel.place('16T 500000 4766400');
  await panel.save();
  const [lon, lat] = panel.store.state.marks[1].geometry.coordinates;
  assert.ok(Math.abs(lon + 87) < 1e-6 && Math.abs(lat - 43.05) < 0.01);
  await panel.open('Pin');
  assert.match(panel.q('.viewer-mark-readout').textContent, /UTM 16N/);
});

test('recently deleted lists the person\'s own marks and restores them in place', async t => {
  const { mount, scope } = await openMarksPanel(t);
  const panel = mount(), other = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  const section = node => node.q('.viewer-mark-deleted');
  const openSection = node => node.q('[data-tab=deleted]').click();
  await panel.place('43.05, -87');
  await panel.type('[name=name]', 'Gone');
  await panel.save();
  const { id } = panel.store.state.marks[0];
  await openSection(panel);
  assert.match(section(panel).textContent, /None in the last 30 days/);
  await panel.show('Gone');
  await panel.card('Delete').click();
  assert.equal(panel.store.state.marks.length, 0);
  assert.match(section(panel).textContent, /Gone/);
  await other.marks.setScope(scope('ops', 'staff-person'));
  await openSection(other);
  assert.doesNotMatch(section(other).textContent, /Gone/);
  await panel.q('[aria-label="Restore Gone"]').click();
  assert.deepEqual(panel.store.state.marks.map(mark => [mark.id, mark.name]), [[id, 'Gone']]);
  assert.doesNotMatch(section(panel).textContent, /Gone/);
  await panel.button('Undo').click();
  assert.match(section(panel).textContent, /Gone/, 'undoing a restore deletes it again');
  await panel.marks.setScope({ mode: 'temporary', key: 'public' });
  assert.equal(panel.q('[data-tab=deleted]').hidden, true);
  assert.equal(section(panel).parent.hidden, true);
  assert.doesNotMatch(panel.text(), /Gone/);
});

test('a save the network refuses says so, keeps what was typed and can be tried again', async t => {
  let fail = null;
  const request = async (path, init) => {
    const how = init.method === 'GET' ? null : fail;
    if (how === 'never sent') throw new TypeError('Failed to fetch');
    const response = await fetch(path, init);
    if (how === 'answer lost') { await response.arrayBuffer(); throw new TypeError('Failed to fetch'); }
    if (how === 'answer cut off') {
      await response.arrayBuffer();
      return new Response(new ReadableStream({ start: body => body.error(new TypeError('network error')) }), { status: response.status });
    }
    return response;
  };
  for (const kind of ['new', 'edit']) for (const how of ['never sent', 'answer lost', 'answer cut off']) {
    const at = `${kind}, ${how}`;
    const { page, person, storage, database, requests } = await start(t, { request });
    const panel = page(), shown = () => panel.q('.viewer-mark-card').textContent;
    await panel.marks.setScope(person);
    const rows = () => database.prepare('SELECT revision, document_json FROM viewer_marks').all().map(row => [row.revision, JSON.parse(row.document_json).note]);
    if (kind === 'edit') {
      await panel.place('43.05, -87');
      await panel.type('[name=name]', 'One');
      await panel.save();
      requests.length = 0;
      await panel.open('One');
      assert.deepEqual(requests, [], 'opening and editing asks for nothing');
    } else await panel.place('43.05, -87');
    await panel.type('[name=name]', 'One');
    await panel.type('[name=note]', 'Ladder');
    const before = rows(), undo = panel.store.state.undo.length;
    const still = message => {
      assert.match(shown(), message, at);
      assert.deepEqual([form(panel).hidden, panel.q('[name=name]').value, panel.q('[name=note]').value], [false, 'One', 'Ladder'], at);
      assert.deepEqual([panel.store.state.busy, stored(storage), panel.store.state.undo.length], [false, true, undo], at);
      assert.ok(!button(panel, 'Save').disabled, at);
    };
    fail = how;
    requests.length = 0;
    await panel.save();
    fail = null;
    assert.equal(requests.length, 1, at + ': one request, not repeated by itself');
    still(/Could not save the change\. Try again\./);
    const sent = kind === 'new' ? [[1, 'Ladder']] : [[2, 'Ladder']];
    assert.deepEqual(rows(), how === 'never sent' ? before : sent, at);
    await panel.save();
    if (kind === 'edit' && how !== 'never sent') {
      // The first one did arrive, so this one is refused, and the one after it is based on that.
      still(/The list was reloaded/);
      assert.deepEqual(rows(), sent, at);
      await panel.save();
    }
    assert.equal(form(panel).hidden, true, at);
    assert.equal(stored(storage), false, at);
    assert.deepEqual(rows().map(([, note]) => note), ['Ladder'], at + ': no copy');
  }
});
