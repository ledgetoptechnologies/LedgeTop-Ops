import assert from 'node:assert/strict';
import test from 'node:test';
import { mountViewerMarks } from '../viewer-marks.mjs';

class Element extends EventTarget {
  children = [];
  value = '';
  textContent = '';
  disabled = false;
  hidden = false;
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
}

function fixture(request) {
  const window = new EventTarget();
  const document = { defaultView: window, createElement: () => new Element() };
  const panel = new Element(), form = new Element(), data = new Map();
  panel.ownerDocument = document;
  panel.querySelector = selector => data.get(selector);
  for (const selector of ['[data-mark-list]', '[data-mark-status]', '[data-mark-placement]', '[data-mark-pick]', '[data-mark-cancel]', '[type="submit"]']) {
    data.set(selector, new Element());
  }
  data.set('form', form);
  const fields = new Map(['kind', 'color', 'name', 'latitude', 'longitude', 'note'].map(field => [field, new Element()]));
  form.elements = { namedItem: field => fields.get(field) };
  const drawn = { marks: [], move: null };
  let nextId = 0;
  const presenter = mountViewerMarks({ panel, request, newId: () => 'synthetic-mark-' + ++nextId,
    mapLayer: { draw(marks, move) { Object.assign(drawn, { marks, move }); } } });
  const click = element => element.dispatchEvent(new Event('click'));
  const submit = () => form.dispatchEvent(new Event('submit', { cancelable: true }));
  const leave = () => window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  return { presenter, panel, data, fields, drawn, click, submit, leave };
}

const compatible = { map: true, mapFrame: true, georef: { epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' } };
const privateScope = key => ({ key, mode: 'private', token: () => key });
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('public mark form supports typed coordinates, map picking and drag without sending data', async () => {
  const f = fixture(() => assert.fail('temporary marks must not reach an API'));
  await f.presenter.setScope({ key: 'public model A', mode: 'temporary' });
  f.presenter.setView(compatible);
  f.fields.get('name').value = 'Typed Tree Stand';
  f.fields.get('latitude').value = '43';
  f.fields.get('longitude').value = '-87';
  f.submit();
  assert.equal(f.drawn.marks[0].name, 'Typed Tree Stand');
  assert.equal(f.drawn.marks[0].latitude, 43);
  assert.equal(f.leave(), false, 'temporary marks warn before refresh');

  f.drawn.move(f.drawn.marks[0], { latitude: 43.1, longitude: -87.1 });
  assert.equal(f.fields.get('latitude').value, '43.1');
  f.submit();
  assert.equal(f.drawn.marks[0].latitude, 43.1);

  f.click(f.data.get('[data-mark-pick]'));
  assert.equal(f.presenter.mapClick({ lat: 43.2, lng: -87.2 }), true);
  f.fields.get('name').value = 'Picked Tree Stand';
  f.submit();
  assert.equal(f.drawn.marks[1].longitude, -87.2);

  f.presenter.setView({ ...compatible, map: false });
  assert.match(f.data.get('[data-mark-placement]').textContent, /verified surface elevation/);
  assert.equal(f.drawn.marks.length, 0);
  f.presenter.setView({ ...compatible, mapFrame: false, georef: { ...compatible.georef, epsg: 26916 } });
  assert.match(f.data.get('[data-mark-placement]').textContent, /verified WGS84/);
  assert.equal(f.drawn.marks.length, 0);
  assert.equal(await f.presenter.setScope({ key: 'public model B', mode: 'temporary' }), false);
  assert.equal(f.panel.hidden, true, 'drafts are not shown in the wrong model');
  assert.equal(f.presenter.hasTemporaryMarks(), true);
  await f.presenter.setScope({ key: 'public model A', mode: 'temporary' });
  assert.equal(f.data.get('[data-mark-list]').children.length, 2);
  f.presenter.discardTemporaryMarks();
  await f.presenter.setScope({ key: 'public model B', mode: 'temporary' });
  assert.equal(f.data.get('[data-mark-list]').children.length, 0);
  assert.equal(f.leave(), true);
  f.presenter.dispose();
});

test('private Marks ignore responses from a replaced identity and never inherit public drafts', async () => {
  const pending = new Map();
  const f = fixture((path, options) => {
    assert.equal(path, '/api/v1/marks');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Promise(resolve => pending.set(options.headers.authorization, { resolve, signal: options.signal }));
  });
  const first = f.presenter.setScope(privateScope('clientA'));
  const second = f.presenter.setScope(privateScope('clientB'));
  assert.equal(pending.get('Bearer clientA').signal.aborted, true);
  pending.get('Bearer clientB').resolve(json({ marks: [{ id: 'b', name: '<B>', latitude: 43, longitude: -87 }] }));
  await second;
  pending.get('Bearer clientA').resolve(json({ marks: [{ id: 'a', name: 'Private A' }] }));
  await first;
  assert.equal(f.data.get('[data-mark-list]').children[0].children[0].textContent, '<B>');
  assert.equal(f.leave(), true, 'persisted private marks are outside the public leave warning');
  await f.presenter.setScope({ key: 'public', mode: 'temporary' });
  assert.equal(f.data.get('[data-mark-list]').children.length, 0);
  assert.equal(f.fields.get('name').value, '');
  f.presenter.dispose();
});

test('private form saves revisions and clears rendered marks when the bearer is denied', async () => {
  let saved, last;
  const f = fixture((path, options) => {
    last = options;
    if (options.method === 'GET') return Promise.resolve(json({ marks: [] }));
    assert.equal(options.headers.authorization, 'Bearer owner');
    if (options.method === 'PUT') {
      assert.match(path, /synthetic-mark-1$/);
      assert.equal(JSON.parse(options.body).revision, 1);
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    saved = { ...JSON.parse(options.body), revision: 1 };
    return Promise.resolve(json({ mark: saved }));
  });
  await f.presenter.setScope(privateScope('owner'));
  f.presenter.setView(compatible);
  f.fields.get('name').value = 'Owner synthetic stand';
  f.fields.get('latitude').value = '43';
  f.fields.get('longitude').value = '-87';
  f.submit();
  await new Promise(setImmediate);
  assert.equal(last.method, 'POST');
  assert.equal(saved.latitude, 43);
  assert.equal(f.drawn.marks[0].id, saved.id);

  const row = f.data.get('[data-mark-list]').children[0];
  f.click(row.children[1]);
  f.fields.get('name').value = 'Edit stand';
  f.submit();
  await new Promise(setImmediate);
  assert.equal(last.method, 'PUT');
  assert.equal(f.drawn.marks.length, 0);
  assert.equal(f.data.get('[data-mark-list]').children.length, 0);
  assert.equal(f.fields.get('name').value, '');
  assert.match(f.data.get('[data-mark-status]').textContent, /hidden until access is restored/);
  assert.equal(f.leave(), true);
  f.presenter.dispose();
});
